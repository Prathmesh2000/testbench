import type { HttpMethod, MockConfig, MockOverride } from '@tb/contracts';
import { pathShape } from './assist';
import { deref, readSpec, type ReadSpec } from './spec';
import { sampleValue } from './testgen';

// The mock server's brain (plan §14): which operation a request is for, and what the spec says it
// answers. Pure, so every behaviour is tested without a server. Answers come from the spec's own
// examples first, then from its schemas, never from anything invented elsewhere.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface MockRequest {
  method: string;
  path: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MockAnswer {
  status: number;
  /** Undefined for no body (204, or a spec that documents none). */
  body: unknown;
  headers: Record<string, string>;
  operation: string | null;
  delayMs: number;
}

interface Compiled {
  read: ReadSpec;
  ops: { key: string; method: HttpMethod; path: string; re: RegExp; names: string[]; literals: number }[];
}

/** Turns each operation's path into a matcher. More literal segments win when several fit. */
export function compile(doc: Obj): Compiled {
  const read = readSpec(doc);
  const ops = read.operations.map((o) => {
    const names: string[] = [];
    const re = new RegExp(
      `^${o.path
        .split('/')
        .map((seg) => (/^\{.+\}$/.test(seg) ? (names.push(seg.slice(1, -1)), '([^/]+)') : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/')}/?$`,
      'i',
    );
    return { key: `${o.method} ${o.path}`, method: o.method, path: o.path, re, names, literals: o.path.split('/').filter((s) => s && !s.startsWith('{')).length };
  });
  return { read, ops };
}

export function matchOperation(c: Compiled, method: string, path: string) {
  const hits = c.ops.filter((o) => o.method === method.toUpperCase() && o.re.test(path)).sort((a, b) => b.literals - a.literals);
  const o = hits[0];
  if (!o) return null;
  const m = o.re.exec(path)!;
  return { op: o, params: Object.fromEntries(o.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) };
}

/** The body the spec documents for a status: its example, else a value built from its schema. */
function documentedBody(doc: Obj, response: unknown): { found: boolean; body: unknown; contentType: string } {
  const r = deref(doc, response);
  if (!isObj(r)) return { found: false, body: undefined, contentType: 'application/json' };
  // Swagger 2: examples by content type, or a schema.
  if (isObj(r.examples) && !isObj(r.content)) {
    const ct = Object.keys(r.examples).find((t) => t.includes('json')) ?? Object.keys(r.examples)[0];
    if (ct) return { found: true, body: (r.examples as Obj)[ct], contentType: ct };
  }
  const content = isObj(r.content) ? r.content : null;
  if (content) {
    const ct = Object.keys(content).find((t) => t.includes('json')) ?? Object.keys(content)[0];
    if (!ct) return { found: true, body: undefined, contentType: 'application/json' };
    const media = content[ct] as Obj;
    if (media.example !== undefined) return { found: true, body: media.example, contentType: ct };
    if (isObj(media.examples)) {
      const first = Object.values(media.examples)[0];
      const ex = deref(doc, first);
      if (isObj(ex) && ex.value !== undefined) return { found: true, body: ex.value, contentType: ct };
    }
    return { found: true, body: media.schema ? sampleValue(doc, media.schema) : undefined, contentType: ct };
  }
  if (r.schema) return { found: true, body: sampleValue(doc, r.schema), contentType: 'application/json' };
  return { found: true, body: undefined, contentType: 'application/json' };
}

const pickSuccess = (codes: string[]) => codes.filter((c) => /^2\d\d$/.test(c)).sort()[0] ?? null;
const hasCredential = (h: MockRequest['headers']) => Boolean(h.authorization || h.cookie || h['x-api-key'] || h['api-key']);

/** A status the tester asked for in the request: Prefer: code=404 (as Prism does) or X-Mock-Status. */
export function requestedStatus(h: MockRequest['headers']): number | null {
  const prefer = [h.prefer].flat().join(',');
  const code = /\bcode=(\d{3})\b/.exec(prefer)?.[1] ?? (typeof h['x-mock-status'] === 'string' ? /^\d{3}$/.exec(h['x-mock-status'])?.[0] : undefined);
  const n = code ? Number(code) : null;
  return n && n >= 100 && n <= 599 ? n : null;
}

const problem = (status: number, message: string, operation: string | null, delayMs: number, extra: Obj = {}): MockAnswer => ({
  status,
  body: { error: message, ...extra },
  headers: { 'content-type': 'application/json' },
  operation,
  delayMs,
});

/** What the mock answers to a request. Never throws: a request it cannot place gets a clear 404. */
export function answer(c: Compiled, doc: Obj, config: MockConfig, overrides: Record<string, MockOverride>, req: MockRequest): MockAnswer {
  const hit = matchOperation(c, req.method, req.path);
  if (!hit) {
    const near = c.ops.filter((o) => pathShape(o.path) === pathShape(req.path) || o.path.split('/')[1] === req.path.split('/')[1]).map((o) => o.key).slice(0, 8);
    return problem(404, `No operation in the spec matches ${req.method.toUpperCase()} ${req.path}.`, null, config.latencyMs, near.length ? { nearest: near } : {});
  }
  const { op } = hit;
  const spec = c.read.operations.find((o) => `${o.method} ${o.path}` === op.key)!;
  const ov = overrides[op.key];
  const delayMs = Math.min(10_000, config.latencyMs + (ov?.delayMs ?? 0));
  const rawOp = deref(doc, (deref(doc, (doc.paths as Obj)[op.path]) as Obj)[op.method.toLowerCase()]) as Obj;
  const responses = isObj(rawOp.responses) ? rawOp.responses : {};
  const clientError = ['400', '422'].find((k) => k in responses) ?? '400';

  if (config.enforceAuth && (spec.security?.length ?? 0) > 0 && !hasCredential(req.headers)) return problem(401, `${op.key} needs a credential (${spec.security!.join(' or ')}).`, op.key, delayMs);

  if (config.validate) {
    const missingQuery = spec.parameters.filter((p) => p.in === 'query' && p.required && req.query[p.name] === undefined).map((p) => p.name);
    if (missingQuery.length) return refuse(doc, responses, clientError, `Missing required query parameter ${missingQuery.join(', ')}.`, op.key, delayMs);
    const missingHeader = spec.parameters.filter((p) => p.in === 'header' && p.required && req.headers[p.name.toLowerCase()] === undefined).map((p) => p.name);
    if (missingHeader.length) return refuse(doc, responses, clientError, `Missing required header ${missingHeader.join(', ')}.`, op.key, delayMs);
    if (spec.requestBody?.required && (req.body === undefined || req.body === null || req.body === '')) return refuse(doc, responses, clientError, 'The request body is required.', op.key, delayMs);
    const required = requiredBodyFields(doc, rawOp);
    if (required.length && isObj(req.body)) {
      const missing = required.filter((f) => !(f in (req.body as Obj)));
      if (missing.length) return refuse(doc, responses, clientError, `Missing required field${missing.length > 1 ? 's' : ''} ${missing.join(', ')}.`, op.key, delayMs);
    }
  }

  const asked = requestedStatus(req.headers);
  const success = pickSuccess(Object.keys(responses));
  const status = asked ?? ov?.status ?? (success ? Number(success) : 200);
  const code = documentedCode(responses, status);
  const headers: Record<string, string> = {};
  let body: unknown;
  let contentType = 'application/json';
  if (ov?.body.trim() && (asked === null || asked === ov.status)) {
    try {
      body = JSON.parse(ov.body);
    } catch {
      return problem(500, `The override body for ${op.key} is not valid JSON.`, op.key, delayMs);
    }
  } else if (code) {
    const d = documentedBody(doc, responses[code]);
    body = d.body;
    contentType = d.contentType;
    // Documented response headers get a sample value.
    const rh = (deref(doc, responses[code]) as Obj | undefined)?.headers;
    if (isObj(rh)) for (const [k, v] of Object.entries(rh)) headers[k.toLowerCase()] = String(sampleValue(doc, (deref(doc, v) as Obj | undefined)?.schema ?? v));
  } else if (status >= 400) body = { error: `Mock answer for status ${status}: the spec does not document it.` };
  if (status === 204 || status === 304) body = undefined;
  headers['content-type'] = contentType;
  return { status, body, headers, operation: op.key, delayMs };
}

function documentedCode(responses: Obj, status: number): string | null {
  return [String(status), `${String(status)[0]}XX`, `${String(status)[0]}xx`, 'default'].find((k) => k in responses) ?? null;
}

function refuse(doc: Obj, responses: Obj, code: string, message: string, operation: string, delayMs: number): MockAnswer {
  const d = code in responses ? documentedBody(doc, responses[code]) : null;
  return {
    status: Number(code),
    body: d?.found && d.body !== undefined && isObj(d.body) ? { ...d.body, message: (d.body as Obj).message ?? message, error: (d.body as Obj).error ?? message } : { error: message },
    headers: { 'content-type': 'application/json' },
    operation,
    delayMs,
  };
}

function requiredBodyFields(doc: Obj, op: Obj): string[] {
  let schema: unknown;
  const rb = deref(doc, op.requestBody);
  if (isObj(rb) && isObj(rb.content)) {
    const ct = Object.keys(rb.content).find((t) => t.includes('json'));
    if (ct) schema = (rb.content[ct] as Obj).schema;
  } else if (Array.isArray(op.parameters)) schema = (op.parameters.map((p) => deref(doc, p) as Obj).find((p) => p?.in === 'body') as Obj | undefined)?.schema;
  const s = deref(doc, schema);
  return isObj(s) && Array.isArray(s.required) ? (s.required as string[]) : [];
}
