import {
  BulkEditBody,
  CaseFilter,
  CaseGroupQuery,
  CaseListQuery,
  CreateCaseBody,
  SetDependenciesBody,
  UpdateCaseBody,
  parseCaseKey,
} from '@tb/contracts';
import { projectTx } from '@tb/iam';
import { badRequest, type ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createBulkJob, getBulkJob } from './bulk';
import {
  countCases,
  createCase,
  getCase,
  getVersion,
  groupCases,
  listCases,
  listVersions,
  setDependencies,
  updateCase,
} from './cases';
import { loadModules, toTree } from './modules';
import { diffSteps } from './step-diff';

const Project = z.object({ projectId: z.uuid() });
const CaseParams = Project.extend({ key: z.string().regex(/^TC-\d+$/i, 'Use a case key such as TC-10231') });
const VersionParams = CaseParams.extend({ version: z.coerce.number().int().min(1) });

const keyOf = (key: string) => parseCaseKey(key)!;
const actorOf = (req: FastifyRequest) => ({ orgId: req.auth.orgId, userId: req.auth.userId });

export const repositoryRoutes: FastifyPluginAsync<ServiceDeps> = async (app, { db }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/projects/:projectId/modules', { schema: { params: Project } }, async (req) => {
    return projectTx(db, req, req.params.projectId, 'case.read', async (trx) =>
      toTree(await loadModules(trx, req.params.projectId)),
    );
  });

  r.get(
    '/projects/:projectId/cases',
    { schema: { params: Project, querystring: CaseListQuery } },
    async (req) => {
      return projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        listCases(trx, req.params.projectId, req.query),
      );
    },
  );

  r.post(
    '/projects/:projectId/cases/count',
    { schema: { params: Project, body: CaseFilter } },
    async (req) => {
      return projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        countCases(trx, req.params.projectId, req.body),
      );
    },
  );

  r.get(
    '/projects/:projectId/cases/groups',
    { schema: { params: Project, querystring: CaseGroupQuery } },
    async (req) => {
      return projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        groupCases(trx, req.params.projectId, req.query),
      );
    },
  );

  r.get('/projects/:projectId/cases/:key', { schema: { params: CaseParams } }, async (req) => {
    return projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
      getCase(trx, req.params.projectId, keyOf(req.params.key)),
    );
  });

  r.post(
    '/projects/:projectId/cases',
    { schema: { params: Project, body: CreateCaseBody } },
    async (req, reply) => {
      const created = await projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        createCase(trx, actorOf(req), req.params.projectId, req.body),
      );
      return reply.status(201).send(created);
    },
  );

  r.patch(
    '/projects/:projectId/cases/:key',
    { schema: { params: CaseParams, body: UpdateCaseBody } },
    async (req) => {
      return projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        updateCase(trx, actorOf(req), req.params.projectId, keyOf(req.params.key), req.body),
      );
    },
  );

  r.get('/projects/:projectId/cases/:key/versions', { schema: { params: CaseParams } }, async (req) => {
    return projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
      listVersions(trx, req.params.projectId, keyOf(req.params.key)),
    );
  });

  /** A version plus its step diff against the version before it (or `?against=`). */
  r.get(
    '/projects/:projectId/cases/:key/versions/:version',
    {
      schema: {
        params: VersionParams,
        querystring: z.object({ against: z.coerce.number().int().min(1).optional() }),
      },
    },
    async (req) => {
      const { projectId, key, version } = req.params;
      return projectTx(db, req, req.params.projectId, 'case.read', async (trx) => {
        const current = await getVersion(trx, projectId, keyOf(key), version);
        const againstNo = req.query.against ?? version - 1;
        if (againstNo < 1) return { version: current, against: null, diff: diffSteps([], current.steps) };
        if (againstNo === version) throw badRequest('Pick a different version to compare against.');
        const against = await getVersion(trx, projectId, keyOf(key), againstNo);
        return { version: current, against, diff: diffSteps(against.steps, current.steps) };
      });
    },
  );

  r.put(
    '/projects/:projectId/cases/:key/dependencies',
    { schema: { params: CaseParams, body: SetDependenciesBody } },
    async (req) => {
      const keys = req.body.dependsOn.map(keyOf);
      return projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        setDependencies(trx, actorOf(req), req.params.projectId, keyOf(req.params.key), keys),
      );
    },
  );

  r.post(
    '/projects/:projectId/cases/bulk',
    { schema: { params: Project, body: BulkEditBody } },
    async (req, reply) => {
      const job = await projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        createBulkJob(trx, actorOf(req), req.params.projectId, req.body.filter, req.body.patch),
      );
      return reply.status(202).send(job);
    },
  );

  r.get(
    '/projects/:projectId/jobs/:jobId',
    { schema: { params: Project.extend({ jobId: z.uuid() }) } },
    async (req) => {
      return projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        getBulkJob(trx, req.params.projectId, req.params.jobId),
      );
    },
  );
};
