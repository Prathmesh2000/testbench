import { describe, expect, it } from 'vitest';
import { modulePaths, toTree, type ModuleRow } from './modules';

const rows: ModuleRow[] = [
  { id: 'upi', parent_id: null, name: 'UPI', position: 0, total: 0, failing: 0 },
  { id: 'collect', parent_id: 'upi', name: 'Collect', position: 0, total: 120, failing: 4 },
  { id: 'expiry', parent_id: 'collect', name: 'Expiry', position: 0, total: 30, failing: 1 },
  { id: 'intent', parent_id: 'upi', name: 'Intent', position: 1, total: 80, failing: 0 },
];

describe('modulePaths', () => {
  it('joins ancestor names', () => {
    const paths = modulePaths(rows);
    expect(paths.get('expiry')).toBe('UPI / Collect / Expiry');
    expect(paths.get('upi')).toBe('UPI');
  });
});

describe('toTree', () => {
  it('rolls counts up to every ancestor', () => {
    const tree = new Map(toTree(rows).map((n) => [n.id, n]));
    expect(tree.get('collect')).toMatchObject({ total: 150, failing: 5 });
    expect(tree.get('upi')).toMatchObject({ total: 230, failing: 5 });
    expect(tree.get('expiry')).toMatchObject({ total: 30, failing: 1 });
  });
});
