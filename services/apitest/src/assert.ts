import { runInNewContext } from 'node:vm';
import type { ApiAssertion, ApiExtractor, AssertionResult } from '@tb/contracts';

// No-code assertions and extractors over a response (plan §7), and the JSONPath subset they use.

/** What assertions can look at. `json` is undefined when the body is not JSON. */
export interface ResponseFacts {
  status: number;
  timeMs: number;
  sizeBytes: number;
  headers: [string, string][];
  bodyText: string;
  json: unknown;
}

type Segment = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wild' } | { kind: 'deep'; key: string | null };

export class PathError extends Error {}

/** Parses $.a.b[0]['c d'][*]..id. Filters and slices are not supported; the builder says so. */
export function parsePath(path: string): Segment[] {
  const p = path.trim();
  if (p !== '$' && !p.startsWith('$.') && !p.startsWith('$[')) throw new PathError('A path starts with $, like $.items[0].id');
  const out: Segment[] = [];
  let i = 1;
  while (i < p.length) {
    if (p.startsWith('..', i)) {
      i += 2;
      const m = /^(\*|[A-Za-z_$][\w$-]*)/.exec(p.slice(i));
      if (!m) throw new PathError(`Expected a name after .. in ${path}`);
      out.push({ kind: 'deep', key: m[1] === '*' ? null : m[1]! });
      i += m[1]!.length;
    } else if (p[i] === '.') {
      const m = /^(\*|[A-Za-z_$][\w$-]*)/.exec(p.slice(i + 1));
      if (!m) throw new PathError(`Expected a name after . in ${path}`);
      out.push(m[1] === '*' ? { kind: 'wild' } : { kind: 'key', key: m[1]! });
      i += 1 + m[1]!.length;
    } else if (p[i] === '[') {
      const close = p.indexOf(']', i);
      if (close < 0) throw new PathError(`Missing ] in ${path}`);
      const inner = p.slice(i + 1, close).trim();
      if (inner === '*') out.push({ kind: 'wild' });
      else if (/^-?\d+$/.test(inner)) out.push({ kind: 'index', index: Number(inner) });
      else if (/^'.*'$|^".*"$/.test(inner)) out.push({ kind: 'key', key: inner.slice(1, -1) });
      else throw new PathError(`Filters and slices are not supported yet: [${inner}]`);
      i = close + 1;
    } else throw new PathError(`Unexpected "${p[i]}" in ${path}`);
  }
  return out;
}

const children = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as Record<string, unknown>) : [];

function descendants(v: unknown, key: string | null, out: unknown[]): void {
  if (v && typeof v === 'object') {
    if (!Array.isArray(v) && key !== null && key in (v as object)) out.push((v as Record<string, unknown>)[key]);
    for (const c of children(v)) {
      if (key === null) out.push(c);
      descendants(c, key, out);
    }
  }
}

/** Every value the path selects. A missing key selects nothing rather than failing. */
export function queryPath(doc: unknown, path: string): unknown[] {
  let current: unknown[] = [doc];
  for (const seg of parsePath(path)) {
    const next: unknown[] = [];
    for (const v of current) {
      if (seg.kind === 'key') {
        if (v && typeof v === 'object' && !Array.isArray(v) && seg.key in v) next.push((v as Record<string, unknown>)[seg.key]);
      } else if (seg.kind === 'index') {
        if (Array.isArray(v)) {
          const at = seg.index < 0 ? v.length + seg.index : seg.index;
          if (at >= 0 && at < v.length) next.push(v[at]);
        }
      } else if (seg.kind === 'wild') next.push(...children(v));
      else descendants(v, seg.key, next);
    }
    current = next;
  }
  return current;
}

const isMulti = (path: string) => path.includes('*') || path.includes('..');
const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? 'undefined');
const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Runs a tester's regex with a time limit. The pattern comes from the tester and runs inside core-api,
 * so a catastrophic pattern would otherwise block the event loop for every tenant.
 */
function regexTest(pattern: string, text: string): boolean {
  const re = new RegExp(pattern);
  return runInNewContext('re.test(s)', { re, s: text }, { timeout: 50 }) as boolean;
}

function compare(op: ApiAssertion['op'], actual: unknown, expected: string): boolean {
  const a = show(actual);
  const na = typeof actual === 'number' ? actual : Number(a);
  const ne = Number(expected);
  const numeric = expected.trim() !== '' && !Number.isNaN(ne) && !Number.isNaN(na) && a.trim() !== '';
  switch (op) {
    case 'eq':
      return numeric ? na === ne : a === expected;
    case 'ne':
      return numeric ? na !== ne : a !== expected;
    case 'lt':
      return numeric && na < ne;
    case 'lte':
      return numeric && na <= ne;
    case 'gt':
      return numeric && na > ne;
    case 'gte':
      return numeric && na >= ne;
    case 'contains':
      return Array.isArray(actual) ? actual.some((x) => show(x) === expected) : a.includes(expected);
    case 'notContains':
      return Array.isArray(actual) ? !actual.some((x) => show(x) === expected) : !a.includes(expected);
    case 'matches':
      return regexTest(expected, a);
    case 'type':
      return typeOf(actual) === expected.trim().toLowerCase();
    case 'in':
      return expected
        .split(',')
        .map((s) => s.trim())
        .includes(a);
    default:
      return false;
  }
}

const OP_WORDS: Record<ApiAssertion['op'], string> = {
  eq: 'is',
  ne: 'is not',
  lt: 'is below',
  lte: 'is at most',
  gt: 'is above',
  gte: 'is at least',
  contains: 'contains',
  notContains: 'does not contain',
  matches: 'matches',
  exists: 'exists',
  notExists: 'does not exist',
  type: 'is of type',
  in: 'is one of',
};

function subject(a: ApiAssertion): string {
  if (a.source === 'status') return 'status';
  if (a.source === 'time') return 'response time (ms)';
  if (a.source === 'size') return 'size (bytes)';
  if (a.source === 'header') return `header ${a.path}`;
  return a.path || '$';
}

/** The values an assertion or extractor reads. Header names match without case. */
function select(source: ApiAssertion['source'], path: string, r: ResponseFacts): unknown[] {
  if (source === 'status') return [r.status];
  if (source === 'time') return [r.timeMs];
  if (source === 'size') return [r.sizeBytes];
  if (source === 'header') {
    const want = path.trim().toLowerCase();
    return r.headers.filter(([k]) => k.toLowerCase() === want).map(([, v]) => v);
  }
  if (!path.trim() || path.trim() === '$') return [r.json === undefined ? r.bodyText : r.json];
  if (r.json === undefined) throw new PathError('The body is not JSON, so a JSONPath cannot be read from it');
  return queryPath(r.json, path);
}

/** Checks each enabled assertion. A broken assertion fails with the reason instead of throwing. */
export function evaluate(assertions: ApiAssertion[], r: ResponseFacts): AssertionResult[] {
  return assertions
    .filter((a) => a.enabled)
    .map((a) => {
      const what = `${subject(a)} ${OP_WORDS[a.op]}${a.op === 'exists' || a.op === 'notExists' ? '' : ` ${a.value}`}`;
      try {
        const values = select(a.source, a.path, r);
        if (a.op === 'exists' || a.op === 'notExists') {
          const passed = (values.length > 0) === (a.op === 'exists');
          return { id: a.id, passed, message: what, actual: values.length ? show(values[0]) : null };
        }
        if (!values.length) return { id: a.id, passed: false, message: `${what}: nothing found there`, actual: null };
        // A wildcard path checks every value it selects: "every item's qty is above 0".
        const checked = isMulti(a.path) ? values : [values[0]];
        const failed = checked.find((v) => !compare(a.op, v, a.value));
        const passed = failed === undefined;
        const actual = show(passed ? checked[0] : failed);
        return { id: a.id, passed, message: passed ? what : `${what}, but it is ${actual}`, actual };
      } catch (err) {
        // Errors thrown inside the vm context come from another realm, so instanceof Error is false there.
        const text = err && typeof err === 'object' && 'message' in err ? String(err.message) : '';
        const reason = text.includes('Script execution timed out') ? 'the pattern took too long' : text || 'it could not be checked';
        return { id: a.id, passed: false, message: `${what}: ${reason}`, actual: null };
      }
    });
}

/** Values the enabled extractors pull out, as strings. A path that finds nothing sets nothing. */
export function extract(extractors: ApiExtractor[], r: ResponseFacts): { values: Record<string, string>; problems: string[] } {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  for (const e of extractors.filter((x) => x.enabled)) {
    try {
      const found = select(e.source, e.path, r);
      if (found.length) values[e.variable] = show(found[0]);
      else problems.push(`${e.variable}: nothing at ${e.path || e.source}`);
    } catch (err) {
      problems.push(`${e.variable}: ${err instanceof Error ? err.message : 'could not be read'}`);
    }
  }
  return { values, problems };
}
