'use client';

import type { StorageSnapshot } from '@tb/contracts';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { dateTimeIST } from '@/lib/format';
import { Pretty } from './RequestDetailView';
import s from './ide.module.css';

type Store = 'cookies' | 'local' | 'session';

/**
 * The active tab's storage, as DevTools' Application panel shows it: every cookie in the Test Browser
 * session, and the page's own local and session storage. A snapshot, read when asked (Refresh, a new
 * page, switching tabs), not a live feed.
 */
export function ApplicationPanel({
  snapshot,
  loading,
  onRefresh,
  reveal,
  onReveal,
}: {
  snapshot: StorageSnapshot | null;
  loading: boolean;
  onRefresh(): void;
  reveal: boolean;
  onReveal(on: boolean): void;
}) {
  const [store, setStore] = useState<Store>('cookies');
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!snapshot) return [];
    const f = filter.trim().toLowerCase();
    const list =
      store === 'cookies'
        ? snapshot.cookies.map((c) => ({ key: `${c.domain}|${c.path}|${c.name}`, name: c.name, value: c.value, cookie: c }))
        : snapshot[store].map(([k, v]) => ({ key: k, name: k, value: v, cookie: null }));
    return list.filter((r) => !f || r.name.toLowerCase().includes(f) || r.value.toLowerCase().includes(f) || r.cookie?.domain.includes(f));
  }, [snapshot, store, filter]);

  const counts = snapshot ? { cookies: snapshot.cookies.length, local: snapshot.local.length, session: snapshot.session.length } : null;
  const selected = rows.find((r) => r.key === open);

  return (
    <div className={s.network}>
      <div className="row" style={{ gap: 6 }}>
        <div className={s.kinds} role="tablist" aria-label="Storage">
          {(
            [
              ['cookies', 'Cookies'],
              ['local', 'Local storage'],
              ['session', 'Session storage'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={store === k} aria-pressed={store === k} onClick={() => { setStore(k); setOpen(null); }}>
              {label}
              {counts ? <span className="t3"> {counts[k]}</span> : null}
            </button>
          ))}
        </div>
        <div className="f1" />
        <label className="row t3" style={{ gap: 4, fontSize: 11 }} title="Show session cookies, tokens and personal data as they are. Only you see them; nothing is stored.">
          <input type="checkbox" checked={reveal} onChange={(e) => onReveal(e.target.checked)} /> Show sensitive values
        </label>
        <button className="ib sm" aria-label="Refresh" title="Read again" onClick={onRefresh} disabled={loading}><Icon name="refresh" size={11} /></button>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input className="inp f1" style={{ height: 24, fontSize: 11.5 }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, value or domain" aria-label="Filter storage" />
        <span className="t3 trunc" style={{ fontSize: 11 }} title={snapshot?.origin}>{snapshot?.origin || ''}</span>
      </div>
      {!snapshot ? (
        <div className="t3" style={{ padding: 10 }}>{loading ? 'Reading…' : 'Open a site in the Test Browser to see its storage.'}</div>
      ) : rows.length === 0 ? (
        <div className="t3" style={{ padding: 10 }}>
          {filter ? 'Nothing matches the filter.' : store === 'cookies' ? 'No cookies in this session yet.' : `This page has nothing in ${store === 'local' ? 'local' : 'session'} storage.`}
        </div>
      ) : (
        <div className={s.netList} role="table" aria-label={store}>
          <div className={`${s.storeRow} ${store === 'cookies' ? s.storeCookie : ''} ${s.netHead}`} role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader">Value</span>
            {store === 'cookies' && (
              <>
                <span role="columnheader">Domain</span>
                <span role="columnheader">Expires</span>
                <span role="columnheader">Flags</span>
              </>
            )}
          </div>
          {rows.map((r) => (
            <button key={r.key} role="row" aria-selected={open === r.key} className={`${s.storeRow} ${store === 'cookies' ? s.storeCookie : ''} ${open === r.key ? s.netOn : ''}`} onClick={() => setOpen(open === r.key ? null : r.key)}>
              <span role="cell" className="trunc">{r.name}</span>
              <span role="cell" className="trunc t3">{r.value}</span>
              {r.cookie && (
                <>
                  <span role="cell" className="trunc t3">{r.cookie.domain}{r.cookie.path !== '/' ? r.cookie.path : ''}</span>
                  <span role="cell" className="trunc t3">{r.cookie.expires < 0 ? 'Session' : dateTimeIST(new Date(r.cookie.expires * 1000).toISOString())}</span>
                  <span role="cell" className="trunc t3">
                    {[r.cookie.httpOnly && 'HttpOnly', r.cookie.secure && 'Secure', r.cookie.sameSite].filter(Boolean).join(' · ')}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {selected && (
        <div className={s.detail}>
          <div className={s.detailBar}>
            <b className="trunc f1">{selected.name}</b>
            <button className="ib sm" aria-label="Close" onClick={() => setOpen(null)}><Icon name="x" size={11} /></button>
          </div>
          <div className={s.detailBody}>
            <Pretty text={selected.value} />
          </div>
        </div>
      )}
      {snapshot?.masked && <span className="t3" style={{ fontSize: 10.5 }}>Values named like credentials, and personal data, are masked (••••).</span>}
    </div>
  );
}
