import { FIELDS, findField, type FieldSpec, type Operator } from './fields';
import { tokenize, type Token } from './lexer';

export interface Suggestion {
  label: string;
  /** Text that replaces the range [from, to). */
  insert: string;
  kind: 'field' | 'operator' | 'value' | 'keyword';
  detail?: string;
}

export interface Suggestions {
  from: number;
  to: number;
  items: Suggestion[];
}

const OPERATOR_TEXT: Record<Operator, string> = {
  '=': '=',
  '!=': '!=',
  '~': '~',
  '!~': '!~',
  IN: 'IN (',
  'NOT IN': 'NOT IN (',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
  'IS EMPTY': 'IS EMPTY',
  'IS NOT EMPTY': 'IS NOT EMPTY',
};
const ENUM_LABELS: Record<string, string> = {
  in_review: 'In review',
  needs_review: 'Needs review',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
  untested: 'Untested',
  draft: 'Draft',
  ready: 'Ready',
  obsolete: 'Obsolete',
  manual: 'Manual',
  automated: 'Automated',
  flaky: 'Flaky',
};
const quoteIfNeeded = (v: string) => (/^[\p{L}\p{N}_.:@/+-]+$/u.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`);
const isFieldPosition = (prev: Token | undefined) =>
  !prev || prev.kind === 'lparen' || (prev.kind === 'keyword' && ['AND', 'OR', 'NOT'].includes(prev.value));

/** Finds the field a value position belongs to, walking back over the operator and any list so far. */
function fieldBefore(tokens: Token[], from: number): FieldSpec | undefined {
  for (let i = from; i >= 0; i--) {
    const t = tokens[i]!;
    if (
      t.kind === 'word' &&
      tokens[i + 1] &&
      (tokens[i + 1]!.kind === 'op' || tokens[i + 1]!.kind === 'keyword')
    ) {
      const field = findField(t.value);
      if (field) return field;
    }
    if (t.kind === 'keyword' && ['AND', 'OR'].includes(t.value)) return undefined;
  }
  return undefined;
}

/**
 * Completions for the text before `cursor`. `dynamicValues` supplies values the parser cannot know,
 * such as label and owner names for this project, keyed by field name.
 */
export function suggest(
  input: string,
  cursor: number,
  dynamicValues: Record<string, readonly string[]> = {},
): Suggestions {
  let tokens: Token[];
  try {
    tokens = tokenize(input.slice(0, cursor));
  } catch {
    return { from: cursor, to: cursor, items: [] }; // inside an unfinished quoted string
  }
  const last = tokens.at(-1);
  const typingWord =
    !!last &&
    last.end === cursor &&
    (last.kind === 'word' || last.kind === 'keyword' || last.kind === 'number');
  const partial = typingWord ? last!.value : '';
  const from = typingWord ? last!.start : cursor;
  const before = typingWord ? tokens.slice(0, -1) : tokens;
  const prev = before.at(-1);
  const prev2 = before.at(-2);

  let items: Suggestion[] = [];
  const fields = (list: readonly FieldSpec[]) =>
    list.map((f): Suggestion => ({
      label: f.name,
      insert: `${f.name} `,
      kind: 'field',
      detail: f.description,
    }));
  const keywords = (list: string[]) =>
    list.map((k): Suggestion => ({ label: k, insert: `${k} `, kind: 'keyword' }));

  if (prev?.kind === 'keyword' && prev.value === 'BY' && prev2?.value === 'ORDER')
    items = fields(FIELDS.filter((f) => f.sortable));
  else if (prev?.kind === 'keyword' && prev.value === 'BY' && prev2?.value === 'GROUP')
    items = fields(FIELDS.filter((f) => f.groupable));
  else if (isFieldPosition(prev)) items = fields(FIELDS);
  else if (prev?.kind === 'word' && findField(prev.value) && isFieldPosition(prev2)) {
    items = findField(prev.value)!.ops.map((op) => ({
      label: op,
      insert: `${OPERATOR_TEXT[op]} `,
      kind: 'operator',
    }));
  } else if (
    prev &&
    (prev.kind === 'op' ||
      (prev.kind === 'keyword' && prev.value === 'IN') ||
      prev.kind === 'lparen' ||
      prev.kind === 'comma')
  ) {
    const field = fieldBefore(before, before.length - 1);
    if (field) {
      const values =
        field.type === 'enum'
          ? field.values!.map((v) => ENUM_LABELS[v] ?? v)
          : field.type === 'date'
            ? ['-24h', '-7d', '-30d']
            : field.name === 'owner'
              ? ['me', ...(dynamicValues.owner ?? [])]
              : (dynamicValues[field.name] ?? []);
      items = values.map((v) => ({
        label: v,
        insert: `${quoteIfNeeded(v)}${prev.kind === 'lparen' || prev.kind === 'comma' ? '' : ' '}`,
        kind: 'value',
      }));
    }
  } else if (prev) {
    // After a complete condition: join it to the next one, or finish with ORDER BY / GROUP BY.
    const inOrderBy = before.some((t, i) => t.value === 'ORDER' && before[i + 1]?.value === 'BY');
    items = inOrderBy
      ? keywords(['ASC', 'DESC', 'GROUP BY'])
      : keywords(['AND', 'OR', 'ORDER BY', 'GROUP BY']);
  }

  const lower = partial.toLowerCase();
  const filtered = lower
    ? items.filter(
        (s) => s.label.toLowerCase().startsWith(lower) || s.label.toLowerCase().includes(` ${lower}`),
      )
    : items;
  return { from, to: cursor, items: filtered.slice(0, 12) };
}

export type HighlightClass = 'kw' | 'field' | 'op' | 'str' | 'num' | 'text';

/** Colour classes for the editor overlay. Never throws: a half-typed query still highlights. */
export function highlight(input: string): { start: number; end: number; cls: HighlightClass }[] {
  let tokens: Token[];
  try {
    tokens = tokenize(input);
  } catch {
    return [];
  }
  return tokens.map((t, i) => {
    const after = tokens[i + 1];
    let cls: HighlightClass = 'text';
    if (t.kind === 'keyword') cls = 'kw';
    else if (t.kind === 'op') cls = 'op';
    else if (t.kind === 'string') cls = 'str';
    else if (t.kind === 'number' || t.kind === 'relative') cls = 'num';
    else if (
      t.kind === 'word' &&
      findField(t.value) &&
      after &&
      (after.kind === 'op' || after.kind === 'keyword')
    )
      cls = 'field';
    return { start: t.start, end: t.end, cls };
  });
}
