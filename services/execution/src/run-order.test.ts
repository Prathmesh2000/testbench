import { describe, expect, it } from 'vitest';
import { orderByPrerequisites } from './run-order';

describe('orderByPrerequisites', () => {
  it('keeps the original order when there are no dependencies', () => {
    expect(orderByPrerequisites(['a', 'b', 'c'], new Map())).toEqual(['a', 'b', 'c']);
  });

  it('moves a prerequisite ahead of the case that needs it', () => {
    expect(
      orderByPrerequisites(['checkout', 'receipt', 'login'], new Map([['checkout', ['login']]])),
    ).toEqual(['receipt', 'login', 'checkout']);
  });

  it('handles chains', () => {
    const deps = new Map([
      ['c', ['b']],
      ['b', ['a']],
    ]);
    expect(orderByPrerequisites(['c', 'b', 'a'], deps)).toEqual(['a', 'b', 'c']);
  });

  it('ignores prerequisites that are not in the run', () => {
    expect(orderByPrerequisites(['b', 'a'], new Map([['b', ['outside']]]))).toEqual(['b', 'a']);
  });

  it('never drops cases, even on a cycle', () => {
    const result = orderByPrerequisites(
      ['a', 'b', 'c'],
      new Map([
        ['a', ['b']],
        ['b', ['a']],
      ]),
    );
    expect(result.sort()).toEqual(['a', 'b', 'c']);
  });
});
