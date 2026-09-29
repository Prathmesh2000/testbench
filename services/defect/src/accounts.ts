import type { JiraConnection, JiraConnectionSummary, JiraMapping, JiraProjectOption } from '@tb/contracts';
import { AppError, badRequest, decryptSecret, encryptSecret, type Tx } from '@tb/platform';
import { JiraClient, JiraError } from './jira';

type ConnectionRow = {
  id: string;
  user_id: string;
  site_url: string;
  email: string;
  display_name: string;
  secret_enc: string;
  status: string;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

export interface JiraAccountsOptions {
  /** Encrypts API tokens at rest; null disables connecting (the server isn't configured for it). */
  tokenSecret: string | null;
  /** Sites people may connect; the server calls the stored URL, so this blocks SSRF to internal hosts. */
  sitePattern: RegExp;
}

/** Where a project's bugs go: its mapping, or the old convention (same key, reporter's own site). */
export interface JiraTarget {
  siteUrl: string | null;
  jiraKey: string;
  issueType: string;
}

const view = (r: ConnectionRow): JiraConnection => ({
  siteUrl: r.site_url,
  email: r.email,
  displayName: r.display_name,
  status: r.status as JiraConnection['status'],
  lastError: r.last_error,
  connectedAt: r.created_at.toISOString(),
});

/**
 * Jira accounts, one per tester. Every Jira action runs as the person who asked for it, so issues,
 * comments and transitions carry their name in Jira; the background sync borrows the reporter's
 * connection. Clients are cached per connection so calls through one account share its rate limit.
 */
export class JiraAccounts {
  private readonly clients = new Map<string, { stamp: number; client: JiraClient }>();

  constructor(private readonly opts: JiraAccountsOptions) {}

  private secret(): string {
    if (!this.opts.tokenSecret)
      throw new AppError(
        503,
        'jira_unavailable',
        'Jira connections are not enabled on this server: JIRA_TOKEN_SECRET is not set.',
      );
    return this.opts.tokenSecret;
  }

  /** A client for a stored connection, rebuilt only when the connection changed. */
  clientOf(row: Pick<ConnectionRow, 'id' | 'site_url' | 'email' | 'secret_enc' | 'updated_at'>): JiraClient {
    const stamp = row.updated_at.getTime();
    const hit = this.clients.get(row.id);
    if (hit?.stamp === stamp) return hit.client;
    const client = new JiraClient({
      baseUrl: row.site_url,
      email: row.email,
      apiToken: decryptSecret(this.secret(), row.secret_enc),
    });
    this.clients.set(row.id, { stamp, client });
    return client;
  }

  private row(trx: Tx, userId: string) {
    return trx.selectFrom('defect.jira_connection').selectAll().where('user_id', '=', userId).executeTakeFirst();
  }

  /** Verifies the token with Jira, then stores it encrypted, replacing any earlier connection. */
  async connect(
    trx: Tx,
    caller: { orgId: string; userId: string },
    body: { siteUrl: string; email: string; apiToken: string },
  ): Promise<JiraConnection> {
    if (!this.opts.sitePattern.test(body.siteUrl))
      throw badRequest('Only Jira Cloud sites, such as https://your-team.atlassian.net, can be connected.');
    const secret = this.secret();
    const probe = new JiraClient({ baseUrl: body.siteUrl, email: body.email, apiToken: body.apiToken });
    const me = await probe.myself().catch((err: unknown) => {
      if (err instanceof JiraError && (err.status === 401 || err.status === 403))
        throw badRequest('Jira did not accept that email and API token. Check both and try again.');
      throw new AppError(502, 'jira_error', err instanceof Error ? err.message : 'Could not reach Jira');
    });
    const values = {
      site_url: body.siteUrl,
      email: body.email,
      account_id: me.accountId,
      display_name: me.displayName,
      secret_enc: encryptSecret(secret, body.apiToken),
      status: 'active',
      last_error: null,
      auth_type: 'api_token',
      updated_at: new Date(),
    };
    const row = await trx
      .insertInto('defect.jira_connection')
      .values({ org_id: caller.orgId, user_id: caller.userId, ...values })
      .onConflict((oc) => oc.columns(['org_id', 'user_id']).doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();
    return view(row);
  }

  async mine(trx: Tx, userId: string): Promise<JiraConnection | null> {
    const row = await this.row(trx, userId);
    return row ? view(row) : null;
  }

  async disconnect(trx: Tx, userId: string): Promise<void> {
    const gone = await trx
      .deleteFrom('defect.jira_connection')
      .where('user_id', '=', userId)
      .returning('id')
      .executeTakeFirst();
    if (gone) this.clients.delete(gone.id);
  }

  /** Everyone in the organisation who has connected Jira, for admins. */
  async list(trx: Tx): Promise<JiraConnectionSummary[]> {
    const rows = await trx
      .selectFrom('defect.jira_connection as c')
      .innerJoin('iam.app_user as u', 'u.id', 'c.user_id')
      .select(['c.site_url', 'c.status', 'c.created_at', 'u.id', 'u.name', 'u.email'])
      .orderBy('u.name')
      .execute();
    return rows.map((r) => ({
      user: { id: r.id, name: r.name, email: r.email },
      siteUrl: r.site_url,
      status: r.status as JiraConnectionSummary['status'],
      connectedAt: r.created_at.toISOString(),
    }));
  }

  /**
   * The caller's own client, for actions that must show as them in Jira. Refuses with a message the
   * tester can act on when they haven't connected, their token stopped working, or they're connected
   * to a different site than the project files bugs on.
   */
  async forUser(trx: Tx, userId: string, siteUrl: string | null): Promise<JiraClient> {
    const row = await this.row(trx, userId);
    if (!row)
      throw new AppError(409, 'jira_not_connected', 'Connect your Jira account in Settings → Jira to do this.');
    if (row.status === 'error')
      throw new AppError(
        409,
        'jira_reconnect',
        `Jira stopped accepting your saved token${row.last_error ? ` (${row.last_error})` : ''}. Reconnect in Settings → Jira.`,
      );
    if (siteUrl && row.site_url !== siteUrl)
      throw new AppError(
        409,
        'jira_wrong_site',
        `This project files bugs on ${siteUrl}, but your Jira connection is for ${row.site_url}.`,
      );
    return this.clientOf(row);
  }

  /** Like forUser, but null instead of an error: for extras such as the duplicate check. */
  async tryForUser(trx: Tx, userId: string, siteUrl: string | null): Promise<JiraClient | null> {
    return this.forUser(trx, userId, siteUrl).catch((err: unknown) => {
      if (err instanceof AppError && err.status === 409) return null;
      throw err;
    });
  }

  /**
   * The caller's client if they have one, else any active connection to the site. Only for read-only
   * project metadata (workflow statuses), where whose account asks makes no difference.
   */
  async readerFor(trx: Tx, userId: string, siteUrl: string | null): Promise<JiraClient> {
    const own = await this.tryForUser(trx, userId, siteUrl);
    if (own) return own;
    const other = (await this.active(trx)).find((c) => !siteUrl || c.site_url === siteUrl);
    if (!other)
      throw new AppError(409, 'jira_not_connected', 'Connect your Jira account in Settings → Jira to do this.');
    return this.clientOf(other);
  }

  /** Active connections in the organisation, for the background sync to choose from. */
  active(trx: Tx) {
    return trx
      .selectFrom('defect.jira_connection')
      .select(['id', 'user_id', 'site_url', 'email', 'secret_enc', 'updated_at'])
      .where('status', '=', 'active')
      .execute();
  }

  /** Records that Jira refused a stored token, so its owner is asked to reconnect. */
  async markFailed(trx: Tx, connectionId: string, message: string): Promise<void> {
    await trx
      .updateTable('defect.jira_connection')
      .set({ status: 'error', last_error: message.slice(0, 500) })
      .where('id', '=', connectionId)
      .execute();
    this.clients.delete(connectionId);
  }
}

// ---------- project mapping ----------

export async function projectTarget(trx: Tx, projectId: string): Promise<JiraTarget> {
  const row = await trx
    .selectFrom('repo.project as p')
    .leftJoin('defect.jira_project_map as m', 'm.project_id', 'p.id')
    .select(['p.key', 'm.site_url', 'm.jira_key', 'm.issue_type'])
    .where('p.id', '=', projectId)
    .executeTakeFirstOrThrow();
  return row.jira_key
    ? { siteUrl: row.site_url, jiraKey: row.jira_key, issueType: row.issue_type ?? 'Bug' }
    : { siteUrl: null, jiraKey: row.key, issueType: 'Bug' };
}

export async function getMapping(trx: Tx, projectId: string): Promise<JiraMapping | null> {
  const m = await trx
    .selectFrom('defect.jira_project_map')
    .selectAll()
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  return m ? { siteUrl: m.site_url, jiraKey: m.jira_key, issueType: m.issue_type, updatedAt: m.updated_at.toISOString() } : null;
}

/**
 * Maps a Testbench project to a Jira project. Checked through the admin's own connection, so a
 * mapping can only point at a project and issue type that really exist on that site.
 */
export async function setMapping(
  trx: Tx,
  accounts: JiraAccounts,
  caller: { orgId: string; userId: string },
  projectId: string,
  body: { siteUrl: string; jiraKey: string; issueType: string },
): Promise<JiraMapping> {
  const jira = await accounts.forUser(trx, caller.userId, body.siteUrl);
  const types = await jira.issueTypes(body.jiraKey).catch((err: unknown) => {
    if (err instanceof JiraError && (err.status === 404 || err.status === 400))
      throw badRequest(`Jira project ${body.jiraKey} doesn't exist on ${body.siteUrl}, or you can't see it.`);
    throw new AppError(502, 'jira_error', err instanceof Error ? err.message : 'Could not reach Jira');
  });
  const issueType = types.find((t) => t.toLowerCase() === body.issueType.toLowerCase());
  if (!issueType)
    throw badRequest(`${body.jiraKey} has no issue type "${body.issueType}". It has: ${types.join(', ') || 'none'}.`);
  const values = {
    site_url: body.siteUrl,
    jira_key: body.jiraKey,
    issue_type: issueType,
    updated_by: caller.userId,
    updated_at: new Date(),
  };
  await trx
    .insertInto('defect.jira_project_map')
    .values({ project_id: projectId, org_id: caller.orgId, ...values })
    .onConflict((oc) => oc.column('project_id').doUpdateSet(values))
    .execute();
  return (await getMapping(trx, projectId))!;
}

export async function jiraProjects(trx: Tx, accounts: JiraAccounts, userId: string): Promise<JiraProjectOption[]> {
  const jira = await accounts.forUser(trx, userId, null);
  return jira.projects();
}
