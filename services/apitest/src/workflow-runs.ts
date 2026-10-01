import { ApiWorkflowDef, type ApiWorkflowRun, type ApiWorkflowRunBody, type ApiWorkflowRunStatus, type ApiWorkflowStepResult } from '@tb/contracts';
import { AppError, badRequest, conflict, notFound, withTenant, type Db, type ObjectStorage, type Tx } from '@tb/platform';
import { sql } from 'kysely';
import { runOneStep, runWorkflow, type EngineDeps, type StepSend } from './engine';
import { maskSecrets } from './resolve';
import { buildSend, factsOf, loadSend, performSend, rawExtracted, recordSend, type SendConfig } from './send';
import { getWorkflow } from './workflows';
import { getNode, workspaceFor, type Caller, type SecretBox } from './workspaces';

// Workflow runs (plan §12). "all" runs in the background of this process and writes each step result
// as it happens, so the UI can watch; "step" runs one top-level step per call, with the variables kept
// encrypted between calls. Every request goes through the same send path as the builder, so history,
// masking, cookies, profiles and certificates behave the same.
// ponytail: background runs live in the core-api process, so a restart abandons them (they are marked
// failed when next read). They move to the runner queue with scheduled suites (plan phase A3).

export interface RunContext {
  db: Db;
  storage: ObjectStorage;
  box: SecretBox;
  cfg: SendConfig;
  caller: Caller;
  projectId: string;
  workspaceId: string;
}

const STALE_MS = 15 * 60_000;
/** Runs cancelled while going; checked before each step. */
const cancelled = new Set<string>();

type RunRow = { id: string; workflow_id: string; version: number; status: string; mode: string; next_step: number; results: unknown[]; error: string | null; started_at: Date; updated_at: Date; finished_at: Date | null };

function runView(r: RunRow): ApiWorkflowRun {
  // A run nobody has touched for a while was abandoned by a restart.
  const stale = r.status === 'running' && Date.now() - r.updated_at.getTime() > STALE_MS;
  return {
    id: r.id,
    workflowId: r.workflow_id,
    version: r.version,
    status: (stale ? 'error' : r.status) as ApiWorkflowRunStatus,
    mode: r.mode as 'all' | 'step',
    next: r.next_step,
    results: r.results as ApiWorkflowStepResult[],
    error: stale ? 'The server restarted while this ran; run it again.' : r.error,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

const runColumns = ['id', 'workflow_id', 'version', 'status', 'mode', 'next_step', 'results', 'error', 'started_at', 'updated_at', 'finished_at'] as const;

export async function listRuns(trx: Tx, workflowId: string, userId: string): Promise<ApiWorkflowRun[]> {
  const rows = await trx.selectFrom('apitest.workflow_run').select(runColumns).where('workflow_id', '=', workflowId).where('user_id', '=', userId).orderBy('started_at', 'desc').limit(20).execute();
  return rows.map(runView);
}

export async function getRun(trx: Tx, workflowId: string, runId: string, userId: string): Promise<ApiWorkflowRun> {
  const r = await trx.selectFrom('apitest.workflow_run').select(runColumns).where('id', '=', runId).where('workflow_id', '=', workflowId).where('user_id', '=', userId).executeTakeFirst();
  if (!r) throw notFound('Run');
  return runView(r);
}

export async function startRun(trx: Tx, box: SecretBox, caller: Caller, projectId: string, workspaceId: string, workflowId: string, body: ApiWorkflowRunBody): Promise<ApiWorkflowRun> {
  const wf = await getWorkflow(trx, workspaceId, workflowId);
  if (!wf.def.steps.length) throw badRequest('This workflow has no steps yet.');
  if (body.mode === 'step' && !box) throw new AppError(503, 'secrets_unavailable', 'Step-by-step runs keep your variables between steps, which needs API_STUDIO_SECRET on the server.');
  const row = await trx
    .insertInto('apitest.workflow_run')
    .values({
      org_id: caller.orgId,
      project_id: projectId,
      workflow_id: workflowId,
      version: wf.version,
      user_id: caller.userId,
      environment_id: body.environmentId,
      mode: body.mode,
      status: body.mode === 'step' ? 'paused' : 'running',
      state_enc: box ? box.encrypt(JSON.stringify({ vars: body.locals, secrets: [], failed: false })) : null,
      updated_at: new Date(),
    })
    .returning(runColumns)
    .executeTakeFirstOrThrow();
  return runView(row);
}

export async function cancelRun(trx: Tx, workflowId: string, runId: string, userId: string): Promise<ApiWorkflowRun> {
  const run = await getRun(trx, workflowId, runId, userId);
  if (run.status !== 'running' && run.status !== 'paused') throw conflict('This run has already finished.');
  cancelled.add(runId);
  await trx.updateTable('apitest.workflow_run').set({ status: 'cancelled', finished_at: new Date(), updated_at: new Date(), state_enc: null }).where('id', '=', runId).execute();
  return getRun(trx, workflowId, runId, userId);
}

/** The engine's view of the world for one run: sends through the builder's path, results into the row. */
/**
 * The engine's view of the world: sends through the builder's path. By default results go onto the
 * workflow run row; a suite passes its own hooks instead, running a workflow as one of its items.
 */
export function engineDeps(
  ctx: RunContext,
  runId: string,
  environmentId: string | null,
  secrets: Set<string>,
  hooks: { onResult?: EngineDeps['onResult']; cancelled?: () => boolean } = {},
): EngineDeps {
  const tenant = <T>(fn: (trx: Tx) => Promise<T>) => withTenant(ctx.db, { orgId: ctx.caller.orgId, userId: ctx.caller.userId }, fn);
  return {
    async send(requestId, variationId, vars): Promise<StepSend> {
      const { loaded, ws } = await tenant(async (trx) => {
        const ws = await workspaceFor(trx, ctx.projectId, ctx.workspaceId, ctx.caller.userId);
        const node = await getNode(trx, ws.id, requestId);
        if (!node.request) throw badRequest('A step points at a folder, not a request.');
        const loaded = await loadSend(trx, ctx.box, ctx.caller, ws, { request: node.request, nodeId: node.id, parentId: null, variationId, environmentId, cookies: 'saved', locals: vars }, { storage: ctx.storage, projectId: ctx.projectId });
        return { loaded, ws };
      });
      const p = await buildSend(loaded, ctx.cfg);
      const sent = await performSend(p, ctx.cfg);
      const result = await tenant((trx) => recordSend(trx, ctx.box, ctx.caller, ctx.projectId, ws.id, p, sent));
      for (const sec of p.secrets) secrets.add(sec);
      const r = sent.outcome.response;
      const failing = result.assertions.filter((a) => !a.passed).map((a) => a.message);
      const scriptErrors = result.scriptErrors.map((e) => `${e.source}: ${e.message}`);
      return {
        passed: !result.error && failing.length === 0 && scriptErrors.length === 0,
        message: result.error?.message ?? [...failing, ...scriptErrors].join('; '),
        historyId: result.historyId,
        facts: r ? factsOf(r, sent.outcome.timings.totalMs) : null,
        extracted: rawExtracted(p, sent),
      };
    },
    loadWorkflow: (id) => tenant(async (trx) => {
      const wf = await getWorkflow(trx, ctx.workspaceId, id);
      return { name: wf.name, def: wf.def };
    }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    onResult: hooks.onResult ?? ((r) =>
      tenant(async (trx) => {
        await sql`UPDATE apitest.workflow_run SET results = results || ${JSON.stringify([r])}::jsonb, updated_at = now() WHERE id = ${runId}`.execute(trx);
      })),
    mask: (t) => maskSecrets(t, [...secrets]),
    cancelled: hooks.cancelled ?? (() => cancelled.has(runId)),
  };
}

async function loadDef(ctx: RunContext, runId: string) {
  return withTenant(ctx.db, { orgId: ctx.caller.orgId, userId: ctx.caller.userId }, async (trx) => {
    const run = await trx.selectFrom('apitest.workflow_run').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    const v = await trx.selectFrom('apitest.workflow_version').select('def').where('workflow_id', '=', run.workflow_id).where('version', '=', run.version).executeTakeFirstOrThrow();
    return { run, def: ApiWorkflowDef.parse(v.def) };
  });
}

/** Runs a whole workflow in the background. Never throws: failures end up on the run row. */
export async function executeRun(ctx: RunContext, runId: string, locals: Record<string, string>): Promise<void> {
  const finish = (status: string, error: string | null) =>
    withTenant(ctx.db, { orgId: ctx.caller.orgId, userId: ctx.caller.userId }, (trx) =>
      trx.updateTable('apitest.workflow_run').set({ status, error, finished_at: new Date(), updated_at: new Date(), state_enc: null }).where('id', '=', runId).where('status', '=', 'running').execute(),
    );
  try {
    const { run, def } = await loadDef(ctx, runId);
    const secrets = new Set<string>();
    const out = await runWorkflow(def, { ...locals }, engineDeps(ctx, runId, run.environment_id, secrets));
    await finish(out.status, out.error ? maskSecrets(out.error, [...secrets]) : null);
  } catch (err) {
    await finish('error', err instanceof Error ? err.message : 'The run failed').catch(() => undefined);
  } finally {
    cancelled.delete(runId);
  }
}

/** Runs the next top-level step of a step-by-step run and says where it stands. */
export async function stepRun(ctx: RunContext, workflowId: string, runId: string): Promise<ApiWorkflowRun> {
  const tenant = <T>(fn: (trx: Tx) => Promise<T>) => withTenant(ctx.db, { orgId: ctx.caller.orgId, userId: ctx.caller.userId }, fn);
  const current = await tenant((trx) => getRun(trx, workflowId, runId, ctx.caller.userId));
  if (current.mode !== 'step') throw conflict('This run is not step by step.');
  if (current.status !== 'paused') throw conflict('This run has finished.');
  // Claimed so two clicks on "next step" cannot run the same step twice.
  const claimed = await tenant((trx) =>
    trx.updateTable('apitest.workflow_run').set({ status: 'running', updated_at: new Date() }).where('id', '=', runId).where('status', '=', 'paused').executeTakeFirst(),
  );
  if (!claimed.numUpdatedRows) throw conflict('That step is already running.');
  const { run, def } = await loadDef(ctx, runId);
  const state = run.state_enc && ctx.box ? (JSON.parse(ctx.box.decrypt(run.state_enc)) as { vars: Record<string, string>; secrets: string[]; failed?: boolean }) : { vars: {}, secrets: [], failed: false };
  const secrets = new Set(state.secrets);
  const out = await runOneStep(def, run.next_step, state.vars, engineDeps(ctx, runId, run.environment_id, secrets), state.failed ?? false).catch((err: unknown) => ({
    done: true,
    status: 'error' as const,
    error: err instanceof Error ? err.message : 'The step failed',
    failed: true,
  }));
  await tenant((trx) =>
    trx
      .updateTable('apitest.workflow_run')
      .set({
        status: out.status,
        next_step: run.next_step + 1,
        error: out.error ? maskSecrets(out.error, [...secrets]) : null,
        state_enc: out.done || !ctx.box ? null : ctx.box.encrypt(JSON.stringify({ vars: state.vars, secrets: [...secrets], failed: out.failed })),
        updated_at: new Date(),
        ...(out.done ? { finished_at: new Date() } : {}),
      })
      .where('id', '=', runId)
      .execute(),
  );
  return tenant((trx) => getRun(trx, workflowId, runId, ctx.caller.userId));
}
