import { closest, FIELDS, findField, normaliseEnum, type FieldSpec, type Operator } from './fields';
import { tokenize, TqlError, type Token } from './lexer';

export type Value =
  | { kind: 'text'; text: string; proximity?: number }
  | { kind: 'list'; items: string[] }
  /** Relative to now, in milliseconds (negative is the past): -7d. */
  | { kind: 'relative'; ms: number }
  | { kind: 'date'; iso: string }
  | { kind: 'number'; n: number }
  | { kind: 'none' };

export interface Clause {
  type: 'clause';
  field: FieldSpec;
  op: Operator;
  value: Value;
  start: number;
  end: number;
}

export type Expr = Clause | { type: 'and' | 'or'; left: Expr; right: Expr } | { type: 'not'; expr: Expr };

export interface Query {
  where: Expr | null;
  orderBy: { field: FieldSpec; dir: 'asc' | 'desc' }[];
  groupBy: FieldSpec | null;
}

const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 } as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

/**
 * Parses TQL into a validated query. Precedence is NOT > AND > OR, as in JQL; parentheses group.
 * Every field, operator and value is checked here, so the translator only ever sees valid queries.
 *
 *   label IN (smoke, regression) AND lastResult = Failed AND text ~ "otp retry"~3
 *   ORDER BY priority DESC GROUP BY module
 */
export function parse(input: string): Query {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];
  const isKeyword = (t: Token | undefined, ...kw: string[]) => t?.kind === 'keyword' && kw.includes(t.value);
  const fail = (message: string, token?: Token): never => {
    throw new TqlError(message, token?.start ?? input.length, token?.end ?? input.length);
  };

  const fieldFrom = (token: Token | undefined, purpose: string): FieldSpec => {
    if (!token || token.kind !== 'word') return fail(`Expected a field name ${purpose}`, token);
    const field = findField(token.value);
    if (!field) {
      const hint = closest(
        token.value,
        FIELDS.map((f) => f.name),
      );
      return fail(`Unknown field '${token.value}'.${hint ? ` Did you mean ${hint}?` : ''}`, token);
    }
    return field;
  };

  const scalar = (field: FieldSpec, token: Token | undefined): string => {
    if (!token || !['word', 'string', 'number'].includes(token.kind))
      return fail(`Expected a value for ${field.name}`, token);
    if (field.type !== 'enum') return token.value;
    const value = normaliseEnum(field, token.value);
    if (!value) {
      const hint = closest(token.value, field.values!);
      return fail(
        `'${token.value}' is not a ${field.name}.${hint ? ` Did you mean ${hint}?` : ` Use one of: ${field.values!.join(', ')}.`}`,
        token,
      );
    }
    return value;
  };

  const readOperator = (field: FieldSpec): Operator => {
    const t = next();
    let op: Operator | undefined;
    if (t?.kind === 'op') op = t.value as Operator;
    else if (isKeyword(t, 'IN')) op = 'IN';
    else if (isKeyword(t, 'NOT') && isKeyword(peek(), 'IN')) {
      next();
      op = 'NOT IN';
    } else if (isKeyword(t, 'IS')) {
      if (isKeyword(peek(), 'NOT')) {
        next();
        op = 'IS NOT EMPTY';
      } else op = 'IS EMPTY';
      if (!isKeyword(next(), 'EMPTY')) fail('Expected EMPTY', tokens[pos - 1]);
    }
    if (!op) return fail(`Expected an operator after ${field.name}, such as = or ~`, t);
    if (!field.ops.includes(op))
      fail(`${field.name} does not support ${op}. Use ${field.ops.join(', ')}.`, t);
    return op;
  };

  const readValue = (field: FieldSpec, op: Operator): Value => {
    if (op === 'IS EMPTY' || op === 'IS NOT EMPTY') return { kind: 'none' };
    if (op === 'IN' || op === 'NOT IN') {
      const open = next();
      if (open?.kind !== 'lparen') fail(`Expected ( after ${op}`, open);
      const items: string[] = [];
      do {
        items.push(scalar(field, next()));
      } while (peek()?.kind === 'comma' && next());
      const close = next();
      if (close?.kind !== 'rparen') fail('Expected , or ) to continue or close the list', close);
      return { kind: 'list', items };
    }
    const t = next();
    if (field.type === 'text') {
      if (!t || (t.kind !== 'string' && t.kind !== 'word' && t.kind !== 'number'))
        return fail(`Expected text to search for, e.g. "otp retry"`, t);
      return { kind: 'text', text: t.value, ...(t.proximity !== undefined && { proximity: t.proximity }) };
    }
    if (field.type === 'date') {
      if (t?.kind === 'relative') {
        const m = /^-(\d+)([hdw])$/.exec(t.value)!;
        return { kind: 'relative', ms: -Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS] };
      }
      if ((t?.kind === 'string' || t?.kind === 'word' || t?.kind === 'number') && ISO_DATE.test(t.value))
        return { kind: 'date', iso: t.value };
      return fail(`Expected a date such as -7d, -24h or "2026-09-01" for ${field.name}`, t);
    }
    if (field.type === 'number') {
      if (t?.kind !== 'number') return fail(`Expected a number for ${field.name}`, t);
      return { kind: 'number', n: Number(t.value) };
    }
    return { kind: 'text', text: scalar(field, t) };
  };

  const clause = (): Expr => {
    const t = peek();
    if (t?.kind === 'lparen') {
      next();
      const inner = orExpr();
      const close = next();
      if (close?.kind !== 'rparen') fail('Expected ) to close the group', close);
      return inner;
    }
    const fieldToken = next();
    const field = fieldFrom(fieldToken, 'here');
    const op = readOperator(field);
    const value = readValue(field, op);
    return { type: 'clause', field, op, value, start: fieldToken!.start, end: tokens[pos - 1]!.end };
  };
  const notExpr = (): Expr =>
    isKeyword(peek(), 'NOT') && !isKeyword(tokens[pos + 1], 'IN')
      ? (next(), { type: 'not', expr: notExpr() })
      : clause();
  const andExpr = (): Expr => {
    let left = notExpr();
    while (isKeyword(peek(), 'AND')) {
      next();
      left = { type: 'and', left, right: notExpr() };
    }
    return left;
  };
  const orExpr = (): Expr => {
    let left = andExpr();
    while (isKeyword(peek(), 'OR')) {
      next();
      left = { type: 'or', left, right: andExpr() };
    }
    return left;
  };

  const query: Query = { where: null, orderBy: [], groupBy: null };
  if (peek() && !isKeyword(peek(), 'ORDER', 'GROUP')) query.where = orExpr();

  while (peek()) {
    const t = next()!;
    if (isKeyword(t, 'ORDER') && isKeyword(next(), 'BY')) {
      do {
        const fieldToken = next();
        const field = fieldFrom(fieldToken, 'after ORDER BY');
        if (!field.sortable) fail(`Results cannot be sorted by ${field.name}`, fieldToken);
        const dir = isKeyword(peek(), 'ASC', 'DESC')
          ? (next()!.value.toLowerCase() as 'asc' | 'desc')
          : 'asc';
        query.orderBy.push({ field, dir });
      } while (peek()?.kind === 'comma' && next());
    } else if (isKeyword(t, 'GROUP') && isKeyword(next(), 'BY')) {
      const fieldToken = next();
      const field = fieldFrom(fieldToken, 'after GROUP BY');
      if (!field.groupable) fail(`Results cannot be grouped by ${field.name}`, fieldToken);
      query.groupBy = field;
    } else {
      fail(
        query.where ? 'Expected AND, OR, ORDER BY or GROUP BY' : 'Expected a condition such as priority = P0',
        t,
      );
    }
  }
  if (pos < tokens.length) fail('Unexpected text', tokens[pos]);
  return query;
}

/** Every clause in a query, for callers that need to pre-resolve values (e.g. owner names to ids). */
export function clauses(expr: Expr | null): Clause[] {
  if (!expr) return [];
  if (expr.type === 'clause') return [expr];
  if (expr.type === 'not') return clauses(expr.expr);
  return [...clauses(expr.left), ...clauses(expr.right)];
}
