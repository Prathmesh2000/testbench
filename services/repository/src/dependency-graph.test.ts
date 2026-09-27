import { describe, expect, it } from 'vitest';
import { findCycle } from './dependency-graph';

const graph = (edges: Record<string, string[]>) => new Map(Object.entries(edges));

describe('findCycle', () => {
  it('allows a new prerequisite when nothing leads back', () => {
    expect(findCycle(graph({ login: [] }), 'checkout', ['login'])).toBeNull();
  });

  it('rejects a case depending on itself', () => {
    expect(findCycle(graph({}), 'a', ['a'])).toEqual(['a', 'a']);
  });

  it('rejects a direct cycle', () => {
    expect(findCycle(graph({ b: ['a'] }), 'a', ['b'])).toEqual(['a', 'b', 'a']);
  });

  it('rejects an indirect cycle and returns the full path', () => {
    // c → b → a already; making a depend on c closes the loop.
    expect(findCycle(graph({ c: ['b'], b: ['a'] }), 'a', ['c'])).toEqual(['a', 'c', 'b', 'a']);
  });

  it('ignores unrelated edges and diamonds', () => {
    const edges = graph({ d: ['b', 'c'], b: ['a'], c: ['a'], x: ['y'] });
    expect(findCycle(edges, 'e', ['d'])).toBeNull();
  });
});
