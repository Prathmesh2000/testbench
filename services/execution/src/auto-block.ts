import type { Result } from '@tb/contracts';

export interface BlockableItem {
  id: string;
  caseId: string;
  caseKey: string;
  config: string;
  status: Result;
  blockedBy: string | null;
}

export interface BlockChange {
  id: string;
  status: Result;
  blockedBy: string | null;
  blockedReason: string | null;
}

/**
 * Dependency auto-block (HLD §5.3). When a prerequisite's item fails or is blocked, every untested item
 * that depends on it — directly or through a chain — in the same configuration becomes Blocked, so
 * testers do not spend time on cases that cannot pass. When the prerequisite later passes (or is reset),
 * the items it had blocked go back to untested.
 *
 * Only items that were auto-blocked by this chain are released; an item a tester blocked by hand
 * (blockedBy null) is never touched, and neither is any item that already has a result.
 *
 * `dependents` maps a case id to the cases that depend on it.
 */
export function autoBlockChanges(
  changed: BlockableItem,
  items: readonly BlockableItem[],
  dependents: ReadonlyMap<string, readonly string[]>,
): BlockChange[] {
  const sameConfig = items.filter((i) => i.config === changed.config && i.id !== changed.id);
  const byCase = new Map(sameConfig.map((i) => [i.caseId, i]));
  const blocking = changed.status === 'failed' || changed.status === 'blocked';
  const changes: BlockChange[] = [];

  const visited = new Set<string>([changed.caseId]);
  const queue = [changed.caseId];
  while (queue.length) {
    const caseId = queue.shift()!;
    for (const dependentCase of dependents.get(caseId) ?? []) {
      if (visited.has(dependentCase)) continue;
      visited.add(dependentCase);
      const item = byCase.get(dependentCase);
      if (!item) continue;

      if (blocking && item.status === 'untested') {
        changes.push({
          id: item.id,
          status: 'blocked',
          blockedBy: changed.id,
          blockedReason: `Prerequisite ${changed.caseKey} ${changed.status === 'failed' ? 'failed' : 'is blocked'}`,
        });
      } else if (!blocking && item.status === 'blocked' && item.blockedBy === changed.id) {
        changes.push({ id: item.id, status: 'untested', blockedBy: null, blockedReason: null });
      } else {
        // An item with its own result is left alone, and so is everything behind it.
        continue;
      }
      // Items further down the chain are blocked by (and later released through) the same root item.
      queue.push(dependentCase);
    }
  }
  return changes;
}
