import { describe, expect, it } from 'vitest';
import { diffSteps } from './step-diff';

const s = (action: string, expected = 'ok') => ({ action, expected, data: '' });
const kinds = (changes: ReturnType<typeof diffSteps>) => changes.map((c) => c.kind);

describe('diffSteps', () => {
  it('reports identical versions as all same', () => {
    expect(kinds(diffSteps([s('a'), s('b')], [s('a'), s('b')]))).toEqual(['same', 'same']);
  });

  it('keeps later steps aligned when one is inserted at the top', () => {
    expect(kinds(diffSteps([s('b'), s('c')], [s('a'), s('b'), s('c')]))).toEqual(['added', 'same', 'same']);
  });

  it('reports an edited step as changed, not removed plus added', () => {
    const result = diffSteps([s('a'), s('b'), s('c')], [s('a'), s('b', 'Status is SUCCESS'), s('c')]);
    expect(kinds(result)).toEqual(['same', 'changed', 'same']);
    expect(result[1]).toMatchObject({ before: { expected: 'ok' }, after: { expected: 'Status is SUCCESS' } });
  });

  it('handles a removed step at the end', () => {
    expect(kinds(diffSteps([s('a'), s('b')], [s('a')]))).toEqual(['same', 'removed']);
  });

  it('pairs uneven replacements and reports the rest', () => {
    expect(kinds(diffSteps([s('a'), s('x'), s('y')], [s('a'), s('z')]))).toEqual([
      'same',
      'changed',
      'removed',
    ]);
  });

  it('handles empty versions', () => {
    expect(diffSteps([], [])).toEqual([]);
    expect(kinds(diffSteps([], [s('a')]))).toEqual(['added']);
    expect(kinds(diffSteps([s('a')], []))).toEqual(['removed']);
  });
});
