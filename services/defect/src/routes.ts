import {
  ConnectJiraBody,
  DefectListQuery,
  JiraMappingBody,
  LinkBugBody,
  LinkIssueBody,
  LogBugBody,
  parseCaseKey,
  RetestBody,
} from '@tb/contracts';
import { orgTx, projectTx, tenantTx } from '@tb/iam';
import { notFound, type ServiceDeps, type Tx } from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getMapping, jiraProjects, projectTarget, setMapping, type JiraAccounts } from './accounts';
import {
  caseIssues,
  getDefect,
  jiraStatuses,
  linkIssueToCase,
  unlinkIssueFromCase,
  linkBug,
  listDefects,
  logBug,
  reconcileProject,
  recordRetest,
  similarDefects,
  syncStatus,
} from './defects';

const Project = z.object({ projectId: z.uuid() });
const CaseParams = Project.extend({ key: z.string().regex(/^TC-\d+$/i) });
// Workflows change rarely; ten minutes keeps the status list fresh without a Jira call per page view.
const STATUS_TTL_S = 600;

async function caseIdOf(trx: Tx, projectId: string, key: string): Promise<string> {
  const c = await trx
    .selectFrom('repo.test_case')
    .select('id')
    .where('project_id', '=', projectId)
    .where('key_no', '=', parseCaseKey(key)!)
    .executeTakeFirst();
  if (!c) throw notFound('Case');
  return c.id;
}
const callerOf = (req: FastifyRequest) => ({
  orgId: req.auth.orgId,
  userId: req.auth.userId,
  name: req.auth.name,
});

interface DefectDeps extends ServiceDeps {
  accounts: JiraAccounts;
  webUrl: string;
}

export const defectRoutes: FastifyPluginAsync<DefectDeps> = async (app, { db, cache, accounts, webUrl }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  /** The caller's own Jira account, checked against the site this project files bugs on. */
  const mine = async (trx: Tx, req: FastifyRequest, projectId: string) =>
    accounts.forUser(trx, req.auth.userId, (await projectTarget(trx, projectId)).siteUrl);

  // ---------- the caller's Jira connection ----------
  r.get('/me/jira', async (req) => tenantTx(db, req, (trx) => accounts.mine(trx, req.auth.userId)));
  r.put('/me/jira', { schema: { body: ConnectJiraBody } }, async (req) =>
    tenantTx(db, req, (trx) => accounts.connect(trx, callerOf(req), req.body)),
  );
  r.delete('/me/jira', async (req, reply) => {
    await tenantTx(db, req, (trx) => accounts.disconnect(trx, req.auth.userId));
    return reply.status(204).send();
  });
  r.get('/me/jira/projects', async (req) =>
    tenantTx(db, req, (trx) => jiraProjects(trx, accounts, req.auth.userId)),
  );
  r.get('/admin/jira/connections', async (req) => orgTx(db, req, 'member.manage', (trx) => accounts.list(trx)));

  // ---------- project mapping ----------
  r.get('/projects/:projectId/jira/mapping', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => getMapping(trx, req.params.projectId)),
  );
  r.put(
    '/projects/:projectId/jira/mapping',
    { schema: { params: Project, body: JiraMappingBody } },
    async (req) => {
      const mapping = await projectTx(db, req, req.params.projectId, 'project.manage', (trx) =>
        setMapping(trx, accounts, callerOf(req), req.params.projectId, req.body),
      );
      await cache.del(`jira-statuses:${req.params.projectId}`);
      return mapping;
    },
  );

  // Viewing defects needs no Jira account: it reads our synced copies.
  r.get(
    '/projects/:projectId/defects',
    { schema: { params: Project, querystring: DefectListQuery } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        listDefects(trx, callerOf(req), req.params.projectId, req.query),
      ),
  );

  // ---------- Jira issues on a case ----------
  r.get('/projects/:projectId/cases/:key/jira', { schema: { params: CaseParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'case.read', async (trx) =>
      caseIssues(trx, req.params.projectId, await caseIdOf(trx, req.params.projectId, req.params.key)),
    ),
  );
  r.post(
    '/projects/:projectId/cases/:key/jira',
    { schema: { params: CaseParams, body: LinkIssueBody } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.write', async (trx) =>
        linkIssueToCase(
          trx,
          await mine(trx, req, req.params.projectId),
          callerOf(req),
          req.params.projectId,
          await caseIdOf(trx, req.params.projectId, req.params.key),
          req.body.jiraKey,
        ),
      );
      return reply.status(201).send();
    },
  );
  r.delete(
    '/projects/:projectId/cases/:key/jira/:defectId',
    { schema: { params: CaseParams.extend({ defectId: z.uuid() }) } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.write', async (trx) =>
        unlinkIssueFromCase(
          trx,
          req.params.projectId,
          await caseIdOf(trx, req.params.projectId, req.params.key),
          req.params.defectId,
        ),
      );
      return reply.status(204).send();
    },
  );
  r.get('/projects/:projectId/jira/statuses', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', async (trx) => {
      const key = `jira-statuses:${req.params.projectId}`;
      const hit = await cache.get<Awaited<ReturnType<typeof jiraStatuses>>>(key);
      if (hit) return hit;
      const site = (await projectTarget(trx, req.params.projectId)).siteUrl;
      const statuses = await jiraStatuses(trx, await accounts.readerFor(trx, req.auth.userId, site), req.params.projectId);
      await cache.set(key, statuses, STATUS_TTL_S);
      return statuses;
    }),
  );

  r.get('/projects/:projectId/defects/sync', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => syncStatus(trx, req.params.projectId)),
  );

  r.post('/projects/:projectId/defects/sync', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', async (trx) => ({
      changed: await reconcileProject(trx, accounts, req.auth.orgId, req.params.projectId),
    })),
  );

  r.get(
    '/projects/:projectId/defects/similar',
    {
      schema: { params: Project, querystring: z.object({ summary: z.string().trim().min(3).max(250) }) },
    },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', async (trx) =>
        similarDefects(
          trx,
          await accounts.tryForUser(trx, req.auth.userId, (await projectTarget(trx, req.params.projectId)).siteUrl),
          req.params.projectId,
          req.query.summary,
        ),
      ),
  );

  r.post(
    '/projects/:projectId/defects',
    { schema: { params: Project, body: LogBugBody } },
    async (req, reply) => {
      const defect = await projectTx(db, req, req.params.projectId, 'run.execute', async (trx) =>
        logBug(trx, await mine(trx, req, req.params.projectId), callerOf(req), req.params.projectId, webUrl, req.body),
      );
      return reply.status(201).send(defect);
    },
  );

  r.post(
    '/projects/:projectId/defects/link',
    { schema: { params: Project, body: LinkBugBody } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.execute', async (trx) =>
        linkBug(trx, await mine(trx, req, req.params.projectId), callerOf(req), req.params.projectId, webUrl, req.body),
      ),
  );

  r.get(
    '/projects/:projectId/defects/:defectId',
    { schema: { params: Project.extend({ defectId: z.uuid() }) } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        getDefect(trx, req.params.projectId, req.params.defectId),
      ),
  );

  r.post(
    '/projects/:projectId/retests/:retestId',
    { schema: { params: Project.extend({ retestId: z.uuid() }), body: RetestBody } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'run.execute', async (trx) =>
        recordRetest(
          trx,
          await mine(trx, req, req.params.projectId),
          callerOf(req),
          req.params.projectId,
          req.params.retestId,
          req.body,
        ),
      );
      return reply.status(204).send();
    },
  );
};
