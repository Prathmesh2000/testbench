import { describe, expect, it } from 'vitest';
import { autoBlockChanges, type BlockableItem } from './auto-block';

const CHROME = 'Chrome 128 · Win 11';
const SAFARI = 'Safari 17 · macOS 14';

function item(caseId: string, config = CHROME, over: Partial<BlockableItem> = {}): BlockableItem {
  return {
    id: `${caseId}@${config}`,
    caseId,
    caseKey: `TC-${caseId}`,
    config,
    status: 'untested',
    blockedBy: null,
    ...over,
  };
}

// checkout and refund depend on login; receipt depends on checkout.
const dependents = new Map([
  ['login', ['checkout', 'refund']],
  ['checkout', ['receipt']],
]);

describe('autoBlockChanges', () => {
  it('blocks direct and indirect dependents when a prerequisite fails', () => {
    const login = item('login', CHROME, { status: 'failed' });
    const items = [login, item('checkout'), item('refund'), item('receipt')];
    const changes = autoBlockChanges(login, items, dependents);
    expect(changes.map((c) => c.id).sort()).toEqual(
      ['checkout@' + CHROME, 'receipt@' + CHROME, 'refund@' + CHROME].sort(),
    );
    expect(changes.every((c) => c.status === 'blocked' && c.blockedBy === login.id)).toBe(true);
    expect(changes[0]!.blockedReason).toBe('Prerequisite TC-login failed');
  });

  it('only affects the same configuration', () => {
    const login = item('login', CHROME, { status: 'failed' });
    const changes = autoBlockChanges(login, [login, item('checkout', SAFARI)], dependents);
    expect(changes).toEqual([]);
  });

  it('leaves items that already have a result, and does not block past them', () => {
    const login = item('login', CHROME, { status: 'failed' });
    const checkout = item('checkout', CHROME, { status: 'passed' });
    const changes = autoBlockChanges(login, [login, checkout, item('receipt')], dependents);
    expect(changes).toEqual([]);
  });

  it('releases only what this prerequisite blocked when it passes', () => {
    const login = item('login', CHROME, { status: 'passed' });
    const autoBlocked = item('checkout', CHROME, { status: 'blocked', blockedBy: login.id });
    const chained = item('receipt', CHROME, { status: 'blocked', blockedBy: login.id });
    const manuallyBlocked = item('refund', CHROME, { status: 'blocked', blockedBy: null });
    const changes = autoBlockChanges(login, [login, autoBlocked, chained, manuallyBlocked], dependents);
    expect(changes).toEqual([
      { id: autoBlocked.id, status: 'untested', blockedBy: null, blockedReason: null },
      { id: chained.id, status: 'untested', blockedBy: null, blockedReason: null },
    ]);
  });

  it('terminates on a cyclic graph even though the API forbids cycles', () => {
    const cyclic = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const a = item('a', CHROME, { status: 'failed' });
    expect(autoBlockChanges(a, [a, item('b')], cyclic)).toHaveLength(1);
  });
});
