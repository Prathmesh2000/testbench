import { parseCaseKey, type CaseFilter, type CaseSort } from '@tb/contracts';
import {
  decodeCursor,
  encodeCursor,
  type CursorValue,
  type Database,
  type ModuleTable,
  type TestCaseTable,
} from '@tb/platform';
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';

// Filtering and keyset pagination over repo.test_case, aliased `c` (joined to repo.module as `m`).
// Used by the case list, bulk edits and run creation, so "select all matching" means the same rows everywhere.

export type CaseScope = Database & { c: TestCaseTable; m: ModuleTable };
type Eb = ExpressionBuilder<CaseScope, 'c' | 'm'>;

/** Escapes LIKE wildcards so a search for "100%" matches the text "100%", not everything after "100". */
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** Builds the WHERE clause for a case filter. Every filter is scoped to one project first. */
export function caseFilter(projectId: string, filter: CaseFilter): (eb: Eb) => Expression<SqlBool> {
  return (eb) => {
    const where: Expression<SqlBool>[] = [eb('c.project_id', '=', projectId)];

    if (filter.moduleId) {
      // Subtree match through the ltree GiST index: the module itself and everything below it.
      where.push(
        eb(
          'c.module_id',
          'in',
          eb
            .selectFrom('repo.module as sub')
            .select('sub.id')
            .where('sub.project_id', '=', projectId)
            .where(sql<boolean>`sub.path <@ (SELECT path FROM repo.module WHERE id = ${filter.moduleId})`),
        ),
      );
    }
    if (filter.priority?.length) where.push(eb('c.priority', 'in', filter.priority));
    if (filter.status?.length) where.push(eb('c.status', 'in', filter.status));
    if (filter.lastResult?.length) where.push(eb('c.last_result', 'in', filter.lastResult));
    if (filter.ownerId) where.push(eb('c.owner_id', '=', filter.ownerId));
    // `@>` means "has all of these labels" and is served by the GIN index on labels.
    if (filter.labels?.length) where.push(sql<boolean>`c.labels @> ${sql.val(filter.labels)}::text[]`);
    if (filter.keys?.length) {
      const numbers = filter.keys.map(parseCaseKey).filter((n): n is number => n !== null);
      where.push(eb('c.key_no', 'in', numbers.length ? numbers : [-1]));
    }
    if (filter.q) {
      const keyNo = parseCaseKey(filter.q);
      // Typing a key jumps straight to that case; anything else is a title search (trigram index).
      where.push(
        keyNo !== null ? eb('c.key_no', '=', keyNo) : eb('c.title', 'ilike', `%${escapeLike(filter.q)}%`),
      );
    }
    return eb.and(where);
  };
}

/** Sort column for each sort option. Every one is NOT NULL, which keeps the keyset comparison simple. */
const SORT_COLUMNS: Record<CaseSort, { column: string; cast: string }> = {
  key: { column: 'c.key_no', cast: 'integer' },
  title: { column: 'c.title', cast: 'text' },
  priority: { column: 'c.priority', cast: 'text' },
  status: { column: 'c.status', cast: 'text' },
  updated: { column: 'c.updated_at', cast: 'timestamptz' },
  // Tree order: children follow their parent, so grouping by module yields contiguous groups.
  module: { column: 'm.path', cast: 'ltree' },
};

export interface SortSpec {
  sort: CaseSort;
  dir: 'asc' | 'desc';
}

/**
 * Keyset condition for "rows after the cursor": (sort value, id) compared as a row, so ties on the
 * sort column are broken by id and no row is skipped or repeated between pages.
 */
export function afterCursor({ sort, dir }: SortSpec, cursor: string): Expression<SqlBool> {
  const [value, id] = decodeCursor(cursor, 2);
  const { column, cast } = SORT_COLUMNS[sort];
  const op = dir === 'asc' ? '>' : '<';
  return sql<boolean>`(${sql.ref(column)}, c.id) ${sql.raw(op)} (CAST(${value} AS ${sql.raw(cast)}), CAST(${id} AS uuid))`;
}

export function sortColumn(sort: CaseSort): string {
  return SORT_COLUMNS[sort].column;
}

export function cursorAfter(
  sort: CaseSort,
  row: {
    id: string;
    key_no: number;
    title: string;
    priority: string;
    status: string;
    updated_at: Date;
    module_path: string;
  },
): string {
  const value: CursorValue = {
    key: row.key_no,
    title: row.title,
    priority: row.priority,
    status: row.status,
    updated: row.updated_at.toISOString(),
    module: row.module_path,
  }[sort];
  return encodeCursor([value, row.id]);
}
