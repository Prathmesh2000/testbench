import {
  BulkEditBody,
  CaseFilter,
  CaseGroupQuery,
  CaseListQuery,
  CreateCaseBody,
  ProjectBody,
  ProjectPatch,
  SetDependenciesBody,
  UpdateCaseBody,
  parseCaseKey,
} from '@tb/contracts';
import { orgTx, projectTx, tenantTx, visibleProjectIds } from '@tb/iam';
import { badRequest, notFound, type ServiceDeps } from '@tb/platform';
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
import { createModule, createProject, projectOverview, renameModule } from './projects';
import { diffSteps } from './step-diff';

const Project = z.object({ projectId: z.uuid() });
const CaseParams = Project.extend({ key: z.string().regex(/^TC-\d+$/i, 'Use a case key such as TC-10231') });
const VersionParams = CaseParams.extend({ version: z.coerce.number().int().min(1) });

const keyOf = (key: string) => parseCaseKey(key)!;
const actorOf = (req: FastifyRequest) => ({ orgId: req.auth.orgId, userId: req.auth.userId });

/** Copying a module tree reads the source project, so the caller must be able to see it. */
function requirePermissionOn(req: FastifyRequest, projectId: string): void {
  const visible = visibleProjectIds(req.auth.grants);
  if (visible && !visible.includes(projectId)) throw notFound('Project');
}

export const repositoryRoutes: FastifyPluginAsync<ServiceDeps> = async (app, { db }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- projects ----------
  r.get('/projects/overview', async (req) =>
    tenantTx(db, req, (trx) => projectOverview(trx, visibleProjectIds(req.auth.grants))),
  );

  // Creating a project is an organisation-level act: it needs project.manage from an org-wide role.
  r.post('/projects', { schema: { body: ProjectBody } }, async (req, reply) => {
    const { copyModulesFrom } = req.body;
    if (copyModulesFrom) requirePermissionOn(req, copyModulesFrom);
    const created = await orgTx(db, req, 'project.manage', (trx) =>
      createProject(trx, actorOf(req), req.body),
    );
    return reply.status(201).send(created);
  });

  r.patch('/projects/:projectId', { schema: { params: Project, body: ProjectPatch } }, async (req, reply) => {
    await projectTx(db, req, req.params.projectId, 'project.manage', async (trx) => {
      const b = req.body;
      if (Object.keys(b).length === 0) return;
      await trx
        .updateTable('repo.project')
        .set({
          ...(b.name !== undefined && { name: b.name }),
          ...(b.group !== undefined && { group_name: b.group }),
          ...(b.description !== undefined && { description: b.description }),
          ...(b.archived !== undefined && { archived: b.archived }),
        })
        .where('id', '=', req.params.projectId)
        .execute();
    });
    return reply.status(204).send();
  });

  r.post(
    '/projects/:projectId/modules',
    {
      schema: {
        params: Project,
        body: z.object({
          name: z.string().trim().min(1).max(120),
          parentId: z.uuid().nullable().default(null),
        }),
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
            createModule(trx, actorOf(req), req.params.projectId, req.body.name, req.body.parentId),
          ),
        ),
  );

  // ponytail: a rename is not pushed to the search index; cases pick up the new path when next edited or
  // on `pnpm search:reindex`. Reindex the subtree from an outbox event if renames become common.
  r.patch(
    '/projects/:projectId/modules/:moduleId',
    {
      schema: {
        params: Project.extend({ moduleId: z.uuid() }),
        body: z.object({ name: z.string().trim().min(1).max(120) }),
      },
    },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        renameModule(trx, req.params.projectId, req.params.moduleId, req.body.name),
      );
      return reply.status(204).send();
    },
  );

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
