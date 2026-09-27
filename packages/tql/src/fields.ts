import { AUTOMATION, CASE_STATUSES, PRIORITIES, RESULTS } from '@tb/contracts';

// The TQL field allowlist. Only these names are accepted, so user input never reaches the search
// engine as a field name. The search service maps each one to its index field.

export type FieldType = 'key' | 'text' | 'module' | 'enum' | 'keyword' | 'user' | 'date' | 'number';
export type Operator =
  '=' | '!=' | '~' | '!~' | 'IN' | 'NOT IN' | '>' | '>=' | '<' | '<=' | 'IS EMPTY' | 'IS NOT EMPTY';

export interface FieldSpec {
  name: string;
  type: FieldType;
  ops: readonly Operator[];
  /** Allowed values for enum fields, canonical form. */
  values?: readonly string[];
  sortable?: boolean;
  groupable?: boolean;
  description: string;
}

const EQ: Operator[] = ['=', '!=', 'IN', 'NOT IN'];
const CMP: Operator[] = ['=', '>', '>=', '<', '<='];

const spec = (s: FieldSpec) => s;
export const FIELDS: readonly FieldSpec[] = [
  spec({
    name: 'text',
    type: 'text',
    ops: ['~', '!~'],
    description: 'Title and steps; "a b"~3 finds words near each other',
  }),
  spec({ name: 'title', type: 'text', ops: ['~', '!~'], sortable: true, description: 'Case title' }),
  spec({ name: 'key', type: 'key', ops: EQ, sortable: true, description: 'Case key, e.g. TC-10231' }),
  spec({
    name: 'module',
    type: 'module',
    ops: [...EQ, '~'],
    sortable: true,
    groupable: true,
    description: 'Module path; = matches the module and everything under it',
  }),
  spec({
    name: 'priority',
    type: 'enum',
    ops: [...EQ, '>', '>=', '<', '<='],
    values: PRIORITIES,
    sortable: true,
    groupable: true,
    description: 'P0 (highest) to P3',
  }),
  spec({
    name: 'status',
    type: 'enum',
    ops: EQ,
    values: CASE_STATUSES,
    sortable: true,
    groupable: true,
    description: 'Draft, In review, Ready, Needs review, Obsolete',
  }),
  spec({
    name: 'lastResult',
    type: 'enum',
    ops: EQ,
    values: RESULTS,
    sortable: true,
    groupable: true,
    description: 'Result of the latest execution',
  }),
  spec({
    name: 'automation',
    type: 'enum',
    ops: EQ,
    values: AUTOMATION,
    groupable: true,
    description: 'Manual, Automated or Flaky',
  }),
  spec({
    name: 'type',
    type: 'keyword',
    ops: EQ,
    groupable: true,
    description: 'Functional, Regression, Negative…',
  }),
  spec({
    name: 'label',
    type: 'keyword',
    ops: [...EQ, 'IS EMPTY', 'IS NOT EMPTY'],
    groupable: true,
    description: 'Case labels',
  }),
  spec({
    name: 'owner',
    type: 'user',
    ops: [...EQ, 'IS EMPTY', 'IS NOT EMPTY'],
    groupable: true,
    description: 'Owner by name or email, or me',
  }),
  spec({
    name: 'updated',
    type: 'date',
    ops: CMP,
    sortable: true,
    description: 'Last change, e.g. updated >= -7d',
  }),
  spec({ name: 'created', type: 'date', ops: CMP, sortable: true, description: 'Creation date' }),
  spec({
    name: 'lastRun',
    type: 'date',
    ops: [...CMP, 'IS EMPTY', 'IS NOT EMPTY'],
    sortable: true,
    description: 'When it last ran',
  }),
  spec({ name: 'estimate', type: 'number', ops: CMP, sortable: true, description: 'Estimated minutes' }),
];

const ALIASES: Record<string, string> = {
  labels: 'label',
  result: 'lastResult',
  lastresult: 'lastResult',
  prio: 'priority',
  lastrun: 'lastRun',
};
const BY_NAME = new Map(FIELDS.map((f) => [f.name.toLowerCase(), f]));

export function findField(name: string): FieldSpec | undefined {
  const lower = name.toLowerCase();
  return BY_NAME.get(lower) ?? BY_NAME.get((ALIASES[lower] ?? '').toLowerCase());
}

/** Canonical enum value from what people type: "Needs review", "needs_review" and "NEEDS-REVIEW" all work. */
export function normaliseEnum(field: FieldSpec, raw: string): string | undefined {
  const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const wanted = squash(raw);
  return field.values?.find((v) => squash(v) === wanted);
}

/** Levenshtein distance, for "did you mean" hints on misspelled field names and values. */
export function editDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

export function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = c.toLowerCase().startsWith(input.toLowerCase()) ? 0 : editDistance(input, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}
