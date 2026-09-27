import { describe, expect, it } from 'vitest';
import { highlight, suggest } from './assist';

const labels = (q: string, cursor = q.length, dynamic = {}) =>
  suggest(q, cursor, dynamic).items.map((i) => i.label);

describe('suggest', () => {
  it('offers fields at the start and after AND', () => {
    expect(labels('')).toContain('priority');
    expect(labels('label = smoke AND ')).toContain('lastResult');
  });

  it('filters by the word being typed and replaces just that word', () => {
    const s = suggest('label = smoke AND pri', 21);
    expect(s.items.map((i) => i.label)).toEqual(['priority']);
    expect(s.from).toBe(18);
    expect(s.to).toBe(21);
  });

  it('offers only the operators a field supports', () => {
    expect(labels('title ')).toEqual(['~', '!~']);
    expect(labels('owner ')).toContain('IS EMPTY');
  });

  it('offers enum values in readable form, quoting when needed', () => {
    const s = suggest('status = ', 9);
    expect(s.items.map((i) => i.label)).toContain('Needs review');
    expect(s.items.find((i) => i.label === 'Needs review')!.insert).toBe('"Needs review" ');
  });

  it('offers values inside a list', () => {
    expect(labels('priority IN (P0, ')).toContain('P2');
  });

  it('uses project-specific values the caller supplies', () => {
    expect(labels('label = ', 8, { label: ['smoke', 'release-4.18'] })).toEqual(['smoke', 'release-4.18']);
    expect(labels('owner = ', 8, { owner: ['Priya Nair'] })).toEqual(['me', 'Priya Nair']);
  });

  it('offers joining keywords after a complete condition', () => {
    expect(labels('label = smoke ')).toEqual(['AND', 'OR', 'ORDER BY', 'GROUP BY']);
  });

  it('offers only sortable fields after ORDER BY and groupable ones after GROUP BY', () => {
    expect(labels('ORDER BY ')).not.toContain('text');
    expect(labels('GROUP BY ')).toContain('module');
    expect(labels('GROUP BY ')).not.toContain('title');
  });

  it('stays quiet inside an unfinished quoted string', () => {
    expect(labels('text ~ "otp re')).toEqual([]);
  });
});

describe('highlight', () => {
  it('classifies fields, operators, keywords, strings and numbers', () => {
    const q = 'priority = P0 AND text ~ "otp"~2 AND updated >= -7d';
    const classes = highlight(q).map((h) => `${q.slice(h.start, h.end)}:${h.cls}`);
    expect(classes).toEqual([
      'priority:field',
      '=:op',
      'P0:text',
      'AND:kw',
      'text:field',
      '~:op',
      '"otp"~2:str',
      'AND:kw',
      'updated:field',
      '>=:op',
      '-7d:num',
    ]);
  });

  it('never throws on a half-typed query', () => {
    expect(highlight('text ~ "unterminated')).toEqual([]);
  });
});
