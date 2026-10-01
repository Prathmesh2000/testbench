import { createHash } from 'node:crypto';
import type { ApiSuggestedWorkflow, DependencyLink, HttpMethod, MapOperation, OperationKey } from '@tb/contracts';
import { deref, readSpec } from './spec';

// Which operations feed which (plan §12): an operation's response fills another's input. Algorithms
// decide the links and the order; nothing here is AI. Every link says why it was made and how sure it is,
// and the tester confirms or rejects it.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface OperationIO {
  key: OperationKey;
  specId: string;
  specName: string;
  method: HttpMethod;
  path: string;
  operationId: string | null;
  summary: string;
  tag: string;
  secured: boolean;
  securitySchemes: string[];
  /** Inputs that must be filled: path parameters and required query and header parameters. */
  inputs: { in: 'path' | 'query' | 'header'; name: string }[];
  /** Top-level request body properties whose name ends in id: they usually point at another resource. */
  bodyIds: string[];
  /** JSONPaths the first 2xx JSON response can hold ($.id, $.data.id, $.items[*].id). */
  outputs: string[];
  /** OpenAPI 3 links from this operation's responses. */
  specLinks: { operationId: string; parameter: string; field: string }[];
}

const MAX_FIELDS = 200;

/** JSONPaths in a schema, two object levels deep, through $ref, allOf/oneOf/anyOf and arrays. */
function fieldsOf(doc: Obj, schema: unknown, prefix: string, depth: number, out: string[]): void {
  const s = deref(doc, schema);
  if (!isObj(s) || out.length >= MAX_FIELDS || depth > 3) return;
  for (const k of ['allOf', 'oneOf', 'anyOf']) if (Array.isArray(s[k])) for (const sub of s[k] as unknown[]) fieldsOf(doc, sub, prefix, depth, out);
  if (s.type === 'array' || s.items) {
    fieldsOf(doc, s.items, `${prefix}[*]`, depth, out);
    return;
  }
  if (isObj(s.properties))
    for (const [name, sub] of Object.entries(s.properties)) {
      const path = /^[A-Za-z_$][\w$]*$/.test(name) ? `${prefix}.${name}` : `${prefix}['${name}']`;
      if (!out.includes(path)) out.push(path);
      if (depth < 2) fieldsOf(doc, sub, path, depth + 1, out);
    }
}

const jsonSchema = (content: unknown): unknown => {
  if (!isObj(content)) return undefined;
  const type = Object.keys(content).find((t) => t.includes('json')) ?? Object.keys(content)[0];
  return type && isObj(content[type]) ? (content[type] as Obj).schema : undefined;
};

/** "$response.body#/data/id" → "$.data.id". Other expressions are not usable as a field and are dropped. */
function linkExpression(expr: unknown): string | null {
  const m = typeof expr === 'string' ? /^\$response\.body#\/(.*)$/.exec(expr) : null;
  if (!m) return null;
  return `$${m[1]!.split('/').map((p) => (/^\d+$/.test(p) ? `[${p}]` : `.${p.replace(/~1/g, '/').replace(/~0/g, '~')}`)).join('')}`;
}

/** Each operation's inputs and outputs, read from the full spec document. */
export function operationsIO(raw: unknown, specId: string, specName: string): OperationIO[] {
  const read = readSpec(raw);
  const doc = raw as Obj;
  const paths = doc.paths as Obj;
  return read.operations.map((o) => {
    const op = deref(doc, (deref(doc, paths[o.path]) as Obj)[o.method.toLowerCase()]) as Obj;
    const responses = isObj(op.responses) ? op.responses : {};
    const ok = Object.keys(responses).sort().find((c) => /^2/.test(c));
    const res = ok ? (deref(doc, responses[ok]) as Obj) : {};
    const outputs: string[] = [];
    fieldsOf(doc, res.schema ?? jsonSchema(res.content), '$', 0, outputs);

    const bodyIds: string[] = [];
    const reqSchema = op.requestBody
      ? jsonSchema((deref(doc, op.requestBody) as Obj).content)
      : (Array.isArray(op.parameters) ? op.parameters : []).map((p) => deref(doc, p) as Obj).find((p) => p.in === 'body')?.schema;
    const reqFields: string[] = [];
    fieldsOf(doc, reqSchema, '$', 2, reqFields);
    for (const f of reqFields) {
      const name = f.slice(2);
      if (/^[A-Za-z_]\w*$/.test(name) && /[a-z](Id|_id|ID)$/.test(name)) bodyIds.push(name);
    }

    const specLinks: OperationIO['specLinks'] = [];
    for (const r of Object.values(responses)) {
      const links = (deref(doc, r) as Obj | undefined)?.links;
      if (!isObj(links)) continue;
      for (const l of Object.values(links)) {
        const link = deref(doc, l) as Obj;
        if (typeof link?.operationId !== 'string' || !isObj(link.parameters)) continue;
        for (const [param, expr] of Object.entries(link.parameters)) {
          const field = linkExpression(expr);
          if (field) specLinks.push({ operationId: link.operationId, parameter: param.replace(/^(path|query|header)\./, ''), field });
        }
      }
    }
    return {
      key: `${o.method} ${o.path}`,
      specId,
      specName,
      method: o.method,
      path: o.path,
      operationId: o.operationId,
      summary: o.summary,
      tag: o.tags[0] ?? 'Other',
      secured: (o.security?.length ?? 0) > 0,
      securitySchemes: o.security ?? [],
      inputs: o.parameters.filter((p) => p.in === 'path' || (p.required && (p.in === 'query' || p.in === 'header'))).map((p) => ({ in: p.in as 'path' | 'query' | 'header', name: p.name })),
      bodyIds,
      outputs,
      specLinks,
    };
  });
}

const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, '');
/** orders → order, categories → category, addresses → address. Good enough for resource names. */
export const singular = (w: string) =>
  /ies$/.test(w) ? w.replace(/ies$/, 'y') : /(ss|sh|ch|x)es$/.test(w) ? w.replace(/es$/, '') : /ss$/.test(w) ? w : w.replace(/s$/, '');
const lastSegment = (path: string) => path.split('/').filter((p) => p && !p.startsWith('{')).pop() ?? '';
const tail = (field: string) => field.replace(/\[\*\]/g, '').split('.').pop()!.replace(/^\['|'\]$/g, '');
const linkId = (from: string, to: string, pin: string, name: string) => createHash('sha1').update(`${from}|${to}|${pin}|${name}`).digest('hex').slice(0, 16);

const AUTH_PATH = /(login|signin|sign-in|token|auth|session)/i;

/** The best producer for each input of each operation, with its reason. */
export function inferLinks(ops: OperationIO[]): DependencyLink[] {
  const byOperationId = new Map(ops.filter((o) => o.operationId).map((o) => [o.operationId!, o]));
  const links: DependencyLink[] = [];
  const add = (from: OperationIO, to: OperationIO, param: DependencyLink['param'], field: string | null, confidence: number, reason: string, source: DependencyLink['source'] = 'inferred') =>
    links.push({ id: linkId(from.key, to.key, param.in, param.name), from: from.key, to: to.key, param, field, confidence, reason, source });

  // Declared links first: the spec says it outright.
  for (const from of ops)
    for (const l of from.specLinks) {
      const to = byOperationId.get(l.operationId);
      const input = to?.inputs.find((i) => i.name === l.parameter);
      if (to && input) add(from, to, input, l.field, 1, `The spec links ${l.parameter} to ${from.key} ${l.field}.`, 'spec');
    }
  const declared = new Set(links.map((l) => `${l.to}|${l.param.name}`));

  for (const to of ops) {
    const wanted = [...to.inputs, ...to.bodyIds.map((name) => ({ in: 'body' as const, name }))];
    for (const input of wanted) {
      if (declared.has(`${to.key}|${input.name}`)) continue;
      let best: { from: OperationIO; field: string; confidence: number; reason: string } | null = null;
      const consider = (from: OperationIO, field: string, confidence: number, reason: string) => {
        if (from.key === to.key) return;
        // Ties go to a create over a read, then to the shorter path (the more basic resource).
        const better = !best || confidence > best.confidence || (confidence === best.confidence && ((from.method === 'POST' && best.from.method !== 'POST') || from.path.length < best.from.path.length));
        if (better) best = { from, field, confidence, reason };
      };
      const resource = /^(.+?)_?(Id|ID|id)$/.exec(input.name)?.[1];
      for (const from of ops) {
        if (!from.outputs.length) continue;
        const idField = from.outputs.find((f) => f === '$.id') ?? from.outputs.find((f) => /^\$\.(data|result)\.id$/.test(f));
        // A top-level output named like the input beats a generic id: /issues/{key} wants $.key.
        const named = from.outputs.find((f) => !f.includes('[*]') && f.split('.').length === 2 && norm(tail(f)) === norm(input.name));
        // POST /orders then /orders/{orderId}: the create gives the id the rest of the resource uses.
        if (from.method === 'POST' && input.in === 'path' && (named ?? idField) && to.path.startsWith(`${from.path}/{${input.name}}`))
          consider(from, (named ?? idField)!, 0.9, `${from.key} creates it; ${to.key} addresses it by ${input.name}.`);
        // customerId ← POST /customers returns id.
        if (resource && idField && from.method === 'POST' && norm(singular(lastSegment(from.path))) === norm(resource))
          consider(from, idField, 0.8, `${input.name} is the id of a ${singular(lastSegment(from.path))}, which ${from.key} creates.`);
        // The response has a field of the same name.
        const same = from.outputs.find((f) => norm(tail(f)) === norm(input.name));
        if (same) consider(from, same, same.includes('[*]') ? 0.5 : 0.7, `${from.key} returns ${same}, named like ${input.name}.`);
      }
      if (best) {
        const b = best as { from: OperationIO; field: string; confidence: number; reason: string };
        add(b.from, to, input, b.field, b.confidence, b.reason);
      }
    }
  }

  // Secured operations need a credential: the public operation that hands one out.
  const tokenOps = ops
    .filter((o) => o.method === 'POST' && !o.secured && AUTH_PATH.test(o.path))
    .sort((a, b) => Number(/token|login/i.test(b.path)) - Number(/token|login/i.test(a.path)) || a.path.length - b.path.length);
  const issuer = tokenOps[0];
  if (issuer)
    for (const to of ops)
      if (to.secured && to.key !== issuer.key)
        add(issuer, to, { in: 'auth', name: to.securitySchemes[0] ?? 'auth' }, null, 0.8, `${to.key} needs a credential; ${issuer.key} looks like the login.`);
  return links;
}

/** Applies the tester's decisions: rejected links go, confirmed ones are certain, added ones join in. */
export function applyDecisions(
  links: DependencyLink[],
  decisions: { from: string; to: string; param: DependencyLink['param']; field: string | null; status: 'confirmed' | 'rejected' }[],
): DependencyLink[] {
  const key = (l: { to: string; param: DependencyLink['param'] }) => `${l.to}|${l.param.in}|${l.param.name}`;
  const byInput = new Map(decisions.map((d) => [`${key(d)}|${d.from}`, d]));
  const out = links
    .filter((l) => byInput.get(`${key(l)}|${l.from}`)?.status !== 'rejected')
    .map((l) => (byInput.get(`${key(l)}|${l.from}`)?.status === 'confirmed' ? { ...l, confidence: 1, source: 'confirmed' as const } : l));
  for (const d of decisions)
    if (d.status === 'confirmed' && !out.some((l) => key(l) === key(d) && l.from === d.from)) {
      // A confirmed link replaces whatever else was guessed for that input.
      const i = out.findIndex((l) => key(l) === key(d));
      const link: DependencyLink = { id: linkId(d.from, d.to, d.param.in, d.param.name), from: d.from, to: d.to, param: d.param, field: d.field, confidence: 1, reason: 'Confirmed by a tester.', source: 'confirmed' };
      if (i >= 0) out[i] = link;
      else out.push(link);
    }
  return out;
}

/** Kahn's order over the links; a cycle is broken at the operation with the fewest unmet inputs. */
export function callOrder(keys: OperationKey[], links: DependencyLink[]): OperationKey[] {
  const pending = new Map(keys.map((k) => [k, new Set<string>()]));
  for (const l of links) if (pending.has(l.to) && pending.has(l.from) && l.from !== l.to) pending.get(l.to)!.add(l.from);
  const order: OperationKey[] = [];
  const done = new Set<string>();
  while (order.length < keys.length) {
    const ready = keys.filter((k) => !done.has(k) && [...pending.get(k)!].every((d) => done.has(d)));
    const next = ready.length ? ready : [keys.filter((k) => !done.has(k)).sort((a, b) => [...pending.get(a)!].filter((d) => !done.has(d)).length - [...pending.get(b)!].filter((d) => !done.has(d)).length)[0]!];
    for (const k of next) {
      done.add(k);
      order.push(k);
    }
  }
  return order;
}

/** Inputs of each operation nothing produces: the tester supplies them. */
export function orphansOf(ops: OperationIO[], links: DependencyLink[]): Map<string, string[]> {
  const met = new Set(links.map((l) => `${l.to}|${l.param.name}`));
  return new Map(ops.map((o) => [o.key, o.inputs.filter((i) => !met.has(`${o.key}|${i.name}`)).map((i) => i.name)]));
}

/** The calls that lead to `target`, producers first: the setup a test of it needs. */
export function chainTo(target: OperationKey, links: DependencyLink[]): OperationKey[] {
  const producers = new Map<string, DependencyLink[]>();
  for (const l of links) producers.set(l.to, [...(producers.get(l.to) ?? []), l]);
  const chain: string[] = [];
  const visit = (k: string, depth: number) => {
    if (chain.includes(k) || depth > 8) return;
    for (const l of producers.get(k) ?? []) if (l.from !== k) visit(l.from, depth + 1);
    chain.push(k);
  };
  visit(target, 0);
  return chain;
}

/**
 * Suggested workflows: a CRUD lifecycle per resource (create → read → update → read → delete → read
 * returns 404), and for each operation that needs setup, the shortest chain of calls that feeds it.
 */
export function suggestWorkflows(ops: OperationIO[], links: DependencyLink[]): ApiSuggestedWorkflow[] {
  const byKey = new Map(ops.map((o) => [o.key, o]));
  const out: ApiSuggestedWorkflow[] = [];
  const auth = links.find((l) => l.param.in === 'auth');

  for (const create of ops.filter((o) => o.method === 'POST' && !/\{[^}]+\}$/.test(o.path))) {
    const item = ops.filter((o) => new RegExp(`^${create.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\{[^}/]+\\}$`).test(o.path));
    const read = item.find((o) => o.method === 'GET');
    const update = item.find((o) => o.method === 'PATCH') ?? item.find((o) => o.method === 'PUT');
    const del = item.find((o) => o.method === 'DELETE');
    if (!read && !update && !del) continue;
    const name = singular(lastSegment(create.path)) || create.path;
    const steps: ApiSuggestedWorkflow['steps'] = [];
    if (auth && create.secured) steps.push({ key: auth.from, expectStatus: null, note: 'Log in' });
    steps.push({ key: create.key, expectStatus: null, note: `Create ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}` });
    if (read) steps.push({ key: read.key, expectStatus: null, note: 'Read it back' });
    if (update) steps.push({ key: update.key, expectStatus: null, note: 'Change it' }, ...(read ? [{ key: read.key, expectStatus: null, note: 'See the change' }] : []));
    if (del) steps.push({ key: del.key, expectStatus: null, note: 'Delete it' }, ...(read ? [{ key: read.key, expectStatus: '404', note: 'It is gone' }] : []));
    out.push({ id: `crud:${create.key}`, kind: 'crud', name: `${name[0]!.toUpperCase()}${name.slice(1)} lifecycle`, steps });
  }

  // Setup chains: walk producers back from each operation that has any.
  const producers = new Map<string, DependencyLink[]>();
  for (const l of links) producers.set(l.to, [...(producers.get(l.to) ?? []), l]);
  for (const target of ops) {
    const feeding = producers.get(target.key)?.filter((l) => l.param.in !== 'auth') ?? [];
    if (!feeding.length) continue;
    const chain: string[] = [];
    const visit = (k: string, depth: number) => {
      if (chain.includes(k) || depth > 8) return;
      for (const l of producers.get(k) ?? []) if (l.from !== k) visit(l.from, depth + 1);
      chain.push(k);
    };
    visit(target.key, 0);
    if (chain.length < 2) continue;
    out.push({
      id: `setup:${target.key}`,
      kind: 'setup',
      name: `Reach ${target.key}`,
      steps: chain.map((k) => ({ key: k, expectStatus: null, note: k === target.key ? 'The call this sets up' : byKey.get(k)?.summary || 'Setup' })),
    });
  }
  return out;
}

export const toMapOperation = (o: OperationIO, orphans: string[]): MapOperation => ({
  key: o.key,
  specId: o.specId,
  specName: o.specName,
  method: o.method,
  path: o.path,
  summary: o.summary,
  tag: o.tag,
  secured: o.secured,
  orphans,
});
