import { PERMISSIONS, ROLE_PERMISSIONS, type Permission, type Role } from '@tb/contracts';

/**
 * One role held by a user in the current organisation; `projectId: null` means every project.
 * Custom roles ("custom:<id>") carry their permissions, resolved when the identity is loaded.
 */
export interface Grant {
  projectId: string | null;
  role: string;
  permissions?: readonly Permission[];
}

const grantPermissions = (g: Grant): readonly Permission[] =>
  g.permissions ?? ROLE_PERMISSIONS[g.role as Role] ?? [];

/**
 * What a user may do in one project: the union of their org-wide roles and their roles on that
 * project. Returned in the canonical PERMISSIONS order so responses and cache entries are stable.
 */
export function permissionsFor(grants: readonly Grant[], projectId: string): Permission[] {
  const granted = new Set<Permission>();
  for (const g of grants) {
    if (g.projectId === null || g.projectId === projectId) {
      for (const p of grantPermissions(g)) granted.add(p);
    }
  }
  return PERMISSIONS.filter((p) => granted.has(p));
}

/** Organisation-level permissions (admin console): only org-wide roles count, not project ones. */
export function orgPermissions(grants: readonly Grant[]): Permission[] {
  const granted = new Set(grants.filter((g) => g.projectId === null).flatMap(grantPermissions));
  return PERMISSIONS.filter((p) => granted.has(p));
}

/** Projects the user can see at all. `null` means every project in the organisation. */
export function visibleProjectIds(grants: readonly Grant[]): string[] | null {
  if (grants.some((g) => g.projectId === null)) return null;
  return [...new Set(grants.map((g) => g.projectId as string))];
}

/**
 * Guardrail for granting (HLD §5.11): nobody hands out a permission they don't hold themselves, so a
 * member manager can't mint someone more powerful than they are. Returns what is missing.
 */
export function ungrantable(callerHolds: readonly Permission[], wanted: readonly Permission[]): Permission[] {
  return wanted.filter((p) => !callerHolds.includes(p));
}

/** Permissions a role reference stands for, given the organisation's custom roles. */
export function roleRefPermissions(
  ref: string,
  custom: ReadonlyMap<string, readonly Permission[]>,
): readonly Permission[] | null {
  return ROLE_PERMISSIONS[ref as Role] ?? custom.get(ref) ?? null;
}
