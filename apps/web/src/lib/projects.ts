// Helpers for working across many projects: grouping for the switcher and portfolio page, and where
// to land after switching.

export const UNGROUPED = 'Other projects';

/** Projects grouped by product line, groups A–Z with ungrouped ones last; order inside a group is kept. */
export function groupProjects<T extends { group: string | null }>(projects: readonly T[]): { group: string; projects: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const p of projects) {
    const key = p.group ?? UNGROUPED;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)))
    .map(([group, list]) => ({ group, projects: list }));
}

/**
 * The same area in the newly selected project: /cases/TC-10231 becomes /cases, because that case (and
 * any run, board or meeting id in the URL) belongs to the project being left.
 */
export function landingAfterSwitch(pathname: string): string {
  const first = pathname.split('/').filter(Boolean)[0];
  return first ? `/${first}` : '/';
}

/** Case-insensitive match on key, name or group, for the switcher's filter box. */
export function matchesProject(p: { key: string; name: string; group: string | null }, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return !needle || [p.key, p.name, p.group ?? ''].some((v) => v.toLowerCase().includes(needle));
}
