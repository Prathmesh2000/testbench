import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { ScriptLog } from '@tb/contracts';
import { getQuickJS, newQuickJSAsyncWASMModule, type QuickJSAsyncContext, type QuickJSContext } from 'quickjs-emscripten';

// Pre- and post-request scripts (plan §6) run in QuickJS compiled to WebAssembly: a separate JS engine
// with its own heap, so a tester's script cannot reach Node, the network, files, other tenants or this
// process. node:vm is not a security boundary and is not used for this. Each run gets a fresh runtime
// with a CPU deadline and a memory cap; state goes in and comes out as JSON.

export const SCRIPT_TIME_MS = 1000;
const MEMORY_BYTES = 32 * 1024 * 1024;
/** tb.sendRequest calls per script run; each is a real request through the SSRF guard. */
export const MAX_SCRIPT_SENDS = 5;

/** A request a script makes with tb.sendRequest, and what comes back. */
export interface ScriptSendRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
}
export type ScriptSendResult = ScriptResponse | { error: string };

export interface ScriptHost {
  /** Sends a script's request. Only offered to scripts that use it: the async engine is slower. */
  send?: (req: ScriptSendRequest) => Promise<ScriptSendResult>;
}

export interface ScriptSource {
  /** Where the script lives, for error messages: "collection Orders", "request". */
  source: string;
  code: string;
}

export interface ScriptRequest {
  method: string;
  url: string;
  headers: { key: string; value: string; enabled: boolean }[];
  /** Raw body text for JSON and text bodies; null when the body is not editable from a script. */
  body: string | null;
}

export interface ScriptResponse {
  code: number;
  status: string;
  headers: [string, string][];
  body: string;
  responseTime: number;
  size: number;
}

export interface ScriptInput {
  phase: 'pre' | 'post';
  request: ScriptRequest;
  response: ScriptResponse | null;
  /** Every variable as it resolves now, for tb.variables.get. */
  variables: Record<string, string>;
  /** The active environment's own values, for tb.environment.get. */
  environment: Record<string, string>;
}

export interface ScriptTest {
  name: string;
  passed: boolean;
  error: string | null;
}

export interface ScriptOutput {
  request: ScriptRequest;
  /** Variables the scripts set: they become the tester's session values. */
  set: Record<string, string>;
  unset: string[];
  tests: ScriptTest[];
  logs: ScriptLog[];
  errors: { source: string; message: string }[];
}

/** Host helpers the sandbox cannot do itself. Strings in, strings out; nothing that touches I/O. */
function hostHelper(op: string, a = '', b = '', c = ''): string {
  switch (op) {
    case 'hash':
      return createHash(a).update(b).digest(c === 'base64' ? 'base64' : 'hex');
    case 'hmac':
      return createHmac(a, b).update(c).digest('hex');
    case 'hmac64':
      return createHmac(a, b).update(c).digest('base64');
    case 'b64enc':
      return Buffer.from(a, 'utf8').toString('base64');
    case 'b64dec':
      return Buffer.from(a, 'base64').toString('utf8');
    case 'uuid':
      return randomUUID();
    default:
      throw new Error(`Unknown helper ${op}`);
  }
}

const HASHES = new Set(['md5', 'sha1', 'sha256', 'sha512']);

// The script API, written in JS and evaluated inside the sandbox before the tester's scripts.
const PRELUDE = String.raw`
const __in = JSON.parse(__input);
const __st = { request: __in.request, set: {}, unset: [], tests: [], logs: [] };
const __vars = Object.assign({}, __in.variables);
const __show = (v) => typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch (e) { return String(v); } })();
const __log = (level) => (...args) => { if (__st.logs.length < 200) __st.logs.push({ level, text: args.map(__show).join(' ').slice(0, 5000) }); };
globalThis.console = { log: __log('log'), info: __log('info'), warn: __log('warn'), error: __log('error'), debug: __log('log') };

const __setVar = (k, v) => { k = String(k); v = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v); __vars[k] = v; __st.set[k] = v; };
const __unsetVar = (k) => { k = String(k); delete __vars[k]; delete __st.set[k]; __st.unset.push(k); };
const __scope = (read) => ({
  get: (k) => read(String(k)),
  has: (k) => read(String(k)) !== undefined,
  // Writes from any scope land in the tester's own session values, never in a shared environment.
  set: __setVar,
  unset: __unsetVar,
  toObject: () => Object.assign({}, __vars),
  replaceIn: (t) => String(t).replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (m, k) => __vars[k] !== undefined ? __vars[k] : m),
});
const variables = __scope((k) => __vars[k]);
const environment = __scope((k) => k in __st.set ? __st.set[k] : __in.environment[k]);

const __headers = {
  get: (k) => { const h = __st.request.headers.find((x) => x.enabled && x.key.toLowerCase() === String(k).toLowerCase()); return h ? h.value : undefined; },
  has: (k) => __headers.get(k) !== undefined,
  add: (h) => { __st.request.headers.push({ key: String(h.key), value: String(h.value), enabled: true }); },
  upsert: (h) => { __headers.remove(h.key); __headers.add(h); },
  remove: (k) => { __st.request.headers = __st.request.headers.filter((x) => x.key.toLowerCase() !== String(k).toLowerCase()); },
  toObject: () => Object.fromEntries(__st.request.headers.filter((x) => x.enabled).map((x) => [x.key, x.value])),
};
const request = {
  get method() { return __st.request.method; }, set method(v) { __st.request.method = String(v).toUpperCase(); },
  get url() { return { toString: () => __st.request.url, valueOf: () => __st.request.url }; },
  set url(v) { __st.request.url = String(v); },
  headers: __headers,
  body: {
    get raw() { return __st.request.body; },
    set raw(v) { if (__st.request.body === null) throw new Error('This request has no JSON or text body to change'); __st.request.body = typeof v === 'string' ? v : JSON.stringify(v); },
    update(v) { this.raw = v; },
  },
};

const __r = __in.response;
const response = __r && {
  code: __r.code, status: __r.status, responseTime: __r.responseTime, responseSize: __r.size,
  headers: { get: (k) => { const h = __r.headers.find((x) => x[0].toLowerCase() === String(k).toLowerCase()); return h ? h[1] : undefined; }, has: (k) => __r.headers.some((x) => x[0].toLowerCase() === String(k).toLowerCase()), toObject: () => Object.fromEntries(__r.headers) },
  text: () => __r.body,
  json: () => JSON.parse(__r.body),
  // pm.response.to.have.status(200) and friends, as in Postman.
  get to() { return expect(response).to; },
};

const __eq = (a, b) => { if (a === b) return true; if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false; if (Array.isArray(a) !== Array.isArray(b)) return false; const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => __eq(a[k], b[k])); };
const __type = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
function expect(actual, label) {
  let neg = false;
  const check = (ok, msg) => { if (ok === neg) throw new Error((label ? label + ': ' : '') + 'expected ' + __show(actual) + (neg ? ' not ' : ' ') + msg); return chain; };
  const chain = {
    get to() { return chain; }, get be() { return chain; }, get been() { return chain; }, get is() { return chain; }, get that() { return chain; }, get which() { return chain; }, get and() { return chain; }, get has() { return chain; }, get have() { return chain; }, get with() { return chain; }, get deep() { return chain; },
    get not() { neg = !neg; return chain; },
    get ok() { return check(!!actual, 'to be truthy'); }, get true() { return check(actual === true, 'to be true'); }, get false() { return check(actual === false, 'to be false'); },
    get null() { return check(actual === null, 'to be null'); }, get undefined() { return check(actual === undefined, 'to be undefined'); },
    get exist() { return check(actual !== null && actual !== undefined, 'to exist'); }, get empty() { return check(actual !== null && actual !== undefined && (actual.length === 0 || (typeof actual === 'object' && Object.keys(actual).length === 0)), 'to be empty'); },
    equal: (v) => check(actual === v, 'to equal ' + __show(v)), equals: (v) => chain.equal(v), eq: (v) => chain.equal(v),
    eql: (v) => check(__eq(actual, v), 'to deeply equal ' + __show(v)),
    above: (n) => check(actual > n, 'to be above ' + n), gt: (n) => chain.above(n), greaterThan: (n) => chain.above(n),
    below: (n) => check(actual < n, 'to be below ' + n), lt: (n) => chain.below(n), lessThan: (n) => chain.below(n),
    least: (n) => check(actual >= n, 'to be at least ' + n), most: (n) => check(actual <= n, 'to be at most ' + n),
    within: (a, b) => check(actual >= a && actual <= b, 'to be within ' + a + '..' + b),
    a: (t) => check(__type(actual) === String(t).toLowerCase(), 'to be a ' + t), an: (t) => chain.a(t),
    include: (v) => check(typeof actual === 'string' ? actual.includes(v) : Array.isArray(actual) ? actual.some((x) => __eq(x, v)) : actual && typeof actual === 'object' && Object.keys(v).every((k) => __eq(actual[k], v[k])), 'to include ' + __show(v)),
    contain: (v) => chain.include(v), includes: (v) => chain.include(v), contains: (v) => chain.include(v),
    oneOf: (list) => check(list.some((x) => __eq(x, actual)), 'to be one of ' + __show(list)),
    match: (re) => check(new RegExp(re).test(String(actual)), 'to match ' + re),
    property: (k, ...v) => check(actual !== null && actual !== undefined && Object.prototype.hasOwnProperty.call(Object(actual), k) && (!v.length || __eq(actual[k], v[0])), 'to have property ' + k + (v.length ? ' = ' + __show(v[0]) : '')),
    lengthOf: (n) => check(actual !== null && actual !== undefined && actual.length === n, 'to have length ' + n), length: (n) => chain.lengthOf(n),
    status: (n) => { const c = actual && actual.code; return check(typeof n === 'number' ? c === n : actual && actual.status === n, 'to have status ' + n); },
    header: (k, v) => { const h = actual && actual.headers && actual.headers.get(k); return check(h !== undefined && (v === undefined || h === v), 'to have header ' + k); },
    jsonBody: () => { let ok = true; try { actual.json(); } catch (e) { ok = false; } return check(ok, 'to have a JSON body'); },
  };
  return chain;
}

function test(name, fn) {
  try { fn(); __st.tests.push({ name: String(name), passed: true, error: null }); }
  catch (e) { __st.tests.push({ name: String(name), passed: false, error: e && e.message ? String(e.message) : String(e) }); }
}
test.skip = (name) => {};

const __h = (op, a, b, c) => __host(op, String(a === undefined ? '' : a), String(b === undefined ? '' : b), String(c === undefined ? '' : c));
const crypto = {
  md5: (s, enc) => __h('hash', 'md5', s, enc), sha1: (s, enc) => __h('hash', 'sha1', s, enc), sha256: (s, enc) => __h('hash', 'sha256', s, enc), sha512: (s, enc) => __h('hash', 'sha512', s, enc),
  hmacSha256: (key, s, enc) => __h(enc === 'base64' ? 'hmac64' : 'hmac', 'sha256', key, s),
  hmacSha1: (key, s, enc) => __h(enc === 'base64' ? 'hmac64' : 'hmac', 'sha1', key, s),
  base64: (s) => __h('b64enc', s), fromBase64: (s) => __h('b64dec', s), uuid: () => __h('uuid'),
};
globalThis.btoa = (s) => __h('b64enc', s);
globalThis.atob = (s) => __h('b64dec', s);

const __notYet = (what) => () => { throw new Error(what + ' is not supported in Testbench scripts yet'); };

const __wrapResponse = (r) => ({
  code: r.code, status: r.status, responseTime: r.responseTime, responseSize: r.size,
  headers: { get: (k) => { const h = r.headers.find((x) => x[0].toLowerCase() === String(k).toLowerCase()); return h ? h[1] : undefined; }, toObject: () => Object.fromEntries(r.headers) },
  text: () => r.body, json: () => JSON.parse(r.body),
});
/** Accepts a URL string, a Postman request object ({ url, method, header, body: { mode: 'raw', raw } }) or plain headers. */
const __normalise = (req) => {
  if (typeof req === 'string') return { method: 'GET', url: req, headers: [], body: null };
  const h = req.header || req.headers || [];
  const headers = Array.isArray(h) ? h.filter((x) => !x.disabled).map((x) => [String(x.key), String(x.value)]) : Object.entries(h).map(([k, v]) => [k, String(v)]);
  const b = req.body;
  const body = b === undefined || b === null ? null : typeof b === 'string' ? b : b.mode === 'raw' ? String(b.raw) : b.mode === 'urlencoded' ? (b.urlencoded || []).map((x) => encodeURIComponent(x.key) + '=' + encodeURIComponent(x.value)).join('&') : JSON.stringify(b);
  return { method: String(req.method || 'GET').toUpperCase(), url: String(req.url && req.url.toString ? req.url.toString() : req.url), headers, body };
};
/** Sends synchronously from the script's point of view; the host awaits the real request. */
const __sendRequest = (req) => {
  if (typeof __hostSend !== 'function') throw new Error('sendRequest is not available here');
  const out = JSON.parse(__hostSend(JSON.stringify(__normalise(req))));
  if (out.error) throw new Error(out.error);
  return __wrapResponse(out);
};
const __pmSend = (req, cb) => {
  let res = null, err = null;
  try { res = __sendRequest(req); } catch (e) { err = e; }
  if (typeof cb === 'function') cb(err, res);
  else if (err) throw err;
  return res;
};
globalThis.tb = { variables, environment, request, response, test, expect, crypto, sendRequest: __sendRequest, info: { requestName: __in.requestName || '', eventName: __in.phase === 'pre' ? 'prerequest' : 'test' } };
// Postman compatibility: the common pm.* surface maps onto tb.*. What is missing says so when called.
globalThis.pm = {
  variables, environment, collectionVariables: variables, globals: variables, iterationData: __scope(() => undefined),
  request, response, test, expect, info: globalThis.tb.info,
  sendRequest: __pmSend, setNextRequest: __notYet('pm.setNextRequest'), execution: { skipRequest: __notYet('pm.execution.skipRequest') },
  cookies: { get: __notYet('pm.cookies'), has: __notYet('pm.cookies') },
};
globalThis.require = (m) => { throw new Error('require("' + m + '") is not available; use tb.crypto for hashing and HMAC'); };
globalThis.postman = { setEnvironmentVariable: __setVar, getEnvironmentVariable: (k) => environment.get(k), setGlobalVariable: __setVar, setNextRequest: __notYet('postman.setNextRequest') };
`;

function errorText(ctx: QuickJSContext, handle: Parameters<QuickJSContext['dump']>[0]): string {
  const e = ctx.dump(handle) as { name?: string; message?: string } | string;
  if (typeof e === 'string') return e;
  if (e?.message === 'interrupted' || e?.name === 'InternalError' && /interrupted/.test(e.message ?? ''))
    return `The script ran longer than ${SCRIPT_TIME_MS / 1000} s and was stopped.`;
  if (e?.name === 'InternalError' && /out of memory|stack overflow/.test(e.message ?? '')) return `The script used too much memory (${e.message}).`;
  return [e?.name, e?.message].filter(Boolean).join(': ') || 'The script failed';
}

/**
 * Runs scripts in order in one sandbox, so a value set by an outer script is visible to an inner one.
 * A script that throws is reported and stops the scripts after it; what the earlier ones did stands.
 */
export async function runScripts(scripts: ScriptSource[], input: ScriptInput & { requestName?: string }, host: ScriptHost = {}): Promise<ScriptOutput> {
  const empty: ScriptOutput = { request: input.request, set: {}, unset: [], tests: [], logs: [], errors: [] };
  const todo = scripts.filter((s) => s.code.trim());
  if (!todo.length) return empty;

  const useAsync = Boolean(host.send) && todo.some((s) => /sendRequest/.test(s.code));
  // An async module can suspend only one call at a time, so each run that sends gets its own module
  // rather than sharing one across concurrent requests.
  const runtime = useAsync ? (await newQuickJSAsyncWASMModule()).newRuntime() : (await getQuickJS()).newRuntime();
  runtime.setMemoryLimit(MEMORY_BYTES);
  runtime.setMaxStackSize(1024 * 1024);
  // The budget is CPU time in the script: time spent waiting on a tb.sendRequest does not count.
  let started = Date.now();
  let waited = 0;
  let budget = SCRIPT_TIME_MS;
  runtime.setInterruptHandler(() => Date.now() - started - waited > budget);
  const ctx = runtime.newContext() as QuickJSContext;
  const evaluate = (code: string, file: string) => (useAsync ? (ctx as unknown as QuickJSAsyncContext).evalCodeAsync(code, file) : Promise.resolve(ctx.evalCode(code, file)));
  const errors: ScriptOutput['errors'] = [];
  try {
    if (useAsync) {
      let sends = 0;
      const actx = ctx as unknown as QuickJSAsyncContext;
      const sendFn = actx.newAsyncifiedFunction('__hostSend', async (arg) => {
        if (++sends > MAX_SCRIPT_SENDS) return actx.newString(JSON.stringify({ error: `A script run can send at most ${MAX_SCRIPT_SENDS} requests.` }));
        const req = JSON.parse(actx.getString(arg)) as ScriptSendRequest;
        const t0 = Date.now();
        try {
          return actx.newString(JSON.stringify(await host.send!(req)));
        } catch (err) {
          return actx.newString(JSON.stringify({ error: err instanceof Error ? err.message : 'The request failed' }));
        } finally {
          waited += Date.now() - t0;
        }
      });
      actx.setProp(actx.global, '__hostSend', sendFn);
      sendFn.dispose();
    }
    const fn = ctx.newFunction('__host', (...args) => {
      const [op, a, b, c] = args.map((h) => ctx.getString(h));
      if ((op === 'hash' || op === 'hmac' || op === 'hmac64') && !HASHES.has(a!)) return { error: ctx.newError(`Unsupported algorithm ${a}`) };
      try {
        return ctx.newString(hostHelper(op!, a, b, c));
      } catch (err) {
        return { error: ctx.newError(err instanceof Error ? err.message : 'helper failed') };
      }
    });
    ctx.setProp(ctx.global, '__host', fn);
    fn.dispose();
    const inputHandle = ctx.newString(JSON.stringify(input));
    ctx.setProp(ctx.global, '__input', inputHandle);
    inputHandle.dispose();

    const prelude = await evaluate(PRELUDE, 'prelude.js');
    if (prelude.error) {
      const message = errorText(ctx, prelude.error);
      prelude.error.dispose();
      throw new Error(`Script runtime failed to start: ${message}`);
    }
    prelude.value.dispose();

    for (const s of todo) {
      // A function scope per script, as Postman does, so one script's const does not clash with the next.
      const run = await evaluate(`(function () {\n${s.code}\n})();`, `${s.source}.js`);
      if (run.error) {
        errors.push({ source: s.source, message: errorText(ctx, run.error) });
        run.error.dispose();
        break;
      }
      run.value.dispose();
    }

    // A fresh budget for reading the results, so a script that timed out still reports its logs.
    started = Date.now();
    waited = 0;
    budget = 200;
    const out = await evaluate('JSON.stringify(__st)', 'result.js');
    if (out.error) {
      errors.push({ source: 'runtime', message: errorText(ctx, out.error) });
      out.error.dispose();
      return { ...empty, errors };
    }
    const st = JSON.parse(ctx.getString(out.value)) as Omit<ScriptOutput, 'errors' | 'logs'> & { logs: Omit<ScriptLog, 'phase'>[] };
    out.value.dispose();
    return { ...st, logs: st.logs.map((l) => ({ ...l, phase: input.phase })), errors };
  } finally {
    ctx.dispose();
    disposeRuntime(runtime, useAsync);
  }
}

function disposeRuntime(runtime: { dispose(): void }, isAsync: boolean): void {
  try {
    runtime.dispose();
  } catch (err) {
    // quickjs-emscripten 0.32's async disposer unregisters the runtime before freeing it, so the GC
    // pass inside the free cannot find it to release our host functions. The module is per run and
    // dropped here, so nothing leaks past it; any other error is real.
    if (!(isAsync && err instanceof Error && /not found when trying to free HostRef/.test(err.message))) throw err;
  }
}
