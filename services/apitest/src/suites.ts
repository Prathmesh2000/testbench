import {
  ApiRequestDef,
  ApiWorkflowDef,
  SuiteItem,
  SuiteSchedule,
  SuiteSettings,
  type ApiSuite,
  type HttpMethod,
  type SuiteBody,
  type SuiteResult,
  type SuiteRun,
  type SuiteRunStatus,
  type SuiteRunTotals,
  type SuiteTrend,
  type SuiteTrigger,
} from '@tb/contracts';
import { badRequest, conflict, notFound, recordEvent, withTenant, type Db, type ObjectStorage, type Tx } from '@tb/platform';
import { sql } from 'kysely';
import { runWorkflow } from './engine';
import { maskSecrets } from './resolve';
import { buildSend, loadSend, performSend, recordSend, type SendConfig } from './send';
import { CronError, nextRun, parseCron, pool, settle, totals } from './suite';
import { engineDeps } from './workflow-runs';
import { getNode, workspaceFor, type Caller, type SecretBox } from './workspaces';

// Suites (plan §13): requests, variations and workflows run together on a trigger. Runs go on in the
// background of this process and write each result as it lands, so the UI and CI can watch.
// ponytail: in-process like workflow runs; moves to the runner queue when runs need to outlive a
// restart or spread across machines. An abandoned run is reported as an error when next read.

export interface SuiteContext {
  db: Db;
  storage: ObjectStorage;
  box: SecretBox;
  cfg: SendConfig;
  caller: Caller;
  projectId: string;
  workspaceId: string;
}

const STALE_MS = 15 * 60_000;
const cancelled = new Set<string>();
const isUnique = (err: unknown) => (err as { code?: string }).code === '23505';

/** When the scheduler should next start a suite: the sooner of its cron and its monitor. */
export function computeNextRun(schedule: SuiteSchedule, from = new Date()): Date | null {
  const candidates: Date[] = [];
  if (schedule.cron) candidates.push(nextRun(schedule.cron, from));
  if (schedule.monitor) candidates.push(new Date(from.getTime() + schedule.monitor.everyMinutes * 60_000));
  return candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
}

type SuiteRow = { id: string; name: string; items: unknown[]; settings: Record<string, unknown>; schedule: Record<string, unknown>; next_run_at: Date | null; updated_at: Date };
type RunRow = { id: string; suite_id: string; trigger: string; status: string; environment_id: string | null; totals: Record<string, unknown>; error: string | null; started_at: Date; updated_at: Date; finished_at: Date | null; triggered_by: string | null };

const emptyTotals = (): SuiteRunTotals => ({ total: 0, passed: 0, flaky: 0, failed: 0, errored: 0, skipped: 0, drift: 0, p50Ms: 0, p95Ms: 0 });

function runView(r: RunRow, results: SuiteResult[] = []): SuiteRun {
  const stale = r.status === 'running' && Date.now() - r.updated_at.getTime() > STALE_MS;
  return {
    id: r.id,
    suiteId: r.suite_id,
    trigger: r.trigger as SuiteTrigger,
    status: (stale ? 'error' : r.status) as SuiteRunStatus,
    environmentId: r.environment_id,
    totals: { ...emptyTotals(), ...(r.totals as Partial<SuiteRunTotals>) },
    results,
    error: stale ? 'The server restarted while this ran; run it again.' : r.error,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    triggeredBy: r.triggered_by,
  };
}

// ---------- suites ----------

export async function listSuites(trx: Tx, workspaceId: string): Promise<ApiSuite[]> {
  const rows = await trx.selectFrom('apitest.suite').select(['id', 'name', 'items', 'settings', 'schedule', 'next_run_at', 'updated_at']).where('workspace_id', '=', workspaceId).orderBy('name').execute();
  const runs = rows.length
    ? await trx
        .selectFrom('apitest.suite_run')
        .select(['id', 'suite_id', 'trigger', 'status', 'environment_id', 'totals', 'error', 'started_at', 'updated_at', 'finished_at', 'triggered_by'])
        .where('suite_id', 'in', rows.map((r) => r.id))
        .orderBy('started_at', 'desc')
        .execute()
    : [];
  return rows.map((r) => suiteView(r, runs.find((x) => x.suite_id === r.id) ?? null));
}

function suiteView(r: SuiteRow, last: RunRow | null): ApiSuite {
  const lv = last ? runView(last) : null;
  return {
    id: r.id,
    name: r.name,
    items: (r.items as unknown[]).map((i) => SuiteItem.parse(i)),
    settings: SuiteSettings.parse(r.settings),
    schedule: SuiteSchedule.parse(r.schedule),
    nextRunAt: r.next_run_at?.toISOString() ?? null,
    lastRun: lv ? { id: lv.id, status: lv.status, totals: lv.totals, finishedAt: lv.finishedAt } : null,
    updatedAt: r.updated_at.toISOString(),
  };
}

async function suiteRow(trx: Tx, workspaceId: string, id: string) {
  const s = await trx.selectFrom('apitest.suite').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (!s) throw notFound('Suite');
  return s;
}

export async function getSuite(trx: Tx, workspaceId: string, id: string): Promise<ApiSuite> {
  return (await listSuites(trx, workspaceId)).find((s) => s.id === id) ?? Promise.reject(notFound('Suite'));
}

/** Everything a suite points at must be in its workspace, and its schedule must parse. */
async function checkSuite(trx: Tx, projectId: string, workspaceId: string, body: SuiteBody): Promise<void> {
  const nodes = body.items.flatMap((i) => (i.kind === 'folder' ? [i.nodeId] : i.kind === 'workflow' ? [] : [i.requestId]));
  if (nodes.length) {
    const found = await trx.selectFrom('apitest.node').select('id').where('workspace_id', '=', workspaceId).where('id', 'in', nodes).execute();
    if (new Set(found.map((f) => f.id)).size !== new Set(nodes).size) throw badRequest('An item points at a request or folder that is not in this workspace.');
  }
  const wfs = body.items.flatMap((i) => (i.kind === 'workflow' ? [i.workflowId] : []));
  if (wfs.length) {
    const found = await trx.selectFrom('apitest.workflow').select('id').where('workspace_id', '=', workspaceId).where('id', 'in', wfs).execute();
    if (found.length !== new Set(wfs).size) throw badRequest('An item runs a workflow that is not in this workspace.');
  }
  if (body.settings.environmentId) {
    const env = await trx.selectFrom('apitest.environment').select('id').where('id', '=', body.settings.environmentId).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!env) throw badRequest('That environment is not in this workspace.');
  }
  if (body.settings.dataSetId) {
    const ds = await trx.selectFrom('repo.data_set').select('id').where('id', '=', body.settings.dataSetId).where('project_id', '=', projectId).executeTakeFirst();
    if (!ds) throw badRequest('That data set is not in this project.');
  }
  if (body.schedule.cron) {
    try {
      parseCron(body.schedule.cron);
    } catch (err) {
      if (err instanceof CronError) throw badRequest(err.message);
      throw err;
    }
  }
}

export async function saveSuite(trx: Tx, caller: Caller, projectId: string, workspaceId: string, body: SuiteBody, id?: string): Promise<ApiSuite> {
  await checkSuite(trx, projectId, workspaceId, body);
  const values = {
    name: body.name,
    items: JSON.stringify(body.items),
    settings: JSON.stringify(body.settings),
    schedule: JSON.stringify(body.schedule),
    next_run_at: computeNextRun(body.schedule),
    updated_by: caller.userId,
    updated_at: new Date(),
  };
  try {
    const row = id
      ? await trx.updateTable('apitest.suite').set({ ...values, owner_id: caller.userId }).where('id', '=', id).where('workspace_id', '=', workspaceId).returning('id').executeTakeFirst()
      : await trx.insertInto('apitest.suite').values({ ...values, org_id: caller.orgId, project_id: projectId, workspace_id: workspaceId, owner_id: caller.userId }).returning('id').executeTakeFirst();
    if (!row) throw notFound('Suite');
    return getSuite(trx, workspaceId, row.id);
  } catch (err) {
    if (isUnique(err)) throw conflict(`A suite called "${body.name}" already exists.`);
    throw err;
  }
}

export async function deleteSuite(trx: Tx, workspaceId: string, id: string): Promise<void> {
  const s = await suiteRow(trx, workspaceId, id);
  await trx.deleteFrom('apitest.suite').where('id', '=', s.id).execute();
}

// ---------- expanding items into units ----------

export type Unit =
  | { kind: 'request'; key: string; group: string; name: string; requestId: string; variationId: string | null; method: HttpMethod; operation: string | null; specId: string | null }
  | { kind: 'workflow'; key: string; group: string; name: string; workflowId: string };

/** What a suite actually runs: folders opened up, every variation listed, duplicates dropped. */
export async function expandItems(trx: Tx, workspaceId: string, items: SuiteItem[]): Promise<Unit[]> {
  const nodes = await trx.selectFrom('apitest.node').select(['id', 'parent_id', 'kind', 'name', 'position', 'config']).where('workspace_id', '=', workspaceId).orderBy('position').orderBy('name').execute();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const variations = await trx
    .selectFrom('apitest.variation as v')
    .innerJoin('apitest.node as n', 'n.id', 'v.request_id')
    .select(['v.id', 'v.request_id', 'v.name'])
    .where('n.workspace_id', '=', workspaceId)
    .orderBy('v.position')
    .execute();
  const groupOf = (id: string) => {
    const parent = byId.get(byId.get(id)?.parent_id ?? '');
    return parent?.name ?? 'Requests';
  };
  const out: Unit[] = [];
  const seen = new Set<string>();
  const add = (u: Unit) => {
    if (!seen.has(u.key)) {
      seen.add(u.key);
      out.push(u);
    }
  };
  const request = (id: string, variationId: string | null) => {
    const n = byId.get(id);
    if (!n || n.kind !== 'request') return;
    const def = ApiRequestDef.safeParse(n.config).data;
    if (!def) return;
    const v = variationId ? variations.find((x) => x.id === variationId) : null;
    if (variationId && !v) return;
    add({
      kind: 'request',
      key: `request:${id}:${variationId ?? 'base'}`,
      group: groupOf(id),
      name: v ? `${n.name} · ${v.name}` : n.name,
      requestId: id,
      variationId,
      method: def.method,
      operation: def.operation ? `${def.operation.method} ${def.operation.path}` : null,
      specId: def.operation?.specId ?? null,
    });
  };
  const all = (id: string) => {
    request(id, null);
    for (const v of variations.filter((x) => x.request_id === id)) request(id, v.id);
  };
  const descendants = (id: string): string[] => nodes.filter((n) => n.parent_id === id).flatMap((n) => (n.kind === 'request' ? [n.id] : descendants(n.id)));
  const wfNames = new Map(
    (await trx.selectFrom('apitest.workflow').select(['id', 'name']).where('workspace_id', '=', workspaceId).execute()).map((w) => [w.id, w.name]),
  );
  for (const i of items) {
    if (i.kind === 'request') request(i.requestId, i.variationId);
    else if (i.kind === 'request_all') all(i.requestId);
    else if (i.kind === 'folder') for (const id of descendants(i.nodeId)) all(id);
    else if (wfNames.has(i.workflowId)) add({ kind: 'workflow', key: `workflow:${i.workflowId}`, group: 'Workflows', name: wfNames.get(i.workflowId)!, workflowId: i.workflowId });
  }
  return out;
}

// ---------- runs ----------

const runColumns = ['id', 'suite_id', 'trigger', 'status', 'environment_id', 'totals', 'error', 'started_at', 'updated_at', 'finished_at', 'triggered_by'] as const;

async function resultsOf(trx: Tx, runId: string): Promise<SuiteResult[]> {
  const rows = await trx.selectFrom('apitest.suite_result').selectAll().where('run_id', '=', runId).orderBy('position').execute();
  return rows.map((r) => ({
    key: r.key,
    group: r.group_name,
    name: r.name,
    row: r.row_index,
    status: r.status as SuiteResult['status'],
    flaky: r.flaky,
    attempts: r.attempts,
    httpStatus: r.http_status,
    durationMs: r.duration_ms,
    message: r.message,
    historyId: r.history_id,
    driftIssues: r.drift_issues,
    method: r.method as HttpMethod | null,
    operation: r.operation,
  }));
}

export async function getSuiteRun(trx: Tx, suiteId: string, runId: string): Promise<SuiteRun> {
  const r = await trx.selectFrom('apitest.suite_run').select(runColumns).where('id', '=', runId).where('suite_id', '=', suiteId).executeTakeFirst();
  if (!r) throw notFound('Run');
  return runView(r, await resultsOf(trx, r.id));
}

export async function listSuiteRuns(trx: Tx, suiteId: string): Promise<SuiteRun[]> {
  const rows = await trx.selectFrom('apitest.suite_run').select(runColumns).where('suite_id', '=', suiteId).orderBy('started_at', 'desc').limit(30).execute();
  return rows.map((r) => runView(r));
}

export async function startSuiteRun(trx: Tx, caller: Caller | null, projectId: string, workspaceId: string, suiteId: string, trigger: SuiteTrigger, environmentId?: string | null): Promise<SuiteRun> {
  const s = await suiteRow(trx, workspaceId, suiteId);
  const settings = SuiteSettings.parse(s.settings);
  const units = await expandItems(trx, workspaceId, (s.items as unknown[]).map((i) => SuiteItem.parse(i)));
  if (!units.length) throw badRequest('This suite has nothing to run: its requests or workflows were deleted.');
  const row = await trx
    .insertInto('apitest.suite_run')
    .values({
      org_id: s.org_id,
      project_id: projectId,
      suite_id: s.id,
      trigger,
      status: 'running',
      environment_id: environmentId === undefined ? settings.environmentId : environmentId,
      triggered_by: caller?.userId ?? null,
      updated_at: new Date(),
    })
    .returning(runColumns)
    .executeTakeFirstOrThrow();
  return runView(row);
}

export async function cancelSuiteRun(trx: Tx, suiteId: string, runId: string): Promise<SuiteRun> {
  const run = await getSuiteRun(trx, suiteId, runId);
  if (run.status !== 'running') throw conflict('This run has already finished.');
  cancelled.add(runId);
  await trx.updateTable('apitest.suite_run').set({ status: 'cancelled', finished_at: new Date(), updated_at: new Date() }).where('id', '=', runId).execute();
  return getSuiteRun(trx, suiteId, runId);
}

/**
 * Runs a suite in the background. Never throws: failures end up on the run row. Each unit runs once
 * per data row, retried on failure; a pass after a retry is flaky.
 */
export async function executeSuiteRun(ctx: SuiteContext, suiteId: string, runId: string): Promise<void> {
  const tenant = <T>(fn: (trx: Tx) => Promise<T>) => withTenant(ctx.db, { orgId: ctx.caller.orgId, userId: ctx.caller.userId }, fn);
  const secrets = new Set<string>();
  const results: SuiteResult[] = [];
  let failedOnce = false;
  try {
    const { suite, run, units, rows } = await tenant(async (trx) => {
      const suite = await suiteRow(trx, ctx.workspaceId, suiteId);
      const run = await trx.selectFrom('apitest.suite_run').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
      const settings = SuiteSettings.parse(suite.settings);
      const units = await expandItems(trx, ctx.workspaceId, (suite.items as unknown[]).map((i) => SuiteItem.parse(i)));
      const ds = settings.dataSetId ? await trx.selectFrom('repo.data_set').select('rows').where('id', '=', settings.dataSetId).executeTakeFirst() : null;
      return { suite, run, units, rows: ds?.rows.length ? ds.rows : [null] };
    });
    const settings = SuiteSettings.parse(suite.settings);
    const work = rows.flatMap((row, r) => units.map((u) => ({ u, row, r: row === null ? null : r })));
    let position = 0;

    const record = async (res: SuiteResult) => {
      const at = position++;
      results.push(res);
      await tenant(async (trx) => {
        await trx
          .insertInto('apitest.suite_result')
          .values({
            org_id: ctx.caller.orgId,
            run_id: runId,
            position: at,
            key: res.key,
            group_name: res.group,
            name: res.name.slice(0, 400),
            row_index: res.row,
            status: res.status,
            flaky: res.flaky,
            attempts: res.attempts,
            http_status: res.httpStatus,
            duration_ms: res.durationMs,
            message: maskSecrets(res.message, [...secrets]).slice(0, 4000),
            history_id: res.historyId,
            drift_issues: res.driftIssues,
            method: res.method,
            operation: res.operation,
          })
          .execute();
        await trx.updateTable('apitest.suite_run').set({ totals: JSON.stringify(totals(results)), updated_at: new Date() }).where('id', '=', runId).execute();
      });
    };

    const sendOnce = async (u: Extract<Unit, { kind: 'request' }>, locals: Record<string, string>) => {
      const { loaded, ws } = await tenant(async (trx) => {
        const ws = await workspaceFor(trx, ctx.projectId, ctx.workspaceId, ctx.caller.userId);
        const node = await getNode(trx, ws.id, u.requestId);
        const loaded = await loadSend(trx, ctx.box, ctx.caller, ws, { request: node.request!, nodeId: node.id, parentId: null, variationId: u.variationId, environmentId: run.environment_id, cookies: 'saved', locals }, { storage: ctx.storage, projectId: ctx.projectId });
        return { loaded, ws };
      });
      const p = await buildSend(loaded, ctx.cfg);
      const sent = await performSend(p, ctx.cfg);
      const result = await tenant((trx) => recordSend(trx, ctx.box, ctx.caller, ctx.projectId, ws.id, p, sent));
      for (const sec of p.secrets) secrets.add(sec);
      const failing = result.assertions.filter((a) => !a.passed).map((a) => a.message);
      const drift = result.drift?.issues.length ?? 0;
      const passed = !result.error && !failing.length && !result.scriptErrors.length && !(settings.failOnDrift && drift > 0);
      const message = result.error?.message ?? [...failing, ...result.scriptErrors.map((e) => e.message), ...(settings.failOnDrift && drift ? [`${drift} differences from the spec`] : [])].join('; ');
      return { passed, message, result, drift };
    };

    await pool(work, settings.parallel, async ({ u, row, r }) => {
      if (cancelled.has(runId)) return;
      const locals = row ? { ...row } : {};
      if (failedOnce && settings.stopOnFail) {
        await record({ key: u.key, group: u.group, name: u.name, row: r, status: 'skipped', flaky: false, attempts: 0, httpStatus: null, durationMs: 0, message: 'Skipped: an earlier item failed.', historyId: null, driftIssues: 0, method: u.kind === 'request' ? u.method : null, operation: u.kind === 'request' ? u.operation : null });
        return;
      }
      const t0 = Date.now();
      if (u.kind === 'workflow') {
        const wf = await tenant((trx) => trx.selectFrom('apitest.workflow as w').innerJoin('apitest.workflow_version as v', (j) => j.onRef('v.workflow_id', '=', 'w.id').onRef('v.version', '=', 'w.current_version')).select('v.def').where('w.id', '=', u.workflowId).executeTakeFirst());
        if (!wf) {
          await record({ key: u.key, group: u.group, name: u.name, row: r, status: 'error', flaky: false, attempts: 1, httpStatus: null, durationMs: 0, message: 'The workflow was deleted.', historyId: null, driftIssues: 0, method: null, operation: null });
          failedOnce = true;
          return;
        }
        const failures: string[] = [];
        const out = await runWorkflow(ApiWorkflowDef.parse(wf.def), locals, engineDeps({ ...ctx }, runId, run.environment_id, secrets, {
          onResult: (x) => {
            if (x.status === 'failed' || x.status === 'error') failures.push(`${x.name || x.kind}: ${x.message}`);
          },
          cancelled: () => cancelled.has(runId),
        }));
        const ok = out.status === 'passed';
        if (!ok) failedOnce = true;
        await record({ key: u.key, group: u.group, name: u.name, row: r, status: ok ? 'passed' : out.status === 'error' ? 'error' : 'failed', flaky: false, attempts: 1, httpStatus: null, durationMs: Date.now() - t0, message: ok ? '' : [out.error, ...failures].filter(Boolean).join('; '), historyId: null, driftIssues: 0, method: null, operation: null });
        return;
      }
      const attempts: boolean[] = [];
      let last: Awaited<ReturnType<typeof sendOnce>> | null = null;
      let error: string | null = null;
      for (let a = 0; a <= settings.retries; a++) {
        try {
          last = await sendOnce(u, locals);
          attempts.push(last.passed);
          if (last.passed) break;
        } catch (err) {
          error = err instanceof Error ? err.message : 'The request could not be sent';
          attempts.push(false);
        }
        if (settings.delayMs) await new Promise((ok) => setTimeout(ok, settings.delayMs));
      }
      const { status, flaky } = settle(attempts);
      if (status === 'failed') failedOnce = true;
      await record({
        key: u.key,
        group: u.group,
        name: u.name,
        row: r,
        status: !last && error ? 'error' : status,
        flaky,
        attempts: attempts.length,
        httpStatus: last?.result.response?.status ?? null,
        durationMs: Date.now() - t0,
        message: error ?? last?.message ?? '',
        historyId: last?.result.historyId ?? null,
        driftIssues: last?.drift ?? 0,
        method: u.method,
        operation: u.operation,
      });
      if (settings.delayMs) await new Promise((ok) => setTimeout(ok, settings.delayMs));
    });

    const t = totals(results);
    const status: SuiteRunStatus = cancelled.has(runId) ? 'cancelled' : t.failed + t.errored > 0 ? 'failed' : 'passed';
    await tenant(async (trx) => {
      await trx.updateTable('apitest.suite_run').set({ status, totals: JSON.stringify(t), finished_at: new Date(), updated_at: new Date() }).where('id', '=', runId).where('status', '=', 'running').execute();
      const schedule = SuiteSchedule.parse(suite.schedule);
      const slow = run.trigger === 'monitor' && schedule.monitor?.maxP95Ms && t.p95Ms > schedule.monitor.maxP95Ms;
      const data = { suiteId, suiteName: suite.name, runId, status, trigger: run.trigger, totals: t, workspaceId: ctx.workspaceId };
      await recordEvent(trx, { orgId: ctx.caller.orgId, projectId: ctx.projectId, type: 'apitest.suite.finished', actor: ctx.caller.userId, data });
      if (run.trigger === 'monitor' && (status === 'failed' || slow))
        await recordEvent(trx, { orgId: ctx.caller.orgId, projectId: ctx.projectId, type: 'apitest.monitor.failed', actor: ctx.caller.userId, data: { ...data, reason: status === 'failed' ? `${t.failed + t.errored} failed` : `p95 ${t.p95Ms} ms is above ${schedule.monitor!.maxP95Ms} ms` } });
    });
  } catch (err) {
    await tenant((trx) =>
      trx.updateTable('apitest.suite_run').set({ status: 'error', error: maskSecrets(err instanceof Error ? err.message : 'The run failed', [...secrets]), totals: JSON.stringify(totals(results)), finished_at: new Date(), updated_at: new Date() }).where('id', '=', runId).where('status', '=', 'running').execute(),
    ).catch(() => undefined);
  } finally {
    cancelled.delete(runId);
  }
}

/** Waits for a run to finish, for CI. Gives up after `maxMs` and returns it as it stands. */
export async function waitForRun(ctx: { db: Db; caller: Caller }, suiteId: string, runId: string, maxMs = 10 * 60_000): Promise<SuiteRun> {
  const until = Date.now() + maxMs;
  for (;;) {
    const run = await withTenant(ctx.db, { orgId: ctx.caller.orgId, userId: ctx.caller.userId }, (trx) => getSuiteRun(trx, suiteId, runId));
    if (run.status !== 'running' || Date.now() > until) return run;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
}

// ---------- trends ----------

export async function suiteTrend(trx: Tx, suiteId: string): Promise<SuiteTrend> {
  const runs = await trx.selectFrom('apitest.suite_run').select(runColumns).where('suite_id', '=', suiteId).where('status', '!=', 'running').orderBy('started_at', 'desc').limit(30).execute();
  const views = runs.map((r) => runView(r)).reverse();
  const results = runs.length
    ? await trx.selectFrom('apitest.suite_result').select(['key', 'name', 'status', 'flaky', 'duration_ms']).where('run_id', 'in', runs.map((r) => r.id)).execute()
    : [];
  const byKey = new Map<string, { name: string; runs: number; failures: number; flaky: number; durations: number[] }>();
  for (const r of results) {
    const e = byKey.get(r.key) ?? { name: r.name, runs: 0, failures: 0, flaky: 0, durations: [] };
    e.runs++;
    if (r.status === 'failed' || r.status === 'error') e.failures++;
    if (r.flaky) e.flaky++;
    e.durations.push(r.duration_ms);
    byKey.set(r.key, e);
  }
  const p95 = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]! : 0;
  };
  return {
    runs: views.map((v) => ({ id: v.id, startedAt: v.startedAt, status: v.status, trigger: v.trigger, passRate: v.totals.total ? Math.round((100 * (v.totals.passed + v.totals.flaky)) / v.totals.total) : 0, flaky: v.totals.flaky, p95Ms: v.totals.p95Ms, drift: v.totals.drift })),
    requests: [...byKey.entries()]
      .map(([key, e]) => ({ key, name: e.name, runs: e.runs, failures: e.failures, flaky: e.flaky, p95Ms: p95(e.durations) }))
      .sort((a, b) => b.failures + b.flaky - (a.failures + a.flaky) || b.p95Ms - a.p95Ms)
      .slice(0, 20),
  };
}

// ---------- the scheduler and spec-change triggers ----------

export interface SchedulerDeps {
  db: Db;
  storage: ObjectStorage;
  box: SecretBox;
  cfg: SendConfig;
  log: { error(o: object, m: string): void; info?(o: object, m: string): void };
}

/** One pass: starts every suite whose schedule or monitor is due, as its owner. */
export async function schedulerPass(deps: SchedulerDeps, now = new Date()): Promise<string[]> {
  const { rows } = await sql<{ org_id: string; suite_id: string; owner_id: string }>`SELECT * FROM apitest.suites_due(${now})`.execute(deps.db);
  const started: string[] = [];
  for (const due of rows) {
    const caller = { orgId: due.org_id, userId: due.owner_id };
    try {
      const claimed = await withTenant(deps.db, caller, async (trx) => {
        const s = await trx.selectFrom('apitest.suite').selectAll().where('id', '=', due.suite_id).executeTakeFirst();
        if (!s?.next_run_at || s.next_run_at > now) return null;
        const schedule = SuiteSchedule.parse(s.schedule);
        // Claimed by moving next_run_at on first, so two schedulers never start the same run.
        const moved = await trx.updateTable('apitest.suite').set({ next_run_at: computeNextRun(schedule, now) }).where('id', '=', s.id).where('next_run_at', '=', s.next_run_at).executeTakeFirst();
        if (!moved.numUpdatedRows) return null;
        // An owner who left the organisation cannot run anything; the schedule stops.
        const member = await trx.selectFrom('iam.membership').select('user_id').where('user_id', '=', s.owner_id).executeTakeFirst();
        if (!member) {
          await trx.updateTable('apitest.suite').set({ next_run_at: null }).where('id', '=', s.id).execute();
          return null;
        }
        const monitorDue = schedule.monitor && (!schedule.cron || nextRun(schedule.cron, new Date(now.getTime() - 60_000)) > now);
        const run = await startSuiteRun(trx, caller, s.project_id, s.workspace_id, s.id, monitorDue ? 'monitor' : 'schedule');
        return { run, s };
      });
      if (!claimed) continue;
      started.push(claimed.run.id);
      void executeSuiteRun({ ...deps, caller, projectId: claimed.s.project_id, workspaceId: claimed.s.workspace_id }, claimed.s.id, claimed.run.id);
    } catch (err) {
      deps.log.error({ err, suiteId: due.suite_id }, 'scheduled suite failed to start');
    }
  }
  return started;
}

/** Starts the scheduler; returns a stop function. Not started on import, so tests drive passes directly. */
export function startSuiteScheduler(deps: SchedulerDeps, intervalMs = 60_000): () => void {
  const timer = setInterval(() => void schedulerPass(deps).catch((err) => deps.log.error({ err }, 'suite scheduler pass failed')), intervalMs);
  return () => clearInterval(timer);
}

/** Suites set to run when a spec they use gets a new version, started as the person who uploaded it. */
export async function runOnSpecChange(trx: Tx, caller: Caller, projectId: string, specId: string): Promise<{ suiteId: string; workspaceId: string; runId: string }[]> {
  const suites = await trx.selectFrom('apitest.suite').select(['id', 'workspace_id', 'items', 'schedule']).where('project_id', '=', projectId).execute();
  const out: { suiteId: string; workspaceId: string; runId: string }[] = [];
  for (const s of suites) {
    if (!SuiteSchedule.parse(s.schedule).onSpecChange) continue;
    const units = await expandItems(trx, s.workspace_id, (s.items as unknown[]).map((i) => SuiteItem.parse(i)));
    if (!units.some((u) => u.kind === 'request' && u.specId === specId)) continue;
    const run = await startSuiteRun(trx, caller, projectId, s.workspace_id, s.id, 'spec_change');
    out.push({ suiteId: s.id, workspaceId: s.workspace_id, runId: run.id });
  }
  return out;
}
