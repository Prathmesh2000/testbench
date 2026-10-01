import type { SpecChange, SpecDiff } from '@tb/contracts';

// Spec-change impact (plan §8): which changes since a request's spec version touch its operation.
// Pure; the database side loads the version diffs and the requests.

/** Changes to `operation` in the versions after `since`, oldest first. Null `since` means "from v1". */
export function changesSince(diffs: { version: number; diff: SpecDiff | null }[], operation: string, since: number | null): SpecChange[] {
  return diffs
    .filter((d) => d.diff && d.version > (since ?? 1))
    .sort((a, b) => a.version - b.version)
    .flatMap((d) => d.diff!.changes.filter((c) => `${c.method} ${c.path}` === operation));
}

/** One sentence for the tree: the breaking change if there is one, otherwise the first change. */
export function reviewNote(changes: SpecChange[]): string | null {
  if (!changes.length) return null;
  const first = changes.find((c) => c.breaking) ?? changes[0]!;
  const more = changes.length > 1 ? ` (+${changes.length - 1} more)` : '';
  return `${first.breaking ? 'Breaking: ' : ''}${first.detail}${more}`;
}
