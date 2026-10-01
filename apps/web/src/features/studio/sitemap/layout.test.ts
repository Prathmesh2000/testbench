import { describe, expect, it } from 'vitest';
import { layers } from './layout';

describe('layers', () => {
  it('puts each node one layer after what leads to it, and survives cycles', () => {
    const placed = layers(
      ['p:/login', 'w:signin', 'p:/projects', 'w:create', 'p:/projects/:id', 'w:module'],
      [
        { from: 'p:/login', to: 'w:signin' },
        { from: 'w:signin', to: 'p:/projects' },
        { from: 'p:/projects', to: 'w:create' },
        { from: 'w:create', to: 'p:/projects/:id' },
        { from: 'p:/projects/:id', to: 'w:module' },
        // Adding a module stays on the project page.
        { from: 'w:module', to: 'p:/projects/:id' },
      ],
    );
    expect([...placed.entries()].map(([id, p]) => [id, p.layer])).toEqual([
      ['p:/login', 0],
      ['w:signin', 1],
      ['p:/projects', 2],
      ['w:create', 3],
      ['p:/projects/:id', 4],
      ['w:module', 5],
    ]);
  });

  it('places nodes nothing reaches, and stacks a layer in rows', () => {
    const placed = layers(['a', 'b', 'c'], [{ from: 'a', to: 'c' }]);
    expect(placed.get('a')).toEqual({ layer: 0, row: 0 });
    expect(placed.get('b')).toEqual({ layer: 0, row: 1 });
    expect(placed.get('c')).toEqual({ layer: 1, row: 0 });
  });
});
