import {
  CapturedElementsBody,
  CODE_PATH,
  SaveCodeFileBody,
  SaveComponentBody,
  SaveElementBody,
  SaveTestBody,
  StartAutoRunBody,
  StartSessionBody,
} from '@tb/contracts';
import { projectTx } from '@tb/iam';
import { withTenant, type ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { allFiles, createStarter, deleteFile, getFile, listFiles, renameFile, saveFile } from './code';
import { pickerSession, readPickerTicket, saveCaptured } from './picker';
import { cancelRun, getRun, listRuns, startRun } from './runs';
import { endSession, startSession, type BrowserConfig } from './sessions';
import {
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
export const studioRoutes: FastifyPluginAsync<ServiceDeps & { browser: BrowserConfig; webUrl: string }> = async (
  app,
  { db, storage, browser, webUrl },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- Test Browser sessions ----------
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
  r.get('/projects/:projectId/studio/runs', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'run.read', (trx) => listRuns(trx, req.params.projectId)),
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
