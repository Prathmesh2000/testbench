import type { ModuleNode } from '@tb/contracts';
import type { Tx } from '@tb/platform';

export interface ModuleRow {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  total: number;
  failing: number;
}

/**
 * All modules of a project with their own case counts. Trees are small (hundreds of nodes even in
 * the largest projects), so loading the whole tree is cheaper than walking it query by query.
 */
export function loadModules(trx: Tx, projectId: string): Promise<ModuleRow[]> {
  return trx
    .selectFrom('repo.module as m')
    .leftJoin('repo.module_stats as s', 's.module_id', 'm.id')
    .select(['m.id', 'm.parent_id', 'm.name', 'm.position'])
    .select((eb) => [
      eb.fn.coalesce('s.total', eb.lit(0)).as('total'),
      eb.fn.coalesce('s.failing', eb.lit(0)).as('failing'),
    ])
    .where('m.project_id', '=', projectId)
    .orderBy('m.path')
    .execute();
}

/** "UPI / Collect" style labels for every module, as shown in grids and breadcrumbs. */
export function modulePaths(rows: readonly ModuleRow[]): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const paths = new Map<string, string>();
  const pathOf = (id: string): string => {
    const cached = paths.get(id);
    if (cached) return cached;
    const row = byId.get(id);
    if (!row) return '';
    const path = row.parent_id ? `${pathOf(row.parent_id)} / ${row.name}` : row.name;
    paths.set(id, path);
    return path;
  };
  for (const r of rows) pathOf(r.id);
  return paths;
}

/**
 * Tree nodes with counts rolled up to every ancestor, so "UPI (8,212)" includes its leaves.
 * module_stats counts only cases filed directly under a module.
 */
export function toTree(rows: readonly ModuleRow[]): ModuleNode[] {
  const nodes = new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, parentId: r.parent_id, name: r.name, position: r.position, total: r.total, failing: r.failing },
    ]),
  );
  // rows arrive in path order (parents first), so walking backwards adds each child before its parent passes it on.
  for (let i = rows.length - 1; i >= 0; i--) {
    const node = nodes.get(rows[i]!.id)!;
    if (node.parentId) {
      const parent = nodes.get(node.parentId);
      if (parent) {
        parent.total += node.total;
        parent.failing += node.failing;
      }
    }
  }
  return [...nodes.values()];
}
