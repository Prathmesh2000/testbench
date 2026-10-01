import {
  CapturedElementsBody,
  CODE_PATH,
  ChatBody,
  GenerateTestsBody,
  IntentBuildBody,
  IntentCommitBody,
  Scenario,
  ScenarioBuildBody,
  JourneyBody,
  SitePageBody,
  WorkflowPlan,
  WorkflowDraftBody,
  WorkflowSaveBody,
  type ChatAnswer,
  type Workflow,
  type LiveFrame,
  SaveCodeFileBody,
  SaveComponentBody,
  SaveElementBody,
  SaveTestBody,
  StartAutoRunBody,
  StartSessionBody,
  UiReviewBody,
  type UiReviewResult,
} from '@tb/contracts';
import type { AiService } from '@tb/ai';
import { projectTx, requirePermission } from '@tb/iam';
import { badRequest, liveFrameKey, notFound, withTenant, type ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { allFiles, createStarter, deleteFile, getFile, listFiles, renameFile, saveFile } from './code';
import { pickerSession, readPickerTicket, saveCaptured } from './picker';
import { cancelRun, getRun, listRuns, startRun } from './runs';
import { aiInput, applyAnswer } from './intent/ai';
import { applyChat, differences, expectationFromSeen } from './intent/scenarios';
import { buildScenarios, fieldOffers } from './intent/validations';
import { generateForWorkflow, generateJourney } from './intent/journeys';
import { getPlan, listPages, savePage, savePlan, siteGraph } from './site';
import { commitDraft, draftFromRecording, prerequisiteSuggestions } from './intent/service';
import { archiveWorkflow, chatInput, draftWorkflowFromRecording, getWorkflow, listWorkflows, saveWorkflow } from './intent/workflow-service';
import { endSession, startSession, type BrowserConfig } from './sessions';
import { maskedReview } from './ui-review';
import {
  archiveTest,
  ejectTest,
  getTest,
  listComponents,
  listElements,
  listTests,
  saveComponent,
  saveElement,
  saveTest,
  testCode,
} from './tests';

const Project = z.object({ projectId: z.uuid() });
const TestParams = Project.extend({ testId: z.uuid() });
const VersionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const callerOf = (req: FastifyRequest) => ({ orgId: req.auth.orgId, userId: req.auth.userId });

// Automation is built by the people who execute tests, so writing it needs the same permission as
// recording results; reading it is open to anyone who can see runs.
export const studioRoutes: FastifyPluginAsync<ServiceDeps & { browser: BrowserConfig; webUrl: string; ai: AiService }> = async (
  app,
  { db, storage, cache, browser, webUrl, ai },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- Test Browser sessions ----------

  /**
   * An AI review of a page the tester scanned in the Test Browser. Nothing is stored. Without a model
   * (or permission to use one) the answer is empty and says why: the rule-based suggestions the web
   * app already shows still stand.
   */
  r.post('/projects/:projectId/studio/ui-review', { schema: { params: Project, body: UiReviewBody } }, async (req): Promise<UiReviewResult> => {
    requirePermission(req, req.params.projectId, 'run.execute');
    const none = (status: UiReviewResult['ai']['status'], message: string): UiReviewResult => ({ summary: '', suggestions: [], ai: { status, message } });
    try {
      requirePermission(req, req.params.projectId, 'ai.use');
    } catch {
      return none('off', 'You do not have permission to use AI in this project.');
    }
    try {
      const answer = await ai.run(callerOf(req), 'ui_review', maskedReview(req.body));
      return { ...answer.result, ai: { status: 'used', message: `${answer.provider} · ${answer.model}` } };
    } catch (err) {
      return none('unavailable', err instanceof Error ? err.message : 'The AI model could not be reached.');
    }
  });
  r.post('/projects/:projectId/sessions', { schema: { params: Project, body: StartSessionBody } }, async (req, reply) => {
    const session = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      startSession(trx, browser, callerOf(req), req.params.projectId, req.body),
    );
    return reply.status(201).send(session);
  });
  r.delete(
    '/projects/:projectId/sessions/:sessionId',
    { schema: { params: Project.extend({ sessionId: z.uuid() }) } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
        endSession(trx, req.auth.userId, req.params.sessionId),
      );
      return reply.status(204).send();
    },
  );

  // ---------- intent builds ----------
  // Build returns a draft to review and saves nothing; commit saves the reviewed draft in one go.
  r.post('/projects/:projectId/studio/intent/build', { schema: { params: Project, body: IntentBuildBody } }, async (req) => {
    const { draft, context } = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      draftFromRecording(trx, req.params.projectId, req.body),
    );
    if (!req.body.useAi) return draft;
    try {
      requirePermission(req, req.params.projectId, 'ai.use');
    } catch {
      return { ...draft, ai: { status: 'off', message: 'You do not have permission to use AI in this project, so this draft uses the rules only.' } };
    }
    // Outside the transaction: a local model can take a minute, and nothing here needs the database.
    try {
      const answer = await ai.run(callerOf(req), 'intent_test', aiInput(draft, context));
      return { ...applyAnswer(draft, context, answer.result), ai: { status: 'used', message: `${answer.provider} · ${answer.model}` } };
    } catch (err) {
      return { ...draft, ai: { status: 'unavailable', message: `${err instanceof Error ? err.message : 'The AI model could not be reached'} The draft uses the rules only.` } };
    }
  });
  r.post('/projects/:projectId/studio/intent/commit', { schema: { params: Project, body: IntentCommitBody } }, async (req, reply) => {
    // It writes data sets as well as tests and components.
    requirePermission(req, req.params.projectId, 'case.write');
    const result = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      commitDraft(trx, callerOf(req), req.params.projectId, req.body),
    );
    return reply.status(201).send(result);
  });
  r.post(
    '/projects/:projectId/studio/intent/prerequisites',
    { schema: { params: Project, body: z.object({ text: z.string().trim().max(2000) }) } },
    async (req) => projectTx(db, req, req.params.projectId, 'run.read', (trx) => prerequisiteSuggestions(trx, req.params.projectId, req.body.text)),
  );

  // ---------- workflows ----------
  r.get('/projects/:projectId/studio/workflows', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => listWorkflows(trx, req.params.projectId)),
  );
  r.post('/projects/:projectId/studio/workflows/draft', { schema: { params: Project, body: WorkflowDraftBody } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) => draftWorkflowFromRecording(trx, req.params.projectId, req.body)),
  );
  r.post('/projects/:projectId/studio/workflows', { schema: { params: Project, body: WorkflowSaveBody } }, async (req, reply) => {
    const saved = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      saveWorkflow(trx, callerOf(req), req.params.projectId, req.body.draft),
    );
    return reply.status(201).send(saved);
  });
  /**
   * One model turn over the scenarios. Without a model (or permission to use it) the list stands as it
   * is, so the tester can still edit and run it. `keep` are scenarios the tester chose, never dropped.
   */
  const scenarioTurn = async (
    req: FastifyRequest,
    projectId: string,
    workflow: Workflow,
    turn: { messages: ChatBody['messages']; scenarios: Scenario[]; intent: string; validations: ScenarioBuildBody['validations'] },
    keep: Scenario[],
    fallbackReply: string,
  ): Promise<ChatAnswer> => {
    const fallback = (message: string | null, status: ChatAnswer['ai']['status']): ChatAnswer => ({ reply: fallbackReply, scenarios: turn.scenarios, ai: { status, message } });
    try {
      requirePermission(req, projectId, 'ai.use');
    } catch {
      return fallback('You do not have permission to use AI in this project.', 'off');
    }
    try {
      const answer = await ai.run(callerOf(req), 'scenario_chat', chatInput(workflow, turn.messages, turn.scenarios, turn.intent, turn.validations));
      const { scenarios, dropped } = applyChat(workflow, turn.scenarios, answer.result);
      const kept = [...scenarios, ...keep.filter((k) => !scenarios.some((s) => s.id === k.id))];
      const note = dropped ? `\n\n(${dropped} suggested scenario${dropped === 1 ? ' was' : 's were'} left out: they used fields the workflow does not have, or values a field cannot hold.)` : '';
      return { reply: answer.result.reply + note, scenarios: kept, ai: { status: 'used', message: `${answer.provider} · ${answer.model}` } };
    } catch (err) {
      return fallback(err instanceof Error ? err.message : 'The AI model could not be reached.', 'unavailable');
    }
  };

  // What each field's type, role and rules suggest checking: the tester picks and answers.
  r.get(
    '/projects/:projectId/studio/workflows/:workflowId/validations',
    { schema: { params: Project.extend({ workflowId: z.uuid() }) } },
    async (req) => {
      const { workflow } = await projectTx(db, req, req.params.projectId, 'run.read', (trx) => getWorkflow(trx, req.params.projectId, req.params.workflowId));
      return fieldOffers(workflow);
    },
  );
  // Scenarios from the tester's intent and field checks; the model adds only what the intent needs.
  r.post(
    '/projects/:projectId/studio/workflows/:workflowId/scenarios',
    { schema: { params: Project.extend({ workflowId: z.uuid() }), body: ScenarioBuildBody } },
    async (req): Promise<ChatAnswer> => {
      const { workflow } = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => getWorkflow(trx, req.params.projectId, req.params.workflowId));
      const built = buildScenarios(workflow, req.body.validations);
      return scenarioTurn(
        req,
        req.params.projectId,
        workflow,
        { messages: [{ role: 'tester', text: req.body.intent }], scenarios: built, intent: req.body.intent, validations: req.body.validations },
        built,
        `${built.length} scenarios from your field checks. Run them to see what the app does, or tell me what to change.`,
      );
    },
  );
  // One chat turn: the model's reply and the scenario list as it now stands.
  r.post(
    '/projects/:projectId/studio/workflows/:workflowId/chat',
    { schema: { params: Project.extend({ workflowId: z.uuid() }), body: ChatBody } },
    async (req): Promise<ChatAnswer> => {
      const { workflow } = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => getWorkflow(trx, req.params.projectId, req.params.workflowId));
      return scenarioTurn(
        req,
        req.params.projectId,
        workflow,
        req.body,
        [],
        'The AI is not available, so I cannot discuss this; edit the scenarios in the list, or run them to see what the app does.',
      );
    },
  );
  // What a discovery run saw, as an expectation to confirm, and where it disagrees with the scenario.
  r.post(
    '/projects/:projectId/studio/workflows/:workflowId/seen',
    { schema: { params: Project.extend({ workflowId: z.uuid() }), body: z.object({ scenario: Scenario }) } },
    async (req) => {
      const { workflow } = await projectTx(db, req, req.params.projectId, 'run.read', (trx) => getWorkflow(trx, req.params.projectId, req.params.workflowId));
      const s = req.body.scenario;
      if (!s.seen) throw badRequest('That scenario has not been run yet.');
      return { proposed: expectationFromSeen(workflow, s.seen), differences: differences(workflow, s.expect, s.seen) };
    },
  );
  r.post(
    '/projects/:projectId/studio/workflows/:workflowId/tests',
    { schema: { params: Project.extend({ workflowId: z.uuid() }), body: GenerateTestsBody } },
    async (req, reply) => {
      // It writes data sets as well as tests.
      requirePermission(req, req.params.projectId, 'case.write');
      const out = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
        generateForWorkflow(trx, callerOf(req), req.params.projectId, req.params.workflowId, req.body.title, req.body.scenarios),
      );
      return reply.status(201).send(out);
    },
  );

  // ---------- site map: pages the Test Browser reached, the workflows between them ----------
  r.post('/projects/:projectId/studio/site/pages', { schema: { params: Project, body: SitePageBody } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) => savePage(trx, callerOf(req).orgId, req.params.projectId, req.body)),
  );
  r.get('/projects/:projectId/studio/site/pages', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => listPages(trx, req.params.projectId)),
  );
  r.get('/projects/:projectId/studio/site/graph', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => siteGraph(trx, req.params.projectId)),
  );
  r.delete('/projects/:projectId/studio/workflows/:workflowId', { schema: { params: Project.extend({ workflowId: z.uuid() }) } }, async (req, reply) => {
    await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => archiveWorkflow(trx, req.params.projectId, req.params.workflowId));
    return reply.status(204).send();
  });
  // What testers settled for a workflow, kept with it: intent, field validation, chat, scenarios, checks.
  r.get('/projects/:projectId/studio/workflows/:workflowId/plan', { schema: { params: Project.extend({ workflowId: z.uuid() }) } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', async (trx) => {
      await getWorkflow(trx, req.params.projectId, req.params.workflowId);
      return getPlan(trx, req.params.projectId, req.params.workflowId);
    }),
  );
  r.put('/projects/:projectId/studio/workflows/:workflowId/plan', { schema: { params: Project.extend({ workflowId: z.uuid() }), body: WorkflowPlan } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', async (trx) => {
      await getWorkflow(trx, req.params.projectId, req.params.workflowId);
      return savePlan(trx, callerOf(req), req.params.projectId, req.params.workflowId, req.body);
    }),
  );
  // Workflows in order as one journey: its tests, and the test case they automate.
  r.post('/projects/:projectId/studio/journeys', { schema: { params: Project, body: JourneyBody } }, async (req, reply) => {
    requirePermission(req, req.params.projectId, 'case.write');
    const out = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => generateJourney(trx, callerOf(req), req.params.projectId, req.body));
    return reply.status(201).send(out);
  });

  // ---------- automated tests ----------
  r.get('/projects/:projectId/studio/tests', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => listTests(trx, req.params.projectId)),
  );
  r.post('/projects/:projectId/studio/tests', { schema: { params: Project, body: SaveTestBody } }, async (req, reply) => {
    const test = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      saveTest(trx, callerOf(req), req.params.projectId, req.body),
    );
    return reply.status(201).send(test);
  });
  r.get('/projects/:projectId/studio/tests/:testId', { schema: { params: TestParams, querystring: VersionQuery } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
      getTest(trx, req.params.projectId, req.params.testId, req.query.version),
    ),
  );
  r.put('/projects/:projectId/studio/tests/:testId', { schema: { params: TestParams, body: SaveTestBody } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      saveTest(trx, callerOf(req), req.params.projectId, req.body, req.params.testId),
    ),
  );
  r.delete('/projects/:projectId/studio/tests/:testId', { schema: { params: TestParams } }, async (req, reply) => {
    await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      archiveTest(trx, callerOf(req), req.params.projectId, req.params.testId),
    );
    return reply.status(204).send();
  });
  r.get(
    '/projects/:projectId/studio/tests/:testId/code',
    { schema: { params: TestParams, querystring: VersionQuery } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        testCode(trx, req.params.projectId, req.params.testId, req.query.version),
      ),
  );

  // ---------- automated runs ----------
  // A personal access token works here too, which is how CI pipelines start runs (§12.2).
  r.post('/projects/:projectId/studio/runs', { schema: { params: Project, body: StartAutoRunBody } }, async (req, reply) => {
    const run = await projectTx(db, req, req.params.projectId, 'run.create', (trx) =>
      startRun(trx, callerOf(req), req.params.projectId, req.body),
    );
    return reply.status(201).send(run);
  });
  r.get('/projects/:projectId/studio/runs', { schema: { params: Project, querystring: z.object({ testId: z.uuid().optional() }) } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => listRuns(trx, req.params.projectId, undefined, req.query.testId)),
  );
  // What a running item shows right now. The item is looked up in the caller's tenant transaction
  // first, so a frame is only ever served for a run in a project the caller may see.
  r.get(
    '/projects/:projectId/studio/runs/:runId/items/:itemId/live',
    { schema: { params: Project.extend({ runId: z.uuid(), itemId: z.uuid() }) } },
    async (req, reply) => {
      const item = await projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        trx
          .selectFrom('studio.auto_run_item as i')
          .innerJoin('studio.auto_run as r', 'r.id', 'i.run_id')
          .select(['i.id', 'i.status'])
          .where('i.id', '=', req.params.itemId)
          .where('r.id', '=', req.params.runId)
          .where('r.project_id', '=', req.params.projectId)
          .executeTakeFirst(),
      );
      if (!item) throw notFound('Run item');
      const live = item.status === 'running' ? await cache.get<LiveFrame>(liveFrameKey(item.id)) : undefined;
      return live ? live : reply.status(204).send();
    },
  );
  r.get('/projects/:projectId/studio/runs/:runId', { schema: { params: Project.extend({ runId: z.uuid() }) } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
      getRun(trx, storage, req.params.projectId, req.params.runId),
    ),
  );
  r.post(
    '/projects/:projectId/studio/runs/:runId/cancel',
    { schema: { params: Project.extend({ runId: z.uuid() }) } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'run.create', (trx) =>
        cancelRun(trx, req.params.projectId, req.params.runId),
      );
      return reply.status(204).send();
    },
  );

  r.post('/projects/:projectId/studio/tests/:testId/eject', { schema: { params: TestParams } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      ejectTest(trx, callerOf(req), req.params.projectId, req.params.testId),
    ),
  );

  // ---------- code workspace ----------
  const PathQuery = z.object({ path: z.string().regex(CODE_PATH) });
  r.get(
    '/projects/:projectId/studio/code',
    { schema: { params: Project, querystring: z.object({ content: z.enum(['0', '1']).default('0') }) } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.read', (trx) =>
        req.query.content === '1' ? allFiles(trx, req.params.projectId) : listFiles(trx, req.params.projectId),
      ),
  );
  r.post(
    '/projects/:projectId/studio/code/rename',
    { schema: { params: Project, body: z.object({ from: z.string().regex(CODE_PATH), to: z.string().max(300) }) } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
        renameFile(trx, callerOf(req), req.params.projectId, req.body.from, req.body.to),
      ),
  );
  r.get('/projects/:projectId/studio/code/file', { schema: { params: Project, querystring: PathQuery } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => getFile(trx, req.params.projectId, req.query.path)),
  );
  r.put('/projects/:projectId/studio/code/file', { schema: { params: Project, body: SaveCodeFileBody } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      saveFile(trx, callerOf(req), req.params.projectId, req.body),
    ),
  );
  r.delete('/projects/:projectId/studio/code/file', { schema: { params: Project, querystring: PathQuery } }, async (req, reply) => {
    await projectTx(db, req, req.params.projectId, 'run.execute', (trx) => deleteFile(trx, req.params.projectId, req.query.path));
    return reply.status(204).send();
  });
  r.post('/projects/:projectId/studio/code/starter', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) => createStarter(trx, callerOf(req), req.params.projectId)),
  );

  // ---------- locator picker ----------
  // The tester picks locators in their own browser on their own site; these two routes hand out the
  // pass and take back what they kept (testing-studio-plan §3.1).
  r.post('/projects/:projectId/studio/picker', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', async () =>
      pickerSession(browser.secret, webUrl, callerOf(req), req.params.projectId),
    ),
  );
  // Authenticated by the picker ticket, not a session: it is called from the tester's own site.
  r.post('/studio/picker/captured', { schema: { body: CapturedElementsBody } }, async (req) => {
    const claims = readPickerTicket(browser.secret, req.body.ticket);
    return withTenant(db, { orgId: claims.org, userId: claims.user }, (trx) => saveCaptured(trx, claims, req.body));
  });

  // ---------- page library ----------
  r.get('/projects/:projectId/studio/elements', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => listElements(trx, req.params.projectId)),
  );
  r.put('/projects/:projectId/studio/elements', { schema: { params: Project, body: SaveElementBody } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
      saveElement(trx, callerOf(req), req.params.projectId, req.body),
    ),
  );

  // ---------- components ----------
  r.get('/projects/:projectId/studio/components', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => listComponents(trx, req.params.projectId)),
  );
  r.post(
    '/projects/:projectId/studio/components',
    { schema: { params: Project, body: SaveComponentBody } },
    async (req, reply) => {
      const component = await projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
        saveComponent(trx, callerOf(req), req.params.projectId, req.body),
      );
      return reply.status(201).send(component);
    },
  );
  r.put(
    '/projects/:projectId/studio/components/:componentId',
    { schema: { params: Project.extend({ componentId: z.uuid() }), body: SaveComponentBody } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'run.execute', (trx) =>
        saveComponent(trx, callerOf(req), req.params.projectId, req.body, req.params.componentId),
      ),
  );
};
