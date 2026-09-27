import { PERMISSIONS, ROLES, type AuditRow, type Permission, type Role, type RoleView } from '@tb/contracts';

// Pure helpers behind the admin console: audit CSV export, audit date filters and the roles matrix.

const CSV_HEADER = ['Time', 'Actor', 'Source', 'Action', 'Entity', 'Details', 'Project'];

/**
 * One CSV cell. Every cell is quoted so commas and newlines in details survive; a leading = + - @ is
 * prefixed with ' so spreadsheet apps don't run audit text (which users typed) as a formula.
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** The loaded audit rows as CSV, times left in ISO so the file sorts and parses cleanly. */
export function auditCsv(rows: AuditRow[]): string {
  const lines = rows.map((r) => [r.at, r.actor ?? 'System', r.source, r.action, r.entity, r.details, r.project ?? ''].map(cell).join(','));
  return [CSV_HEADER.map(cell).join(','), ...lines].join('\r\n');
}

/**
 * Two `<input type="date">` values as the API's from/to. Dates are read as IST days, and `to` covers
 * the whole of its day so a one-day range (from = to) is not empty.
 */
export function dateRangeIso(from: string, to: string): { from?: string; to?: string } {
  return {
    from: from ? `${from}T00:00:00+05:30` : undefined,
    to: to ? `${to}T23:59:59+05:30` : undefined,
  };
}

/** Adds or removes a permission, keeping the canonical order so drafts compare cleanly. */
export function togglePermission(list: readonly Permission[], p: Permission): Permission[] {
  const next = new Set(list);
  if (next.has(p)) next.delete(p);
  else next.add(p);
  return PERMISSIONS.filter((x) => next.has(x));
}

export function samePermissions(a: readonly Permission[], b: readonly Permission[]): boolean {
  const set = new Set(a);
  return a.length === b.length && b.every((p) => set.has(p));
}

/** Custom roles whose draft permissions differ from what the server has. */
export function changedRoles(roles: RoleView[], drafts: Record<string, Permission[]>): RoleView[] {
  return roles.filter((r) => !r.builtIn && drafts[r.ref] && !samePermissions(drafts[r.ref]!, r.permissions));
}

/**
 * The POST body for copying a role. The API records which built-in a custom role derives from, so a
 * copy of a custom role inherits that role's own base.
 */
export function copyRoleBody(source: RoleView, name: string): { name: string; basedOn: Role; permissions: Permission[] } {
  const base = source.builtIn ? source.ref : source.basedOn;
  const basedOn = (ROLES as readonly string[]).includes(base ?? '') ? (base as Role) : 'viewer';
  return { name: name.trim(), basedOn, permissions: [...source.permissions] };
}

/** "custom:<uuid>" → "<uuid>", for the /admin/roles/:id routes. */
export const customRoleId = (ref: string) => ref.replace(/^custom:/, '');
