'use client';

import type { CaseFilter, CaseSort, Member, ModuleNode } from '@tb/contracts';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';

// Queries shared by the case screens.

export interface ModuleInfo extends ModuleNode {
  path: string;
  depth: number;
  children: string[];
}

/** The module tree plus a lookup with display paths ("UPI / Collect") and child lists. */
export function useModules(projectId: string) {
  return useQuery({
    queryKey: ['modules', projectId],
    queryFn: () => get<ModuleNode[]>(`/projects/${projectId}/modules`),
    staleTime: 60_000,
    select: (nodes) => {
      const byId = new Map<string, ModuleInfo>();
      for (const n of nodes) byId.set(n.id, { ...n, path: n.name, depth: 0, children: [] });
      // Nodes arrive parents-first, so each parent's path is known when its children are reached.
      for (const n of byId.values()) {
        const parent = n.parentId ? byId.get(n.parentId) : undefined;
        if (parent) {
          parent.children.push(n.id);
          n.path = `${parent.path} / ${n.name}`;
          n.depth = parent.depth + 1;
        }
      }
      const bySiblingOrder = (a: string, b: string) => {
        const x = byId.get(a)!;
        const y = byId.get(b)!;
        return x.position - y.position || x.name.localeCompare(y.name);
      };
      for (const n of byId.values()) n.children.sort(bySiblingOrder);
      const roots = [...byId.values()].filter((n) => !n.parentId || !byId.has(n.parentId)).map((n) => n.id).sort(bySiblingOrder);
      return { byId, roots, total: roots.reduce((sum, id) => sum + byId.get(id)!.total, 0) };
    },
  });
}

export function useMembers(projectId: string) {
  return useQuery({ queryKey: ['members', projectId], queryFn: () => get<Member[]>(`/projects/${projectId}/members`), staleTime: 5 * 60_000 });
}

export interface CaseView {
  moduleId?: string;
  q: string;
  priority: string[];
  status: string[];
  lastResult: string[];
  labels: string[];
  sort: CaseSort;
  dir: 'asc' | 'desc';
  groupBy: '' | 'module' | 'priority' | 'status' | 'lastResult';
}

export const emptyView: CaseView = { q: '', priority: [], status: [], lastResult: [], labels: [], sort: 'key', dir: 'asc', groupBy: '' };

/** The filter part of a view, in the shape the bulk, count and run endpoints take. */
export function filterOf(view: CaseView): CaseFilter {
  return {
    moduleId: view.moduleId,
    q: view.q || undefined,
    priority: view.priority.length ? (view.priority as CaseFilter['priority']) : undefined,
    status: view.status.length ? (view.status as CaseFilter['status']) : undefined,
    lastResult: view.lastResult.length ? (view.lastResult as CaseFilter['lastResult']) : undefined,
    labels: view.labels.length ? view.labels : undefined,
  };
}

/** Grouping needs rows sorted by the group field first, so groups arrive contiguous across pages. */
export const sortFor = (view: CaseView): CaseSort => (view.groupBy || view.sort) as CaseSort;
