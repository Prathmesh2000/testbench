// Pure helpers for the board editors, kept apart from React and Yjs so they can be unit tested.

/** Spreadsheet column name for a zero-based index: 0 → A, 25 → Z, 26 → AA. */
export function colName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Key of a cell in the shared `cells` map. */
export const cellKey = (row: number, col: number) => `${row}:${col}`;

/** "B7" style reference for the formula bar. */
export const cellRef = (row: number, col: number) => `${colName(col)}${row + 1}`;

/** The fields of an Excalidraw element the sync logic relies on. */
export interface Versioned {
  id: string;
  version: number;
  index?: string | null;
}

/** Local elements that are new or newer than what the shared map holds, i.e. what this client must publish. */
export function localChanges<T extends Versioned>(local: readonly T[], stored: (id: string) => T | undefined): T[] {
  return local.filter((el) => {
    const prev = stored(el.id);
    return !prev || el.version > prev.version;
  });
}

/**
 * The scene after a remote change. The shared map is the converged state, so it wins unless this
 * client holds a strictly newer version it has not published yet. Deleted elements travel as
 * `isDeleted` tombstones and are merged like any other.
 */
export function mergeElements<T extends Versioned>(local: readonly T[], remote: Iterable<T>): T[] {
  const byId = new Map(local.map((el) => [el.id, el]));
  for (const el of remote) {
    const mine = byId.get(el.id);
    if (!mine || el.version >= mine.version) byId.set(el.id, el);
  }
  // Excalidraw orders the scene by fractional index strings, which compare as plain strings.
  return [...byId.values()].sort((a, b) => {
    if (a.index == null || b.index == null || a.index === b.index) return 0;
    return a.index < b.index ? -1 : 1;
  });
}
