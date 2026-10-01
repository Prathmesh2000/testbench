import type { SpecDiff } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { changesSince, reviewNote } from './impact';

const diff = (changes: SpecDiff['changes']): SpecDiff => ({ fromVersion: 1, added: 0, removed: 0, changed: changes.length, breaking: changes.filter((c) => c.breaking).length, changes });
const diffs = [
  { version: 1, diff: null },
  { version: 2, diff: diff([{ kind: 'response_added', breaking: false, method: 'POST', path: '/orders', detail: 'Response 409 documented' }]) },
  { version: 3, diff: diff([{ kind: 'parameter_now_required', breaking: true, method: 'POST', path: '/orders', detail: 'header parameter X-Tenant is now required' }, { kind: 'deprecated', breaking: false, method: 'GET', path: '/orders', detail: 'GET /orders is deprecated' }]) },
];

describe('impact', () => {
  it('collects the changes to one operation after a version, and leads with what breaks', () => {
    expect(changesSince(diffs, 'POST /orders', 1)).toHaveLength(2);
    expect(changesSince(diffs, 'POST /orders', 2)).toHaveLength(1);
    expect(changesSince(diffs, 'POST /orders', 3)).toEqual([]);
    expect(reviewNote(changesSince(diffs, 'POST /orders', 1))).toBe('Breaking: header parameter X-Tenant is now required (+1 more)');
    expect(reviewNote([])).toBeNull();
  });
});
