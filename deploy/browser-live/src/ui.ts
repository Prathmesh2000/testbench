import { UiIssue, UiNode, UiPerf, UiScan } from '@tb/contracts';
import type { Page } from 'playwright';
import { UI_MAX_NODES, UI_SCAN_SOURCE } from './ui-scan';

// The UI review's reads of the active tab (see ui-scan.ts for what runs in the page).

// Evaluated in the page, so each call names the global itself: a helper here would not exist there.
type Ui = { __tbUi: { scan(max: number): unknown; at(x: number, y: number): unknown; highlight(id: number | null, scroll: boolean): void } };

/**
 * A scan as the page returned it, checked piece by piece: one element that does not fit the contract
 * costs only itself, not the tree. Its children then hang from the nearest element that was kept.
 */
export function parseScan(raw: unknown, maskUrl: (url: string) => string): UiScan | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const nodes = Array.isArray(r.nodes) ? r.nodes.slice(0, UI_MAX_NODES).flatMap((n) => { const p = UiNode.safeParse(n); return p.success ? [p.data] : []; }) : [];
  const kept = new Set(nodes.map((n) => n.id));
  const parentOf = new Map<number, number | null>();
  for (const n of Array.isArray(r.nodes) ? (r.nodes as Array<{ id?: unknown; parent?: unknown }>) : [])
    if (typeof n?.id === 'number') parentOf.set(n.id, typeof n.parent === 'number' ? n.parent : null);
  const nearest = (id: number | null): number | null => {
    for (let at = id, hops = 0; at !== null && hops < 500; at = parentOf.get(at) ?? null, hops++) if (kept.has(at)) return at;
    return null;
  };
  for (const n of nodes) n.parent = nearest(n.parent);
  const issues = Array.isArray(r.issues) ? r.issues.flatMap((i) => { const p = UiIssue.safeParse(i); return p.success && (p.data.node === null || kept.has(p.data.node)) ? [p.data] : []; }) : [];
  const perf = UiPerf.safeParse(r.perf);
  const scan = UiScan.safeParse({ ...r, nodes, issues, perf: perf.success ? perf.data : undefined });
  if (!scan.success) return null;
  const { perf: p } = scan.data;
  const mask = (list: typeof p.largest) => list.map((x) => ({ ...x, url: maskUrl(x.url) }));
  return { ...scan.data, url: maskUrl(scan.data.url), perf: { ...p, largest: mask(p.largest), slowest: mask(p.slowest) } };
}

/** Defines the page's __tbUi if this document does not have it yet. */
async function ready(page: Page) {
  await page.evaluate(UI_SCAN_SOURCE);
}

export async function scanPage(page: Page, maskUrl: (url: string) => string): Promise<UiScan | null> {
  await ready(page);
  return parseScan(await page.evaluate((max) => (globalThis as unknown as Ui).__tbUi.scan(max), UI_MAX_NODES), maskUrl);
}

export async function elementAt(page: Page, x: number, y: number): Promise<UiNode | null> {
  await ready(page);
  const node = UiNode.safeParse(await page.evaluate(([px, py]) => (globalThis as unknown as Ui).__tbUi.at(px!, py!), [x, y]));
  return node.success ? node.data : null;
}

export async function highlight(page: Page, node: number | null, scroll: boolean): Promise<void> {
  await ready(page);
  await page.evaluate(([id, s]) => (globalThis as unknown as Ui).__tbUi.highlight(id as number | null, s as boolean), [node, scroll]);
}
