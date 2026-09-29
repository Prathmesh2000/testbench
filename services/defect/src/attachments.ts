import { withTenant, type Db, type ObjectStorage, type Tx } from '@tb/platform';
import { sql } from 'kysely';
import type { JiraAccounts } from './accounts';
import { JiraError, type JiraClient } from './jira';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
const MAX_ATTEMPTS = 5;
// A site admin rarely changes the upload limit; re-reading it hourly keeps one call per upload away.
const SETTINGS_TTL_MS = 3_600_000;

/** Queues evidence to be attached to a Jira issue as `uploaderId`, once each per defect. */
export async function queueAttachments(
  trx: Tx,
  orgId: string,
  defectId: string,
  uploaderId: string,
  evidenceIds: string[],
): Promise<void> {
  if (!evidenceIds.length) return;
  await trx
    .insertInto('defect.attachment')
    .values(evidenceIds.map((id) => ({ org_id: orgId, defect_id: defectId, evidence_id: id, uploader_id: uploaderId })))
    .onConflict((oc) => oc.columns(['defect_id', 'evidence_id']).doNothing())
    .execute();
}

type Outcome =
  | { status: 'uploaded'; jiraId: string }
  | { status: 'linked_only' | 'failed'; error: string }
  | { status: 'retry'; error: string };

const siteSettings = new Map<string, { at: number; enabled: boolean; limit: number }>();
async function settingsOf(jira: JiraClient) {
  const hit = siteSettings.get(jira.cfg.baseUrl);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit;
  const s = await jira.attachmentSettings();
  const fresh = { at: Date.now(), enabled: s.enabled, limit: s.uploadLimit };
  siteSettings.set(jira.cfg.baseUrl, fresh);
  return fresh;
}

const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;

/**
 * Uploads one claimed attachment. The row is read and the result written in short transactions; the
 * upload itself runs between them, so a slow Jira never holds a database connection.
 */
export async function processAttachment(
  db: Db,
  storage: ObjectStorage,
  accounts: JiraAccounts,
  claimed: { id: string; org_id: string },
): Promise<Outcome> {
  const actor = { orgId: claimed.org_id, userId: SYSTEM_USER };
  const job = await withTenant(db, actor, async (trx) => {
    const row = await trx
      .selectFrom('defect.attachment as a')
      .innerJoin('exec.evidence as e', 'e.id', 'a.evidence_id')
      .innerJoin('defect.defect as d', 'd.id', 'a.defect_id')
      .leftJoin('defect.jira_connection as c', 'c.user_id', 'a.uploader_id')
      .select([
        'a.attempts',
        'e.object_key',
        'e.file_name',
        'e.content_type',
        'e.size_bytes',
        'd.jira_key',
        'c.id as connection_id',
        'c.site_url',
        'c.email',
        'c.secret_enc',
        'c.status as connection_status',
        'c.updated_at',
      ])
      .where('a.id', '=', claimed.id)
      .executeTakeFirst();
    return row ?? null;
  });
  if (!job) return { status: 'failed', error: 'The attachment no longer exists' };

  let outcome: Outcome;
  if (!job.connection_id || job.connection_status !== 'active') {
    outcome = { status: 'failed', error: 'The person who logged this bug has disconnected Jira' };
  } else {
    const jira = accounts.clientOf({
      id: job.connection_id,
      site_url: job.site_url!,
      email: job.email!,
      secret_enc: job.secret_enc!,
      updated_at: job.updated_at!,
    });
    try {
      const site = await settingsOf(jira);
      if (!site.enabled) outcome = { status: 'linked_only', error: 'Attachments are turned off on this Jira site' };
      else if (job.size_bytes > site.limit)
        outcome = {
          status: 'linked_only',
          error: `Larger than this Jira site's ${mb(site.limit)} upload limit; it stays in Testbench`,
        };
      else {
        const bytes = await storage.read(job.object_key);
        const created = await jira.attach(job.jira_key, {
          name: job.file_name,
          contentType: job.content_type,
          bytes,
        });
        outcome = { status: 'uploaded', jiraId: created?.id ?? '' };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof JiraError && err.status === 401) {
        await withTenant(db, actor, (trx) => accounts.markFailed(trx, job.connection_id!, message));
        outcome = { status: 'failed', error: message };
      } else if (err instanceof JiraError && (err.status === 403 || err.status === 404)) {
        // Permission or a deleted issue: retrying cannot help.
        outcome = { status: 'failed', error: message };
      } else {
        outcome = job.attempts >= MAX_ATTEMPTS ? { status: 'failed', error: message } : { status: 'retry', error: message };
      }
    }
  }

  await withTenant(db, actor, (trx) =>
    trx
      .updateTable('defect.attachment')
      .set(
        outcome.status === 'uploaded'
          ? { status: 'uploaded', jira_attachment_id: outcome.jiraId, last_error: null, updated_at: new Date() }
          : outcome.status === 'retry'
            ? {
                status: 'pending',
                last_error: outcome.error.slice(0, 500),
                // 2, 4, 8, 16 minutes: rides out a Jira outage without hammering it.
                next_attempt_at: new Date(Date.now() + 2 ** job.attempts * 60_000),
                updated_at: new Date(),
              }
            : { status: outcome.status, last_error: outcome.error.slice(0, 500), updated_at: new Date() },
      )
      .where('id', '=', claimed.id)
      .execute(),
  );
  return outcome;
}

/** Drains due attachments on an interval, one at a time per process. */
export function startAttachmentWorker(
  db: Db,
  storage: ObjectStorage,
  accounts: JiraAccounts,
  log: { error(o: object, m: string): void },
  intervalMs = 5_000,
): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const { rows } = await sql<{ id: string; org_id: string }>`SELECT * FROM defect.claim_attachment()`.execute(db);
        if (!rows[0]) break;
        await processAttachment(db, storage, accounts, rows[0]).catch((err) =>
          log.error({ err, attachmentId: rows[0]!.id }, 'Jira attachment upload failed'),
        );
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick().catch((err) => log.error({ err }, 'Attachment worker pass failed')), intervalMs);
  return () => clearInterval(timer);
}
