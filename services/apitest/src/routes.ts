import type { AiService } from '@tb/ai';
import { logStandaloneBug, projectTarget, type JiraAccounts } from '@tb/defect';
import {
  LoadRunBody,
  LoadTestBody,
  SecurityRunBody,
  SuppressBody,
  TargetBody,
  VerifyTargetBody,
  MockBody,
  AskBody,
  ChainWorkflowBody,
  DetectAuthBody,
  ExplainBody,
  PlanBody,
  ApiBugBody,
  SuiteBody,
  SuiteRunBody,
  EnrichmentAnswerBody,
  EnrichmentStatusBody,
  GenerateBody,
  LintSettingBody,
  ReviewGeneratedBody,
  ApiWorkflowBody,
  ApiWorkflowFromSuggestionBody,
  ApiWorkflowRunBody,
  AuthProfileBody,
  LinkDecisionBody,
  ClientCertBody,
  CreateNodeBody,
  EnvironmentBody,
  IMPORT_MAX_BYTES,
  ImportBody,
  SendBody,
  SnippetBody,
  SPEC_MAX_BYTES,
  SpecImportBody,
  SpecUploadBody,
  SpecVersionBody,
  UpdateNodeBody,
  VariationBody,
  WorkspaceBody,
  WorkspacePatch,
  type Permission,
} from '@tb/contracts';
import { projectTx, requirePermission } from '@tb/iam';
import { AppError, badRequest, decryptSecret, encryptSecret, notFound, recordEvent, type ServiceDeps, type Tx } from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { clearSessions, createCert, deleteCert, deleteProfile, listCerts, listProfiles, saveProfile } from './auth';
import { askContext, askWithAi, detectFromHistory, explainContext, explainWithAi, planContext, planWithAi } from './assistant';
import { apiBugDescription } from './bug';
import { addTarget, listTargets, markVerified, proveTarget, realProver, removeTarget, targetToProve } from './gate';
import { cancelSecurityRun, completePlan, createSecurityRun, executeSecurityRun, getFinding, getSecurityRun, listFindings, prepareSecurityRun, reopenFinding, resolveUrls, suppressFinding } from './securityRun';
import { forgetMockCache, getMock, MOCK_ROUTE, mockLog, rotateMock, saveMock, serveMock } from './mocks';
import { loadSpecDoc } from './effective';
import { performStream } from './streamRun';
import { buildAll, cancelLoadRun, deleteLoadTest, executeLoadRun, exportK6, getLoadRun, getLoadTest, listLoadRuns, listLoadTests, prepareLoadRun, saveLoadTest, startLoadRun } from './loadRun';
import { sendHttp } from './http';
import { htmlReport, junit } from './suite';
import { cancelSuiteRun, deleteSuite, executeSuiteRun, getSuite, getSuiteRun, listSuiteRuns, listSuites, runOnSpecChange, saveSuite, startSuiteRun, suiteTrend, waitForRun } from './suites';
import { answerQuestion, coverage, draftAnswer, draftContext, enrichmentView, generatedView, generateTests, reviewTests, setLintRule, setQuestionStatus, specQuality } from './quality';
import { decideLink, forgetDecision, projectMap } from './map';
import { cancelRun, executeRun, getRun, listRuns, startRun, stepRun } from './workflow-runs';
import { deleteWorkflow, getWorkflow, listWorkflows, saveWorkflow, workflowFromSteps, workflowFromSuggestion } from './workflows';
import { maskHeaders, maskSecrets } from './resolve';
import { snippet } from './snippets';
import { duplicateNode, exportPostman, importInto } from './transfer';
import { buildSend, clearCookies, clearHistory, getHistory, listCookies, listHistory, loadSend, performSend, recordSend } from './send';
import { addVersion, deleteSpec, getSpec, importToCollection, listSpecs, parseUpload, sourceOf, specImpact, uploadSpec } from './specs';
import {
  createEnvironment,
  createNode,
  createVariation,
  createWorkspace,
  deleteEnvironment,
  deleteNode,
  deleteVariation,
  deleteWorkspace,
  getNode,
  markReviewed,
  listEnvironments,
  listTree,
  listWorkspaces,
  updateEnvironment,
  updateNode,
  updateVariation,
  updateWorkspace,
  workspaceFor,
  type SecretBox,
} from './workspaces';

export interface ApiStudioConfig {
  /** Encrypts secret variables and cookie jars; null disables secrets. */
  secret: string | null;
  /** Local development only: lets requests reach localhost and private addresses. */
  allowPrivate: boolean;
}

const Project = z.object({ projectId: z.uuid() });
const Ws = Project.extend({ workspaceId: z.uuid() });
const NodeParams = Ws.extend({ nodeId: z.uuid() });
const SpecParams = Project.extend({ specId: z.uuid() });
const EnvQuery = z.object({ environmentId: z.uuid().optional() });
const callerOf = (req: FastifyRequest) => ({ orgId: req.auth.orgId, userId: req.auth.userId });

/** Fetches a spec from a URL through the same SSRF guard as every other send. */
async function fetchSpec(url: string, allowPrivate: boolean): Promise<string> {
  const out = await sendHttp(
    { method: 'GET', url, headers: [['Accept', 'application/json, application/yaml, text/yaml, */*']], body: null, secrets: [], unresolved: [] },
    { allowPrivate, timeoutMs: 30_000, followRedirects: true, maxBodyBytes: SPEC_MAX_BYTES },
  );
  if (out.error) throw badRequest(`The spec could not be fetched: ${out.error.message}`);
  if (out.response!.status >= 400) throw badRequest(`The spec could not be fetched: the server answered ${out.response!.status}.`);
  if (out.response!.truncated) throw badRequest('The spec is larger than 20 MB.');
  return out.response!.body.toString('utf8');
}

// API testing is testing work, so it takes the permissions testers already have: reading needs what
// viewing runs needs, and editing or sending needs what recording results needs.
export const apiStudioRoutes: FastifyPluginAsync<ServiceDeps & { apiStudio: ApiStudioConfig; ai: AiService; jira: JiraAccounts; webUrl: string }> = async (
  app,
  { db, storage, apiStudio, ai, jira, webUrl },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const secret = apiStudio.secret;
  const box: SecretBox = secret ? { encrypt: (s) => encryptSecret(secret, s), decrypt: (c) => decryptSecret(secret, c) } : null;
  const base = '/projects/:projectId/apitest';

  /** A transaction inside a workspace the caller can see; 404 for someone else's personal workspace. */
  const inWorkspace = <T>(
    req: FastifyRequest & { params: { projectId: string; workspaceId: string } },
    permission: Permission,
    fn: (trx: Tx, ws: Awaited<ReturnType<typeof workspaceFor>>) => Promise<T>,
  ) =>
    projectTx(db, req, req.params.projectId, permission, async (trx) =>
      fn(trx, await workspaceFor(trx, req.params.projectId, req.params.workspaceId, req.auth.userId)),
    );

  // ---------- workspaces ----------
  r.get(`${base}/workspaces`, { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => listWorkspaces(trx, req.params.projectId, req.auth.userId)),
  );
  r.post(`${base}/workspaces`, { schema: { params: Project, body: WorkspaceBody } }, async (req, reply) => {
    const ws = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => createWorkspace(trx, callerOf(req), req.params.projectId, req.body));
    return reply.status(201).send(ws);
  });
  r.patch(`${base}/workspaces/:workspaceId`, { schema: { params: Ws, body: WorkspacePatch } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      updateWorkspace(trx, box, callerOf(req), req.params.projectId, req.params.workspaceId, req.body),
    ),
  );
  r.delete(`${base}/workspaces/:workspaceId`, { schema: { params: Ws } }, async (req, reply) => {
    await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => deleteWorkspace(trx, req.params.projectId, req.params.workspaceId, req.auth.userId));
    return reply.status(204).send();
  });

  // ---------- tree and variations ----------
  r.get(`${base}/workspaces/:workspaceId/tree`, { schema: { params: Ws } }, async (req) => inWorkspace(req, 'run.read', (trx, ws) => listTree(trx, ws.id)));
  r.post(`${base}/workspaces/:workspaceId/nodes`, { schema: { params: Ws, body: CreateNodeBody } }, async (req, reply) => {
    const node = await inWorkspace(req, 'run.execute', (trx, ws) => createNode(trx, box, callerOf(req), ws.id, req.body));
    return reply.status(201).send(node);
  });
  r.get(`${base}/workspaces/:workspaceId/nodes/:nodeId`, { schema: { params: NodeParams } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => getNode(trx, ws.id, req.params.nodeId)),
  );
  r.patch(`${base}/workspaces/:workspaceId/nodes/:nodeId`, { schema: { params: NodeParams, body: UpdateNodeBody } }, async (req) =>
    inWorkspace(req, 'run.execute', (trx, ws) => updateNode(trx, box, callerOf(req), ws.id, req.params.nodeId, req.body)),
  );
  r.delete(`${base}/workspaces/:workspaceId/nodes/:nodeId`, { schema: { params: NodeParams } }, async (req, reply) => {
    await inWorkspace(req, 'run.execute', (trx, ws) => deleteNode(trx, ws.id, req.params.nodeId));
    return reply.status(204).send();
  });
  r.post(`${base}/workspaces/:workspaceId/nodes/:nodeId/variations`, { schema: { params: NodeParams, body: VariationBody } }, async (req, reply) => {
    const list = await inWorkspace(req, 'run.execute', (trx, ws) => createVariation(trx, callerOf(req), ws.id, req.params.nodeId, req.body));
    return reply.status(201).send(list);
  });
  r.put(
    `${base}/workspaces/:workspaceId/nodes/:nodeId/variations/:variationId`,
    { schema: { params: NodeParams.extend({ variationId: z.uuid() }), body: VariationBody } },
    async (req) => inWorkspace(req, 'run.execute', (trx, ws) => updateVariation(trx, callerOf(req), ws.id, req.params.nodeId, req.params.variationId, req.body)),
  );
  r.delete(
    `${base}/workspaces/:workspaceId/nodes/:nodeId/variations/:variationId`,
    { schema: { params: NodeParams.extend({ variationId: z.uuid() }) } },
    async (req, reply) => {
      await inWorkspace(req, 'run.execute', (trx, ws) => deleteVariation(trx, ws.id, req.params.nodeId, req.params.variationId));
      return reply.status(204).send();
    },
  );

  r.post(`${base}/workspaces/:workspaceId/nodes/:nodeId/reviewed`, { schema: { params: NodeParams } }, async (req) =>
    inWorkspace(req, 'run.execute', (trx, ws) => markReviewed(trx, callerOf(req), ws.id, req.params.nodeId)),
  );
  r.get(`${base}/specs/:specId/impact`, { schema: { params: SpecParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => specImpact(trx, req.params.projectId, req.params.specId)),
  );
  r.post(`${base}/workspaces/:workspaceId/nodes/:nodeId/duplicate`, { schema: { params: NodeParams } }, async (req, reply) => {
    const node = await inWorkspace(req, 'run.execute', async (trx, ws) => getNode(trx, ws.id, await duplicateNode(trx, callerOf(req), ws.id, req.params.nodeId)));
    return reply.status(201).send(node);
  });
  r.get(`${base}/workspaces/:workspaceId/nodes/:nodeId/export`, { schema: { params: NodeParams } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => exportPostman(trx, ws.id, req.params.nodeId)),
  );
  // Postman exports run to many megabytes, above the app's 1 MB default body limit.
  r.post(`${base}/workspaces/:workspaceId/import`, { bodyLimit: IMPORT_MAX_BYTES + 1024 * 1024, schema: { params: Ws, body: ImportBody } }, async (req, reply) => {
    const result = await inWorkspace(req, 'run.execute', (trx, ws) => importInto(trx, box, callerOf(req), ws.id, req.body));
    return reply.status(201).send(result);
  });

  // ---------- environments ----------
  r.get(`${base}/workspaces/:workspaceId/environments`, { schema: { params: Ws } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => listEnvironments(trx, ws.id)),
  );
  r.post(`${base}/workspaces/:workspaceId/environments`, { schema: { params: Ws, body: EnvironmentBody } }, async (req, reply) => {
    const env = await inWorkspace(req, 'run.execute', (trx, ws) => createEnvironment(trx, box, callerOf(req), ws.id, req.body));
    return reply.status(201).send(env);
  });
  r.put(`${base}/workspaces/:workspaceId/environments/:environmentId`, { schema: { params: Ws.extend({ environmentId: z.uuid() }), body: EnvironmentBody } }, async (req) =>
    inWorkspace(req, 'run.execute', (trx, ws) => updateEnvironment(trx, box, ws.id, req.params.environmentId, req.body)),
  );
  r.delete(`${base}/workspaces/:workspaceId/environments/:environmentId`, { schema: { params: Ws.extend({ environmentId: z.uuid() }) } }, async (req, reply) => {
    await inWorkspace(req, 'run.execute', (trx, ws) => deleteEnvironment(trx, ws.id, req.params.environmentId));
    return reply.status(204).send();
  });

  // ---------- client certificates and auth profiles ----------
  const CertParams = Ws.extend({ certId: z.uuid() });
  const ProfileParams = Ws.extend({ profileId: z.uuid() });
  r.get(`${base}/workspaces/:workspaceId/certificates`, { schema: { params: Ws } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => listCerts(trx, box, ws.id)),
  );
  r.post(`${base}/workspaces/:workspaceId/certificates`, { schema: { params: Ws, body: ClientCertBody } }, async (req, reply) => {
    const cert = await inWorkspace(req, 'run.execute', (trx, ws) => createCert(trx, box, callerOf(req), ws.id, req.body));
    return reply.status(201).send(cert);
  });
  r.delete(`${base}/workspaces/:workspaceId/certificates/:certId`, { schema: { params: CertParams } }, async (req, reply) => {
    await inWorkspace(req, 'run.execute', (trx, ws) => deleteCert(trx, ws.id, req.params.certId));
    return reply.status(204).send();
  });
  r.get(`${base}/workspaces/:workspaceId/profiles`, { schema: { params: Ws } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => listProfiles(trx, ws.id)),
  );
  r.post(`${base}/workspaces/:workspaceId/profiles`, { schema: { params: Ws, body: AuthProfileBody } }, async (req, reply) => {
    const profile = await inWorkspace(req, 'run.execute', (trx, ws) => saveProfile(trx, callerOf(req), ws.id, req.body));
    return reply.status(201).send(profile);
  });
  r.put(`${base}/workspaces/:workspaceId/profiles/:profileId`, { schema: { params: ProfileParams, body: AuthProfileBody } }, async (req) =>
    inWorkspace(req, 'run.execute', (trx, ws) => saveProfile(trx, callerOf(req), ws.id, req.body, req.params.profileId)),
  );
  r.delete(`${base}/workspaces/:workspaceId/profiles/:profileId`, { schema: { params: ProfileParams } }, async (req, reply) => {
    await inWorkspace(req, 'run.execute', (trx, ws) => deleteProfile(trx, ws.id, req.params.profileId));
    return reply.status(204).send();
  });
  /** Forgets this tester's logged-in sessions in the workspace; the next request logs in again. */
  r.delete(`${base}/workspaces/:workspaceId/sessions`, { schema: { params: Ws } }, async (req, reply) => {
    await inWorkspace(req, 'run.read', (trx, ws) => clearSessions(trx, req.auth.userId, ws.id));
    return reply.status(204).send();
  });

  // ---------- sending ----------
  // Load in a transaction, then build (pre scripts), send and run post scripts with none open, then
  // record in a second one: nothing holds a connection while the target API or a script's request answers.
  r.post(`${base}/workspaces/:workspaceId/send`, { schema: { params: Ws, body: SendBody } }, async (req) => {
    const caller = callerOf(req);
    const cfg = { allowPrivate: apiStudio.allowPrivate };
    const loaded = await inWorkspace(req, 'run.execute', (trx, ws) => loadSend(trx, box, caller, ws, req.body, { storage, projectId: req.params.projectId }));
    const prepared = await buildSend(loaded, cfg);
    const sent = await performSend(prepared, cfg);
    return inWorkspace(req, 'run.execute', (trx, ws) => recordSend(trx, box, caller, req.params.projectId, ws.id, prepared, sent));
  });
  /** A WebSocket or SSE request: connect, send, listen for a bounded time, and return the transcript. */
  r.post(`${base}/workspaces/:workspaceId/stream`, { schema: { params: Ws, body: SendBody } }, async (req) => {
    const caller = callerOf(req);
    const cfg = { allowPrivate: apiStudio.allowPrivate };
    const loaded = await inWorkspace(req, 'run.execute', (trx, ws) => loadSend(trx, box, caller, ws, { ...req.body, cookies: 'none' }, { storage, projectId: req.params.projectId }));
    return performStream(await buildSend(loaded, cfg), cfg);
  });
  /** The request as it would be sent, as code for another tool, with every secret masked. */
  r.post(`${base}/workspaces/:workspaceId/snippet`, { schema: { params: Ws, body: SnippetBody } }, async (req) => {
    const loaded = await inWorkspace(req, 'run.execute', (trx, ws) => loadSend(trx, box, callerOf(req), ws, { ...req.body, cookies: 'none' }));
    const p = await buildSend(loaded, { allowPrivate: apiStudio.allowPrivate });
    const code = snippet(req.body.language, {
      method: p.request.method,
      url: maskSecrets(p.request.url, p.secrets),
      headers: maskHeaders(p.request.headers, p.secrets),
      body: p.request.body ? maskSecrets(p.request.body.toString('utf8'), p.secrets) : null,
    });
    return { language: req.body.language, code };
  });
  r.get(`${base}/workspaces/:workspaceId/history`, { schema: { params: Ws } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => listHistory(trx, req.auth.userId, ws.id)),
  );
  r.get(`${base}/workspaces/:workspaceId/history/:historyId`, { schema: { params: Ws.extend({ historyId: z.uuid() }) } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => getHistory(trx, req.auth.userId, ws.id, req.params.historyId)),
  );
  /** Files a Jira bug from a send in history, with the masked request and response, as the tester. */
  r.post(`${base}/workspaces/:workspaceId/history/:historyId/bug`, { schema: { params: Ws.extend({ historyId: z.uuid() }), body: ApiBugBody } }, async (req, reply) => {
    const defect = await inWorkspace(req, 'run.execute', async (trx, ws) => {
      const h = await getHistory(trx, req.auth.userId, ws.id, req.params.historyId);
      const client = await jira.forUser(trx, req.auth.userId, (await projectTarget(trx, req.params.projectId)).siteUrl);
      return logStandaloneBug(trx, client, { ...callerOf(req), name: req.auth.name }, req.params.projectId, {
        summary: req.body.summary,
        severity: req.body.severity,
        labels: ['api', ...req.body.labels],
        description: apiBugDescription(h, { note: req.body.note, found: req.body.found, failures: req.body.failures, link: `${webUrl}/api?ws=${ws.id}&side=history&h=${h.id}` }),
        found: `${req.body.found}: ${h.method} ${h.url}`,
      });
    });
    return reply.status(201).send(defect);
  });
  r.delete(`${base}/workspaces/:workspaceId/history`, { schema: { params: Ws } }, async (req, reply) => {
    await inWorkspace(req, 'run.read', (trx, ws) => clearHistory(trx, req.auth.userId, ws.id));
    return reply.status(204).send();
  });
  r.get(`${base}/workspaces/:workspaceId/cookies`, { schema: { params: Ws, querystring: EnvQuery } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => listCookies(trx, box, req.auth.userId, ws.id, req.query.environmentId ?? null)),
  );
  r.delete(`${base}/workspaces/:workspaceId/cookies`, { schema: { params: Ws, querystring: EnvQuery } }, async (req, reply) => {
    await inWorkspace(req, 'run.read', (trx, ws) => clearCookies(trx, req.auth.userId, ws.id, req.query.environmentId ?? null));
    return reply.status(204).send();
  });

  // ---------- quality, enrichment, generated tests and coverage (plan §9–§11) ----------
  const VersionQ = z.object({ version: z.coerce.number().int().min(1).optional() });
  r.get(`${base}/specs/:specId/quality`, { schema: { params: SpecParams, querystring: VersionQ } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => specQuality(trx, storage, req.params.projectId, req.params.specId, req.query.version)),
  );
  r.put(`${base}/quality/rules`, { schema: { params: Project, body: LintSettingBody } }, async (req, reply) => {
    await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => setLintRule(trx, callerOf(req), req.params.projectId, req.body));
    return reply.status(204).send();
  });
  r.get(`${base}/specs/:specId/enrichment`, { schema: { params: SpecParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => enrichmentView(trx, storage, req.params.projectId, req.params.specId)),
  );
  // An answer changes the effective spec, so a mock serving it must not keep answering from the old one.
  r.post(`${base}/specs/:specId/enrichment/answer`, { schema: { params: SpecParams, body: EnrichmentAnswerBody } }, async (req) => {
    const view = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => answerQuestion(trx, storage, callerOf(req), req.params.projectId, req.params.specId, req.body));
    forgetMockCache(req.params.specId);
    return view;
  });
  r.post(`${base}/specs/:specId/enrichment/status`, { schema: { params: SpecParams, body: EnrichmentStatusBody } }, async (req) => {
    const view = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => setQuestionStatus(trx, storage, callerOf(req), req.params.projectId, req.params.specId, req.body));
    forgetMockCache(req.params.specId);
    return view;
  });
  /** An AI draft of an answer, to accept or edit. Nothing is saved. */
  r.post(`${base}/specs/:specId/enrichment/draft`, { schema: { params: SpecParams, body: z.object({ questionId: z.string().min(8).max(40) }) } }, async (req) => {
    const { input, gap } = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => draftContext(trx, storage, req.params.projectId, req.params.specId, req.body.questionId));
    try {
      requirePermission(req, req.params.projectId, 'ai.use');
    } catch {
      return { answer: null, why: '', ai: { status: 'off', message: 'You do not have permission to use AI in this project.' } };
    }
    // Outside the transaction: a model can take a while and nothing here needs the database.
    return draftAnswer(ai, callerOf(req), input, gap.kind);
  });
  /** The spec with every answer applied, to push back into the team's own source spec. */
  r.get(`${base}/specs/:specId/effective`, { schema: { params: SpecParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', async (trx) => (await loadSpecDoc(trx, storage, req.params.projectId, req.params.specId)).doc),
  );
  r.get(`${base}/specs/:specId/tests`, { schema: { params: SpecParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', async (trx) => {
      const v = await trx.selectFrom('apitest.spec').select('current_version').where('id', '=', req.params.specId).where('project_id', '=', req.params.projectId).executeTakeFirst();
      if (!v) throw notFound('Spec');
      return generatedView(trx, req.params.specId, v.current_version);
    }),
  );
  r.post(`${base}/specs/:specId/tests/generate`, { schema: { params: SpecParams, body: GenerateBody } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) => generateTests(trx, storage, callerOf(req), req.params.projectId, req.params.specId, req.body.operations)),
  );
  r.post(`${base}/specs/:specId/tests/review`, { schema: { params: SpecParams, body: ReviewGeneratedBody } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', async (trx) => {
      if (req.body.workspaceId) await workspaceFor(trx, req.params.projectId, req.body.workspaceId, req.auth.userId);
      return reviewTests(trx, box, storage, callerOf(req), req.params.projectId, req.params.specId, req.body);
    }),
  );
  r.get(`${base}/specs/:specId/coverage`, { schema: { params: SpecParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => coverage(trx, storage, req.params.projectId, req.params.specId)),
  );

  // ---------- project map and workflows ----------
  r.get(`${base}/map`, { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', async (trx) => {
      const { io: _io, ...map } = await projectMap(trx, storage, req.params.projectId);
      return map;
    }),
  );
  r.post(`${base}/map/links`, { schema: { params: Project, body: LinkDecisionBody } }, async (req, reply) => {
    await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => decideLink(trx, callerOf(req), req.params.projectId, req.body));
    return reply.status(204).send();
  });
  r.delete(`${base}/map/links`, { schema: { params: Project, body: LinkDecisionBody.omit({ status: true, field: true }) } }, async (req, reply) => {
    await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => forgetDecision(trx, req.params.projectId, req.body));
    return reply.status(204).send();
  });

  const WfParams = Ws.extend({ workflowId: z.uuid() });
  const RunParams = WfParams.extend({ runId: z.uuid() });
  r.get(`${base}/workspaces/:workspaceId/workflows`, { schema: { params: Ws } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => listWorkflows(trx, ws.id)),
  );
  r.post(`${base}/workspaces/:workspaceId/workflows`, { schema: { params: Ws, body: ApiWorkflowBody } }, async (req, reply) => {
    const wf = await inWorkspace(req, 'run.execute', (trx, ws) => saveWorkflow(trx, callerOf(req), ws.id, req.body));
    return reply.status(201).send(wf);
  });
  r.post(`${base}/workspaces/:workspaceId/workflows/from-suggestion`, { schema: { params: Ws, body: ApiWorkflowFromSuggestionBody } }, async (req, reply) => {
    const wf = await inWorkspace(req, 'run.execute', (trx, ws) =>
      workflowFromSuggestion(trx, storage, box, callerOf(req), req.params.projectId, ws.id, req.body.suggestionId, req.body.name),
    );
    return reply.status(201).send(wf);
  });
  r.get(`${base}/workspaces/:workspaceId/workflows/:workflowId`, { schema: { params: WfParams, querystring: z.object({ version: z.coerce.number().int().min(1).optional() }) } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => getWorkflow(trx, ws.id, req.params.workflowId, req.query.version)),
  );
  r.put(`${base}/workspaces/:workspaceId/workflows/:workflowId`, { schema: { params: WfParams, body: ApiWorkflowBody } }, async (req) =>
    inWorkspace(req, 'run.execute', (trx, ws) => saveWorkflow(trx, callerOf(req), ws.id, req.body, req.params.workflowId)),
  );
  r.delete(`${base}/workspaces/:workspaceId/workflows/:workflowId`, { schema: { params: WfParams } }, async (req, reply) => {
    await inWorkspace(req, 'run.execute', (trx, ws) => deleteWorkflow(trx, ws.id, req.params.workflowId));
    return reply.status(204).send();
  });

  const runContext = (req: FastifyRequest & { params: { projectId: string; workspaceId: string } }) => ({
    db,
    storage,
    box,
    cfg: { allowPrivate: apiStudio.allowPrivate },
    caller: callerOf(req),
    projectId: req.params.projectId,
    workspaceId: req.params.workspaceId,
  });
  /** Starts a run. "all" goes on in the background; poll the run to watch it. */
  r.post(`${base}/workspaces/:workspaceId/workflows/:workflowId/runs`, { schema: { params: WfParams, body: ApiWorkflowRunBody } }, async (req, reply) => {
    const run = await inWorkspace(req, 'run.execute', (trx, ws) => startRun(trx, box, callerOf(req), req.params.projectId, ws.id, req.params.workflowId, req.body));
    if (run.mode === 'all') void executeRun(runContext(req), run.id, req.body.locals);
    return reply.status(201).send(run);
  });
  r.get(`${base}/workspaces/:workspaceId/workflows/:workflowId/runs`, { schema: { params: WfParams } }, async (req) =>
    inWorkspace(req, 'run.read', (trx) => listRuns(trx, req.params.workflowId, req.auth.userId)),
  );
  r.get(`${base}/workspaces/:workspaceId/workflows/:workflowId/runs/:runId`, { schema: { params: RunParams } }, async (req) =>
    inWorkspace(req, 'run.read', (trx) => getRun(trx, req.params.workflowId, req.params.runId, req.auth.userId)),
  );
  r.post(`${base}/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/step`, { schema: { params: RunParams } }, async (req) => {
    // Checked in a transaction first; the step itself opens its own, one per request it sends.
    await inWorkspace(req, 'run.execute', (trx) => getRun(trx, req.params.workflowId, req.params.runId, req.auth.userId));
    return stepRun(runContext(req), req.params.workflowId, req.params.runId);
  });
  r.post(`${base}/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/cancel`, { schema: { params: RunParams } }, async (req) =>
    inWorkspace(req, 'run.execute', (trx) => cancelRun(trx, req.params.workflowId, req.params.runId, req.auth.userId)),
  );

  // ---------- the safety gate, security checks and findings (plan §14) ----------
  /** Whether the caller may override the production guard: a project admin. */
  const canManage = (req: FastifyRequest, projectId: string) => {
    try {
      requirePermission(req, projectId, 'project.manage');
      return true;
    } catch {
      return false;
    }
  };
  r.get(`${base}/targets`, { schema: { params: Project } }, async (req) => projectTx(db, req, req.params.projectId, 'run.read', (trx) => listTargets(trx, req.params.projectId)));
  r.post(`${base}/targets`, { schema: { params: Project, body: TargetBody } }, async (req, reply) => {
    const t = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => addTarget(trx, callerOf(req), req.params.projectId, req.body.host));
    return reply.status(201).send(t);
  });
  r.delete(`${base}/targets/:targetId`, { schema: { params: Project.extend({ targetId: z.uuid() }) } }, async (req, reply) => {
    await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => removeTarget(trx, req.params.projectId, req.params.targetId));
    return reply.status(204).send();
  });
  /** Checks the DNS record or file is published, as the person who owns the host would have done. */
  r.post(`${base}/targets/:targetId/verify`, { schema: { params: Project.extend({ targetId: z.uuid() }), body: VerifyTargetBody } }, async (req) => {
    const t = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => targetToProve(trx, req.params.projectId, req.params.targetId));
    // A host with no TLS (a staging box) may serve the file over http; production hosts should not.
    const proven = await proveTarget(realProver(apiStudio.allowPrivate), t, req.body.method, apiStudio.allowPrivate ? ['https', 'http'] : ['https']);
    if (!proven)
      throw new AppError(422, 'not_verified', req.body.method === 'dns' ? `The TXT record was not found. Publish it, wait for DNS to catch up, and try again.` : `The file was not found, or does not contain the token. Check the address and content, and try again.`);
    return projectTx(db, req, req.params.projectId, 'run.execute', async (trx) => {
      await markVerified(trx, callerOf(req), t.id, req.body.method);
      await recordEvent(trx, { orgId: req.auth.orgId, projectId: req.params.projectId, type: 'apitest.target.verified', actor: req.auth.userId, data: { host: t.host, method: req.body.method } });
      return (await listTargets(trx, req.params.projectId)).find((x) => x.id === t.id)!;
    });
  });
  r.post(`${base}/specs/:specId/security/runs`, { schema: { params: SpecParams, body: SecurityRunBody } }, async (req, reply) => {
    const caller = callerOf(req);
    const cfg = { allowPrivate: apiStudio.allowPrivate };
    const prepared = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => prepareSecurityRun(trx, box, caller, storage, req.params.projectId, req.params.specId, req.body));
    const urls = await resolveUrls(prepared, cfg);
    const { runId, plan } = await projectTx(db, req, req.params.projectId, 'run.execute', async (trx) => {
      const plan = await completePlan(trx, cfg, req.params.projectId, prepared, urls, { requested: req.body.productionOverride, canOverride: canManage(req, req.params.projectId) });
      return { plan, runId: await createSecurityRun(trx, caller, req.params.projectId, plan) };
    });
    void executeSecurityRun({ db, storage, box, cfg, caller, projectId: req.params.projectId }, runId, plan);
    const view = await projectTx(db, req, req.params.projectId, 'run.read', (trx) => getSecurityRun(trx, req.params.projectId, req.params.specId, runId));
    return reply.status(201).send(view);
  });
  r.get(`${base}/specs/:specId/security/runs/:runId`, { schema: { params: SpecParams.extend({ runId: z.uuid() }) } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => getSecurityRun(trx, req.params.projectId, req.params.specId, req.params.runId)),
  );
  r.post(`${base}/specs/:specId/security/runs/:runId/cancel`, { schema: { params: SpecParams.extend({ runId: z.uuid() }) } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', async (trx) => {
      const run = await getSecurityRun(trx, req.params.projectId, req.params.specId, req.params.runId);
      if (run.status === 'running') cancelSecurityRun(run.id);
      return run;
    }),
  );
  r.get(`${base}/specs/:specId/security/findings`, { schema: { params: SpecParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => listFindings(trx, req.params.projectId, req.params.specId)),
  );
  const FindingParams = SpecParams.extend({ findingId: z.uuid() });
  r.post(`${base}/specs/:specId/security/findings/:findingId/suppress`, { schema: { params: FindingParams, body: SuppressBody } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) => suppressFinding(trx, callerOf(req), req.params.projectId, req.params.findingId, req.body.reason, req.body.days)),
  );
  r.post(`${base}/specs/:specId/security/findings/:findingId/reopen`, { schema: { params: FindingParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) => reopenFinding(trx, req.params.projectId, req.params.findingId)),
  );
  /** A Jira bug from a finding, with its masked evidence, as the tester. */
  r.post(`${base}/specs/:specId/security/findings/:findingId/bug`, { schema: { params: FindingParams, body: z.object({ note: z.string().max(4000).default('') }) } }, async (req, reply) => {
    const defect = await projectTx(db, req, req.params.projectId, 'run.execute', async (trx) => {
      const f = await getFinding(trx, req.params.projectId, req.params.findingId);
      const client = await jira.forUser(trx, req.auth.userId, (await projectTarget(trx, req.params.projectId)).siteUrl);
      const code = (text: string): { type: 'codeBlock'; attrs: { language: string }; content: { type: 'text'; text: string }[] } => ({ type: 'codeBlock', attrs: { language: 'http' }, content: [{ type: 'text', text: text || '(empty)' }] });
      const para = (label: string, value: string) => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text: label, marks: [{ type: 'strong' as const }] }, { type: 'text' as const, text: value }] });
      return logStandaloneBug(trx, client, { ...callerOf(req), name: req.auth.name }, req.params.projectId, {
        summary: `[Security] ${f.title}`.slice(0, 250),
        severity: f.severity === 'high' ? 'Critical' : f.severity === 'medium' ? 'Major' : 'Minor',
        labels: ['api', 'security'],
        description: { type: 'doc', version: 1, content: [para('Category: ', f.owasp), para('Operation: ', f.operation ?? 'the whole API'), para('What is wrong: ', f.detail), ...(req.body.note.trim() ? [para('Notes: ', req.body.note.trim())] : []), { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Request' }] }, code(f.evidence.request), { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Response' }] }, code(f.evidence.response)] },
        found: 'API security check',
      });
    });
    return reply.status(201).send(defect);
  });

  // ---------- mock servers (plan §14) ----------
  const originOf = (req: FastifyRequest) => `${req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
  r.get(`${base}/specs/:specId/mock`, { schema: { params: SpecParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => getMock(trx, box, req.params.projectId, req.params.specId, originOf(req))),
  );
  r.put(`${base}/specs/:specId/mock`, { schema: { params: SpecParams, body: MockBody } }, async (req) => {
    const view = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => saveMock(trx, box, callerOf(req), req.params.projectId, req.params.specId, req.body, originOf(req)));
    forgetMockCache(req.params.specId);
    return view;
  });
  r.post(`${base}/specs/:specId/mock/rotate`, { schema: { params: SpecParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) => rotateMock(trx, box, req.params.projectId, req.params.specId, originOf(req))),
  );
  r.get(`${base}/specs/:specId/mock/log`, { schema: { params: SpecParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', async (trx) => {
      const spec = await trx.selectFrom('apitest.spec').select('id').where('id', '=', req.params.specId).where('project_id', '=', req.params.projectId).executeTakeFirst();
      if (!spec) throw notFound('Spec');
      return mockLog(req.params.specId);
    }),
  );
  // The mock itself, in its own scope: it takes any body, answers cross-origin, and needs no login
  // (its token is the credential; the auth plugin is told this route pattern is public).
  await app.register(async (mock) => {
    mock.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    mock.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      url: MOCK_ROUTE.replace('/api/v1', ''),
      bodyLimit: 1024 * 1024,
      handler: async (req, reply) => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS', 'access-control-expose-headers': '*', 'x-mock': 'testbench' };
        if (req.method === 'OPTIONS') return reply.status(204).headers(cors).send();
        const { token, '*': rest } = req.params as { token: string; '*': string };
        let body: unknown = req.body;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch {
            // Not JSON: validation treats it as a body that is present but has no fields.
          }
        }
        const out = await serveMock(db, storage, token, { method: req.method, path: `/${rest}`, query: req.query as Record<string, string | string[]>, headers: req.headers, body });
        if (out.delayMs) await new Promise((ok) => setTimeout(ok, out.delayMs));
        reply.status(out.status).headers({ ...cors, ...out.headers, ...(out.operation ? { 'x-mock-operation': out.operation } : {}) });
        if (out.body === undefined || req.method === 'HEAD') return reply.send();
        return reply.send(typeof out.body === 'string' && out.headers['content-type']?.includes('json') ? JSON.stringify(out.body) : out.body);
      },
    });
  });

  // ---------- the assistant (plan §16) ----------
  /** Why AI is off for this caller, or null when it may be used. The rules answer either way. */
  const aiOff = (req: FastifyRequest, projectId: string): string | null => {
    try {
      requirePermission(req, projectId, 'ai.use');
      return null;
    } catch {
      return 'You do not have permission to use AI in this project, so this answer uses the rules only.';
    }
  };
  r.post(`${base}/assistant/explain`, { bodyLimit: 4 * 1024 * 1024, schema: { params: Project, body: ExplainBody } }, async (req) => {
    const ctx = await projectTx(db, req, req.params.projectId, 'run.read', (trx) => explainContext(trx, storage, req.params.projectId, req.body.text));
    return explainWithAi(ai, callerOf(req), ctx, aiOff(req, req.params.projectId));
  });
  r.post(`${base}/assistant/plan`, { schema: { params: Project, body: PlanBody } }, async (req) => {
    const { chains } = await projectTx(db, req, req.params.projectId, 'run.read', (trx) => planContext(trx, storage, req.params.projectId, req.body.requirement));
    return planWithAi(ai, callerOf(req), req.body.requirement, chains, aiOff(req, req.params.projectId));
  });
  r.post(`${base}/workspaces/:workspaceId/assistant/ask`, { schema: { params: Ws, body: AskBody } }, async (req) => {
    const ctx = await inWorkspace(req, 'run.read', (trx, ws) => askContext(trx, storage, req.params.projectId, req.auth.userId, ws.id, req.body.question, req.body.historyId));
    return askWithAi(ai, callerOf(req), ctx, aiOff(req, req.params.projectId));
  });
  /** Reads how a login hands out its credential, to make an auth profile from. Saves nothing. */
  r.post(`${base}/workspaces/:workspaceId/assistant/detect-auth`, { schema: { params: Ws, body: DetectAuthBody } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => detectFromHistory(trx, req.auth.userId, ws.id, req.body.historyId)),
  );
  /** A workflow from a chain the assistant planned, made the same way as one from the project map. */
  r.post(`${base}/workspaces/:workspaceId/assistant/workflow`, { schema: { params: Ws, body: ChainWorkflowBody } }, async (req, reply) => {
    const wf = await inWorkspace(req, 'run.execute', (trx, ws) =>
      workflowFromSteps(trx, storage, box, callerOf(req), req.params.projectId, ws.id, req.body.name, req.body.steps.map((key) => ({ key, expectStatus: null, note: '' }))),
    );
    return reply.status(201).send(wf);
  });

  // ---------- suites (plan §13, §15) ----------
  const SuiteParams = Ws.extend({ suiteId: z.uuid() });
  const SuiteRunParams = SuiteParams.extend({ runId: z.uuid() });
  const suiteContext = (req: FastifyRequest & { params: { projectId: string; workspaceId: string } }) => ({
    db,
    storage,
    box,
    cfg: { allowPrivate: apiStudio.allowPrivate },
    caller: callerOf(req),
    projectId: req.params.projectId,
    workspaceId: req.params.workspaceId,
  });
  /** A new spec version: tell whoever listens, and start suites set to run on spec changes. */
  async function afterNewVersion(req: FastifyRequest & { params: { projectId: string } }, specId: string, version: number) {
    forgetMockCache(specId);
    const started = await projectTx(db, req, req.params.projectId, 'run.execute', async (trx) => {
      await recordEvent(trx, { orgId: req.auth.orgId, projectId: req.params.projectId, type: 'apitest.spec.versioned', actor: req.auth.userId, data: { specId, version } });
      return runOnSpecChange(trx, callerOf(req), req.params.projectId, specId);
    });
    for (const s of started)
      void executeSuiteRun({ db, storage, box, cfg: { allowPrivate: apiStudio.allowPrivate }, caller: callerOf(req), projectId: req.params.projectId, workspaceId: s.workspaceId }, s.suiteId, s.runId);
  }
  r.get(`${base}/workspaces/:workspaceId/suites`, { schema: { params: Ws } }, async (req) => inWorkspace(req, 'run.read', (trx, ws) => listSuites(trx, ws.id)));
  r.post(`${base}/workspaces/:workspaceId/suites`, { schema: { params: Ws, body: SuiteBody } }, async (req, reply) => {
    const suite = await inWorkspace(req, 'run.execute', (trx, ws) => saveSuite(trx, callerOf(req), req.params.projectId, ws.id, req.body));
    return reply.status(201).send(suite);
  });
  r.get(`${base}/workspaces/:workspaceId/suites/:suiteId`, { schema: { params: SuiteParams } }, async (req) => inWorkspace(req, 'run.read', (trx, ws) => getSuite(trx, ws.id, req.params.suiteId)));
  r.put(`${base}/workspaces/:workspaceId/suites/:suiteId`, { schema: { params: SuiteParams, body: SuiteBody } }, async (req) =>
    inWorkspace(req, 'run.execute', (trx, ws) => saveSuite(trx, callerOf(req), req.params.projectId, ws.id, req.body, req.params.suiteId)),
  );
  r.delete(`${base}/workspaces/:workspaceId/suites/:suiteId`, { schema: { params: SuiteParams } }, async (req, reply) => {
    await inWorkspace(req, 'run.execute', (trx, ws) => deleteSuite(trx, ws.id, req.params.suiteId));
    return reply.status(204).send();
  });
  /**
   * Starts a run. With wait=true (what CI uses, with a personal access token) the call returns once the
   * run has finished: check `status` for "passed", or fetch the JUnit file.
   */
  r.post(`${base}/workspaces/:workspaceId/suites/:suiteId/runs`, { schema: { params: SuiteParams, body: SuiteRunBody } }, async (req, reply) => {
    const run = await inWorkspace(req, 'run.execute', (trx, ws) => startSuiteRun(trx, callerOf(req), req.params.projectId, ws.id, req.params.suiteId, req.body.wait ? 'ci' : 'manual', req.body.environmentId));
    const ctx = suiteContext(req);
    if (!req.body.wait) {
      void executeSuiteRun(ctx, req.params.suiteId, run.id);
      return reply.status(201).send(run);
    }
    await executeSuiteRun(ctx, req.params.suiteId, run.id);
    return reply.status(200).send(await waitForRun(ctx, req.params.suiteId, run.id));
  });
  r.get(`${base}/workspaces/:workspaceId/suites/:suiteId/runs`, { schema: { params: SuiteParams } }, async (req) =>
    inWorkspace(req, 'run.read', async (trx, ws) => {
      await getSuite(trx, ws.id, req.params.suiteId);
      return listSuiteRuns(trx, req.params.suiteId);
    }),
  );
  r.get(`${base}/workspaces/:workspaceId/suites/:suiteId/trend`, { schema: { params: SuiteParams } }, async (req) =>
    inWorkspace(req, 'run.read', async (trx, ws) => {
      await getSuite(trx, ws.id, req.params.suiteId);
      return suiteTrend(trx, req.params.suiteId);
    }),
  );
  r.get(`${base}/workspaces/:workspaceId/suites/:suiteId/runs/:runId`, { schema: { params: SuiteRunParams } }, async (req) =>
    inWorkspace(req, 'run.read', async (trx, ws) => {
      await getSuite(trx, ws.id, req.params.suiteId);
      return getSuiteRun(trx, req.params.suiteId, req.params.runId);
    }),
  );
  r.post(`${base}/workspaces/:workspaceId/suites/:suiteId/runs/:runId/cancel`, { schema: { params: SuiteRunParams } }, async (req) =>
    inWorkspace(req, 'run.execute', async (trx, ws) => {
      await getSuite(trx, ws.id, req.params.suiteId);
      return cancelSuiteRun(trx, req.params.suiteId, req.params.runId);
    }),
  );
  r.get(`${base}/workspaces/:workspaceId/suites/:suiteId/runs/:runId/junit`, { schema: { params: SuiteRunParams } }, async (req, reply) => {
    const { suite, run } = await inWorkspace(req, 'run.read', async (trx, ws) => ({ suite: await getSuite(trx, ws.id, req.params.suiteId), run: await getSuiteRun(trx, req.params.suiteId, req.params.runId) }));
    return reply.type('application/xml').header('content-disposition', `attachment; filename="${suite.name.replace(/[^\w.-]+/g, '_')}-junit.xml"`).send(junit(suite.name, run.results, run.startedAt));
  });
  r.get(`${base}/workspaces/:workspaceId/suites/:suiteId/runs/:runId/report`, { schema: { params: SuiteRunParams } }, async (req, reply) => {
    const { suite, run } = await inWorkspace(req, 'run.read', async (trx, ws) => ({ suite: await getSuite(trx, ws.id, req.params.suiteId), run: await getSuiteRun(trx, req.params.suiteId, req.params.runId) }));
    return reply.type('text/html; charset=utf-8').header('content-disposition', `attachment; filename="${suite.name.replace(/[^\w.-]+/g, '_')}-report.html"`).send(htmlReport(suite.name, run, new Date().toISOString()));
  });

  // ---------- spec library ----------
  r.get(`${base}/specs`, { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => listSpecs(trx, req.params.projectId)),
  );
  // Specs run to 20 MB, above the app's 1 MB default body limit.
  r.post(`${base}/specs`, { bodyLimit: SPEC_MAX_BYTES + 1024 * 1024, schema: { params: Project, body: SpecUploadBody } }, async (req, reply) => {
    const content = req.body.content ?? (await fetchSpec(req.body.url!, apiStudio.allowPrivate));
    const parsed = parseUpload(content);
    const result = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      uploadSpec(trx, storage, callerOf(req), req.params.projectId, { name: req.body.name, sourceUrl: req.body.url ?? null, parsed }),
    );
    if (result.created && result.spec.version > 1) await afterNewVersion(req, result.spec.id, result.spec.version);
    return reply.status(result.created ? 201 : 200).send(result);
  });
  r.get(`${base}/specs/:specId`, { schema: { params: SpecParams, querystring: z.object({ version: z.coerce.number().int().min(1).optional() }) } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => getSpec(trx, req.params.projectId, req.params.specId, req.query.version)),
  );
  /** A new version from uploaded content, or fetched again from the spec's URL when no content is given. */
  r.post(`${base}/specs/:specId/versions`, { bodyLimit: SPEC_MAX_BYTES + 1024 * 1024, schema: { params: SpecParams, body: SpecVersionBody } }, async (req, reply) => {
    let content = req.body.content;
    if (!content) {
      const url = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => sourceOf(trx, req.params.projectId, req.params.specId));
      if (!url) throw badRequest('This spec was uploaded, not fetched from a URL; upload the new version instead.');
      content = await fetchSpec(url, apiStudio.allowPrivate);
    }
    const parsed = parseUpload(content);
    const result = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      addVersion(trx, storage, callerOf(req), req.params.projectId, req.params.specId, parsed),
    );
    if (result.created) await afterNewVersion(req, result.spec.id, result.spec.version);
    return reply.status(result.created ? 201 : 200).send(result);
  });
  r.delete(`${base}/specs/:specId`, { schema: { params: SpecParams } }, async (req, reply) => {
    await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => deleteSpec(trx, req.params.projectId, req.params.specId));
    return reply.status(204).send();
  });
  r.post(`${base}/specs/:specId/import`, { schema: { params: SpecParams, body: SpecImportBody } }, async (req, reply) => {
    const result = await projectTx(db, req, req.params.projectId, 'run.execute', async (trx) => {
      await workspaceFor(trx, req.params.projectId, req.body.workspaceId, req.auth.userId);
      return importToCollection(trx, box, callerOf(req), req.params.projectId, req.params.specId, req.body, storage);
    });
    return reply.status(201).send(result);
  });

  // ---------- load tests (plan §14) ----------
  const LoadParams = Ws.extend({ testId: z.uuid() });
  const LoadRunParams = LoadParams.extend({ runId: z.uuid() });
  r.get(`${base}/workspaces/:workspaceId/load-tests`, { schema: { params: Ws } }, async (req) => inWorkspace(req, 'run.read', (trx, ws) => listLoadTests(trx, ws.id)));
  r.post(`${base}/workspaces/:workspaceId/load-tests`, { schema: { params: Ws, body: LoadTestBody } }, async (req, reply) => {
    const t = await inWorkspace(req, 'run.execute', (trx, ws) => saveLoadTest(trx, callerOf(req), req.params.projectId, ws.id, req.body));
    return reply.status(201).send(t);
  });
  r.put(`${base}/workspaces/:workspaceId/load-tests/:testId`, { schema: { params: LoadParams, body: LoadTestBody } }, async (req) =>
    inWorkspace(req, 'run.execute', (trx, ws) => saveLoadTest(trx, callerOf(req), req.params.projectId, ws.id, req.body, req.params.testId)),
  );
  r.delete(`${base}/workspaces/:workspaceId/load-tests/:testId`, { schema: { params: LoadParams } }, async (req, reply) => {
    await inWorkspace(req, 'run.execute', (trx, ws) => deleteLoadTest(trx, ws.id, req.params.testId));
    return reply.status(204).send();
  });
  r.get(`${base}/workspaces/:workspaceId/load-tests/:testId`, { schema: { params: LoadParams } }, async (req) => inWorkspace(req, 'run.read', (trx, ws) => getLoadTest(trx, ws.id, req.params.testId)));
  /** The test as a k6 script, for more capacity than Testbench runs itself. Secrets become environment variables. */
  r.get(`${base}/workspaces/:workspaceId/load-tests/:testId/k6`, { schema: { params: LoadParams } }, async (req, reply) => {
    const caller = callerOf(req);
    const prepared = await inWorkspace(req, 'run.execute', (trx, ws) => prepareLoadRun(trx, box, caller, storage, req.params.projectId, ws.id, req.params.testId, { inProcess: false }));
    const built = await buildAll(prepared, { allowPrivate: apiStudio.allowPrivate });
    return reply.type('text/javascript; charset=utf-8').send(await exportK6(prepared, built));
  });
  r.post(`${base}/workspaces/:workspaceId/load-tests/:testId/runs`, { schema: { params: LoadParams, body: LoadRunBody } }, async (req, reply) => {
    const caller = callerOf(req);
    const cfg = { allowPrivate: apiStudio.allowPrivate };
    const prepared = await inWorkspace(req, 'run.execute', (trx, ws) => prepareLoadRun(trx, box, caller, storage, req.params.projectId, ws.id, req.params.testId, { inProcess: true }));
    const built = await buildAll(prepared, cfg);
    const { runId } = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      startLoadRun(trx, cfg, caller, req.params.projectId, prepared, built, { requested: req.body.productionOverride, canOverride: canManage(req, req.params.projectId) }),
    );
    void executeLoadRun({ db, storage, box, cfg, caller, projectId: req.params.projectId }, runId, prepared, built);
    return reply.status(201).send(await inWorkspace(req, 'run.read', (trx, ws) => getLoadRun(trx, ws.id, req.params.testId, runId)));
  });
  r.get(`${base}/workspaces/:workspaceId/load-tests/:testId/runs`, { schema: { params: LoadParams } }, async (req) => inWorkspace(req, 'run.read', (trx, ws) => listLoadRuns(trx, ws.id, req.params.testId)));
  r.get(`${base}/workspaces/:workspaceId/load-tests/:testId/runs/:runId`, { schema: { params: LoadRunParams } }, async (req) =>
    inWorkspace(req, 'run.read', (trx, ws) => getLoadRun(trx, ws.id, req.params.testId, req.params.runId)),
  );
  r.post(`${base}/workspaces/:workspaceId/load-tests/:testId/runs/:runId/cancel`, { schema: { params: LoadRunParams } }, async (req) =>
    inWorkspace(req, 'run.execute', async (trx, ws) => {
      const run = await getLoadRun(trx, ws.id, req.params.testId, req.params.runId);
      if (run.status === 'running') cancelLoadRun(run.id);
      return run;
    }),
  );
};
