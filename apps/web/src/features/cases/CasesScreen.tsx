'use client';

import { CASE_STATUSES, PRIORITIES, RESULTS, type CaseCount, type CaseGroup, type CaseRow, type CaseSort, type Page } from '@tb/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { usePrefs, useSession } from '@/components/providers';
import { caseStatusLabel, resultLabel } from '@/components/status';
import { api, get, qs } from '@/lib/api';
import { fmt } from '@/lib/format';
import { isTypingTarget, moveFocus } from '@/lib/keys';
import { BulkBar } from './BulkBar';
import { CaseDrawer } from './CaseDrawer';
import { CaseGrid, COLUMNS, type GridEntry } from './CaseGrid';
import { emptyView, filterOf, sortFor, useModules, type CaseView } from './data';
import { FilterMenu } from './FilterMenu';
import { ModuleTree } from './ModuleTree';
import { NewCaseDialog } from './NewCaseDialog';
import s from './cases.module.css';

const PAGE = 200;
const DEFAULT_HIDDEN = ['type', 'estimate'];

const readHidden = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem('tb.cases.hidden') ?? 'null') ?? DEFAULT_HIDDEN;
  } catch {
    return DEFAULT_HIDDEN;
  }
};

const groupValueOf = (row: CaseRow, by: CaseView['groupBy']): string =>
  by === 'module' ? row.moduleId : by === 'priority' ? row.priority : by === 'status' ? row.status : by === 'lastResult' ? row.lastResult : '';

/** Test cases: module tree, filterable virtualised grid, quick-look drawer and bulk actions. */
export function CasesScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const { project, can } = useSession();
  const { density } = usePrefs();
  const [view, setView] = useState<CaseView>(emptyView);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [focus, setFocus] = useState(-1);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<string[]>(DEFAULT_HIDDEN);
  const [columnsMenu, setColumnsMenu] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => setHidden(readHidden()), []);
  useEffect(() => { if (params.get('new') === '1') setCreating(true); }, [params]);
  useEffect(() => {
    const t = setTimeout(() => setView((v) => ({ ...v, q: search.trim() })), 250);
    return () => clearTimeout(t);
  }, [search]);
  // Any change to what is shown invalidates the selection; keeping it would let a bulk action hit rows the user can no longer see.
  useEffect(() => { setSelected(new Set()); setAllMatching(false); setFocus(-1); setCollapsed(new Set()); }, [view]);

  const modules = useModules(project.id);
  const filter = filterOf(view);
  const sort = sortFor(view);
  const listParams = { moduleId: view.moduleId, q: view.q, priority: view.priority, status: view.status, lastResult: view.lastResult, labels: view.labels };

  const cases = useInfiniteQuery({
    queryKey: ['cases', project.id, 'list', view],
    queryFn: ({ pageParam }) => get<Page<CaseRow>>(`/projects/${project.id}/cases${qs({ ...listParams, sort, dir: view.dir, limit: PAGE, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const count = useQuery({
    queryKey: ['cases', project.id, 'count', filter],
    queryFn: () => api<CaseCount>('POST', `/projects/${project.id}/cases/count`, filter),
  });
  const groups = useQuery({
    queryKey: ['cases', project.id, 'groups', view],
    queryFn: () => get<CaseGroup[]>(`/projects/${project.id}/cases/groups${qs({ ...listParams, by: view.groupBy })}`),
    enabled: !!view.groupBy,
  });

  const rows = useMemo(() => cases.data?.pages.flatMap((p) => p.items) ?? [], [cases.data]);
  const entries = useMemo<GridEntry[]>(() => {
    if (!view.groupBy) return rows.map((row) => ({ kind: 'case', row }));
    const counts = new Map(groups.data?.map((g) => [g.value, g]) ?? []);
    const out: GridEntry[] = [];
    let current: string | null = null;
    for (const row of rows) {
      const value = groupValueOf(row, view.groupBy);
      if (value !== current) {
        current = value;
        const g = counts.get(value);
        const label = view.groupBy === 'module' ? row.modulePath : view.groupBy === 'status' ? caseStatusLabel(row.status) : view.groupBy === 'lastResult' ? resultLabel(row.lastResult) : value;
        out.push({ kind: 'group', value, label: g?.label && view.groupBy === 'module' ? g.label : label, count: g?.count ?? null });
      }
      if (!collapsed.has(value)) out.push({ kind: 'case', row });
    }
    return out;
  }, [rows, view.groupBy, groups.data, collapsed]);

  const columns = COLUMNS.filter((c) => !hidden.includes(c.id));
  const focusedRow = entries[focus]?.kind === 'case' ? (entries[focus] as { row: CaseRow }).row : null;

  // Grid keyboard: J/K or arrows move, Enter opens the drawer, O opens the full page, X selects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey || creating) return;
      const selectable = (i: number) => entries[i]?.kind === 'case';
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setFocus((f) => moveFocus(f, 1, selectable, entries.length)); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setFocus((f) => moveFocus(f, -1, selectable, entries.length)); }
      else if (e.key === 'Enter' && focusedRow) setOpenKey(focusedRow.key);
      else if (e.key === 'o' && (focusedRow || openKey)) router.push(`/cases/${focusedRow?.key ?? openKey}`);
      else if (e.key === 'x' && focusedRow) toggle(focusedRow);
      else if (e.key === 'Escape') setOpenKey(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggle = (row: CaseRow) => {
    setAllMatching(false);
    setSelected((sel) => {
      const next = new Set(sel);
      if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
      return next;
    });
  };
  const toggleAll = () => {
    if (allMatching || (rows.length > 0 && selected.size === rows.length)) { setSelected(new Set()); setAllMatching(false); }
    else setSelected(new Set(rows.map((r) => r.key)));
  };
  const onSort = (next: CaseSort) => setView((v) => ({ ...v, groupBy: '', sort: next, dir: v.sort === next && v.dir === 'asc' ? 'desc' : 'asc' }));
  const setHiddenColumns = (next: string[]) => {
    setHidden(next);
    try { localStorage.setItem('tb.cases.hidden', JSON.stringify(next)); } catch { /* preference only */ }
  };

  const hasFilters = !!(view.q || view.priority.length || view.status.length || view.lastResult.length || view.labels.length);
  // Unfiltered, the tree's rolled-up count is exact at any size; filtered counts are capped (see countCases).
  const exactTotal = !hasFilters ? (view.moduleId ? modules.data?.byId.get(view.moduleId)?.total : modules.data?.total) : undefined;
  const totalLabel = exactTotal !== undefined
    ? `${fmt(exactTotal)} cases`
    : count.data ? `${count.data.capped ? `${fmt(count.data.count)}+` : fmt(count.data.count)} cases` : '';
  const moduleName = view.moduleId ? modules.data?.byId.get(view.moduleId)?.path : 'All cases';
  const everyLoadedSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <div className={s.layout}>
      <ModuleTree tree={modules.data} selected={view.moduleId} onSelect={(moduleId) => setView((v) => ({ ...v, moduleId }))} />

      <section className={s.center} aria-label="Cases">
        <div className={s.toolbar}>
          <h1 className="h1" style={{ fontSize: 16 }}>{moduleName}</h1>
          <span className="mono t3">{totalLabel}</span>
          <div className="f1" />
          {can('case.write') && <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} />New case</button>}
        </div>
        <div className={s.toolbar} style={{ gap: 6, paddingTop: 0 }}>
          <div className="row" style={{ position: 'relative', flex: '0 1 280px' }}>
            <span className="t3" style={{ position: 'absolute', left: 8, display: 'flex' }}><Icon name="search" size={14} /></span>
            <input className="inp f1" style={{ paddingLeft: 28 }} placeholder="Search titles or type TC-10231" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search cases" />
          </div>
          <FilterMenu label="Priority" value={view.priority} onChange={(priority) => setView((v) => ({ ...v, priority }))} options={PRIORITIES.map((p) => ({ value: p, label: p }))} />
          <FilterMenu label="Status" value={view.status} onChange={(status) => setView((v) => ({ ...v, status }))} options={CASE_STATUSES.map((st) => ({ value: st, label: caseStatusLabel(st) }))} />
          <FilterMenu label="Last result" value={view.lastResult} onChange={(lastResult) => setView((v) => ({ ...v, lastResult }))} options={RESULTS.map((r) => ({ value: r, label: resultLabel(r) }))} />
          <input
            className="inp" style={{ width: 150 }} placeholder="Label, e.g. smoke" aria-label="Filter by label"
            onKeyDown={(e) => {
              const value = e.currentTarget.value.trim().toLowerCase();
              if (e.key === 'Enter' && value) { setView((v) => ({ ...v, labels: [...new Set([...v.labels, value])] })); e.currentTarget.value = ''; }
            }}
          />
          {view.labels.map((l) => <button key={l} className="chip on" onClick={() => setView((v) => ({ ...v, labels: v.labels.filter((x) => x !== l) }))}>{l}<Icon name="x" size={10} /></button>)}
          {hasFilters && <button className="btn ghost sm" onClick={() => { setSearch(''); setView((v) => ({ ...emptyView, moduleId: v.moduleId })); }}>Clear</button>}
          <div className="f1" />
          <label className="row t3" style={{ gap: 6, fontSize: 12 }}>
            <Icon name="group" size={14} />
            <select className="inp" value={view.groupBy} onChange={(e) => setView((v) => ({ ...v, groupBy: e.target.value as CaseView['groupBy'] }))} aria-label="Group by">
              <option value="">No grouping</option>
              <option value="module">Group by module</option>
              <option value="priority">Group by priority</option>
              <option value="status">Group by status</option>
              <option value="lastResult">Group by last result</option>
            </select>
          </label>
          <span style={{ position: 'relative' }}>
            <button className="ib" aria-label="Choose columns" title="Columns" onClick={() => setColumnsMenu((o) => !o)}><Icon name="columns" /></button>
            {columnsMenu && (
              <>
                <div className="scrim" style={{ background: 'transparent' }} onClick={() => setColumnsMenu(false)} />
                <div className="menu" style={{ right: 0, top: 32, zIndex: 52 }} role="menu">
                  {COLUMNS.map((c) => (
                    <label key={c.id} className="mi">
                      <input type="checkbox" className="cb" checked={!hidden.includes(c.id)} onChange={() => setHiddenColumns(hidden.includes(c.id) ? hidden.filter((h) => h !== c.id) : [...hidden, c.id])} />
                      {c.label}
                    </label>
                  ))}
                </div>
              </>
            )}
          </span>
        </div>

        <div className={s.gridWrap}>
          {cases.isError ? (
            <div className="empty" style={{ flex: 1 }}><Icon name="alert" size={20} /><div>Could not load cases.</div><button className="btn" onClick={() => cases.refetch()}>Try again</button></div>
          ) : !cases.isLoading && rows.length === 0 ? (
            <div className="empty" style={{ flex: 1 }}>
              <Icon name="search" size={22} />
              <div>No cases match {hasFilters ? 'these filters' : 'this module yet'}.</div>
              {hasFilters
                ? <button className="btn" onClick={() => { setSearch(''); setView((v) => ({ ...emptyView, moduleId: v.moduleId })); }}>Clear filters</button>
                : can('case.write') && <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} />New case</button>}
            </div>
          ) : (
            <CaseGrid
              entries={entries} columns={columns} focus={focus} openKey={openKey} selected={selected} allSelected={allMatching || everyLoadedSelected}
              sort={sort} dir={view.dir} collapsed={collapsed} hasMore={!!cases.hasNextPage} loadingMore={cases.isFetchingNextPage}
              rowHeight={density === 'comfy' ? 36 : 30}
              onFocus={setFocus} onOpen={(r) => setOpenKey(r.key)} onToggle={toggle} onToggleAll={toggleAll} onSort={onSort}
              onToggleGroup={(value) => setCollapsed((c) => { const next = new Set(c); if (next.has(value)) next.delete(value); else next.add(value); return next; })}
              onNearEnd={() => cases.fetchNextPage()}
            />
          )}
          {(selected.size > 0 || allMatching) && (
            <BulkBar
              target={allMatching && count.data ? { kind: 'all', filter, count: count.data.count, capped: count.data.capped } : { kind: 'keys', keys: [...selected] }}
              canSelectAll={everyLoadedSelected && count.data && count.data.count > rows.length ? count.data : null}
              onSelectAll={() => setAllMatching(true)}
              onClear={() => { setSelected(new Set()); setAllMatching(false); }}
            />
          )}
        </div>
        <div className={s.foot}>
          <span className="num">{fmt(rows.length)} loaded{totalLabel && ` of ${totalLabel}`}</span>
          <span className="dotsep">·</span>
          <span><span className="kbd">J</span> <span className="kbd">K</span> move · <span className="kbd">Enter</span> open · <span className="kbd">X</span> select</span>
        </div>
      </section>

      {openKey && <CaseDrawer projectId={project.id} caseKey={openKey} onClose={() => setOpenKey(null)} />}
      {creating && modules.data && (
        <NewCaseDialog
          modules={modules.data.byId} defaultModuleId={view.moduleId}
          onClose={() => { setCreating(false); if (params.get('new')) router.replace('/cases'); }}
          onCreated={(c) => { setCreating(false); setOpenKey(c.key); }}
        />
      )}
    </div>
  );
}
