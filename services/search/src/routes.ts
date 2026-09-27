import { SavedFilterBody, SearchBody, SearchKeysBody } from '@tb/contracts';
import { projectTx } from '@tb/iam';
import type { ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { CaseIndex } from './case-index';
import { deleteFilter, listFilters, saveFilter, setSubscription, updateFilter } from './filters';
import { fieldValues, search, searchKeys } from './search';

const Project = z.object({ projectId: z.uuid() });
const FilterParams = Project.extend({ filterId: z.uuid() });
const callerOf = (req: FastifyRequest) => ({ orgId: req.auth.orgId, userId: req.auth.userId });

/** Same limit as synchronous run creation: "Create run from results" cannot ask for more. */
const MAX_KEYS = 5_000;

export const searchRoutes: FastifyPluginAsync<ServiceDeps & { index: CaseIndex }> = async (
  app,
  { db, index },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/projects/:projectId/search', { schema: { params: Project, body: SearchBody } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
      search(trx, index, callerOf(req), req.params.projectId, req.body.tql, {
        cursor: req.body.cursor,
        limit: req.body.limit,
      }),
    ),
  );

  r.post(
    '/projects/:projectId/search/keys',
    { schema: { params: Project, body: SearchKeysBody } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        searchKeys(trx, index, callerOf(req), req.params.projectId, req.body.tql, MAX_KEYS),
      ),
  );

  r.get('/projects/:projectId/search/values', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'case.read', async (trx) => {
      const [values, people] = await Promise.all([
        fieldValues(index, req.params.projectId),
        trx
          .selectFrom('iam.membership as m')
          .innerJoin('iam.app_user as u', 'u.id', 'm.user_id')
          .select('u.name')
          .distinct()
          .where('m.org_id', '=', req.auth.orgId)
          .orderBy('u.name')
          .execute(),
      ]);
      return { ...values, owner: people.map((p) => p.name) };
    }),
  );

  r.get('/projects/:projectId/filters', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
      listFilters(trx, callerOf(req), req.params.projectId),
    ),
  );

  r.post(
    '/projects/:projectId/filters',
    { schema: { params: Project, body: SavedFilterBody } },
    async (req, reply) => {
      const id = await projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        saveFilter(trx, callerOf(req), req.params.projectId, req.body),
      );
      return reply.status(201).send({ id });
    },
  );

  r.put(
    '/projects/:projectId/filters/:filterId',
    { schema: { params: FilterParams, body: SavedFilterBody } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        updateFilter(trx, callerOf(req), req.params.projectId, req.params.filterId, req.body),
      );
      return reply.status(204).send();
    },
  );

  r.delete(
    '/projects/:projectId/filters/:filterId',
    { schema: { params: FilterParams } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        deleteFilter(trx, callerOf(req), req.params.projectId, req.params.filterId),
      );
      return reply.status(204).send();
    },
  );

  r.put(
    '/projects/:projectId/filters/:filterId/subscription',
    {
      schema: { params: FilterParams, body: z.object({ subscribed: z.boolean() }) },
    },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        setSubscription(trx, callerOf(req), req.params.projectId, req.params.filterId, req.body.subscribed),
      );
      return reply.status(204).send();
    },
  );
};
