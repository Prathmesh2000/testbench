'use client';

import type { SavedFilter, SearchHit, SearchResult } from '@tb/contracts';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { parse } from '@tb/tql';
import { useEffect, useMemo, useState } from 'react';
import { Highlighted } from '@/components/Highlighted';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { CaseStatusPill, PriorityTag, ResultStatus } from '@/components/status';
import { api, ApiError, get } from '@/lib/api';
import { fmt } from '@/lib/format';
import { TqlEditor } from './TqlEditor';
import s from './search.module.css';

const EXAMPLES = [
  { name: 'Failing smoke', tql: 'label = smoke AND lastResult = Failed' },
  { name: 'OTP retry wording', tql: 'text ~ "otp retry"~3' },
  { name: 'P0 not run this week', tql: 'priority = P0 AND (lastRun < -7d OR lastRun IS EMPTY)' },
  { name: 'Needs review, by module', tql: 'status = "Needs review" GROUP BY module' },
];

/** TQL search over every case in the project, with saved and shared filters (HLD §6). */
export function SearchScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { project, can } = useSession();
  const { notify } = useToast();
  const [draft, setDraft] = useState(params.get('q') ?? 'label = smoke AND lastResult = Failed');
  const [tql, setTql] = useState(draft);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);

  const values = useQuery({
    queryKey: ['search-values', project.id],
    queryFn: () => get<Record<string, string[]>>(`/projects/${project.id}/search/values`),
    staleTime: 5 * 60_000,
  });
  const filters = useQuery({ queryKey: ['filters', project.id], queryFn: () => get<SavedFilter[]>(`/projects/${project.id}/filters`) });
  const results = useInfiniteQuery({
    queryKey: ['search', project.id, tql],
    queryFn: ({ pageParam }) => api<SearchResult>('POST', `/projects/${project.id}/search`, { tql, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });

  useEffect(() => {
    router.replace(`/search?q=${encodeURIComponent(tql)}`, { scroll: false });
  }, [tql, router]);

  const run = () => setTql(draft.trim());
  const first = results.data?.pages[0];
  const hits = useMemo(() => results.data?.pages.flatMap((p) => p.items) ?? [], [results.data]);
  const serverError = results.error instanceof ApiError
    ? { message: results.error.message, ...(results.error.details as { start?: number; end?: number } | undefined) }
    : null;

  const groupField = useMemo(() => {
    try {
      return parse(tql).groupBy?.name ?? null;
    } catch {
      return null;
    }
  }, [tql]);
  const grouped = useMemo(() => {
    if (!first?.groups || !groupField) return null;
    return first.groups.map((g) => ({ ...g, hits: hits.filter((h) => groupValues(h, groupField).includes(g.value)) }));
  }, [first, hits, groupField]);

  const saveFilter = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', `/projects/${project.id}/filters`, { name, tql, shared: share });
      await queryClient.invalidateQueries({ queryKey: ['filters', project.id] });
      notify(`Saved “${name}”`);
      setSaving(false);
      setName('');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the filter', 'bad');
    }
  };

  const active = filters.data?.find((f) => f.id === activeFilter);
  const toggleSubscription = async () => {
    if (!active) return;
    await api('PUT', `/projects/${project.id}/filters/${active.id}/subscription`, { subscribed: !active.subscribed });
    await queryClient.invalidateQueries({ queryKey: ['filters', project.id] });
    notify(active.subscribed ? 'Unsubscribed' : 'Subscribed. Alerts for new matches start with notifications (M3).');
  };

  const createRun = async () => {
    try {
      const { keys, more } = await api<{ keys: string[]; more: boolean }>('POST', `/projects/${project.id}/search/keys`, { tql });
      if (!keys.length) { notify('Nothing to run: the search has no results', 'bad'); return; }
      if (more) notify(`Only the first ${fmt(keys.length)} results go into the run`);
      sessionStorage.setItem('tb.runSelection', JSON.stringify({ keys }));
      router.push('/runs/new?from=selection');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not collect the results', 'bad');
    }
  };

  const pick = (f: { id?: string; tql: string }) => {
    setActiveFilter(f.id ?? null);
    setDraft(f.tql);
    setTql(f.tql);
  };

  const mine = filters.data?.filter((f) => f.mine) ?? [];
  const shared = filters.data?.filter((f) => !f.mine) ?? [];

  return (
    <div className={s.layout}>
      <aside className={s.side} aria-label="Saved filters">
        <div className="sec" style={{ padding: '4px 8px 6px' }}>Mine</div>
        {mine.map((f) => <FilterButton key={f.id} f={f} on={f.id === activeFilter} onPick={() => pick(f)} />)}
        {mine.length === 0 && <div className="t3" style={{ fontSize: 12, padding: '2px 8px' }}>Save a search to find it here.</div>}
        <div className="sec" style={{ padding: '14px 8px 6px' }}>Shared with {project.key}</div>
        {shared.map((f) => <FilterButton key={f.id} f={f} on={f.id === activeFilter} onPick={() => pick(f)} />)}
        {shared.length === 0 && <div className="t3" style={{ fontSize: 12, padding: '2px 8px' }}>None yet.</div>}
        <div className="sec" style={{ padding: '14px 8px 6px' }}>Examples</div>
        {EXAMPLES.map((ex) => (
          <button key={ex.name} className={s.sf} onClick={() => pick(ex)}><Icon name="search" size={13} /><span className="trunc">{ex.name}</span></button>
        ))}
      </aside>

      <div className="f1" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className={s.head}>
          <div className="row" style={{ gap: 8 }}>
            <h1 className="h1">Search</h1>
            <span className="t3" style={{ fontSize: 12 }}>TQL · Testbench query language</span>
            <div className="f1" />
            <button className="btn primary" onClick={run}><Icon name="search" size={14} />Search<span className="kbd">Enter</span></button>
          </div>
          <TqlEditor value={draft} onChange={setDraft} onRun={run} values={values.data ?? {}} serverError={draft === tql ? serverError : null} />
          {first && (
            <div className="row" style={{ gap: 8, fontSize: 12.5 }}>
              <span className="st st-passed"><Icon name="check" size={13} /></span>
              <span><b className="num">{first.totalCapped ? `${fmt(first.total)}+` : fmt(first.total)}</b> results in <span className="num">{first.tookMs}</span> ms</span>
              {results.isFetching && <Icon name="refresh" size={12} className="spin t3" />}
            </div>
          )}
        </div>

        <div className={s.actions}>
          {saving ? (
            <form className="row" style={{ gap: 6 }} onSubmit={saveFilter}>
              <input className="inp" autoFocus placeholder="Filter name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Filter name" />
              <label className="row t2" style={{ gap: 5, fontSize: 12 }}><input type="checkbox" className="cb" checked={share} onChange={(e) => setShare(e.target.checked)} />Share with {project.key}</label>
              <button className="btn sm primary" type="submit" disabled={!name.trim()}>Save</button>
              <button className="btn sm" type="button" onClick={() => setSaving(false)}>Cancel</button>
            </form>
          ) : (
            <button className="btn sm" onClick={() => setSaving(true)} disabled={!!serverError}><Icon name="plus" size={12} />Save filter</button>
          )}
          {active && <button className="btn sm" onClick={toggleSubscription}><Icon name="bell" size={12} />{active.subscribed ? 'Unsubscribe' : 'Subscribe'}</button>}
          <div className="f1" />
          {can('run.create') && <button className="btn sm primary" onClick={createRun} disabled={!hits.length}><Icon name="play" size={12} />Create run from results</button>}
        </div>

        <div className={s.results}>
          {results.isLoading && <div className="empty t3" style={{ padding: 40 }}>Searching…</div>}
          {first && hits.length === 0 && <div className="empty" style={{ padding: 40 }}><Icon name="search" size={20} /><div>No cases match this query.</div></div>}
          {grouped
            ? grouped.map((g) => (
                <details key={g.value} className={s.rg} open>
                  <summary><Icon name="chevRight" size={12} className={s.chev} />{g.label}<span className="mono t3" style={{ fontWeight: 400 }}>{fmt(g.count)}</span></summary>
                  {g.hits.map((h) => <Hit key={h.id} h={h} />)}
                  {g.hits.length < g.count && <div className="t3" style={{ fontSize: 12, padding: '6px 14px' }}>{fmt(g.count - g.hits.length)} more; load more results below.</div>}
                </details>
              ))
            : hits.map((h) => <Hit key={h.id} h={h} />)}
          {results.hasNextPage && (
            <div style={{ padding: 12, textAlign: 'center' }}>
              <button className="btn" onClick={() => results.fetchNextPage()} disabled={results.isFetchingNextPage}>{results.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The bucket value(s) a hit falls under for a GROUP BY field; labels can put one case in several groups. */
function groupValues(h: SearchHit, field: string): string[] {
  switch (field) {
    case 'module': return [h.modulePath];
    case 'priority': return [h.priority];
    case 'status': return [h.status];
    case 'lastResult': return [h.lastResult];
    case 'automation': return [h.automation];
    case 'type': return [h.type];
    case 'owner': return [h.owner?.name ?? '—'];
    case 'label': return h.labels.length ? h.labels : ['—'];
    default: return [];
  }
}

function FilterButton({ f, on, onPick }: { f: SavedFilter; on: boolean; onPick(): void }) {
  return (
    <button className={`${s.sf} ${on ? s.on : ''}`} onClick={onPick} title={f.tql}>
      <Icon name="filter" size={13} />
      <span className="trunc">{f.name}</span>
      {f.subscribed && <Icon name="bell" size={11} className={s.c} />}
    </button>
  );
}

function Hit({ h }: { h: SearchHit }) {
  return (
    <Link className={s.res} href={`/cases/${h.key}`}>
      <span className="mono t2">{h.key}</span>
      <span className="col" style={{ gap: 3, minWidth: 0 }}>
        <span><Highlighted text={h.highlight.title ?? h.title} /></span>
        {h.highlight.steps && <span className="t3" style={{ fontSize: 12 }}><Highlighted text={h.highlight.steps} /></span>}
        <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{h.labels.map((l) => <span key={l} className="lbl">{l}</span>)}</span>
      </span>
      <span className="col" style={{ gap: 4 }}><CaseStatusPill status={h.status} /><ResultStatus result={h.lastResult} /></span>
      <PriorityTag priority={h.priority} />
      <span className="t3 trunc">{h.modulePath}</span>
    </Link>
  );
}
