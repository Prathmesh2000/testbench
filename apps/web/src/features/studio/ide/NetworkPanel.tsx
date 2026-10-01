'use client';

import type { NetworkEntry, RequestDetail } from '@tb/contracts';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { RequestDetailView } from './RequestDetailView';
import s from './ide.module.css';

export interface NetworkRow extends NetworkEntry {
  tab: string;
}

/** Newest calls the pane keeps; older ones are still in the session log saved as evidence. */
export const NETWORK_LIMIT = 1_000;

const TYPE_LABEL: Record<string, string> = {
  fetch: 'fetch', xhr: 'xhr', document: 'doc', eventsource: 'stream', script: 'js', stylesheet: 'css',
  image: 'img', media: 'media', font: 'font', websocket: 'ws',
};

/** The type filters, as in Chrome's Network panel; `other` is whatever none of the rest claim. */
const KINDS = [
  { key: 'all', label: 'All', types: [] },
  { key: 'api', label: 'Fetch/XHR', types: ['fetch', 'xhr'] },
  { key: 'doc', label: 'Doc', types: ['document'] },
  { key: 'js', label: 'JS', types: ['script'] },
  { key: 'css', label: 'CSS', types: ['stylesheet'] },
  { key: 'img', label: 'Img', types: ['image'] },
  { key: 'media', label: 'Media', types: ['media'] },
  { key: 'font', label: 'Font', types: ['font'] },
  { key: 'ws', label: 'WS', types: ['websocket'] },
  { key: 'other', label: 'Other', types: [] },
] as const;
type Kind = (typeof KINDS)[number]['key'];
const CLAIMED = new Set<string>(KINDS.flatMap((k) => [...k.types]));
const ofKind = (r: NetworkEntry, kind: Kind) =>
  kind === 'all' ? true : kind === 'other' ? !CLAIMED.has(r.resourceType) : (KINDS.find((k) => k.key === kind)!.types as readonly string[]).includes(r.resourceType);

type SortKey = 'start' | 'method' | 'status' | 'path' | 'type' | 'duration';
const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'start', label: 'Start' },
  { key: 'method', label: 'Method' },
  { key: 'status', label: 'Status' },
  { key: 'path', label: 'Path' },
  { key: 'type', label: 'Type' },
  { key: 'duration', label: 'Time' },
];

function pathOf(url: string): { path: string; host: string } {
  try {
    const u = new URL(url);
    return { path: `${u.pathname}${u.search}`, host: u.host };
  } catch {
    return { path: url, host: '' };
  }
}

/** When the page sent the request; older entries without a start time fall back to when it ended. */
const startOf = (r: NetworkRow) => Date.parse(r.startedAt ?? r.at);

function sortValue(r: NetworkRow, key: SortKey): number | string {
  switch (key) {
    case 'start':
      return startOf(r);
    case 'method':
      return r.method;
    case 'status':
      return r.status ?? -1; // failed requests have no status; they sort first
    case 'path':
      return pathOf(r.url).path;
    case 'type':
      return r.resourceType;
    case 'duration':
      return r.durationMs ?? -1;
  }
}

/**
 * The API calls and page loads of the Test Browser as the session saw them, in the order the page
 * made them by default, sortable by any column. URLs are masked on the server before they get here
 * (credentials in query strings), and bodies are never sent.
 */
export function NetworkPanel({
  rows,
  tabNames,
  onClear,
  selected,
  onSelect,
  detail,
  reveal,
  onReveal,
}: {
  rows: NetworkRow[];
  tabNames: Map<string, string>;
  onClear(): void;
  selected: string | null;
  onSelect(id: string | null): void;
  /** For the selected request: undefined while it loads, null when the browser no longer has it. */
  detail: RequestDetail | null | undefined;
  reveal: boolean;
  onReveal(on: boolean): void;
}) {
  const [filter, setFilter] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'start', dir: 1 });

  const first = useMemo(() => rows.reduce((min, r) => Math.min(min, startOf(r)), Infinity), [rows]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        ofKind(r, kind) &&
        (!failedOnly || r.failure || (r.status ?? 0) >= 400) &&
        (!f || r.url.toLowerCase().includes(f) || r.method.toLowerCase() === f),
    );
    return list.sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      const byKey = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      // Ties keep the order the page made them in.
      return (byKey || startOf(a) - startOf(b)) * sort.dir;
    });
  }, [rows, filter, failedOnly, kind, sort]);
  const counts = useMemo(() => new Map(KINDS.map((k) => [k.key, rows.filter((r) => ofKind(r, k.key)).length])), [rows]);

  const failed = rows.filter((r) => r.failure || (r.status ?? 0) >= 400).length;
  const sortBy = (key: SortKey) => setSort((cur) => ({ key, dir: cur.key === key ? (cur.dir === 1 ? -1 : 1) : 1 }));

  return (
    <div className={s.network}>
      <div className="row" style={{ gap: 6 }}>
        <input className="inp f1" style={{ height: 24, fontSize: 11.5 }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by URL or method" aria-label="Filter requests" />
        <label className="row t3" style={{ gap: 4, fontSize: 11 }}>
          <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failed ({failed})
        </label>
        <button className="ib sm" aria-label="Clear the list" title="Clear" onClick={onClear}><Icon name="x" size={11} /></button>
      </div>
      <div className={s.kinds} role="group" aria-label="Request type">
        {KINDS.map((k) => (
          <button key={k.key} aria-pressed={kind === k.key} onClick={() => setKind(k.key)} disabled={k.key !== 'all' && !counts.get(k.key)}>
            {k.label}
            {k.key !== 'all' && counts.get(k.key) ? <span className="t3"> {counts.get(k.key)}</span> : null}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="t3" style={{ padding: '10px 2px' }}>
          {rows.length ? 'Nothing matches the filter.' : 'API calls and page loads from the Test Browser appear here as the site makes them.'}
        </div>
      ) : (
        <div className={s.netList} role="table" aria-label="Requests">
          <div className={`${s.netRow} ${s.netHead}`} role="row">
            {COLUMNS.map((c) => (
              <button
                key={c.key}
                role="columnheader"
                aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                className={s.netSort}
                onClick={() => sortBy(c.key)}
                title={c.key === 'start' ? 'When the page sent it, from the first request in the list' : `Sort by ${c.label.toLowerCase()}`}
              >
                {c.label}
                {sort.key === c.key && <span aria-hidden>{sort.dir === 1 ? ' ▲' : ' ▼'}</span>}
              </button>
            ))}
          </div>
          {shown.map((r) => {
            const bad = !!r.failure || (r.status ?? 0) >= 400;
            const { path } = pathOf(r.url);
            return (
              <button
                key={r.id}
                className={`${s.netRow} ${bad ? s.netBad : ''} ${selected === r.id ? s.netOn : ''}`}
                role="row"
                aria-selected={selected === r.id}
                onClick={() => onSelect(selected === r.id ? null : r.id)}
                title={`${r.url}\n${tabNames.get(r.tab) ?? ''}${r.failure ? `\n${r.failure}` : ''}`}
              >
                <span role="cell" className="t3">+{((startOf(r) - first) / 1000).toFixed(2)}s</span>
                <span role="cell">{r.method}</span>
                <span role="cell">{r.status ?? 'failed'}</span>
                <span role="cell" className="trunc">{path}</span>
                <span role="cell" className="t3">{TYPE_LABEL[r.resourceType] ?? r.resourceType}</span>
                <span role="cell" className="t3">{r.durationMs === null ? '–' : `${r.durationMs} ms`}</span>
              </button>
            );
          })}
        </div>
      )}
      {selected && (
        <RequestDetailView
          key={selected}
          detail={detail}
          reveal={reveal}
          onReveal={onReveal}
          onClose={() => onSelect(null)}
        />
      )}
    </div>
  );
}
