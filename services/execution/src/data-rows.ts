import type { Tx } from '@tb/platform';

// Data-driven cases: a case linked to a data set becomes one run item per data row (per
// configuration). The row's values are copied into the item so a later edit of the data set never
// changes what a past run executed.

export interface CaseToRun {
  id: string;
  version: number;
  dataSetId: string | null;
}

export interface ExpandedItem {
  caseId: string;
  version: number;
  config: string;
  /** Index of the case in the input, so callers can keep their own ordering and positions. */
  caseIndex: number;
  configIndex: number;
  dataRow: number | null;
  data: Record<string, string> | null;
}

/** Items for the cases × configurations × data rows; cases without a data set (or an empty one) run once. */
export function expandItems(
  cases: readonly CaseToRun[],
  configs: readonly string[],
  rowsOf: ReadonlyMap<string, readonly Record<string, string>[]>,
): ExpandedItem[] {
  const out: ExpandedItem[] = [];
  cases.forEach((c, caseIndex) => {
    const rows = c.dataSetId ? rowsOf.get(c.dataSetId) : undefined;
    configs.forEach((config, configIndex) => {
      if (!rows?.length) {
        out.push({
          caseId: c.id,
          version: c.version,
          config,
          caseIndex,
          configIndex,
          dataRow: null,
          data: null,
        });
        return;
      }
      rows.forEach((data, dataRow) =>
        out.push({ caseId: c.id, version: c.version, config, caseIndex, configIndex, dataRow, data }),
      );
    });
  });
  return out;
}

/** The rows of every data set these cases use, in one query. */
export async function loadRows(
  trx: Tx,
  cases: readonly CaseToRun[],
): Promise<Map<string, Record<string, string>[]>> {
  const ids = [...new Set(cases.flatMap((c) => (c.dataSetId ? [c.dataSetId] : [])))];
  if (!ids.length) return new Map();
  const sets = await trx.selectFrom('repo.data_set').select(['id', 'rows']).where('id', 'in', ids).execute();
  return new Map(sets.map((s) => [s.id, s.rows]));
}

/** "{{amount}}" in a step becomes the row's value; unknown placeholders are left visible on purpose. */
export function fillPlaceholders(text: string, data: Record<string, string> | null): string {
  if (!data) return text;
  const lower = new Map(Object.entries(data).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(
    /\{\{\s*([^}]+?)\s*\}\}/g,
    (whole, name: string) => lower.get(name.toLowerCase()) ?? whole,
  );
}
