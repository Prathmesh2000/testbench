'use client';

import { AUDIT_SOURCES, type AuditPage } from '@tb/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, get, qs } from '@/lib/api';
import { dateTimeIST, fmt } from '@/lib/format';
import { auditCsv, dateRangeIso } from './admin-utils';
import s from './admin.module.css';

type Source = (typeof AUDIT_SOURCES)[number];
const SOURCE_LABELS: Record<Source, string> = { web: 'Web', api: 'API', mcp: 'MCP', slack: 'Slack' };

/** Who did what, filterable by text, source and date range, with a CSV export of what is loaded. */
export function AuditTab() {
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [source, setSource] = useState<Source | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const range = dateRangeIso(from, to);
  const audit = useInfiniteQuery({
    queryKey: ['admin-audit', q, source, range.from, range.to],
    queryFn: ({ pageParam }) => get<AuditPage>(`/admin/audit${qs({ q, source, ...range, cursor: pageParam, limit: 100 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const rows = audit.data?.pages.flatMap((p) => p.items) ?? [];

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([auditCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `testbench-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={s.stack}>
      <div className={s.bar}>
        <input className={`inp ${s.search}`} type="search" placeholder="Search actions, entities, details" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the audit log" />
        <div className="row" role="group" aria-label="Source" style={{ gap: 4 }}>
          <button type="button" className={`chip ${source === null ? 'on' : ''}`} aria-pressed={source === null} onClick={() => setSource(null)}>All</button>
          {AUDIT_SOURCES.map((src) => (
            <button key={src} type="button" className={`chip ${source === src ? 'on' : ''}`} aria-pressed={source === src} onClick={() => setSource(src)}>{SOURCE_LABELS[src]}</button>
          ))}
        </div>
        <div className="f1" />
        <input type="date" className="inp" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        <span className="t3">to</span>
        <input type="date" className="inp" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
      </div>

      <section className={`panel ${s.tableWrap}`}>
        <div className="hdr">
          <h3>Audit log</h3>
          <span className="cnt">{fmt(rows.length)}{audit.hasNextPage ? '+' : ''} · times in IST</span>
          <div className="f1" />
          <button type="button" className="btn ghost sm" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
        </div>
        {audit.error ? (
          <div className={`empty ${s.message}`}>{audit.error instanceof ApiError ? audit.error.message : 'The audit log is not available.'}</div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th><th>Project</th><th>Source</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono t2">{dateTimeIST(r.at)}</td>
                  <td className={r.actor ? undefined : 't3'}>{r.actor ?? 'System'}</td>
                  <td>{r.action}</td>
                  <td className="mono acc">{r.entity}</td>
                  <td className={`t2 ${s.details}`} title={r.details}>{r.details}</td>
                  <td className="mono t2">{r.project ?? '—'}</td>
                  <td><span className={s.srcB}>{SOURCE_LABELS[r.source]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {audit.isLoading && <div className={`empty t3 ${s.message}`}>Loading the audit log…</div>}
        {audit.data && rows.length === 0 && <div className={`empty t3 ${s.message}`}>Nothing recorded for these filters.</div>}
        {audit.hasNextPage && (
          <div className={s.more}><button type="button" className="btn sm" onClick={() => audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>{audit.isFetchingNextPage ? 'Loading…' : 'Load more'}</button></div>
        )}
      </section>
    </div>
  );
}
