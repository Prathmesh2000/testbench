import { describe, expect, it } from 'vitest';
import { tokenize, TqlError } from './lexer';
import { clauses, parse, type Clause, type Expr } from './parser';

const only = (q: string): Clause => {
  const where = parse(q).where!;
  expect(where.type).toBe('clause');
  return where as Clause;
};
const errorOf = (q: string): TqlError => {
  try {
    parse(q);
  } catch (err) {
    return err as TqlError;
  }
  throw new Error(`expected "${q}" to fail`);
};
const shape = (e: Expr | null): unknown => {
  if (!e) return null;
  if (e.type === 'clause') return `${e.field.name}${e.op}`;
  if (e.type === 'not') return { not: shape(e.expr) };
  return { [e.type]: [shape(e.left), shape(e.right)] };
};

describe('tokenize', () => {
  it('keeps labels, keys and emails as single words', () => {
    expect(
      tokenize('label = release-4.18 AND key = TC-10231 AND owner = sneha.iyer@paytrail.in')
        .filter((t) => t.kind === 'word')
        .map((t) => t.value),
    ).toEqual(['label', 'release-4.18', 'key', 'TC-10231', 'owner', 'sneha.iyer@paytrail.in']);
  });

  it('reads proximity after a quoted phrase', () => {
    const [, , phrase] = tokenize('text ~ "otp retry"~3');
    expect(phrase).toMatchObject({ kind: 'string', value: 'otp retry', proximity: 3 });
  });

  it('reads relative dates as one token', () => {
    expect(tokenize('updated >= -7d')[2]).toMatchObject({ kind: 'relative', value: '-7d' });
  });

  it('reports an unclosed quote with its position', () => {
    expect(() => tokenize('text ~ "otp')).toThrowError(TqlError);
    try {
      tokenize('text ~ "otp');
    } catch (err) {
      expect((err as TqlError).start).toBe(7);
    }
  });
});

describe('parse', () => {
  it('normalises enum values however they are typed', () => {
    expect(only('status = "Needs review"').value).toEqual({ kind: 'text', text: 'needs_review' });
    expect(only('lastResult = Failed').value).toEqual({ kind: 'text', text: 'failed' });
    expect(only('result = FAILED').field.name).toBe('lastResult');
  });

  it('parses lists', () => {
    expect(only('label IN (smoke, regression)').value).toEqual({
      kind: 'list',
      items: ['smoke', 'regression'],
    });
    expect(only('priority NOT IN (P2, P3)').op).toBe('NOT IN');
  });

  it('parses proximity text search', () => {
    expect(only('text ~ "otp retry"~3').value).toEqual({ kind: 'text', text: 'otp retry', proximity: 3 });
  });

  it('parses relative and absolute dates', () => {
    expect(only('updated >= -7d').value).toEqual({ kind: 'relative', ms: -7 * 86_400_000 });
    expect(only('created < "2026-09-01"').value).toEqual({ kind: 'date', iso: '2026-09-01' });
  });

  it('parses IS EMPTY and IS NOT EMPTY', () => {
    expect(only('owner IS EMPTY').op).toBe('IS EMPTY');
    expect(only('label IS NOT EMPTY').op).toBe('IS NOT EMPTY');
  });

  it('binds NOT tighter than AND, and AND tighter than OR', () => {
    expect(shape(parse('priority = P0 OR priority = P1 AND NOT status = draft').where)).toEqual({
      or: ['priority=', { and: ['priority=', { not: 'status=' }] }],
    });
  });

  it('respects parentheses', () => {
    expect(shape(parse('(priority = P0 OR priority = P1) AND label = smoke').where)).toEqual({
      and: [{ or: ['priority=', 'priority='] }, 'label='],
    });
  });

  it('parses ORDER BY and GROUP BY, with or without a condition', () => {
    const q = parse('label = smoke ORDER BY priority DESC, updated GROUP BY module');
    expect(q.orderBy.map((o) => `${o.field.name} ${o.dir}`)).toEqual(['priority desc', 'updated asc']);
    expect(q.groupBy?.name).toBe('module');
    expect(parse('GROUP BY status').where).toBeNull();
    expect(parse('').where).toBeNull();
  });

  it('lists every clause for pre-resolution', () => {
    expect(
      clauses(parse('owner = me AND (label = a OR NOT owner = "Priya Nair")').where).map((c) => c.field.name),
    ).toEqual(['owner', 'label', 'owner']);
  });
});

describe('parse errors', () => {
  it('suggests the field that was meant', () => {
    const err = errorOf('prio = P0 AND statsu = ready');
    // "prio" is an accepted alias, so the error is on the second field.
    expect(err.message).toBe("Unknown field 'statsu'. Did you mean status?");
    expect(err.start).toBe(14);
  });

  it('suggests the value that was meant', () => {
    expect(errorOf('lastResult = faild').message).toBe("'faild' is not a lastResult. Did you mean failed?");
  });

  it('rejects operators a field does not support', () => {
    expect(errorOf('title = something').message).toContain('title does not support =');
  });

  it('rejects bad dates and numbers', () => {
    expect(errorOf('updated > yesterday').message).toContain('Expected a date');
    expect(errorOf('estimate > ten').message).toContain('Expected a number');
  });

  it('rejects sorting or grouping by a field that does not allow it', () => {
    expect(errorOf('ORDER BY text').message).toContain('cannot be sorted by text');
    expect(errorOf('GROUP BY title').message).toContain('cannot be grouped by title');
  });

  it('points at trailing junk and unclosed groups', () => {
    expect(errorOf('label = smoke smoke').message).toBe('Expected AND, OR, ORDER BY or GROUP BY');
    expect(errorOf('(label = smoke').message).toBe('Expected ) to close the group');
    expect(errorOf('label IN (smoke').message).toContain('Expected , or )');
  });
});
