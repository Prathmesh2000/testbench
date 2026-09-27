import type { Role } from '@tb/contracts';
import { AppError, withUser, type Db, type JsonCache, type VerifiedToken } from '@tb/platform';
import { sql } from 'kysely';
import type { Grant } from './permissions';

/** Who is calling, resolved once per request and attached as `req.auth`. */
export interface AuthContext {
  userId: string;
  orgId: string;
  email: string;
  name: string;
  grants: Grant[];
}

interface CachedIdentity {
  userId: string;
  memberships: { orgId: string; projectId: string | null; role: Role }[];
}

const IDENTITY_TTL_S = 300;
export const identityCacheKey = (subject: string) => `identity:${subject}`;

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
    const memberships = await withUser(db, userId, (trx) =>
      trx
        .selectFrom('iam.membership')
        .select(['org_id as orgId', 'project_id as projectId', 'role'])
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .execute(),
    );
    identity = { userId, memberships: memberships as CachedIdentity['memberships'] };
    await cache.set(key, identity, IDENTITY_TTL_S);
  }

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
    email: token.email,
    name: token.name,
    grants: identity.memberships
      .filter((m) => m.orgId === orgId)
      .map(({ projectId, role }) => ({ projectId, role })),
  };
}
