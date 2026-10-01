import { createHash } from 'node:crypto';
import type { ApiRequestDef, ApiVariationOverrides, GeneratedKind, SpecOperation } from '@tb/contracts';
import { requestsFromOperations } from './spec-import';
import { deref, readSpec } from './spec';

// Test variations generated from the effective spec (plan §11). Rule based and repeatable: the same spec
// gives the same variations with the same ids, so regenerating keeps what testers accepted or rejected.
// Each variation says which rule made it and which part of the spec it comes from.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Generated {
  id: string;
  operation: string;
  kind: GeneratedKind;
  name: string;
  overrides: ApiVariationOverrides;
  /** Status codes that pass; "2xx" means any success. */
  expect: string[];
  why: string;
  pointer: string;
}

const CLIENT_ERROR = ['400', '422'];
const esc = (p: string) => p.replace(/~/g, '~0').replace(/\//g, '~1');
const genId = (op: string, kind: string, detail: string) => createHash('sha1').update(`${op}|${kind}|${detail}`).digest('hex').slice(0, 20);

/** A valid value for a schema: its example, else its first enum value, else one that fits its format and limits. */
export function sampleValue(doc: Obj, raw: unknown, depth = 0): unknown {
  const s = deref(doc, raw);
  if (!isObj(s) || depth > 5) return null;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Array.isArray(s.allOf)) return Object.assign({}, ...s.allOf.map((x) => sampleValue(doc, x, depth + 1)).filter(isObj));
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) return sampleValue(doc, ((s.oneOf ?? s.anyOf) as unknown[])[0], depth + 1);
  const type = s.type ?? (s.properties ? 'object' : s.items ? 'array' : 'string');
  if (type === 'object') {
    const out: Obj = {};
    for (const [k, v] of Object.entries(isObj(s.properties) ? s.properties : {})) out[k] = sampleValue(doc, v, depth + 1);
    return out;
  }
  if (type === 'array') return [sampleValue(doc, s.items, depth + 1)];
  if (type === 'integer' || type === 'number') {
    const min = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
    const max = typeof s.maximum === 'number' ? s.maximum : undefined;
    return max !== undefined && min > max ? max : min;
  }
  if (type === 'boolean') return true;
  switch (s.format) {
    case 'email':
      return 'tester@example.com';
    case 'uuid':
      return '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
    case 'date':
      return '2026-10-01';
    case 'date-time':
      return '2026-10-01T10:00:00Z';
    case 'uri':
    case 'url':
      return 'https://example.com';
  }
  let text = 'sample';
  if (typeof s.minLength === 'number' && text.length < s.minLength) text = text.padEnd(s.minLength, 'x');
  if (typeof s.maxLength === 'number' && text.length > s.maxLength) text = text.slice(0, s.maxLength);
  return text;
}

const INVALID_FORMAT: Record<string, string> = { email: 'not-an-email', uuid: 'not-a-uuid', date: '31-31-2026', 'date-time': 'yesterday', uri: 'not a url', url: 'not a url' };

/**
 * Rows that together contain every pair of values of every two factors: far fewer rows than every
 * combination. Greedy over the full product, which stays small (at most 6 factors of 5 values).
 */
export function pairwise(factors: { name: string; values: unknown[] }[]): Obj[] {
  if (factors.length < 2) return factors[0] ? factors[0].values.map((v) => ({ [factors[0]!.name]: v })) : [];
  const product: number[][] = [[]];
  for (const f of factors) {
    const next: number[][] = [];
    for (const row of product) f.values.forEach((_, i) => next.push([...row, i]));
    product.splice(0, product.length, ...next);
  }
  const pairsOf = (row: number[]) => {
    const out: string[] = [];
    for (let a = 0; a < row.length; a++) for (let b = a + 1; b < row.length; b++) out.push(`${a}:${row[a]}|${b}:${row[b]}`);
    return out;
  };
  const uncovered = new Set(product.flatMap(pairsOf));
  const rows: number[][] = [];
  while (uncovered.size) {
    let best = product[0]!;
    let bestScore = -1;
    for (const row of product) {
      const score = pairsOf(row).filter((k) => uncovered.has(k)).length;
      if (score > bestScore) [best, bestScore] = [row, score];
    }
    for (const k of pairsOf(best)) uncovered.delete(k);
    rows.push(best);
  }
  return rows.map((r) => Object.fromEntries(r.map((v, i) => [factors[i]!.name, factors[i]!.values[v]])));
}

const statusCheck = (expect: string[]): ApiVariationOverrides['assertions'] =>
  expect[0] === '2xx'
    ? [{ id: 'status', source: 'status', path: '', op: 'lt', value: '300', enabled: true }, { id: 'status-ok', source: 'status', path: '', op: 'gte', value: '200', enabled: true }]
    : [{ id: 'status', source: 'status', path: '', op: expect.length > 1 ? 'in' : 'eq', value: expect.join(', '), enabled: true }];

/** Every variation for one operation, from the effective spec. */
export function generateForOperation(doc: Obj, specId: string, o: SpecOperation): Generated[] {
  const key = `${o.method} ${o.path}`;
  const opPtr = `#/paths/${esc(o.path)}/${o.method.toLowerCase()}`;
  const base: ApiRequestDef = requestsFromOperations(specId, [o])[0]!.request;
  const paths = doc.paths as Obj;
  const op = deref(doc, (deref(doc, paths[o.path]) as Obj)[o.method.toLowerCase()]) as Obj;
  const out: Generated[] = [];
  const documented = (code: string) => o.responses.includes(code);
  const okCode = o.responses.find((c) => /^2\d\d$/.test(c));
  const bad = CLIENT_ERROR.filter(documented).length ? CLIENT_ERROR.filter(documented) : CLIENT_ERROR;
  const add = (kind: GeneratedKind, detail: string, name: string, overrides: ApiVariationOverrides, expect: string[], why: string, pointer: string) =>
    out.push({ id: genId(key, kind, detail), operation: key, kind, name: name.slice(0, 200), overrides: { ...overrides, assertions: statusCheck(expect) }, expect, why, pointer });

  // The request body schema, OpenAPI 3 or Swagger 2.
  let schema: Obj | null = null;
  let bodyPtr = '';
  const rb = deref(doc, op.requestBody) as Obj | undefined;
  if (isObj(rb) && isObj(rb.content)) {
    const ct = Object.keys(rb.content).find((c) => c.includes('json'));
    if (ct) {
      schema = deref(doc, (rb.content[ct] as Obj).schema) as Obj;
      bodyPtr = `${opPtr}/requestBody`;
      const ex = (rb.content[ct] as Obj).example;
      if (ex !== undefined && isObj(schema)) schema = { ...schema, example: ex };
    }
  } else if (Array.isArray(op.parameters)) {
    const i = op.parameters.findIndex((p) => (deref(doc, p) as Obj)?.in === 'body');
    if (i >= 0) {
      schema = deref(doc, (deref(doc, op.parameters[i]) as Obj).schema) as Obj;
      bodyPtr = `${opPtr}/parameters/${i}`;
    }
  }
  const happyBody = schema ? sampleValue(doc, schema) : null;
  const bodyOf = (v: unknown): ApiVariationOverrides => ({ body: { type: 'json', text: JSON.stringify(v, null, 2) } });

  add('happy', 'happy', `Happy path`, happyBody !== null ? bodyOf(happyBody) : {}, okCode ? [okCode] : ['2xx'], happyBody !== null ? 'A valid request built from the schema and its examples.' : 'The request with its required inputs.', opPtr);

  if (isObj(schema) && isObj(schema.properties) && isObj(happyBody)) {
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const f of required)
      if (f in happyBody) {
        const { [f]: _gone, ...rest } = happyBody;
        add('required_missing', f, `Without ${f}`, bodyOf(rest), bad, `${f} is required, so leaving it out must be refused.`, `${bodyPtr}/required`);
      }
    for (const [f, rawProp] of Object.entries(schema.properties)) {
      const p = deref(doc, rawProp) as Obj;
      if (!isObj(p)) continue;
      const ptr = `${bodyPtr}/properties/${esc(f)}`;
      const type = p.type;
      const wrong = type === 'string' ? 12345 : type === 'integer' || type === 'number' ? 'not-a-number' : type === 'boolean' ? 'yes' : type === 'array' ? 'not-a-list' : type === 'object' ? 'not-an-object' : null;
      if (wrong !== null) add('wrong_type', f, `${f} of the wrong type`, bodyOf({ ...happyBody, [f]: wrong }), bad, `${f} is ${type}; ${JSON.stringify(wrong)} must be refused.`, ptr);
      if (type === 'integer' || type === 'number') {
        const step = type === 'integer' ? 1 : 0.01;
        if (typeof p.minimum === 'number') {
          add('boundary', `${f}<min`, `${f} just below the minimum (${p.minimum - step})`, bodyOf({ ...happyBody, [f]: p.minimum - step }), bad, `The minimum of ${f} is ${p.minimum}.`, ptr);
          add('boundary', `${f}=min`, `${f} at the minimum (${p.minimum})`, bodyOf({ ...happyBody, [f]: p.minimum }), okCode ? [okCode] : ['2xx'], `The minimum of ${f} is allowed.`, ptr);
        }
        if (typeof p.maximum === 'number') {
          add('boundary', `${f}=max`, `${f} at the maximum (${p.maximum})`, bodyOf({ ...happyBody, [f]: p.maximum }), okCode ? [okCode] : ['2xx'], `The maximum of ${f} is allowed.`, ptr);
          add('boundary', `${f}>max`, `${f} just above the maximum (${p.maximum + step})`, bodyOf({ ...happyBody, [f]: p.maximum + step }), bad, `The maximum of ${f} is ${p.maximum}.`, ptr);
        }
      }
      if (type === 'string') {
        if (typeof p.maxLength === 'number') {
          add('boundary', `${f}=maxLength`, `${f} at its maximum length (${p.maxLength})`, bodyOf({ ...happyBody, [f]: 'a'.repeat(p.maxLength) }), okCode ? [okCode] : ['2xx'], `${f} can be ${p.maxLength} characters.`, ptr);
          add('boundary', `${f}>maxLength`, `${f} one character too long`, bodyOf({ ...happyBody, [f]: 'a'.repeat(p.maxLength + 1) }), bad, `${f} is at most ${p.maxLength} characters.`, ptr);
        }
        if (typeof p.minLength === 'number' && p.minLength > 0)
          add('boundary', `${f}<minLength`, `${f} too short`, bodyOf({ ...happyBody, [f]: 'a'.repeat(p.minLength - 1) }), bad, `${f} is at least ${p.minLength} characters.`, ptr);
        if (typeof p.format === 'string' && INVALID_FORMAT[p.format])
          add('format', f, `${f} not a valid ${p.format}`, bodyOf({ ...happyBody, [f]: INVALID_FORMAT[p.format] }), bad, `${f} must be a ${p.format}.`, ptr);
        if (typeof p.pattern === 'string')
          add('pattern', f, `${f} not matching its pattern`, bodyOf({ ...happyBody, [f]: '!!!' }), bad, `${f} must match ${p.pattern}.`, ptr);
      }
      if (Array.isArray(p.enum)) {
        for (const v of p.enum.slice(0, 20)) add('enum', `${f}=${JSON.stringify(v)}`, `${f} = ${JSON.stringify(v)}`, bodyOf({ ...happyBody, [f]: v }), okCode ? [okCode] : ['2xx'], `${JSON.stringify(v)} is an allowed value of ${f}.`, ptr);
        add('enum', `${f}=invalid`, `${f} not an allowed value`, bodyOf({ ...happyBody, [f]: 'NOT_AN_ALLOWED_VALUE' }), bad, `${f} is one of ${p.enum.join(', ')}.`, ptr);
      }
    }
    // Optional enums and booleans together: pairs, not every combination.
    const factors = Object.entries(schema.properties)
      .filter(([f]) => !required.includes(f))
      .map(([f, raw]) => ({ f, p: deref(doc, raw) as Obj }))
      .filter(({ p }) => isObj(p) && (Array.isArray(p.enum) || p.type === 'boolean'))
      .slice(0, 6)
      .map(({ f, p }) => ({ name: f, values: Array.isArray(p.enum) ? p.enum.slice(0, 5) : [true, false] }));
    if (factors.length >= 2)
      pairwise(factors).forEach((combo, i) =>
        add('pairwise', `${i}:${JSON.stringify(combo)}`, `Combination ${i + 1}: ${Object.entries(combo).map(([k, v]) => `${k}=${String(v)}`).join(', ')}`, bodyOf({ ...happyBody, ...combo }), okCode ? [okCode] : ['2xx'], 'Covers every pair of optional values with few requests.', bodyPtr),
      );
  }

  for (const p of o.parameters) {
    if (p.in === 'query' && p.required)
      add('required_missing', `query:${p.name}`, `Without the ${p.name} parameter`, { params: base.params.map((x) => (x.key === p.name ? { ...x, enabled: false } : x)) }, bad, `The query parameter ${p.name} is required.`, opPtr);
    if (p.in === 'query' && /^(limit|size|page_?size|per_?page)$/i.test(p.name)) {
      const param = (Array.isArray(op.parameters) ? op.parameters : []).map((x) => deref(doc, x) as Obj).find((x) => x?.name === p.name);
      const max = (deref(doc, param?.schema) as Obj | undefined)?.maximum ?? param?.maximum;
      if (typeof max === 'number')
        add('boundary', `query:${p.name}>max`, `${p.name} above its maximum (${max + 1})`, { params: base.params.map((x) => (x.key === p.name ? { ...x, value: String(max + 1), enabled: true } : x)) }, bad, `At most ${max} items per page.`, opPtr);
    }
    if (p.in === 'path' && o.method !== 'POST')
      add('not_found', p.name, `Unknown ${p.name}`, { url: base.url.replace(`{{${p.name}}}`, 'does-not-exist-000') }, ['404'], `Nothing has the ${p.name} does-not-exist-000.`, opPtr);
  }
  if ((o.security?.length ?? 0) > 0)
    add('auth_missing', 'no-auth', 'Without a credential', { auth: { type: 'none' } }, ['401'], `${key} needs ${o.security!.join(' or ')}; with none it must answer 401.`, `${opPtr}/security`);
  return out;
}

export function generateForSpec(doc: Obj, specId: string, only?: Set<string>): Generated[] {
  return readSpec(doc).operations.filter((o) => !only || only.has(`${o.method} ${o.path}`)).flatMap((o) => generateForOperation(doc, specId, o));
}

/** Status codes a request's checks expect: from "status is 201" and "status is one of 400, 422". */
export function expectedStatuses(assertions: ApiRequestDef['assertions']): string[] {
  const out: string[] = [];
  for (const a of assertions)
    if (a.enabled && a.source === 'status') {
      if (a.op === 'eq') out.push(a.value.trim());
      else if (a.op === 'in') out.push(...a.value.split(',').map((v) => v.trim()));
      else if (a.op === 'lt' && a.value.trim() === '300') out.push('2xx');
    }
  return out.filter(Boolean);
}
