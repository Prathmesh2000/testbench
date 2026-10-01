import {
  ApiRequestDef,
  type SecurityCheck,
  type SecurityFinding,
  type SecurityRunBody,
  type SecurityRunView,
  type StoredFinding,
} from '@tb/contracts';
import { badRequest, notFound, recordEvent, withTenant, type Db, type ObjectStorage, type Tx } from '@tb/platform';
import { loadSpecDoc } from './effective';
import { assertAllowed, hostKey } from './gate';
import { sendHttp } from './http';
import { maskSecrets } from './resolve';
import { buildSend, factsOf, loadSend, performSend, type LoadedSend, type SendConfig } from './send';
import { bolaVerdict, corsVerdict, finding, INJECTION, injectionVerdict, looksPrivileged, massAssignmentFields, massAssignmentVerdict, passiveChecks, rateVerdict, tamperedAuth, type Exchange } from './security';
import { readSpec } from './spec';
import { generateForOperation } from './testgen';
import { getNode, workspaceFor, type Caller, type SecretBox } from './workspaces';

// Active security checks (plan §14): probes sent at a host that passed the safety gate, as the tester,
// with the tester's own accounts. Each check says what it sends and why a result is or is not a problem.
// ponytail: runs inside core-api like suites and workflow runs; moves to the runner with them.

export const MAX_PROBES = 2000;
const BURST = 25;

export interface SecurityContext {
  db: Db;
  storage: ObjectStorage;
  box: SecretBox;
  cfg: SendConfig;
  caller: Caller;
  projectId: string;
}

interface Unit {
  nodeId: string;
  name: string;
  operation: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  hasPathParam: boolean;
}

export interface Plan {
  specId: string;
  workspaceId: string;
  environmentId: string;
  environmentName: string;
  host: string;
  units: Unit[];
  checks: SecurityCheck[];
  values: Record<string, string>;
  otherProfileId: string | null;
  lowProfileId: string | null;
  override: boolean;
  via: string;
}

const CHECK_OF_RULE: Record<string, SecurityCheck | 'passive'> = {
  'auth-bypass': 'auth',
  bfla: 'bfla',
  bola: 'bola',
  'mass-assignment': 'mass_assignment',
  injection: 'injection',
  'cors-origin': 'cors',
  'no-rate-limit': 'rate_limit',
};
const checkOf = (rule: string) => CHECK_OF_RULE[rule] ?? 'passive';

export interface Prepared {
  base: Omit<Plan, 'host' | 'via' | 'override'>;
  env: { id: string; name: string; production: boolean };
  /** Each request loaded and ready to build; building runs scripts, so it happens outside a transaction. */
  loads: { unit: Unit; loaded: LoadedSend }[];
}

/** Step 1, in a transaction: what the run would check, and everything needed to build its requests. */
export async function prepareSecurityRun(trx: Tx, box: SecretBox, caller: Caller, storage: ObjectStorage, projectId: string, specId: string, body: SecurityRunBody): Promise<Prepared> {
  const ws = await workspaceFor(trx, projectId, body.workspaceId, caller.userId);
  const spec = await loadSpecDoc(trx, storage, projectId, specId);
  const env = await trx.selectFrom('apitest.environment').select(['id', 'name', 'production']).where('id', '=', body.environmentId).where('workspace_id', '=', ws.id).executeTakeFirst();
  if (!env) throw notFound('Environment');
  for (const id of [body.otherProfileId, body.lowProfileId])
    if (id && !(await trx.selectFrom('apitest.auth_profile').select('id').where('id', '=', id).where('workspace_id', '=', ws.id).executeTakeFirst())) throw badRequest('That account (auth profile) is not in this workspace.');

  const nodes = await trx.selectFrom('apitest.node').select(['id', 'parent_id', 'kind', 'name', 'config']).where('workspace_id', '=', ws.id).execute();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const under = (id: string, root: string): boolean => id === root || (byId.get(id)?.parent_id ? under(byId.get(id)!.parent_id!, root) : false);
  const ops = new Map(readSpec(spec.doc).operations.map((o) => [`${o.method} ${o.path}`, o]));
  const units: Unit[] = [];
  for (const n of nodes) {
    if (n.kind !== 'request') continue;
    const def = ApiRequestDef.safeParse(n.config).data;
    if (!def?.operation || def.operation.specId !== specId) continue;
    if (body.nodeIds.length && !body.nodeIds.some((root) => under(n.id, root))) continue;
    const key = `${def.operation.method} ${def.operation.path}`;
    const o = ops.get(key);
    units.push({ nodeId: n.id, name: n.name, operation: key, method: def.operation.method, path: def.operation.path, tag: o?.tags[0] ?? '', summary: o?.summary ?? n.name, hasPathParam: /\{[^}]+\}/.test(def.operation.path) });
  }
  if (!units.length) throw badRequest('No requests made from this spec are in that workspace. Make requests from its operations first (Specs, then Make requests).');
  const loads: Prepared['loads'] = [];
  for (const unit of units) {
    const node = await getNode(trx, ws.id, unit.nodeId);
    loads.push({ unit, loaded: await loadSend(trx, box, caller, ws, { request: node.request!, nodeId: unit.nodeId, parentId: null, variationId: null, environmentId: env.id, cookies: 'none', locals: body.values }, { storage, projectId }) });
  }
  return {
    base: { specId, workspaceId: ws.id, environmentId: env.id, environmentName: env.name, units, checks: body.checks, values: body.values, otherProfileId: body.otherProfileId, lowProfileId: body.lowProfileId },
    env,
    loads,
  };
}

/** Step 2, no transaction: the address each request would go to. */
export async function resolveUrls(prepared: Prepared, cfg: SendConfig): Promise<string[]> {
  const urls: string[] = [];
  for (const { loaded } of prepared.loads) urls.push((await buildSend(loaded, cfg)).request.url);
  return urls;
}

/**
 * Step 3, in a transaction: the gate. Every distinct host must be verified (or local), and a production
 * environment needs an admin's override. Throws with the reason; nothing has been sent by then.
 */
export async function completePlan(trx: Tx, cfg: SendConfig, projectId: string, prepared: Prepared, urls: string[], override: { requested: boolean; canOverride: boolean }): Promise<Plan> {
  const hosts = new Set<string>();
  let via = 'local';
  for (const url of urls) {
    const key = hostKey(url);
    if (hosts.has(key)) continue;
    const allowed = await assertAllowed(trx, cfg, projectId, url, prepared.env, override);
    hosts.add(key);
    if (allowed.decision.via === 'verified') via = 'verified';
  }
  return { ...prepared.base, host: [...hosts].join(', '), via, override: prepared.env.production && override.requested };
}

/** Records the run, and the audit entry that says who pointed what at which host. */
export async function createSecurityRun(trx: Tx, caller: Caller, projectId: string, plan: Plan): Promise<string> {
  const row = await trx
    .insertInto('apitest.security_run')
    .values({ org_id: caller.orgId, project_id: projectId, spec_id: plan.specId, user_id: caller.userId, environment_id: plan.environmentId, host: plan.host, checks: plan.checks, status: 'running', override_by: plan.override ? caller.userId : null, updated_at: new Date() })
    .returning('id')
    .executeTakeFirstOrThrow();
  await recordEvent(trx, { orgId: caller.orgId, projectId, type: 'apitest.security.run', actor: caller.userId, data: { runId: row.id, host: plan.host, checks: plan.checks, override: plan.override, via: plan.via, requests: plan.units.length } });
  return row.id;
}

const cancelled = new Set<string>();
export const cancelSecurityRun = (id: string) => cancelled.add(id);

const jsonOf = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** Runs the checks in the background. Never throws: the outcome lands on the run row. */
export async function executeSecurityRun(ctx: SecurityContext, runId: string, plan: Plan): Promise<void> {
  const tenant = <T>(fn: (trx: Tx) => Promise<T>) => withTenant(ctx.db, { orgId: ctx.caller.orgId, userId: ctx.caller.userId }, fn);
  const secrets = new Set<string>();
  const found = new Map<string, SecurityFinding>();
  const notes: string[] = [];
  let probes = 0;
  const want = (c: SecurityCheck) => plan.checks.includes(c);
  const add = (f: SecurityFinding) => found.set(f.fingerprint, f);
  const budget = () => probes < MAX_PROBES && !cancelled.has(runId);

  try {
    const spec = await tenant((trx) => loadSpecDoc(trx, ctx.storage, ctx.projectId, plan.specId));
    const ws = await tenant((trx) => workspaceFor(trx, ctx.projectId, plan.workspaceId, ctx.caller.userId));

    /** A request ready to tweak and send, optionally as another account. */
    const load = (u: Unit, asProfile?: string | null, defTweak?: (d: ApiRequestDef) => ApiRequestDef): Promise<LoadedSend> =>
      tenant(async (trx) => {
        const node = await getNode(trx, ws.id, u.nodeId);
        let def = node.request!;
        // A spec-made request starts with an empty body; the generated happy path is one the API can accept.
        if (def.body.type === 'json' && def.body.text.trim() === '{}' && def.operation) {
          const op = readSpec(spec.doc).operations.find((o) => o.method === def.operation!.method && o.path === def.operation!.path);
          const happy = op ? generateForOperation(spec.doc, plan.specId, op).find((g) => g.kind === 'happy') : null;
          if (happy?.overrides.body) def = { ...def, body: happy.overrides.body };
        }
        if (asProfile) def = { ...def, auth: { type: 'profile', profileId: asProfile } };
        if (defTweak) def = defTweak(def);
        return loadSend(trx, ctx.box, ctx.caller, ws, { request: def, nodeId: u.nodeId, parentId: null, variationId: null, environmentId: plan.environmentId, cookies: 'none', locals: plan.values }, { storage: ctx.storage, projectId: ctx.projectId });
      });

    interface Probe {
      ex: Exchange;
      status: number | null;
      text: string;
      json: unknown;
      contentType: string;
      authSent: boolean;
    }
    /** Sends a loaded request, optionally changed after it is built (credentials, method, headers). */
    const fire = async (l: LoadedSend, after?: (r: { method: string; headers: [string, string][]; body: Buffer | null }) => void): Promise<Probe> => {
      probes++;
      const p = await buildSend(l, ctx.cfg);
      for (const sec of p.secrets) secrets.add(sec);
      if (after) after(p.request);
      const sent = await performSend(p, ctx.cfg);
      for (const sec of p.secrets) secrets.add(sec);
      const r = sent.outcome.response;
      const facts = r ? factsOf(r, sent.outcome.timings.totalMs) : null;
      return {
        ex: { method: p.request.method, url: p.request.url, requestHeaders: sent.outcome.sentHeaders, requestBody: p.request.body?.toString('utf8').slice(0, 2000) ?? null, status: r?.status ?? null, responseHeaders: r?.headers ?? [], responseBody: facts?.bodyText.slice(0, 2000) ?? (sent.outcome.error?.message ?? '') },
        status: r?.status ?? null,
        text: facts?.bodyText ?? '',
        json: facts?.json,
        contentType: r?.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '',
        authSent: sent.outcome.sentHeaders.some(([k]) => /^(authorization|cookie|x-api-key)$/i.test(k)) || Boolean(l.profile),
      };
    };
    const make = (d: Omit<SecurityFinding, 'fingerprint' | 'evidence' | 'historyId'>, ex: Exchange, extra = '') => add(finding(d, ex, [...secrets], extra));

    let corsDone = false;
    let rateDone = false;
    for (const u of plan.units) {
      if (!budget()) break;
      let loaded: LoadedSend;
      let base: Probe;
      try {
        loaded = await load(u);
        base = await fire(loaded);
      } catch (err) {
        notes.push(`${u.operation}: could not be sent (${err instanceof Error ? err.message : 'error'}).`);
        continue;
      }
      for (const f of passiveChecks(base.ex, { operation: u.operation, authSent: base.authSent, json: base.json }, [...secrets])) add(f);
      if (base.status === null || base.status >= 300) {
        notes.push(`${u.operation}: the normal request answered ${base.status ?? 'nothing'}, so its probes were skipped. Give it values that work in "Values for what the specs do not say".`);
        continue;
      }
      const authHeader = base.ex.requestHeaders.find(([k]) => k.toLowerCase() === 'authorization')?.[1];
      const secured = base.authSent;

      if (want('auth') && secured && budget()) {
        for (const t of tamperedAuth(authHeader ?? 'Bearer x')) {
          if (!budget()) break;
          const l = { ...loaded, profile: null, auth: { type: 'none' as const } };
          const pr = await fire(l, (r) => {
            r.headers = r.headers.filter(([k]) => !/^(authorization|cookie)$/i.test(k));
            if (t.value) r.headers.push(['Authorization', t.value]);
          });
          if (pr.status !== null && pr.status >= 200 && pr.status < 300)
            make({ rule: 'auth-bypass', severity: 'high', owasp: 'API2:2023 Broken Authentication', operation: u.operation, title: `${u.operation} accepted ${t.label}`, detail: `The request succeeded (${pr.status}) with ${t.label}. Every protected operation must refuse a request whose credential is missing, invalid or tampered with.` }, pr.ex, t.label);
        }
      }
      if (want('bfla') && budget()) {
        if (!plan.lowProfileId) notes.push('Admin-operation check skipped: pick a low-privilege account to try it with.');
        else if (looksPrivileged({ path: u.path, tag: u.tag, summary: u.summary })) {
          const pr = await fire(await load(u, plan.lowProfileId));
          if (pr.status !== null && pr.status >= 200 && pr.status < 300)
            make({ rule: 'bfla', severity: 'high', owasp: 'API5:2023 Broken Function Level Authorization', operation: u.operation, title: `A low-privilege account can call ${u.operation}`, detail: `${u.operation} looks like an administrative operation, and an account with the lowest role got ${pr.status}. Check the caller's role on the server for every function.` }, pr.ex);
        }
      }
      if (want('bola') && budget()) {
        if (!plan.otherProfileId) {
          if (u.hasPathParam) notes.push('Other-account check skipped: pick a second account to try the first account’s ids with.');
        } else if (u.hasPathParam) {
          const pr = await fire(await load(u, plan.otherProfileId));
          const verdict = bolaVerdict({ status: base.status, body: base.text }, { status: pr.status, body: pr.text });
          if (verdict === 'leak')
            make({ rule: 'bola', severity: 'high', owasp: 'API1:2023 Broken Object Level Authorization', operation: u.operation, title: `Another account can read the first account's data at ${u.operation}`, detail: 'The second account sent the first account’s request, with the same id, and got the same data back. Check that the signed-in user owns the object on every request.' }, pr.ex);
          else if (verdict === 'unclear')
            make({ rule: 'bola', severity: 'info', owasp: 'API1:2023 Broken Object Level Authorization', operation: u.operation, title: `${u.operation} answered the second account with different data`, detail: 'The second account got a success, but not the same data. That may be fine (their own object) or a leak: compare the two responses.' }, pr.ex, 'unclear');
        }
      }
      if (want('mass_assignment') && ['POST', 'PUT', 'PATCH'].includes(u.method) && budget()) {
        const body = jsonOf(loaded.def.body.type === 'json' ? loaded.def.body.text : '');
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const extra = massAssignmentFields(body as Record<string, unknown>);
          const l = await load(u, null, (d) => ({ ...d, body: { type: 'json', text: JSON.stringify({ ...(body as object), ...Object.fromEntries(extra) }) } }));
          const pr = await fire(l);
          const taken = massAssignmentVerdict(extra, pr.status, pr.json);
          if (taken.length)
            make({ rule: 'mass-assignment', severity: 'high', owasp: 'API3:2023 Broken Object Property Level Authorization', operation: u.operation, title: `${u.operation} accepted fields it should not: ${taken.map(([k]) => k).join(', ')}`, detail: `Fields a client should never set (${taken.map(([k]) => k).join(', ')}) were sent with the normal body, and the response returned them as set. Accept only the fields the operation documents.` }, pr.ex);
        }
      }
      if (want('injection') && budget()) {
        const targets: { kind: 'query' | 'body'; name: string }[] = [
          ...loaded.def.params.filter((p) => p.enabled && p.key).slice(0, 3).map((p) => ({ kind: 'query' as const, name: p.key })),
          ...(() => {
            const b = jsonOf(loaded.def.body.type === 'json' ? loaded.def.body.text : '');
            return b && typeof b === 'object' && !Array.isArray(b) ? Object.entries(b as Record<string, unknown>).filter(([, v]) => typeof v === 'string').slice(0, 3).map(([k]) => ({ kind: 'body' as const, name: k })) : [];
          })(),
        ];
        for (const t of targets) {
          for (const payload of INJECTION) {
            if (!budget()) break;
            const l = await load(u, null, (d) =>
              t.kind === 'query'
                ? { ...d, params: d.params.map((p) => (p.key === t.name ? { ...p, value: payload.payload } : p)) }
                : { ...d, body: { type: 'json', text: JSON.stringify({ ...(jsonOf((d.body as { text: string }).text) as object), [t.name]: payload.payload }) } },
            );
            const pr = await fire(l);
            const v = injectionVerdict(payload, base.status, pr.status, pr.text, pr.contentType);
            if (v) make({ rule: 'injection', severity: v.severity, owasp: 'Injection (OWASP Top 10 A03)', operation: u.operation, title: `${v.title}: ${u.operation}, ${t.kind === 'query' ? 'parameter' : 'field'} ${t.name}`, detail: v.detail }, pr.ex, `${t.kind}:${t.name}:${payload.kind}`);
          }
        }
      }
      if (want('cors') && !corsDone && budget()) {
        corsDone = true;
        const origin = 'https://evil.example';
        const p = await buildSend(loaded, ctx.cfg);
        const out = await sendHttp({ ...p.request, method: 'OPTIONS', headers: [['Origin', origin], ['Access-Control-Request-Method', u.method], ['Access-Control-Request-Headers', 'authorization,content-type']], body: null }, { allowPrivate: ctx.cfg.allowPrivate, timeoutMs: 10_000, followRedirects: false, maxBodyBytes: 4096 });
        probes++;
        const pre = out.response?.headers ?? [];
        const get = await fire(loaded, (r) => r.headers.push(['Origin', origin]));
        const v = corsVerdict(origin, pre) ?? corsVerdict(origin, get.ex.responseHeaders);
        if (v) make({ rule: 'cors-origin', severity: v.severity, owasp: 'API8:2023 Security Misconfiguration', operation: null, title: v.title, detail: v.detail }, { ...get.ex, responseHeaders: pre.length ? pre : get.ex.responseHeaders }, 'cors');
      }
      if (want('rate_limit') && !rateDone && u.method === 'GET' && budget()) {
        rateDone = true;
        const statuses: (number | null)[] = [];
        let lastHeaders: [string, string][] = [];
        let lastEx = base.ex;
        for (let i = 0; i < BURST && budget(); i += 5)
          await Promise.all(
            Array.from({ length: 5 }, async () => {
              const pr = await fire(loaded);
              statuses.push(pr.status);
              if (pr.status === 429 || !lastHeaders.length) {
                lastHeaders = pr.ex.responseHeaders;
                lastEx = pr.ex;
              }
            }),
          );
        const v = rateVerdict(statuses, lastHeaders);
        if (v) make({ rule: 'no-rate-limit', severity: v.severity, owasp: 'API4:2023 Unrestricted Resource Consumption', operation: u.operation, title: v.title, detail: v.detail }, lastEx);
      }
    }
    if (probes >= MAX_PROBES) notes.push(`Stopped after ${MAX_PROBES} requests, the most one run may send.`);

    const list = [...found.values()].map((f) => ({ ...f, evidence: { request: maskSecrets(f.evidence.request, [...secrets]), response: maskSecrets(f.evidence.response, [...secrets]) } }));
    await tenant(async (trx) => {
      await saveFindings(trx, ctx.caller, ctx.projectId, plan, list);
      await trx
        .updateTable('apitest.security_run')
        .set({ status: cancelled.has(runId) ? 'cancelled' : 'done', requests: probes, found: JSON.stringify(list.map((f) => f.fingerprint)), notes: JSON.stringify(notes), finished_at: new Date(), updated_at: new Date() })
        .where('id', '=', runId)
        .execute();
    });
  } catch (err) {
    await tenant((trx) =>
      trx.updateTable('apitest.security_run').set({ status: 'error', requests: probes, error: maskSecrets(err instanceof Error ? err.message : 'The run failed', [...secrets]), finished_at: new Date(), updated_at: new Date() }).where('id', '=', runId).execute(),
    ).catch(() => undefined);
  } finally {
    cancelled.delete(runId);
  }
}

// ---------- findings ----------

/**
 * Keeps findings between runs: a repeat updates the one finding; a reopened or expired suppression is
 * open again; an open finding that this run looked for and did not find is marked fixed.
 */
async function saveFindings(trx: Tx, caller: Caller, projectId: string, plan: Plan, list: SecurityFinding[]): Promise<void> {
  const now = new Date();
  for (const f of list) {
    const e = await trx.selectFrom('apitest.finding').select(['id', 'status', 'suppress_until']).where('spec_id', '=', plan.specId).where('fingerprint', '=', f.fingerprint).executeTakeFirst();
    const evidence = JSON.stringify(f.evidence);
    if (!e) {
      await trx.insertInto('apitest.finding').values({ org_id: caller.orgId, project_id: projectId, spec_id: plan.specId, fingerprint: f.fingerprint, rule: f.rule, severity: f.severity, owasp: f.owasp, operation: f.operation, title: f.title, detail: f.detail, evidence, history_id: f.historyId, first_seen: now, last_seen: now }).execute();
      continue;
    }
    const expired = e.status === 'suppressed' && e.suppress_until && e.suppress_until <= now;
    await trx
      .updateTable('apitest.finding')
      .set({ severity: f.severity, title: f.title, detail: f.detail, evidence, last_seen: now, ...(e.status === 'fixed' || expired ? { status: 'open', suppress_reason: null, suppress_until: null } : {}) })
      .where('id', '=', e.id)
      .execute();
  }
  const seen = new Set(list.map((f) => f.fingerprint));
  const ran = new Set<string>(['passive', ...plan.checks]);
  const ops = plan.units.map((u) => u.operation);
  const open = await trx.selectFrom('apitest.finding').select(['id', 'rule', 'fingerprint', 'operation']).where('spec_id', '=', plan.specId).where('status', '=', 'open').execute();
  for (const o of open) {
    if (seen.has(o.fingerprint) || !ran.has(checkOf(o.rule)) || (o.operation && !ops.includes(o.operation))) continue;
    await trx.updateTable('apitest.finding').set({ status: 'fixed' }).where('id', '=', o.id).execute();
  }
}

type FindingRow = { id: string; fingerprint: string; rule: string; severity: string; owasp: string; operation: string | null; title: string; detail: string; evidence: Record<string, unknown>; history_id: string | null; status: string; suppress_reason: string | null; suppress_until: Date | null; first_seen: Date; last_seen: Date };
const findingView = (r: FindingRow): StoredFinding => {
  // A suppression that has run out shows as open again, whether or not a run has touched it since.
  const expired = r.status === 'suppressed' && r.suppress_until && r.suppress_until <= new Date();
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    rule: r.rule,
    severity: r.severity as StoredFinding['severity'],
    owasp: r.owasp,
    operation: r.operation,
    title: r.title,
    detail: r.detail,
    evidence: r.evidence as StoredFinding['evidence'],
    historyId: r.history_id,
    status: expired ? 'open' : (r.status as StoredFinding['status']),
    suppressReason: expired ? null : r.suppress_reason,
    suppressUntil: expired ? null : (r.suppress_until?.toISOString() ?? null),
    firstSeen: r.first_seen.toISOString(),
    lastSeen: r.last_seen.toISOString(),
  };
};

const SEVERITY_ORDER = ['high', 'medium', 'low', 'info'];
export async function listFindings(trx: Tx, projectId: string, specId: string): Promise<StoredFinding[]> {
  const rows = await trx.selectFrom('apitest.finding').selectAll().where('project_id', '=', projectId).where('spec_id', '=', specId).orderBy('last_seen', 'desc').execute();
  return rows.map(findingView).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

export async function suppressFinding(trx: Tx, caller: Caller, projectId: string, id: string, reason: string, days: number | null): Promise<StoredFinding> {
  const until = days === null ? null : new Date(Date.now() + days * 86_400_000);
  const row = await trx.updateTable('apitest.finding').set({ status: 'suppressed', suppress_reason: reason, suppress_until: until, suppressed_by: caller.userId }).where('id', '=', id).where('project_id', '=', projectId).returningAll().executeTakeFirst();
  if (!row) throw notFound('Finding');
  return findingView(row);
}

export async function reopenFinding(trx: Tx, projectId: string, id: string): Promise<StoredFinding> {
  const row = await trx.updateTable('apitest.finding').set({ status: 'open', suppress_reason: null, suppress_until: null }).where('id', '=', id).where('project_id', '=', projectId).returningAll().executeTakeFirst();
  if (!row) throw notFound('Finding');
  return findingView(row);
}

export async function getFinding(trx: Tx, projectId: string, id: string): Promise<StoredFinding> {
  const row = await trx.selectFrom('apitest.finding').selectAll().where('id', '=', id).where('project_id', '=', projectId).executeTakeFirst();
  if (!row) throw notFound('Finding');
  return findingView(row);
}

export async function getSecurityRun(trx: Tx, projectId: string, specId: string, runId: string): Promise<SecurityRunView> {
  const r = await trx
    .selectFrom('apitest.security_run as s')
    .leftJoin('apitest.environment as e', 'e.id', 's.environment_id')
    .select(['s.id', 's.spec_id', 's.status', 's.host', 's.checks', 's.requests', 's.found', 's.notes', 's.error', 's.started_at', 's.finished_at', 's.updated_at', 'e.name as env'])
    .where('s.id', '=', runId)
    .where('s.spec_id', '=', specId)
    .where('s.project_id', '=', projectId)
    .executeTakeFirst();
  if (!r) throw notFound('Run');
  const prints = r.found as string[];
  const rows = prints.length ? await trx.selectFrom('apitest.finding').selectAll().where('spec_id', '=', specId).where('fingerprint', 'in', prints).execute() : [];
  const stale = r.status === 'running' && Date.now() - r.updated_at.getTime() > 15 * 60_000;
  return {
    id: r.id,
    specId: r.spec_id,
    status: (stale ? 'error' : r.status) as SecurityRunView['status'],
    host: r.host,
    environmentName: r.env ?? '',
    checks: r.checks as SecurityCheck[],
    requests: r.requests,
    findings: rows.map(findingView).map(({ id: _i, status: _s, suppressReason: _r, suppressUntil: _u, firstSeen: _f, lastSeen: _l, ...f }) => f).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)),
    notes: r.notes as string[],
    error: stale ? 'The server restarted while this ran; run it again.' : r.error,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

