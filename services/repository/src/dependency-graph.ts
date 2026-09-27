/**
 * Checks whether making `caseId` depend on `dependsOn` would create a cycle, given the existing
 * "depends on" edges. Returns the offending path (caseId → … → caseId) or null.
 *
 * Cycles must be rejected at write time: the run expander orders cases by their prerequisites and
 * auto-blocks dependents, and neither is defined on a cycle.
 */
export function findCycle(
  edges: ReadonlyMap<string, readonly string[]>,
  caseId: string,
  dependsOn: readonly string[],
): string[] | null {
  if (dependsOn.includes(caseId)) return [caseId, caseId];
  // A cycle exists iff caseId is reachable from one of its new prerequisites.
  const parent = new Map<string, string>();
  const queue = [...new Set(dependsOn)];
  for (const d of queue) parent.set(d, caseId);
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of edges.get(current) ?? []) {
      if (next === caseId) {
        const path = [caseId, current];
        for (let p = parent.get(current); p !== undefined && p !== caseId; p = parent.get(p))
          path.splice(1, 0, p);
        path.push(caseId);
        return path;
      }
      if (!parent.has(next)) {
        parent.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}
