import { CreateRunBody, EvidenceUploadBody, RecordResultBody } from '@tb/contracts';
import { projectTx } from '@tb/iam';
import type { ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createEvidenceUpload,
  createRun,
  getItem,
  getRun,
  homeSummary,
  listItems,
  listRuns,
  recordResult,
} from './runs';

const Project = z.object({ projectId: z.uuid() });
const RunParams = Project.extend({ runId: z.uuid() });
const ItemParams = RunParams.extend({ itemId: z.uuid() });
const actorOf = (req: FastifyRequest) => ({ orgId: req.auth.orgId, userId: req.auth.userId });

export const executionRoutes: FastifyPluginAsync<ServiceDeps> = async (app, { db, storage }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/projects/:projectId/home', { schema: { params: Project } }, async (req) => {
    return projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
      homeSummary(trx, req.auth.userId, req.params.projectId),
    );
  });

  r.get(
    '/projects/:projectId/runs',
    {
      schema: {
        params: Project,
        querystring: z.object({ status: z.enum(['preparing', 'active', 'completed']).optional() }),
      },
    },
    async (req) => {
      return projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        listRuns(trx, req.params.projectId, req.query.status),
      );
    },
  );

  r.post(
    '/projects/:projectId/runs',
    { schema: { params: Project, body: CreateRunBody } },
    async (req, reply) => {
      const run = await projectTx(db, req, req.params.projectId, 'run.create', (trx) =>
        createRun(trx, actorOf(req), req.params.projectId, req.body),
      );
      return reply.status(201).send(run);
    },
  );

  r.get('/projects/:projectId/runs/:runId', { schema: { params: RunParams } }, async (req) => {
    return projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
      getRun(trx, req.params.projectId, req.params.runId),
    );
  });

  r.get('/projects/:projectId/runs/:runId/items', { schema: { params: RunParams } }, async (req) => {
    return projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
      listItems(trx, req.params.projectId, req.params.runId),
    );
  });

  r.get('/projects/:projectId/runs/:runId/items/:itemId', { schema: { params: ItemParams } }, async (req) => {
    const { projectId, runId, itemId } = req.params;
    return projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
      getItem(trx, storage, projectId, runId, itemId),
    );
  });

  r.post(
    '/projects/:projectId/runs/:runId/items/:itemId/results',
    { schema: { params: ItemParams, body: RecordResultBody } },
    async (req) => {
      const { projectId, runId, itemId } = req.params;
      return projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
        recordResult(trx, storage, actorOf(req), projectId, runId, itemId, req.body),
      );
    },
  );

  r.post(
    '/projects/:projectId/runs/:runId/items/:itemId/evidence',
    { schema: { params: ItemParams, body: EvidenceUploadBody } },
    async (req, reply) => {
      const { projectId, runId, itemId } = req.params;
      const upload = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
        createEvidenceUpload(trx, storage, actorOf(req), projectId, runId, itemId, req.body),
      );
      return reply.status(201).send(upload);
    },
  );
};
