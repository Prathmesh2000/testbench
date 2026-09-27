import { SignoffBody } from '@tb/contracts';
import { projectTx } from '@tb/iam';
import { AppError, type ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { builds, compareBuilds, health, overview, readiness, workload } from './reports';

const Project = z.object({ projectId: z.uuid() });
const Build = z.string().trim().min(1).max(60);
// Reports scan many rows; a minute of staleness is fine for dashboards and keeps refreshes cheap.
const TTL_S = 60;

export const analyticsRoutes: FastifyPluginAsync<ServiceDeps> = async (app, { db, cache }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Permission check first (inside projectTx), then the cache, then the query. */
  const cached = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = await cache.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await load();
    await cache.set(key, value, TTL_S);
    return value;
  };

  r.get(
    '/projects/:projectId/reports/overview',
    {
      schema: {
        params: Project,
        querystring: z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }),
      },
    },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        cached(`analytics:${req.params.projectId}:overview:${req.query.days}`, () =>
          overview(trx, req.params.projectId, req.query.days),
        ),
      ),
  );

  r.get(
    '/projects/:projectId/reports/readiness',
    { schema: { params: Project, querystring: z.object({ build: Build.optional() }) } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        cached(`analytics:${req.params.projectId}:readiness:${req.query.build ?? ''}`, () =>
          readiness(trx, req.params.projectId, req.query.build ?? null),
        ),
      ),
  );

  r.post(
    '/projects/:projectId/reports/readiness/signoff',
    { schema: { params: Project, body: SignoffBody } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'run.signoff', async (trx) => {
        // Evaluated fresh, never from the cache: the decision is recorded against what is true now.
        const now = await readiness(trx, req.params.projectId, req.body.build);
        if (req.body.decision === 'go' && !now.ready)
          throw new AppError(
            409,
            'not_ready',
            'Go is not allowed while any criterion is failing or has no data.',
          );
        await trx
          .insertInto('analytics.signoff')
          .values({
            org_id: req.auth.orgId,
            project_id: req.params.projectId,
            build: req.body.build,
            decision: req.body.decision,
            note: req.body.note,
            criteria: JSON.stringify(now.criteria),
            decided_by: req.auth.userId,
          })
          .execute();
      });
      await cache.del(
        `analytics:${req.params.projectId}:readiness:${req.body.build}`,
        `analytics:${req.params.projectId}:readiness:`,
      );
      return reply.status(201).send();
    },
  );

  r.get('/projects/:projectId/reports/health', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
      cached(`analytics:${req.params.projectId}:health`, () => health(trx, req.params.projectId)),
    ),
  );

  r.get(
    '/projects/:projectId/reports/compare',
    {
      schema: { params: Project, querystring: z.object({ base: Build.optional(), head: Build.optional() }) },
    },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', async (trx) => {
        // Default to the two most recent builds, which is almost always the comparison people want.
        const all = await builds(trx, req.params.projectId);
        const head = req.query.head ?? all[0];
        const base = req.query.base ?? all.find((b) => b !== head);
        if (!head || !base)
          return { base: base ?? '', head: head ?? '', builds: all, counts: null, compared: 0, rows: [] };
        return cached(`analytics:${req.params.projectId}:compare:${base}:${head}`, () =>
          compareBuilds(trx, req.params.projectId, base, head),
        );
      }),
  );

  r.get('/projects/:projectId/reports/workload', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
      cached(`analytics:${req.params.projectId}:workload`, () => workload(trx, req.params.projectId)),
    ),
  );
};
