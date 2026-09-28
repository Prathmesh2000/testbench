import { describe, expect, it } from 'vitest';
import { cellKey, cellRef, colName, localChanges, mergeElements } from './boards-utils';

describe('sheet addressing', () => {
  it('names columns like a spreadsheet', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(colName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('builds cell keys and references', () => {
    expect(cellKey(3, 1)).toBe('3:1');
    expect(cellRef(0, 0)).toBe('A1');
    expect(cellRef(6, 27)).toBe('AB7');
  });
});

describe('whiteboard element sync', () => {
  const el = (id: string, version: number, index: string | null = null) => ({ id, version, index });

  it('publishes only new or newer local elements', () => {
    const stored = new Map([['a', el('a', 2)], ['b', el('b', 5)]]);
    const changed = localChanges([el('a', 3), el('b', 5), el('c', 1)], (id) => stored.get(id));
    expect(changed.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('takes remote versions unless the local one is strictly newer', () => {
    const merged = mergeElements([el('a', 4, 'a1'), el('b', 1, 'a2')], [el('a', 3, 'a1'), el('b', 1, 'a2'), el('c', 1, 'a0')]);
    expect(merged.map((e) => [e.id, e.version])).toEqual([['c', 1], ['a', 4], ['b', 1]]);
  });

  it('does not produce local changes after merging a remote scene (no echo)', () => {
    const remote = [el('a', 7), el('b', 2)];
    const stored = new Map(remote.map((e) => [e.id, e]));
    const merged = mergeElements([el('a', 6)], remote);
    expect(localChanges(merged, (id) => stored.get(id))).toEqual([]);
  });
});
