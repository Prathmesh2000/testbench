import { randomBytes } from 'node:crypto';
import {
  CUSTOM_ROLE_PREFIX,
  InviteBody,
  MemberRoleBody,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  ROLES,
  RoleBody,
  TokenBody,
  type AdminMember,
  type InviteResult,
  type Permission,
  type Role,
  type RoleView,
  type TokenCreated,
  type TokenView,
} from '@tb/contracts';
import {
  AppError,
  conflict,
  notFound,
  recordEvent,
  type JsonCache,
  type ServiceDeps,
  type Tx,
} from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { orgTx, tenantTx } from './access';
import { TOKEN_PREFIX } from './auth-plugin';
import { hashToken, identityCacheKey, tokenCacheKey } from './identity';
import type { KeycloakAdmin } from './keycloak';
import { orgPermissions, roleRefPermissions, ungrantable } from './permissions';

const UserParam = z.object({ userId: z.uuid() });
const RoleParam = z.object({ roleId: z.uuid() });

interface CustomRole {
  id: string;
  name: string;
  based_on: string;
  permissions: string[];
  version: number;
}

async function customRoles(trx: Tx): Promise<CustomRole[]> {
  return trx
    .selectFrom('iam.custom_role')
    .select(['id', 'name', 'based_on', 'permissions', 'version'])
    .orderBy('name')
    .execute();
}

const refOf = (id: string) => `${CUSTOM_ROLE_PREFIX}${id}`;

function labeller(custom: CustomRole[]) {
  const names = new Map(custom.map((c) => [refOf(c.id), c.name]));
  return (ref: string) => ROLE_LABELS[ref as Role] ?? names.get(ref) ?? 'Unknown role';
}

/** Throws unless the caller may hand out `ref`: it must exist and grant nothing the caller lacks. */
function assertGrantable(req: FastifyRequest, ref: string, custom: CustomRole[]): void {
  const perms = roleRefPermissions(
    ref,
    new Map(custom.map((c) => [refOf(c.id), c.permissions as Permission[]])),
  );
  if (!perms) throw notFound('Role');
  const missing = ungrantable(orgPermissions(req.auth.grants), perms);
  if (missing.length)
    throw new AppError(
      403,
      'grant_exceeds_own',
      `You can't grant permissions you don't hold: ${missing.join(', ')}.`,
    );
}

/** The last Org Admin can't be removed or demoted, or nobody could administer the organisation. */
async function assertNotLastAdmin(trx: Tx, userId: string): Promise<void> {
  const admins = await trx
    .selectFrom('iam.membership')
    .select('user_id')
    .where('project_id', 'is', null)
    .where('role', '=', 'org_admin')
    .execute();
  if (admins.length === 1 && admins[0]!.user_id === userId)
    throw conflict('This is the last Org Admin. Make someone else Org Admin first.');
}

/** Cached identities of these people are dropped after the change commits, so new roles apply at once. */
async function subjectsOf(trx: Tx, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return [];
  const rows = await trx.selectFrom('iam.app_user').select('subject').where('id', 'in', userIds).execute();
  return rows.flatMap((r) => (r.subject ? [r.subject] : []));
}
const forget = (cache: JsonCache, subjects: string[]) => cache.del(...subjects.map(identityCacheKey));

function tokenView(t: {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: Date;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}): TokenView {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes as TokenView['scopes'],
    expiresAt: t.expires_at.toISOString(),
    lastUsedAt: t.last_used_at?.toISOString() ?? null,
    createdAt: t.created_at.toISOString(),
    revoked: t.revoked_at !== null,
  };
}

/** Organisation administration (HLD §5.11) and each person's own access tokens. */
export const adminRoutes: FastifyPluginAsync<ServiceDeps & { keycloak: KeycloakAdmin | null }> = async (
  app,
  { db, cache, keycloak },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- members ----------
  r.get('/admin/members', async (req): Promise<AdminMember[]> =>
    orgTx(db, req, 'member.manage', async (trx) => {
      const [rows, custom] = await Promise.all([
        trx
          .selectFrom('iam.membership as m')
          .innerJoin('iam.app_user as u', 'u.id', 'm.user_id')
          .leftJoin('repo.project as p', 'p.id', 'm.project_id')
          .select(['u.id', 'u.name', 'u.email', 'u.subject', 'm.role', 'm.project_id', 'p.key'])
          .orderBy('u.name')
          .execute(),
        customRoles(trx),
      ]);
      const label = labeller(custom);
      const byUser = new Map<string, AdminMember>();
      for (const row of rows) {
        const m = byUser.get(row.id) ?? {
          user: { id: row.id, name: row.name, email: row.email },
          active: row.subject !== null,
          orgRole: null,
          projects: [],
        };
        if (row.project_id === null) m.orgRole = { ref: row.role, label: label(row.role) };
        else
          m.projects.push({
            projectId: row.project_id,
            projectKey: row.key ?? '?',
            ref: row.role,
            label: label(row.role),
          });
        byUser.set(row.id, m);
      }
      return [...byUser.values()];
    }),
  );

  r.post('/admin/invites', { schema: { body: InviteBody } }, async (req, reply) => {
    const userId = await orgTx(db, req, 'member.manage', async (trx) => {
      assertGrantable(req, req.body.role, await customRoles(trx));
      const { rows } = await sql<{
        id: string;
      }>`SELECT iam.invite_user(${req.body.email}, ${req.body.name}) AS id`.execute(trx);
      const id = rows[0]!.id;
      const existing = await trx
        .selectFrom('iam.membership')
        .select('id')
        .where('user_id', '=', id)
        .executeTakeFirst();
      if (existing) throw conflict(`${req.body.email} is already a member.`);
      await trx
        .insertInto('iam.membership')
        .values({ org_id: req.auth.orgId, user_id: id, project_id: null, role: req.body.role })
        .execute();
      await recordEvent(trx, {
        type: 'member.invited',
        orgId: req.auth.orgId,
        projectId: null,
        actor: req.auth.userId,
        data: { user_id: id, email: req.body.email, role: req.body.role },
      });
      return id;
    });
    // After the membership commits: if the identity provider fails, the invite still stands and can be retried there.
    let temporaryPassword: string | null = null;
    if (keycloak) {
      try {
        temporaryPassword = await keycloak.createUser(req.body.email, req.body.name);
      } catch (err) {
        req.log.warn({ err }, 'could not create the Keycloak account for an invite');
      }
    }
    const result: InviteResult = { userId, temporaryPassword };
    return reply.status(201).send(result);
  });

  r.put(
    '/admin/members/:userId',
    { schema: { params: UserParam, body: MemberRoleBody } },
    async (req, reply) => {
      const { userId } = req.params;
      const { role, projectId } = req.body;
      if (role === 'org_admin' && projectId) throw conflict('Org Admin is an organisation-wide role.');
      const subjects = await orgTx(db, req, 'member.manage', async (trx) => {
        assertGrantable(req, role, await customRoles(trx));
        const current = await trx
          .selectFrom('iam.membership')
          .select('role')
          .where('user_id', '=', userId)
          .where('project_id', projectId ? '=' : 'is', projectId)
          .executeTakeFirst();
        // Changing someone who outranks you would be a way round the guardrail, so the old role counts too.
        if (current) assertGrantable(req, current.role, await customRoles(trx));
        if (current?.role === 'org_admin' && role !== 'org_admin') await assertNotLastAdmin(trx, userId);
        await trx
          .insertInto('iam.membership')
          .values({ org_id: req.auth.orgId, user_id: userId, project_id: projectId, role })
          .onConflict((oc) => oc.columns(['org_id', 'user_id', 'project_id']).doUpdateSet({ role }))
          .execute();
        await recordEvent(trx, {
          type: 'user.role_changed',
          orgId: req.auth.orgId,
          projectId,
          actor: req.auth.userId,
          data: { user_id: userId, role, from: current?.role ?? null },
        });
        return subjectsOf(trx, [userId]);
      });
      await forget(cache, subjects);
      return reply.status(204).send();
    },
  );

  r.delete(
    '/admin/members/:userId',
    { schema: { params: UserParam, querystring: z.object({ projectId: z.uuid().optional() }) } },
    async (req, reply) => {
      const { userId } = req.params;
      const subjects = await orgTx(db, req, 'member.manage', async (trx) => {
        let q = trx.selectFrom('iam.membership').select(['role', 'project_id']).where('user_id', '=', userId);
        if (req.query.projectId) q = q.where('project_id', '=', req.query.projectId);
        const rows = await q.execute();
        if (!rows.length) throw notFound('Membership');
        const custom = await customRoles(trx);
        for (const m of rows) assertGrantable(req, m.role, custom);
        if (rows.some((m) => m.role === 'org_admin' && m.project_id === null))
          await assertNotLastAdmin(trx, userId);
        let del = trx.deleteFrom('iam.membership').where('user_id', '=', userId);
        if (req.query.projectId) del = del.where('project_id', '=', req.query.projectId);
        await del.execute();
        await recordEvent(trx, {
          type: 'member.removed',
          orgId: req.auth.orgId,
          projectId: req.query.projectId ?? null,
          actor: req.auth.userId,
          data: { user_id: userId },
        });
        return subjectsOf(trx, [userId]);
      });
      await forget(cache, subjects);
      return reply.status(204).send();
    },
  );

  // ---------- roles ----------
  // Readable with member.manage too, because inviting and changing members needs the role list.
  r.get('/admin/roles', async (req): Promise<RoleView[]> => {
    const perms = orgPermissions(req.auth.grants);
    if (!perms.includes('role.manage') && !perms.includes('member.manage'))
      throw new AppError(403, 'forbidden', 'You do not have permission to do this');
    return tenantTx(db, req, async (trx) => {
      const [custom, counts] = await Promise.all([
        customRoles(trx),
        trx
          .selectFrom('iam.membership')
          .select(['role', (eb) => eb.fn.count<number>('user_id').distinct().as('n')])
          .groupBy('role')
          .execute(),
      ]);
      const holders = (ref: string) => counts.find((c) => c.role === ref)?.n ?? 0;
      return [
        ...[...ROLES].map((role) => ({
          ref: role,
          name: ROLE_LABELS[role],
          builtIn: true,
          basedOn: null,
          permissions: [...ROLE_PERMISSIONS[role]],
          version: 1,
          holders: holders(role),
        })),
        ...custom.map((c) => ({
          ref: refOf(c.id),
          name: c.name,
          builtIn: false,
          basedOn: c.based_on,
          permissions: c.permissions as Permission[],
          version: c.version,
          holders: holders(refOf(c.id)),
        })),
      ];
    });
  });

  r.post('/admin/roles', { schema: { body: RoleBody } }, async (req, reply) => {
    const missing = ungrantable(orgPermissions(req.auth.grants), req.body.permissions);
    if (missing.length)
      throw new AppError(
        403,
        'grant_exceeds_own',
        `You can't grant permissions you don't hold: ${missing.join(', ')}.`,
      );
    const role = await orgTx(db, req, 'role.manage', async (trx) => {
      if (ROLES.some((r) => ROLE_LABELS[r].toLowerCase() === req.body.name.toLowerCase()))
        throw conflict('That name belongs to a built-in role.');
      const created = await trx
        .insertInto('iam.custom_role')
        .values({
          org_id: req.auth.orgId,
          name: req.body.name,
          based_on: req.body.basedOn,
          permissions: req.body.permissions,
          updated_by: req.auth.userId,
        })
        .onConflict((oc) => oc.columns(['org_id', 'name']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!created) throw conflict(`A role called ${req.body.name} already exists.`);
      await recordEvent(trx, {
        type: 'role.saved',
        orgId: req.auth.orgId,
        projectId: null,
        actor: req.auth.userId,
        data: { role_id: created.id, name: req.body.name, version: 1, permissions: req.body.permissions },
      });
      return created;
    });
    return reply.status(201).send({ ref: refOf(role.id) });
  });

  r.put('/admin/roles/:roleId', { schema: { params: RoleParam, body: RoleBody } }, async (req, reply) => {
    const missing = ungrantable(orgPermissions(req.auth.grants), req.body.permissions);
    if (missing.length)
      throw new AppError(
        403,
        'grant_exceeds_own',
        `You can't grant permissions you don't hold: ${missing.join(', ')}.`,
      );
    const subjects = await orgTx(db, req, 'role.manage', async (trx) => {
      const before = await trx
        .selectFrom('iam.custom_role')
        .select(['version', 'permissions'])
        .where('id', '=', req.params.roleId)
        .executeTakeFirst();
      if (!before) throw notFound('Role');
      await trx
        .updateTable('iam.custom_role')
        .set({
          name: req.body.name,
          permissions: req.body.permissions,
          version: before.version + 1,
          updated_by: req.auth.userId,
          updated_at: new Date(),
        })
        .where('id', '=', req.params.roleId)
        .execute();
      const added = req.body.permissions.filter((p) => !before.permissions.includes(p));
      const removed = before.permissions.filter((p) => !(req.body.permissions as string[]).includes(p));
      await recordEvent(trx, {
        type: 'role.saved',
        orgId: req.auth.orgId,
        projectId: null,
        actor: req.auth.userId,
        data: {
          role_id: req.params.roleId,
          name: req.body.name,
          version: before.version + 1,
          added,
          removed,
        },
      });
      const holders = await trx
        .selectFrom('iam.membership')
        .select('user_id')
        .where('role', '=', refOf(req.params.roleId))
        .execute();
      return subjectsOf(
        trx,
        holders.map((h) => h.user_id),
      );
    });
    await forget(cache, subjects);
    return reply.status(204).send();
  });

  r.delete('/admin/roles/:roleId', { schema: { params: RoleParam } }, async (req, reply) => {
    await orgTx(db, req, 'role.manage', async (trx) => {
      const held = await trx
        .selectFrom('iam.membership')
        .select('id')
        .where('role', '=', refOf(req.params.roleId))
        .executeTakeFirst();
      if (held) throw conflict('People still hold this role. Give them another role first.');
      const gone = await trx
        .deleteFrom('iam.custom_role')
        .where('id', '=', req.params.roleId)
        .returning('name')
        .executeTakeFirst();
      if (!gone) throw notFound('Role');
      await recordEvent(trx, {
        type: 'role.deleted',
        orgId: req.auth.orgId,
        projectId: null,
        actor: req.auth.userId,
        data: { role_id: req.params.roleId, name: gone.name },
      });
    });
    return reply.status(204).send();
  });

  // ---------- personal access tokens ----------
  r.get('/me/tokens', async (req): Promise<TokenView[]> =>
    tenantTx(db, req, async (trx) =>
      (
        await trx
          .selectFrom('iam.token')
          .selectAll()
          .where('user_id', '=', req.auth.userId)
          .orderBy('created_at', 'desc')
          .execute()
      ).map(tokenView),
    ),
  );

  r.post('/me/tokens', { schema: { body: TokenBody } }, async (req, reply) => {
    // A token can't outlive or outrank the session that makes it; tokens don't mint tokens.
    if (req.auth.scopes)
      throw new AppError(403, 'forbidden', 'Access tokens are created from a signed-in session.');
    const raw = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const created = await tenantTx(db, req, async (trx) => {
      const row = await trx
        .insertInto('iam.token')
        .values({
          org_id: req.auth.orgId,
          user_id: req.auth.userId,
          name: req.body.name,
          token_hash: hashToken(raw),
          prefix: raw.slice(0, TOKEN_PREFIX.length + 6),
          scopes: [...new Set(req.body.scopes)],
          expires_at: new Date(Date.now() + req.body.days * 86_400_000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordEvent(trx, {
        type: 'token.created',
        orgId: req.auth.orgId,
        projectId: null,
        actor: req.auth.userId,
        data: { token_id: row.id, name: row.name, scopes: row.scopes, days: req.body.days },
      });
      return row;
    });
    const body: TokenCreated = { ...tokenView(created), token: raw };
    return reply.status(201).send(body);
  });

  r.delete(
    '/me/tokens/:tokenId',
    { schema: { params: z.object({ tokenId: z.uuid() }) } },
    async (req, reply) => {
      const hash = await tenantTx(db, req, async (trx) => {
        const row = await trx
          .updateTable('iam.token')
          .set({ revoked_at: new Date() })
          .where('id', '=', req.params.tokenId)
          .where('user_id', '=', req.auth.userId)
          .where('revoked_at', 'is', null)
          .returning(['token_hash', 'name'])
          .executeTakeFirst();
        if (!row) throw notFound('Token');
        await recordEvent(trx, {
          type: 'token.revoked',
          orgId: req.auth.orgId,
          projectId: null,
          actor: req.auth.userId,
          data: { token_id: req.params.tokenId, name: row.name },
        });
        return row.token_hash;
      });
      await cache.del(tokenCacheKey(hash));
      return reply.status(204).send();
    },
  );
};
