import type { DriftIssue } from '@tb/contracts';
import { deref } from './spec';

// Schema drift (plan §14): whether a response still matches what the spec says it returns. Not a full
// JSON Schema validator on purpose: it checks what breaks clients (types, required fields, enums, extra
// fields, undocumented statuses) and reports each with the path in the body where it happened.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_ISSUES = 50;

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (want: string, got: string) => want === got || (want === 'number' && got === 'integer');

function check(doc: Obj, raw: unknown, value: unknown, path: string, out: DriftIssue[], depth: number): void {
  if (out.length >= MAX_ISSUES || depth > 12) return;
  const s = deref(doc, raw);
  if (!isObj(s)) return;
  if (Array.isArray(s.allOf)) for (const sub of s.allOf) check(doc, sub, value, path, out, depth + 1);
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
    // Fits one of them: try each on a scratch list and keep the one with the fewest issues.
    const options = ((s.oneOf ?? s.anyOf) as unknown[]).map((sub) => {
      const tmp: DriftIssue[] = [];
      check(doc, sub, value, path, tmp, depth + 1);
      return tmp;
    });
    const best = options.sort((a, b) => a.length - b.length)[0];
    if (best?.length) out.push(...best);
    return;
  }
  const got = typeOf(value);
  if (value === null && (s.nullable === true || (Array.isArray(s.type) && s.type.includes('null')))) return;
  const want = Array.isArray(s.type) ? (s.type as string[]).filter((t) => t !== 'null') : typeof s.type === 'string' ? [s.type] : s.properties ? ['object'] : s.items ? ['array'] : [];
  if (want.length && !want.some((w) => fits(w, got))) {
    out.push({ path, kind: 'type', expected: want.join(' or '), actual: got });
    return;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    out.push({ path, kind: 'enum', expected: s.enum.map((e) => JSON.stringify(e)).join(', '), actual: JSON.stringify(value) });
  if (isObj(value) && (isObj(s.properties) || Array.isArray(s.required))) {
    const props = isObj(s.properties) ? s.properties : {};
    for (const r of Array.isArray(s.required) ? (s.required as string[]) : []) if (!(r in value)) out.push({ path: `${path}.${r}`, kind: 'missing', expected: 'present', actual: 'absent' });
    for (const [k, v] of Object.entries(value)) {
      if (k in props) check(doc, props[k], v, `${path}.${k}`, out, depth + 1);
      else if (s.additionalProperties === false || (isObj(s.properties) && s.additionalProperties === undefined))
        out.push({ path: `${path}.${k}`, kind: 'extra', expected: 'not in the spec', actual: typeOf(v) });
    }
  }
  if (Array.isArray(value) && s.items) value.slice(0, 20).forEach((v, i) => check(doc, s.items, v, `${path}[${i}]`, out, depth + 1));
}

/** The documented response for a status: exact code, then its class (4XX), then default. */
export function responseFor(doc: Obj, op: Obj, status: number): { code: string; schema: unknown } | null {
  const responses = isObj(op.responses) ? op.responses : {};
  const code = [String(status), `${String(status)[0]}XX`, `${String(status)[0]}xx`, 'default'].find((c) => c in responses);
  if (!code) return null;
  const r = deref(doc, responses[code]) as Obj;
  if (r?.schema) return { code, schema: r.schema };
  const content = isObj(r?.content) ? r.content : {};
  const type = Object.keys(content).find((t) => t.includes('json'));
  return { code, schema: type ? (content[type] as Obj).schema : undefined };
}

/** Everything about this response the spec does not agree with. */
export function checkDrift(doc: Obj, op: Obj, status: number, body: unknown): DriftIssue[] {
  const documented = responseFor(doc, op, status);
  if (!documented) return [{ path: '$', kind: 'status', expected: Object.keys(isObj(op.responses) ? op.responses : {}).join(', ') || 'none documented', actual: String(status) }];
  if (documented.schema === undefined || body === undefined) return [];
  const out: DriftIssue[] = [];
  check(doc, documented.schema, body, '$', out, 0);
  return out;
}
