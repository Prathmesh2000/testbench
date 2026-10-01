import type { ApiNode, ApiRequestDef, ApiVariationOverrides, HttpMethod } from '@tb/contracts';

// Pure helpers for API Studio screens: nesting the flat tree, working out a variation's overrides from
// what the tester edited, and small display rules.

export interface TreeItem extends ApiNode {
  children: TreeItem[];
}

/** The flat node list as a tree, siblings by position then name. Orphans (parent deleted) are dropped. */
export function nestTree(nodes: ApiNode[]): TreeItem[] {
  const byId = new Map(nodes.map((n) => [n.id, { ...n, children: [] as TreeItem[] }]));
  const roots: TreeItem[] = [];
  for (const item of byId.values()) {
    if (!item.parentId) roots.push(item);
    else byId.get(item.parentId)?.children.push(item);
  }
  const sort = (items: TreeItem[]) => {
    items.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const i of items) sort(i.children);
  };
  sort(roots);
  return roots;
}

/** Ids from the root down to this node, so the tree can open the folders around a selected request. */
export function pathTo(nodes: ApiNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (let at = byId.get(id); at; at = at.parentId ? byId.get(at.parentId) : undefined) out.unshift(at.id);
  return out;
}

const OVERRIDABLE = ['url', 'params', 'headers', 'body', 'auth', 'assertions'] as const;

/** A request with a variation applied: each field the variation sets replaces the request's own. */
export function withOverrides(base: ApiRequestDef, overrides: ApiVariationOverrides): ApiRequestDef {
  const out = { ...base };
  for (const k of OVERRIDABLE) if (overrides[k] !== undefined) (out as Record<string, unknown>)[k] = overrides[k];
  return out;
}

/** What a variation must store: the fields where the edited request differs from the base request. */
export function overridesFrom(base: ApiRequestDef, edited: ApiRequestDef): ApiVariationOverrides {
  const out: Record<string, unknown> = {};
  for (const k of OVERRIDABLE) if (JSON.stringify(base[k]) !== JSON.stringify(edited[k])) out[k] = edited[k];
  return out as ApiVariationOverrides;
}

/** Body text as shown: JSON indented, anything else as it came. */
export function prettyBody(body: string, contentType: string | null): string {
  if (!contentType?.includes('json') && !/^\s*[{[]/.test(body)) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export type Tone = 'ok' | 'redirect' | 'client' | 'server' | 'none';
export const statusTone = (status: number | null): Tone =>
  status === null ? 'none' : status < 300 ? 'ok' : status < 400 ? 'redirect' : status < 500 ? 'client' : 'server';

export const METHOD_SHORT: Record<HttpMethod, string> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DEL',
  HEAD: 'HEAD',
  OPTIONS: 'OPT',
};

/** Variables in a text, for highlighting the ones that are not defined anywhere. */
export const variablesIn = (text: string): string[] => [...text.matchAll(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g)].map((m) => m[1]!);

export const newId = () => Math.random().toString(36).slice(2, 10);
