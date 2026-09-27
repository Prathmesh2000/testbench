import { ROLES, UpdateMemberBody, type Me, type Member, type Role } from '@tb/contracts';
import { conflict, notFound, recordEvent, type ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { projectTx, tenantTx } from './access';
import { identityCacheKey } from './identity';
import { permissionsFor, visibleProjectIds } from './permissions';

const ProjectParams = z.object({ projectId: z.uuid() });
const MemberParams = ProjectParams.extend({ userId: z.uuid() });

export const iamRoutes: FastifyPluginAsync<ServiceDeps> = async (app, { db, cache }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** The signed-in user, their organisation, and every project they can see with their permissions in it. */
  r.get('/me', async (req): Promise<Me> => {
    return tenantTx(db, req, async (trx) => {
      const org = await trx
        .selectFrom('iam.org')
        .select(['id', 'slug', 'name'])
        .where('id', '=', req.auth.orgId)
        .executeTakeFirstOrThrow();
      const visible = visibleProjectIds(req.auth.grants);
      let query = trx.selectFrom('repo.project').select(['id', 'key', 'name']).orderBy('key');
      if (visible) query = query.where('id', '=', (eb) => eb.fn.any(eb.val(visible)));
      const projects = await query.execute();
      return {
        user: { id: req.auth.userId, name: req.auth.name, email: req.auth.email },
        org,
        projects: projects.map((p) => ({ ...p, permissions: permissionsFor(req.auth.grants, p.id) })),
      };
    });
  });

  r.get(
    '/projects/:projectId/members',
    { schema: { params: ProjectParams } },
    async (req): Promise<Member[]> => {
      return projectTx(db, req, req.params.projectId, 'case.read', async (trx) => {
        const rows = await trx
          .selectFrom('iam.membership as m')
          .innerJoin('iam.app_user as u', 'u.id', 'm.user_id')
          .select(['u.id', 'u.name', 'u.email', 'm.role', 'm.project_id'])
          .where('m.org_id', '=', req.auth.orgId)
          .where((eb) =>
            eb.or([eb('m.project_id', 'is', null), eb('m.project_id', '=', req.params.projectId)]),
          )
          .orderBy('u.name')
          .execute();
        return rows.map((row) => ({
          user: { id: row.id, name: row.name, email: row.email },
          role: row.role as Role,
          scope: row.project_id ? 'project' : 'org',
        }));
      });
    },
  );

  /**
   * Sets a user's role on one project. Org-wide roles are managed in the admin console (M5), so this
   * refuses to shadow one with a project role: that would silently leave the org-wide role in force.
   */
  r.put(
    '/projects/:projectId/members/:userId',
    { schema: { params: MemberParams, body: UpdateMemberBody } },
    async (req, reply) => {
      const { projectId, userId } = req.params;
      if (req.body.role === 'org_admin')
        throw conflict('Org Admin is an organisation-wide role and cannot be set per project.');

      const subject = await projectTx(db, req, projectId, 'member.manage', async (trx) => {
        const user = await trx
          .selectFrom('iam.app_user')
          .select(['id', 'subject'])
          .where('id', '=', userId)
          .executeTakeFirst();
        if (!user) throw notFound('User');
        const orgWide = await trx
          .selectFrom('iam.membership')
          .select('role')
          .where('user_id', '=', userId)
          .where('project_id', 'is', null)
          .executeTakeFirst();
        if (orgWide && ROLES.indexOf(orgWide.role as Role) <= ROLES.indexOf(req.body.role)) {
          throw conflict(
            `This person already holds ${orgWide.role} across the organisation, which includes this project.`,
          );
        }
        await trx
          .insertInto('iam.membership')
          .values({ org_id: req.auth.orgId, user_id: userId, project_id: projectId, role: req.body.role })
          .onConflict((oc) =>
            oc.columns(['org_id', 'user_id', 'project_id']).doUpdateSet({ role: req.body.role }),
          )
          .execute();
        await recordEvent(trx, {
          type: 'user.role_changed',
          orgId: req.auth.orgId,
          projectId,
          actor: req.auth.userId,
          data: { user_id: userId, role: req.body.role },
        });
        return user.subject;
      });
      // After commit: invalidating before it could let a concurrent request re-cache the old role.
      if (subject) await cache.del(identityCacheKey(subject));
      return reply.status(204).send();
    },
  );
};
