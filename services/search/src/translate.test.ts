import { parse } from '@tb/tql';
import { describe, expect, it } from 'vitest';
import { searchBody, whereQuery, type Resolved } from './translate';

const now = new Date('2026-09-27T10:00:00Z');
const resolved: Resolved = {
  owners: new Map([
    ['me', 'user-me'],
    ['Priya Nair', 'user-priya'],
    ['Nobody Here', null],
  ]),
  modules: new Map([['UPI', ['m-upi', 'm-upi-2']]]),
  now,
};
const where = (tql: string) => whereQuery(parse(tql).where, resolved);

describe('whereQuery', () => {
  it('maps equality and lists to term and terms', () => {
    expect(where('priority = P0')).toEqual({ term: { priority: 'P0' } });
    expect(where('label IN (smoke, regression)')).toEqual({ terms: { labels: ['smoke', 'regression'] } });
  });

  it('negates != and NOT IN', () => {
    expect(where('status != obsolete')).toEqual({ bool: { must_not: { term: { status: 'obsolete' } } } });
    expect(where('label NOT IN (a, b)')).toEqual({ bool: { must_not: { terms: { labels: ['a', 'b'] } } } });
  });

  it('turns proximity into a sloppy phrase over title and steps', () => {
    expect(where('text ~ "otp retry"~3')).toEqual({
      multi_match: { query: 'otp retry', fields: ['title^2', 'steps_text'], type: 'phrase', slop: 3 },
    });
    expect(where('title ~ "collect expiry"')).toEqual({
      multi_match: { query: 'collect expiry', fields: ['title'], operator: 'and' },
    });
  });

  it('reads priority comparisons with P0 as the highest', () => {
    expect(where('priority >= P1')).toEqual({ range: { priority_rank: { lte: 1 } } });
    expect(where('priority < P1')).toEqual({ range: { priority_rank: { gt: 1 } } });
  });

  it('resolves relative dates against now', () => {
    expect(where('updated >= -7d')).toEqual({ range: { updated_at: { gte: '2026-09-20T10:00:00.000Z' } } });
  });

  it('treats a date equality as that whole day in IST', () => {
    expect(where('created = "2026-09-01"')).toEqual({
      range: { created_at: { gte: '2026-08-31T18:30:00.000Z', lt: '2026-09-01T18:30:00.000Z' } },
    });
  });

  it('uses pre-resolved owners and modules, and never matches an unknown one', () => {
    expect(where('owner = me')).toEqual({ term: { owner_id: 'user-me' } });
    expect(where('owner = "Nobody Here"')).toEqual({ term: { owner_id: '__nobody__' } });
    expect(where('module = UPI')).toEqual({ terms: { module_ids: ['m-upi', 'm-upi-2'] } });
  });

  it('turns key lookups into key numbers', () => {
    expect(where('key IN (TC-1, TC-2)')).toEqual({ terms: { key_no: [1, 2] } });
  });

  it('flattens AND and OR chains', () => {
    const q = where('priority = P0 AND label = smoke AND status = ready') as { bool: { must: unknown[] } };
    expect(q.bool.must).toHaveLength(3);
    const or = where('priority = P0 OR priority = P1') as {
      bool: { should: unknown[]; minimum_should_match: number };
    };
    expect(or.bool).toMatchObject({ minimum_should_match: 1 });
    expect(or.bool.should).toHaveLength(2);
  });

  it('maps emptiness to exists', () => {
    expect(where('owner IS EMPTY')).toEqual({ bool: { must_not: { exists: { field: 'owner_id' } } } });
  });

  it('escapes wildcard characters in module contains', () => {
    expect(where('module ~ "a*b"')).toEqual({
      wildcard: { module_path: { value: '*a\\*b*', case_insensitive: true } },
    });
  });
});

describe('searchBody', () => {
  it('always filters by project and ends the sort with case_id for search_after', () => {
    const body = searchBody(parse('label = smoke'), 'p1', resolved, { size: 50 });
    expect(body.query).toMatchObject({ bool: { filter: [{ term: { project_id: 'p1' } }] } });
    expect((body.sort as unknown[]).at(-1)).toEqual({ case_id: 'asc' });
  });

  it('sorts by relevance when searching text, otherwise by key', () => {
    expect((searchBody(parse('text ~ otp'), 'p', resolved, { size: 1 }).sort as unknown[])[0]).toEqual({
      _score: 'desc',
    });
    expect((searchBody(parse('label = a'), 'p', resolved, { size: 1 }).sort as unknown[])[0]).toEqual({
      key_no: 'asc',
    });
  });

  it('sorts by the group field first and asks for group counts on the first page only', () => {
    const first = searchBody(parse('label = a GROUP BY module'), 'p', resolved, { size: 1 });
    expect((first.sort as unknown[])[0]).toEqual({ module_sort: 'asc' });
    expect(first.aggs).toEqual({ groups: { terms: { field: 'module_path', size: 100, missing: '—' } } });
    expect(
      searchBody(parse('label = a GROUP BY module'), 'p', resolved, { size: 1, after: [1, 'x'] }).aggs,
    ).toBeUndefined();
  });
});
