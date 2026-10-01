/**
 * Left-to-right layers for the site map: each node goes one layer after the nearest node that leads
 * to it, starting from nodes nothing leads to (the pages a user lands on). Cycles are fine: a node
 * keeps the first layer it is reached at. Rows within a layer keep their input order.
 */
export function layers(ids: string[], edges: Array<{ from: string; to: string }>): Map<string, { layer: number; row: number }> {
  const into = new Map(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!into.has(e.from) || !into.has(e.to) || e.from === e.to) continue;
    into.set(e.to, (into.get(e.to) ?? 0) + 1);
    out.get(e.from)!.push(e.to);
  }
  const layer = new Map<string, number>();
  const queue = ids.filter((id) => into.get(id) === 0);
  // Everything in a cycle with no way in starts at the first of its nodes.
  for (const id of queue) layer.set(id, 0);
  const visit = (start: string[]) => {
    const q = [...start];
    while (q.length) {
      const id = q.shift()!;
      for (const next of out.get(id) ?? [])
        if (!layer.has(next)) {
          layer.set(next, layer.get(id)! + 1);
          q.push(next);
        }
    }
  };
  visit(queue);
  for (const id of ids)
    if (!layer.has(id)) {
      layer.set(id, 0);
      visit([id]);
    }
  const rows = new Map<number, number>();
  const placed = new Map<string, { layer: number; row: number }>();
  for (const id of ids) {
    const l = layer.get(id)!;
    const row = rows.get(l) ?? 0;
    rows.set(l, row + 1);
    placed.set(id, { layer: l, row });
  }
  return placed;
}
