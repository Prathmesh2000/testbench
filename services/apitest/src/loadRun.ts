import {
  ApiRequestDef,
  type ApiWorkflowDef,
  LOAD_LIMITS,
  LoadSource,
  LoadTestBody,
  SuiteBody,
  type ApiLoadTest,
  type ApiWorkflowStep,
  type LoadMetrics,
  type LoadRunView,
  type LoadVerdict,
} from '@tb/contracts';
import { AppError, badRequest, conflict, notFound, recordEvent, withTenant, type Db, type ObjectStorage, type Tx } from '@tb/platform';
import { assertAllowed, hostKey } from './gate';
import { abortReason, Collector, compareRuns, judge, k6Script, stagesFor, statusOk, vusAt, type K6Request } from './load';
import { maskSecrets } from './resolve';
import { runWorkflow, type EngineDeps } from './engine';
import { buildSend, factsOf, loadSend, performSend, rawExtracted, type LoadedSend, type PreparedSend, type SendConfig } from './send';
import { getWorkflow } from './workflows';
import { expandItems } from './suites';
import { getNode, workspaceFor, type Caller, type SecretBox } from './workspaces';

// Load tests (plan §14), run in-process like suites and security checks. Every request is built once
// (scripts and auth resolved) and then sent over and over by virtual users, so what is measured is the
// API, not Testbench. Pre scripts therefore run once, and post scripts and assertions do not run.

export interface LoadContext {
  db: Db;
  storage: ObjectStorage;
  box: SecretBox;
  cfg: SendConfig;
  caller: Caller;
  projectId: string;
}

/** Requests × data rows prepared for one run; the cap keeps the build step quick. */
const MAX_ITEMS = 300;
const PERSIST_EVERY_MS = 3000;
const MAX_REQUEST_MS = 30_000;
const isUnique = (err: unknown) => (err as { code?: string }).code === '23505';

// ---------- tests ----------

interface TestRow {
  id: string;
  name: string;
  body: unknown;
  updated_at: Date;
}
type RunRow = { id: string; load_test_id: string; status: string; host: string; metrics: unknown; verdicts: unknown; error: string | null; started_at: Date; updated_at: Date; finished_at: Date | null };

const emptyMetrics = (): LoadMetrics => ({ requests: 0, errors: 0, errorPercent: 0, rps: 0, p50: 0, p95: 0, p99: 0, max: 0, bytes: 0, endpoints: [], timeline: [] });
const metricsOf = (m: unknown): LoadMetrics => ({ ...emptyMetrics(), ...(m as Partial<LoadMetrics>) });

function runView(r: RunRow, compare: LoadRunView['compare'] = null): LoadRunView {
  const stale = r.status === 'running' && Date.now() - r.updated_at.getTime() > 2 * 60_000;
  return {
    id: r.id,
    loadTestId: r.load_test_id,
    status: (stale ? 'error' : r.status) as LoadRunView['status'],
    host: r.host,
    metrics: metricsOf(r.metrics),
    verdicts: r.verdicts as LoadVerdict[],
    compare,
    error: stale ? 'The server restarted while this ran; run it again.' : r.error,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

const testView = (t: TestRow, last: RunRow | null): ApiLoadTest => {
  const m = last ? metricsOf(last.metrics) : null;
  return {
    id: t.id,
    name: t.name,
    body: LoadTestBody.parse(t.body),
    lastRun: last && m ? { id: last.id, status: runView(last).status, p95: m.p95, rps: m.rps, finishedAt: last.finished_at?.toISOString() ?? null } : null,
    updatedAt: t.updated_at.toISOString(),
  };
};

export async function listLoadTests(trx: Tx, workspaceId: string): Promise<ApiLoadTest[]> {
  const tests = await trx.selectFrom('apitest.load_test').select(['id', 'name', 'body', 'updated_at']).where('workspace_id', '=', workspaceId).orderBy('name').execute();
  const out: ApiLoadTest[] = [];
  for (const t of tests) {
    const last = await trx.selectFrom('apitest.load_run').select(['id', 'load_test_id', 'status', 'host', 'metrics', 'verdicts', 'error', 'started_at', 'updated_at', 'finished_at']).where('load_test_id', '=', t.id).orderBy('started_at', 'desc').limit(1).executeTakeFirst();
    out.push(testView(t, last ?? null));
  }
  return out;
}

async function testRow(trx: Tx, workspaceId: string, id: string) {
  const t = await trx.selectFrom('apitest.load_test').select(['id', 'name', 'body', 'updated_at']).where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (!t) throw notFound('Load test');
  return t;
}

export async function getLoadTest(trx: Tx, workspaceId: string, id: string): Promise<ApiLoadTest> {
  const t = await testRow(trx, workspaceId, id);
  const last = await trx.selectFrom('apitest.load_run').select(['id', 'load_test_id', 'status', 'host', 'metrics', 'verdicts', 'error', 'started_at', 'updated_at', 'finished_at']).where('load_test_id', '=', id).orderBy('started_at', 'desc').limit(1).executeTakeFirst();
  return testView(t, last ?? null);
}

export async function saveLoadTest(trx: Tx, caller: Caller, projectId: string, workspaceId: string, body: LoadTestBody, id?: string): Promise<ApiLoadTest> {
  const env = await trx.selectFrom('apitest.environment').select('id').where('id', '=', body.environmentId).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (!env) throw badRequest('That environment is not in this workspace.');
  if (body.dataSetId && !(await trx.selectFrom('repo.data_set').select('id').where('id', '=', body.dataSetId).where('project_id', '=', projectId).executeTakeFirst())) throw badRequest('That data set is not in this project.');
  if (!(await sourceCount(trx, workspaceId, body))) throw badRequest('Nothing to send: those sources hold no requests.');
  try {
    if (id) {
      const done = await trx.updateTable('apitest.load_test').set({ name: body.name, body: JSON.stringify(body), updated_by: caller.userId, updated_at: new Date() }).where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (!done.numUpdatedRows) throw notFound('Load test');
      return getLoadTest(trx, workspaceId, id);
    }
    const row = await trx
      .insertInto('apitest.load_test')
      .values({ org_id: caller.orgId, project_id: projectId, workspace_id: workspaceId, name: body.name, body: JSON.stringify(body), updated_by: caller.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    return getLoadTest(trx, workspaceId, row.id);
  } catch (err) {
    if (isUnique(err)) throw conflict(`A load test called "${body.name}" already exists.`);
    throw err;
  }
}

export async function deleteLoadTest(trx: Tx, workspaceId: string, id: string): Promise<void> {
  const done = await trx.deleteFrom('apitest.load_test').where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (!done.numDeletedRows) throw notFound('Load test');
}

// ---------- what a test sends ----------

interface Item {
  key: string;
  name: string;
  requestId: string;
  variationId: string | null;
}

function requestsIn(steps: ApiWorkflowStep[], out: { requestId: string; variationId: string | null; name: string }[] = [], nested: string[] = []) {
  for (const s of steps) {
    if (s.kind === 'request' || s.kind === 'poll') out.push({ requestId: s.requestId, variationId: s.variationId, name: s.name });
    else if (s.kind === 'workflow') nested.push(s.workflowId);
    else if (s.kind === 'if') requestsIn([...s.then, ...s.else], out, nested);
    else if (s.kind === 'loop') requestsIn(s.steps, out, nested);
    else if (s.kind === 'parallel') requestsIn(s.branches.flat(), out, nested);
  }
  return { requests: out, nested };
}

/** The plain requests behind a test's sources (suites opened up, duplicates dropped), and its workflows. */
async function sourcesOf(trx: Tx, workspaceId: string, body: Pick<LoadTestBody, 'source'>): Promise<{ items: Item[]; workflowIds: string[] }> {
  const out = new Map<string, Item>();
  const flows = new Set<string>();
  const add = (requestId: string, variationId: string | null, name: string) => out.set(`${requestId}:${variationId ?? 'base'}`, { key: `${requestId}:${variationId ?? 'base'}`, name, requestId, variationId });
  for (const src of body.source.map((s) => LoadSource.parse(s))) {
    if (src.kind === 'request') {
      const n = await trx.selectFrom('apitest.node').select(['id', 'name', 'kind']).where('id', '=', src.requestId).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (!n || n.kind !== 'request') throw badRequest('One of the requests is not in this workspace.');
      add(src.requestId, src.variationId, n.name);
    } else if (src.kind === 'suite') {
      const s = await trx.selectFrom('apitest.suite').select('items').where('id', '=', src.suiteId).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (!s) throw badRequest('One of the suites is not in this workspace.');
      for (const u of await expandItems(trx, workspaceId, SuiteBody.shape.items.parse(s.items))) {
        if (u.kind === 'request') add(u.requestId, u.variationId, u.name);
        else flows.add(u.workflowId);
      }
    } else {
      const w = await trx.selectFrom('apitest.workflow').select('id').where('id', '=', src.workflowId).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (!w) throw badRequest('One of the workflows is not in this workspace.');
      flows.add(src.workflowId);
    }
  }
  return { items: [...out.values()], workflowIds: [...flows] };
}

/** Whether a test has anything to send, for saving it. */
async function sourceCount(trx: Tx, workspaceId: string, body: Pick<LoadTestBody, 'source'>): Promise<number> {
  const s = await sourcesOf(trx, workspaceId, body);
  return s.items.length + s.workflowIds.length;
}

/** A workflow, the workflows it calls, and the requests all of them send, loaded and ready to build. */
export interface PreparedFlow {
  id: string;
  name: string;
  def: ApiWorkflowDef;
  nested: Map<string, { name: string; def: ApiWorkflowDef }>;
  requests: Map<string, { name: string; loaded: LoadedSend }>;
}

export interface PreparedLoad {
  testId: string;
  body: LoadTestBody;
  env: { id: string; name: string; production: boolean };
  workspaceId: string;
  /** One per request and data row. */
  loads: { item: Item; loaded: LoadedSend }[];
  flows: PreparedFlow[];
  /** The data set's rows; workflows take the next row each time they run. */
  rows: Record<string, string>[];
}

const requestKey = (requestId: string, variationId: string | null) => `${requestId}:${variationId ?? 'base'}`;

/** Step 1, in a transaction: the test, and everything needed to build its requests. */
export async function prepareLoadRun(trx: Tx, box: SecretBox, caller: Caller, storage: ObjectStorage, projectId: string, workspaceId: string, testId: string, opts: { inProcess: boolean }): Promise<PreparedLoad> {
  const ws = await workspaceFor(trx, projectId, workspaceId, caller.userId);
  const body = LoadTestBody.parse((await testRow(trx, ws.id, testId)).body);
  if (opts.inProcess && (body.vus > LOAD_LIMITS.vus || body.seconds > LOAD_LIMITS.seconds))
    throw new AppError(422, 'too_large', `Testbench runs up to ${LOAD_LIMITS.vus} users for ${LOAD_LIMITS.seconds} seconds. Export this test as a k6 script to run it with more capacity, or lower the numbers.`);
  const env = await trx.selectFrom('apitest.environment').select(['id', 'name', 'production']).where('id', '=', body.environmentId).where('workspace_id', '=', ws.id).executeTakeFirst();
  if (!env) throw badRequest('The environment of this test was deleted. Edit the test and pick another.');
  const { items, workflowIds } = await sourcesOf(trx, ws.id, body);
  if (!items.length && !workflowIds.length) throw badRequest('Nothing to send: the sources of this test hold no requests any more.');
  const ds = body.dataSetId ? await trx.selectFrom('repo.data_set').select('rows').where('id', '=', body.dataSetId).executeTakeFirst() : null;
  const rows: Record<string, string>[] = ds?.rows.length ? (ds.rows as Record<string, string>[]) : [{}];
  const room = Math.max(1, Math.floor(MAX_ITEMS / Math.max(1, items.length)));
  const loads: PreparedLoad['loads'] = [];
  for (const item of items) {
    const node = await getNode(trx, ws.id, item.requestId);
    if (!ApiRequestDef.safeParse(node.request).success) continue;
    for (const row of rows.slice(0, room))
      loads.push({ item, loaded: await loadSend(trx, box, caller, ws, { request: node.request!, nodeId: item.requestId, parentId: null, variationId: item.variationId, environmentId: env.id, cookies: 'none', locals: row }, { storage, projectId }) });
  }

  const flows: PreparedFlow[] = [];
  for (const id of workflowIds) {
    const top = await getWorkflow(trx, ws.id, id);
    const nested = new Map<string, { name: string; def: ApiWorkflowDef }>();
    const queue = [...requestsIn([...top.def.steps, ...top.def.teardown]).nested];
    while (queue.length && nested.size < 20) {
      const next = queue.shift()!;
      if (next === id || nested.has(next)) continue;
      const sub = await getWorkflow(trx, ws.id, next);
      nested.set(next, { name: sub.name, def: sub.def });
      queue.push(...requestsIn([...sub.def.steps, ...sub.def.teardown]).nested);
    }
    const wanted = new Map<string, { requestId: string; variationId: string | null }>();
    for (const def of [top.def, ...[...nested.values()].map((n) => n.def)])
      for (const r of requestsIn([...def.steps, ...def.teardown]).requests) wanted.set(requestKey(r.requestId, r.variationId), r);
    const requests = new Map<string, { name: string; loaded: LoadedSend }>();
    for (const [key, r] of wanted) {
      const node = await getNode(trx, ws.id, r.requestId);
      if (!ApiRequestDef.safeParse(node.request).success) throw badRequest(`A step of "${top.name}" points at something that is not a request.`);
      requests.set(key, { name: node.name, loaded: await loadSend(trx, box, caller, ws, { request: node.request!, nodeId: r.requestId, parentId: null, variationId: r.variationId, environmentId: env.id, cookies: 'none', locals: {} }, { storage, projectId }) });
    }
    flows.push({ id, name: top.name, def: top.def, nested, requests });
  }
  return { testId, body, env, workspaceId: ws.id, loads, flows, rows };
}

export interface BuiltLoad {
  items: { item: Item; prepared: PreparedSend }[];
  flows: { flow: PreparedFlow; requests: Map<string, PreparedSend> }[];
}

/** Every built request, for the gate: plain ones and each workflow's, each once. */
export const allBuilt = (b: BuiltLoad): { prepared: PreparedSend }[] => [...b.items, ...b.flows.flatMap((f) => [...f.requests.values()].map((prepared) => ({ prepared })))];

/** Step 2, no transaction: building runs pre scripts, so it cannot hold one open. */
export async function buildAll(p: PreparedLoad, cfg: SendConfig): Promise<BuiltLoad> {
  const items: BuiltLoad['items'] = [];
  for (const { item, loaded } of p.loads) items.push({ item, prepared: await buildSend(loaded, cfg) });
  const flows: BuiltLoad['flows'] = [];
  for (const flow of p.flows) {
    const requests = new Map<string, PreparedSend>();
    for (const [key, r] of flow.requests) requests.set(key, await buildSend(r.loaded, cfg));
    flows.push({ flow, requests });
  }
  const broken = [...items.map((o) => ({ name: o.item.name, prepared: o.prepared })), ...flows.flatMap((f) => [...f.requests].map(([key, prepared]) => ({ name: f.flow.requests.get(key)!.name, prepared })))].find((o) => o.prepared.pre?.errors.length);
  if (broken) throw badRequest(`The pre-request script of "${broken.name}" failed, so nothing was sent: ${broken.prepared.pre!.errors[0]!.message}`);
  return { items, flows };
}

export async function exportK6(p: PreparedLoad, built: BuiltLoad): Promise<string> {
  const secrets = [...new Set(allBuilt(built).flatMap((b) => b.prepared.secrets).filter(Boolean))];
  const seen = new Set<string>();
  const requests: K6Request[] = [];
  for (const { item, prepared } of built.items) {
    const body = prepared.request.body ? prepared.request.body.toString('utf8') : null;
    const key = `${item.key}|${prepared.request.url}|${body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({ name: item.name, method: prepared.request.method, url: prepared.request.url, headers: prepared.request.headers, body });
  }
  for (const { flow, requests: built2 } of built.flows)
    for (const step of flow.def.steps) {
      if (step.kind !== 'request') continue;
      const prepared = built2.get(requestKey(step.requestId, step.variationId));
      if (!prepared) continue;
      requests.push({
        name: step.name,
        workflow: flow.name,
        method: prepared.request.method,
        url: prepared.request.url,
        headers: prepared.request.headers,
        body: prepared.request.body ? prepared.request.body.toString('utf8') : null,
        assign: step.assign.filter((a) => a.source === 'body').map((a) => ({ variable: a.variable, path: a.path })),
      });
    }
  return k6Script({ name: p.body.name, stages: stagesFor(p.body.profile, p.body.vus, p.body.seconds), thresholds: p.body.thresholds, requests, secrets });
}

// ---------- the gate and the run ----------

export interface LoadPlan {
  host: string;
  via: string;
  override: boolean;
}

/** Step 3, in a transaction: the gate for every host, then the run and its audit entry. */
export async function startLoadRun(
  trx: Tx,
  cfg: SendConfig,
  caller: Caller,
  projectId: string,
  p: PreparedLoad,
  built: BuiltLoad,
  override: { requested: boolean; canOverride: boolean },
): Promise<{ runId: string; plan: LoadPlan }> {
  const hosts = new Set<string>();
  let via = 'local';
  const all = allBuilt(built);
  for (const { prepared } of all) {
    const url = prepared.request.url;
    const key = hostKey(url);
    if (hosts.has(key)) continue;
    const allowed = await assertAllowed(trx, cfg, projectId, url, p.env, override);
    hosts.add(key);
    if (allowed.decision.via === 'verified') via = 'verified';
  }
  const plan = { host: [...hosts].join(', '), via, override: p.env.production && override.requested };
  const row = await trx
    .insertInto('apitest.load_run')
    .values({ org_id: caller.orgId, project_id: projectId, load_test_id: p.testId, user_id: caller.userId, host: plan.host, status: 'running', override_by: plan.override ? caller.userId : null, updated_at: new Date() })
    .returning('id')
    .executeTakeFirstOrThrow();
  await recordEvent(trx, { orgId: caller.orgId, projectId, type: 'apitest.load.run', actor: caller.userId, data: { runId: row.id, host: plan.host, profile: p.body.profile, vus: p.body.vus, seconds: p.body.seconds, override: plan.override, via: plan.via, requests: all.length } });
  return { runId: row.id, plan };
}

const cancelled = new Set<string>();
export const cancelLoadRun = (id: string) => cancelled.add(id);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const asLocals = (vars: Record<string, string>) => Object.entries(vars).map(([key, value]) => ({ key, value, secret: false, enabled: true }));

/** Runs in the background and never throws: the outcome ends up on the run row. */
export async function executeLoadRun(ctx: LoadContext, runId: string, p: PreparedLoad, built: BuiltLoad): Promise<void> {
  const tenant = <T>(fn: (trx: Tx) => Promise<T>) => withTenant(ctx.db, { orgId: ctx.caller.orgId, userId: ctx.caller.userId }, fn);
  const secrets = [...new Set(allBuilt(built).flatMap((b) => b.prepared.secrets).filter(Boolean))];
  const collector = new Collector();
  const stages = stagesFor(p.body.profile, p.body.vus, p.body.seconds);
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;
  const save = (fields: { status?: string; error?: string | null; verdicts?: LoadVerdict[]; finished?: boolean }, m: LoadMetrics) =>
    tenant((trx) =>
      trx
        .updateTable('apitest.load_run')
        .set({ metrics: JSON.stringify(m), updated_at: new Date(), ...(fields.status ? { status: fields.status } : {}), ...(fields.error !== undefined ? { error: fields.error } : {}), ...(fields.verdicts ? { verdicts: JSON.stringify(fields.verdicts) } : {}), ...(fields.finished ? { finished_at: new Date() } : {}) })
        .where('id', '=', runId)
        .execute(),
    );

  try {
    // One real send per auth profile logs in; the rest share that credential instead of logging in per user.
    const warmed = new Map<string, string>();
    const warm = async (prepared: PreparedSend) => {
      const profile = prepared.profile?.loaded;
      if (!profile) return;
      const have = warmed.get(profile.id);
      if (have) {
        profile.session = { token: have, expired: false };
        return;
      }
      const sent = await performSend({ ...prepared, post: [] }, ctx.cfg);
      if (sent.session) {
        warmed.set(profile.id, sent.session.token);
        secrets.push(sent.session.token);
        profile.session = { token: sent.session.token, expired: false };
      } else if (!sent.outcome.response) throw new Error(sent.outcome.error?.message ?? 'The login did not answer.');
    };
    for (const { prepared } of allBuilt(built)) await warm(prepared);

    let target = 0;
    let stop = false;
    let counter = 0;
    const alive = new Set<number>();
    const workers: Promise<void>[] = [];
    const capped = (prepared: PreparedSend): PreparedSend => ({ ...prepared, post: [], def: { ...prepared.def, settings: { ...prepared.def.settings, timeoutMs: Math.min(prepared.def.settings.timeoutMs, MAX_REQUEST_MS) } } });
    // A wait step in a workflow is real think time, but it must not hold the end of the test hostage.
    const napping = async (ms: number) => {
      for (let left = ms; left > 0 && !stop; left -= 200) await sleep(Math.min(200, left));
    };

    /** One request: timed, counted against its endpoint, answered as a workflow step would need. */
    const timed = async (key: string, name: string, prepared: PreparedSend) => {
      const t0 = performance.now();
      const sent = await performSend(capped(prepared), ctx.cfg);
      const r = sent.outcome.response;
      const ms = Math.round(performance.now() - t0);
      if (!stop) collector.record({ key, name, second: Math.floor(elapsed()), vus: target, ms, ok: !!r && statusOk(prepared.def.assertions, r.status), bytes: r?.body.length ?? 0 });
      return { sent, r, ms };
    };

    /** One user running a workflow once, as the workflow runner would: values pass from step to step. */
    const iterate = async (flow: BuiltLoad['flows'][number], row: Record<string, string>) => {
      const t0 = performance.now();
      const deps: EngineDeps = {
        send: async (requestId, variationId, vars) => {
          const k = requestKey(requestId, variationId);
          const entry = flow.flow.requests.get(k);
          if (!entry) throw new Error('A step points at a request this test did not load.');
          const loaded: LoadedSend = { ...entry.loaded, scopes: [asLocals(vars), ...entry.loaded.scopes.slice(1)] };
          const prepared = await buildSend(loaded, ctx.cfg);
          const { sent, r, ms } = await timed(`${flow.flow.id}:${k}`, `${flow.flow.name} › ${entry.name}`, prepared);
          return { passed: !!r && statusOk(prepared.def.assertions, r.status), message: r ? '' : (sent.outcome.error?.message ?? 'no answer'), historyId: null, facts: r ? factsOf(r, ms) : null, extracted: rawExtracted(prepared, sent) };
        },
        loadWorkflow: async (id) => {
          const sub = flow.flow.nested.get(id);
          if (!sub) throw new Error('A step calls a workflow this test did not load.');
          return sub;
        },
        sleep: napping,
        now: () => Date.now(),
        onResult: () => undefined,
        mask: (t) => t,
        cancelled: () => stop,
      };
      const out = await runWorkflow(flow.flow.def, { ...row }, deps);
      if (!stop) collector.record({ key: `${flow.flow.id}:whole`, name: `${flow.flow.name} (whole workflow)`, second: Math.floor(elapsed()), vus: target, ms: Math.round(performance.now() - t0), ok: out.status === 'passed', bytes: 0, whole: true });
    };

    const units = built.items.length + built.flows.length;
    const worker = async (id: number) => {
      alive.add(id);
      try {
        while (!stop && id < target) {
          const n = counter++;
          const at = n % units;
          if (at < built.items.length) {
            const { item, prepared } = built.items[at]!;
            await timed(item.key, item.name, prepared);
          } else await iterate(built.flows[at - built.items.length]!, p.rows[n % p.rows.length] ?? {});
        }
      } finally {
        alive.delete(id);
      }
    };

    let reason: string | null = null;
    let lastSave = 0;
    while (elapsed() < p.body.seconds) {
      if (cancelled.has(runId)) break;
      target = vusAt(stages, elapsed());
      for (let id = 0; id < target; id++) if (!alive.has(id)) workers.push(worker(id));
      if (elapsed() > 5) {
        reason = abortReason(collector.recent(Math.floor(elapsed()), 10), p.body.abort);
        if (reason) break;
      }
      if (Date.now() - lastSave > PERSIST_EVERY_MS) {
        lastSave = Date.now();
        await save({}, collector.snapshot(elapsed()));
      }
      await sleep(250);
    }
    stop = true;
    target = 0;
    const wasCancelled = cancelled.has(runId);
    const seconds = Math.max(1, Math.min(elapsed(), p.body.seconds));
    await Promise.allSettled(workers);
    const metrics = collector.snapshot(seconds);
    const verdicts = judge(metrics, p.body.thresholds);
    const failed = verdicts.some((v) => !v.passed);
    const status = wasCancelled ? 'cancelled' : reason ? 'aborted' : failed ? 'failed' : 'passed';
    await save({ status, verdicts, error: reason ? maskSecrets(reason, secrets) : null, finished: true }, metrics);
  } catch (err) {
    const message = maskSecrets(err instanceof Error ? err.message : String(err), secrets);
    await save({ status: 'error', error: message, finished: true }, collector.snapshot(Math.max(1, elapsed()))).catch(() => undefined);
  } finally {
    cancelled.delete(runId);
  }
}

// ---------- reading runs ----------

async function previousOf(trx: Tx, r: RunRow): Promise<LoadRunView['compare']> {
  if (r.status === 'running' || r.status === 'error' || r.status === 'cancelled') return null;
  const prev = await trx
    .selectFrom('apitest.load_run')
    .select(['id', 'metrics'])
    .where('load_test_id', '=', r.load_test_id)
    .where('started_at', '<', r.started_at)
    .where('status', 'in', ['passed', 'failed', 'aborted'])
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return prev ? compareRuns({ id: prev.id, metrics: metricsOf(prev.metrics) }, metricsOf(r.metrics)) : null;
}

export async function getLoadRun(trx: Tx, workspaceId: string, testId: string, runId: string): Promise<LoadRunView> {
  await testRow(trx, workspaceId, testId);
  const r = await trx.selectFrom('apitest.load_run').select(['id', 'load_test_id', 'status', 'host', 'metrics', 'verdicts', 'error', 'started_at', 'updated_at', 'finished_at']).where('id', '=', runId).where('load_test_id', '=', testId).executeTakeFirst();
  if (!r) throw notFound('Run');
  return runView(r, await previousOf(trx, r));
}

export async function listLoadRuns(trx: Tx, workspaceId: string, testId: string): Promise<LoadRunView[]> {
  await testRow(trx, workspaceId, testId);
  const rows = await trx.selectFrom('apitest.load_run').select(['id', 'load_test_id', 'status', 'host', 'metrics', 'verdicts', 'error', 'started_at', 'updated_at', 'finished_at']).where('load_test_id', '=', testId).orderBy('started_at', 'desc').limit(15).execute();
  return rows.map((r) => runView(r));
}
