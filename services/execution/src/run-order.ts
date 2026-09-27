/**
 * Orders a run's cases so every prerequisite comes before the cases that depend on it (HLD §5.3),
 * keeping the original order wherever dependencies do not force a change.
 *
 * `dependsOn` maps a case to its prerequisites; prerequisites outside the run are ignored. Uses Kahn's
 * algorithm, always releasing the earliest remaining case, so the result is deterministic.
 */
export function orderByPrerequisites(
  caseIds: readonly string[],
  dependsOn: ReadonlyMap<string, readonly string[]>,
): string[] {
  const inRun = new Set(caseIds);
  const position = new Map(caseIds.map((id, i) => [id, i]));
  const waitingOn = new Map<string, number>();
  const unlocks = new Map<string, string[]>();
  for (const id of caseIds) {
    const prereqs = [...new Set(dependsOn.get(id) ?? [])].filter((p) => inRun.has(p) && p !== id);
    waitingOn.set(id, prereqs.length);
    for (const p of prereqs) unlocks.set(p, [...(unlocks.get(p) ?? []), id]);
  }

  // ponytail: sorted-array "priority queue" is O(n²) in the worst case; fine for the 5,000-case run cap.
  const ready = caseIds.filter((id) => waitingOn.get(id) === 0);
  const ordered: string[] = [];
  while (ready.length) {
    const next = ready.shift()!;
    ordered.push(next);
    for (const dependent of unlocks.get(next) ?? []) {
      const left = waitingOn.get(dependent)! - 1;
      waitingOn.set(dependent, left);
      if (left === 0) {
        const at = ready.findIndex((r) => position.get(r)! > position.get(dependent)!);
        ready.splice(at === -1 ? ready.length : at, 0, dependent);
      }
    }
  }
  // A cycle (which the repository refuses to store) would leave cases behind; keep them rather than drop them.
  if (ordered.length < caseIds.length) ordered.push(...caseIds.filter((id) => !ordered.includes(id)));
  return ordered;
}
