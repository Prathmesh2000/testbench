'use client';

import type { CaseRow, CaseSort } from '@tb/contracts';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { Avatar, CaseStatusPill, PriorityTag, ResultStatus } from '@/components/status';
import { ago, fmt } from '@/lib/format';
import s from './cases.module.css';

export type GridEntry = { kind: 'group'; value: string; label: string; count: number | null } | { kind: 'case'; row: CaseRow };

export interface Column {
  id: string;
  label: string;
  width: number;
  sort?: CaseSort;
  render(row: CaseRow): ReactNode;
}

export const COLUMNS: Column[] = [
  { id: 'module', label: 'Module', width: 190, sort: 'module', render: (r) => <span className="trunc t2">{r.modulePath}</span> },
  { id: 'priority', label: 'Pri', width: 48, sort: 'priority', render: (r) => <PriorityTag priority={r.priority} /> },
  { id: 'type', label: 'Type', width: 104, render: (r) => <span className="trunc t2">{r.type}</span> },
  { id: 'status', label: 'Status', width: 116, sort: 'status', render: (r) => <CaseStatusPill status={r.status} /> },
  { id: 'lastResult', label: 'Last result', width: 106, sort: 'lastResult', render: (r) => <ResultStatus result={r.lastResult} /> },
  { id: 'labels', label: 'Labels', width: 190, render: (r) => <span className="row" style={{ gap: 4, overflow: 'hidden' }}>{r.labels.map((l) => <span key={l} className="lbl">{l}</span>)}</span> },
  { id: 'owner', label: 'Owner', width: 150, render: (r) => r.owner && <span className="row" style={{ gap: 6, minWidth: 0 }}><Avatar user={r.owner} /><span className="trunc">{r.owner.name}</span></span> },
  { id: 'updated', label: 'Updated', width: 84, sort: 'updated', render: (r) => <span className="t3">{ago(r.updatedAt)}</span> },
  { id: 'estimate', label: 'Est.', width: 56, render: (r) => <span className="mono t3">{r.estimateMin ? `${r.estimateMin}m` : ''}</span> },
  { id: 'automation', label: 'Automation', width: 96, render: (r) => <span className={`aut-${r.automation}`} style={{ fontSize: 12, textTransform: 'capitalize' }}>{r.automation}</span> },
];
const TITLE_MIN = 360;
const FROZEN = 34 + 88;

interface Props {
  entries: GridEntry[];
  columns: Column[];
  focus: number;
  openKey: string | null;
  selected: ReadonlySet<string>;
  allSelected: boolean;
  sort: CaseSort;
  dir: 'asc' | 'desc';
  collapsed: ReadonlySet<string>;
  hasMore: boolean;
  loadingMore: boolean;
  rowHeight: number;
  onFocus(index: number): void;
  onOpen(row: CaseRow): void;
  onToggle(row: CaseRow): void;
  onToggleAll(): void;
  onToggleGroup(value: string): void;
  onSort(sort: CaseSort): void;
  onNearEnd(): void;
}

/**
 * The case grid. Only the rows on screen exist in the DOM (TanStack Virtual), so scrolling stays smooth
 * whether 200 or 1,00,000 rows have been loaded. One scroll container handles both axes; the header is
 * sticky and the checkbox and key columns are frozen on the left.
 */
export function CaseGrid(p: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = p.entries.length + (p.hasMore ? 1 : 0);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => p.rowHeight,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();

  // Density changes the row height; re-measure instead of leaving rows overlapping.
  useEffect(() => virtualizer.measure(), [p.rowHeight, virtualizer]);

  const lastIndex = items.at(-1)?.index ?? 0;
  useEffect(() => {
    if (p.hasMore && !p.loadingMore && lastIndex >= p.entries.length - 40) p.onNearEnd();
  }, [lastIndex, p]);

  useEffect(() => {
    if (p.focus >= 0) virtualizer.scrollToIndex(p.focus, { align: 'auto' });
  }, [p.focus, virtualizer]);

  const width = FROZEN + TITLE_MIN + p.columns.reduce((sum, c) => sum + c.width, 0);
  const sortMark = (sort?: CaseSort) => sort && p.sort === sort && <Icon name={p.dir === 'asc' ? 'chevDown' : 'chevRight'} size={10} />;

  return (
    <div ref={scrollRef} className={s.gscroll} role="grid" aria-rowcount={count} aria-label="Test cases">
      <div className={s.ghd} style={{ minWidth: width }} role="row">
        <div className={s.fz}>
          <div className={s.gc} style={{ width: 34 }}>
            <input type="checkbox" className="cb" aria-label="Select all loaded cases" checked={p.allSelected} onChange={p.onToggleAll} />
          </div>
          <button className={`${s.gc} ${s.hbtn}`} style={{ width: 88 }} onClick={() => p.onSort('key')}>Key {sortMark('key')}</button>
        </div>
        <button className={`${s.gc} ${s.hbtn}`} style={{ flex: 1, minWidth: TITLE_MIN }} onClick={() => p.onSort('title')}>Title {sortMark('title')}</button>
        {p.columns.map((c) => (
          <button key={c.id} className={`${s.gc} ${c.sort ? s.hbtn : ''}`} style={{ width: c.width }} onClick={() => c.sort && p.onSort(c.sort)} disabled={!c.sort}>
            {c.label} {sortMark(c.sort)}
          </button>
        ))}
      </div>

      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: width }}>
        {items.map((vi) => {
          const entry = p.entries[vi.index];
          const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: p.rowHeight, transform: `translateY(${vi.start}px)` };
          if (!entry) {
            return <div key="loader" className={`${s.gr} t3`} style={style}><div className={s.gc} style={{ paddingLeft: 16 }}><Icon name="refresh" size={12} className="spin" /> Loading more cases…</div></div>;
          }
          if (entry.kind === 'group') {
            const isCollapsed = p.collapsed.has(entry.value);
            return (
              <div key={`g-${entry.value}`} className={s.ggrp} style={style} onClick={() => p.onToggleGroup(entry.value)} role="row" aria-expanded={!isCollapsed}>
                <div className={s.gin}>
                  <span className={`${s.cv} ${isCollapsed ? '' : s.open}`}><Icon name="chevRight" size={12} /></span>
                  {entry.label}
                  {entry.count !== null && <span className="mono t3" style={{ fontWeight: 400 }}>{fmt(entry.count)}</span>}
                </div>
              </div>
            );
          }
          const r = entry.row;
          const isSelected = p.selected.has(r.key) || p.allSelected;
          return (
            <div
              key={r.id} role="row" aria-selected={isSelected} style={style}
              className={`${s.gr} ${isSelected ? s.sel : ''} ${p.openKey === r.key ? s.opened : ''} ${p.focus === vi.index ? s.foc : ''}`}
              onClick={() => { p.onFocus(vi.index); p.onOpen(r); }}
            >
              <div className={s.fz}>
                <div className={s.gc} style={{ width: 34 }} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" className="cb" aria-label={`Select ${r.key}`} checked={isSelected} onChange={() => p.onToggle(r)} />
                </div>
                <div className={`${s.gc} mono t2`} style={{ width: 88 }}>{r.key}</div>
              </div>
              <div className={s.gc} style={{ flex: 1, minWidth: TITLE_MIN }}><span className="trunc">{r.title}</span></div>
              {p.columns.map((c) => <div key={c.id} className={s.gc} style={{ width: c.width }}>{c.render(r)}</div>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
