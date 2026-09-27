import { createHash } from 'node:crypto';
import { CUSTOM_ROLE_PREFIX, type Permission } from '@tb/contracts';
import { AppError, withTenant, withUser, type Db, type JsonCache, type VerifiedToken } from '@tb/platform';
import { sql } from 'kysely';
import type { Grant } from './permissions';

/** Where a request comes from, recorded with every change it makes (the audit log's "source"). */
export type RequestSource = 'web' | 'api' | 'mcp' | 'slack';

/** Who is calling, resolved once per request and attached as `req.auth`. */
export interface AuthContext {
  userId: string;
  orgId: string;
  email: string;
  name: string;
  grants: Grant[];
  source: RequestSource;
  /** Scopes of the personal access token used, or null for a signed-in session (no limits beyond roles). */
  scopes: ('read' | 'write')[] | null;
}

interface Membership {
  orgId: string;
  projectId: string | null;
  role: string;
  permissions?: Permission[];
}

interface CachedIdentity {
  userId: string;
  memberships: Membership[];
}

const IDENTITY_TTL_S = 300;
export const identityCacheKey = (subject: string) => `identity:${subject}`;
export const tokenCacheKey = (hash: string) => `pat:${hash}`;
// Short, because a revoked token must stop working quickly; revoking also deletes the entry.
const TOKEN_TTL_S = 60;

export const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** A user's memberships in every organisation, with custom roles resolved to their permissions. */
async function loadMemberships(db: Db, userId: string): Promise<Membership[]> {
  const rows = (await withUser(db, userId, (trx) =>
    trx
      .selectFrom('iam.membership')
      .select(['org_id as orgId', 'project_id as projectId', 'role'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
  )) as Membership[];
  const customOrgs = [
    ...new Set(rows.filter((m) => m.role.startsWith(CUSTOM_ROLE_PREFIX)).map((m) => m.orgId)),
  ];
  for (const orgId of customOrgs) {
    // Custom roles live under their organisation's RLS, so each is read in that tenant's context.
    const roles = await withTenant(db, { orgId, userId }, (trx) =>
      trx.selectFrom('iam.custom_role').select(['id', 'permissions']).execute(),
    );
    const byRef = new Map(roles.map((r) => [`${CUSTOM_ROLE_PREFIX}${r.id}`, r.permissions as Permission[]]));
    for (const m of rows)
      if (m.orgId === orgId && m.role.startsWith(CUSTOM_ROLE_PREFIX)) m.permissions = byRef.get(m.role) ?? [];
  }
  return rows;
}

/**
 * Maps a verified token to a user and the organisation they are acting in.
 *
 * The result is cached per token subject because it is needed on every request and changes rarely;
 * role changes delete the entry (see routes.ts), and the TTL bounds staleness if that delete is lost.
 * `requestedOrgId` comes from the X-Org-Id header for people in several organisations; without it
 * the first organisation they joined is used.
 */
export async function resolveIdentity(
  db: Db,
  cache: JsonCache,
  token: VerifiedToken,
  requestedOrgId?: string,
): Promise<AuthContext> {
  const key = identityCacheKey(token.subject);
  let identity = await cache.get<CachedIdentity>(key);
  if (!identity) {
    const { rows } = await sql<{
      id: string | null;
    }>`SELECT iam.resolve_user(${token.subject}, ${token.email}, ${token.name}) AS id`.execute(db);
    const userId = rows[0]?.id;
    if (!userId) {
      throw new AppError(
        403,
        'identity_conflict',
        'This email is linked to a different sign-in account. Ask an admin to reconnect it.',
      );
    }
    identity = { userId, memberships: await loadMemberships(db, userId) };
    await cache.set(key, identity, IDENTITY_TTL_S);
  }
  return contextFor(identity, token, requestedOrgId, 'web', null);
}

/**
 * Maps a personal access token (tbp_…) to its user. A token belongs to one organisation, so the
 * X-Org-Id header plays no part. `client` is what the caller says it is (the agent gateway sends
 * "mcp" or "slack"); it only labels the audit log and grants nothing.
 */
export async function resolveTokenIdentity(
  db: Db,
  cache: JsonCache,
  raw: string,
  client: string | undefined,
): Promise<AuthContext> {
  const hash = hashToken(raw);
  type Cached = CachedIdentity & { orgId: string; email: string; name: string; scopes: ('read' | 'write')[] };
  let hit = await cache.get<Cached>(tokenCacheKey(hash));
  if (!hit) {
    const { rows } = await sql<{
      user_id: string;
      org_id: string;
      scopes: ('read' | 'write')[];
      email: string;
      name: string;
    }>`
      SELECT user_id, org_id, scopes, email, name FROM iam.resolve_token(${hash})`.execute(db);
    const row = rows[0];
    if (!row) throw new AppError(401, 'invalid_token', 'This access token is invalid, expired or revoked.');
    hit = {
      userId: row.user_id,
      orgId: row.org_id,
      email: row.email,
      name: row.name,
      scopes: row.scopes,
      memberships: (await loadMemberships(db, row.user_id)).filter((m) => m.orgId === row.org_id),
    };
    await cache.set(tokenCacheKey(hash), hit, TOKEN_TTL_S);
  }
  const source: RequestSource = client === 'mcp' || client === 'slack' ? client : 'api';
  return contextFor(hit, { email: hit.email, name: hit.name }, hit.orgId, source, hit.scopes);
}

function contextFor(
  identity: CachedIdentity,
  person: { email: string; name: string },
  requestedOrgId: string | undefined,
  source: RequestSource,
  scopes: ('read' | 'write')[] | null,
): AuthContext {
  if (identity.memberships.length === 0) {
    throw new AppError(
      403,
      'no_organisation',
      'Your account is not part of any organisation yet. Ask an admin to invite you.',
    );
  }
  const orgId =
    requestedOrgId && identity.memberships.some((m) => m.orgId === requestedOrgId)
      ? requestedOrgId
      : identity.memberships[0]!.orgId;

  return {
    userId: identity.userId,
    orgId,
    email: person.email,
    name: person.name,
    grants: identity.memberships
      .filter((m) => m.orgId === orgId)
      .map(({ projectId, role, permissions }) => ({ projectId, role, permissions })),
    source,
    scopes,
  };
}
