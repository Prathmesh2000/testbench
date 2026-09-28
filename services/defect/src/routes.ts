import {
  DefectListQuery,
  LinkBugBody,
  LinkIssueBody,
  LogBugBody,
  parseCaseKey,
  RetestBody,
} from '@tb/contracts';
import { projectTx } from '@tb/iam';
import { AppError, notFound, type ServiceDeps, type Tx } from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  caseIssues,
  getDefect,
  jiraStatuses,
  linkIssueToCase,
  unlinkIssueFromCase,
  handleWebhookIssue,
  linkBug,
  listDefects,
  logBug,
  reconcileProject,
  recordRetest,
  similarDefects,
  syncStatus,
} from './defects';
import type { JiraClient, JiraIssue } from './jira';
import { verifySignature } from './webhook';

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
  /** Null when no Jira site is configured: every defect route then answers 503 with a clear message. */
  jira: JiraClient | null;
  webUrl: string;
}

export const defectRoutes: FastifyPluginAsync<DefectDeps> = async (app, { db, cache, jira, webUrl }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const connected = (): JiraClient => {
    if (!jira)
      throw new AppError(
        503,
        'jira_not_connected',
        'Jira is not connected. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.',
      );
    return jira;
  };

  r.get(
    '/projects/:projectId/defects',
    { schema: { params: Project, querystring: DefectListQuery } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        listDefects(trx, connected(), callerOf(req), req.params.projectId, req.query),
      ),
  );

  // ---------- Jira issues on a case ----------
  r.get('/projects/:projectId/cases/:key/jira', { schema: { params: CaseParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'case.read', async (trx) =>
      caseIssues(
        trx,
        connected(),
        req.params.projectId,
        await caseIdOf(trx, req.params.projectId, req.params.key),
      ),
    ),
  );
  r.post(
    '/projects/:projectId/cases/:key/jira',
    { schema: { params: CaseParams, body: LinkIssueBody } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.write', async (trx) =>
        linkIssueToCase(
          trx,
          connected(),
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
      const statuses = await jiraStatuses(trx, connected(), req.params.projectId);
      await cache.set(key, statuses, STATUS_TTL_S);
      return statuses;
    }),
  );

  r.get('/projects/:projectId/defects/sync', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', async (trx) =>
      jira ? syncStatus(trx, req.params.projectId) : { connected: false, lastSyncAt: null, lastError: null },
    ),
  );

  r.post('/projects/:projectId/defects/sync', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', async (trx) => ({
      changed: await reconcileProject(trx, connected(), req.auth.orgId, req.params.projectId),
    })),
  );

  r.get(
    '/projects/:projectId/defects/similar',
    {
      schema: { params: Project, querystring: z.object({ summary: z.string().trim().min(3).max(250) }) },
    },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        similarDefects(trx, connected(), req.params.projectId, req.query.summary),
      ),
  );

  r.post(
    '/projects/:projectId/defects',
    { schema: { params: Project, body: LogBugBody } },
    async (req, reply) => {
      const defect = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
        logBug(trx, connected(), callerOf(req), req.params.projectId, webUrl, req.body),
      );
      return reply.status(201).send(defect);
    },
  );

  r.post(
    '/projects/:projectId/defects/link',
    { schema: { params: Project, body: LinkBugBody } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
        linkBug(trx, connected(), callerOf(req), req.params.projectId, webUrl, req.body),
      ),
  );

  r.get(
    '/projects/:projectId/defects/:defectId',
    { schema: { params: Project.extend({ defectId: z.uuid() }) } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        getDefect(trx, connected(), req.params.projectId, req.params.defectId),
      ),
  );

  r.post(
    '/projects/:projectId/retests/:retestId',
    { schema: { params: Project.extend({ retestId: z.uuid() }), body: RetestBody } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
        recordRetest(trx, connected(), callerOf(req), req.params.projectId, req.params.retestId, req.body),
      );
      return reply.status(204).send();
    },
  );
};

/**
 * Jira webhook receiver, mounted outside /api/v1 because Jira has no user token. It is authenticated
 * by the HMAC signature instead, which needs the exact raw body; this plugin therefore reads JSON as
 * a string and parses it only after the signature checks out.
 */
export const jiraWebhook: FastifyPluginAsync<{ db: ServiceDeps['db']; secret: string }> = async (
  app,
  { db, secret },
) => {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  app.post('/webhooks/jira', async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    const signature = req.headers['x-hub-signature'];
    if (!verifySignature(secret, raw, typeof signature === 'string' ? signature : undefined)) {
      return reply
        .status(401)
        .send({ error: { code: 'bad_signature', message: 'Webhook signature does not match.' } });
    }
    const payload = JSON.parse(raw) as { webhookEvent?: string; issue?: JiraIssue };
    if (!payload.issue?.key || !payload.issue.fields?.status)
      return reply.status(202).send({ ignored: true });
    const tenants = await handleWebhookIssue(db, payload.issue);
    return reply.status(200).send({ applied: tenants });
  });
};
