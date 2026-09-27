import { PERMISSIONS, ROLE_PERMISSIONS, type Permission, type Role } from '@tb/contracts';

/** One role held by a user in the current organisation; `projectId: null` means every project. */
export interface Grant {
  projectId: string | null;
  role: Role;
}

/**
 * What a user may do in one project: the union of their org-wide roles and their roles on that
 * project. Returned in the canonical PERMISSIONS order so responses and cache entries are stable.
 */
export function permissionsFor(grants: readonly Grant[], projectId: string): Permission[] {
  const granted = new Set<Permission>();
  for (const g of grants) {
    if (g.projectId === null || g.projectId === projectId) {
      for (const p of ROLE_PERMISSIONS[g.role]) granted.add(p);
    }
  }
  return PERMISSIONS.filter((p) => granted.has(p));
}

/** Projects the user can see at all. `null` means every project in the organisation. */
export function visibleProjectIds(grants: readonly Grant[]): string[] | null {
  if (grants.some((g) => g.projectId === null)) return null;
  return [...new Set(grants.map((g) => g.projectId as string))];
}
