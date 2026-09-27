'use client';

import {
  EVIDENCE_MAX_BYTES, EVIDENCE_TYPES,
  type DefectRow, type EvidenceUpload, type RecordableResult, type RecordResultResponse, type Result, type RunItemDetail, type RunItemRow, type RunSummary,
} from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { Avatar, Avatars, PriorityTag, ResultStatus, resultLabel, StackedBar } from '@/components/status';
import { api, ApiError, get } from '@/lib/api';
import { bytes, clock, dateTimeIST, fmt } from '@/lib/format';
import { executeAction, isTypingTarget } from '@/lib/keys';
import { JiraStatus } from '../defects/defect-bits';
import { LogBugDialog } from './LogBugDialog';
import s from './execute.module.css';

const FILTERS: (Result | 'all')[] = ['all', 'untested', 'failed', 'blocked', 'passed', 'skipped'];

/** The execute view (HLD §5.3): work through a run's items and record results step by step. */
export function ExecuteScreen({ runId }: { runId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { me, project, can } = useSession();
  const { notify } = useToast();
  const base = `/projects/${project.id}/runs/${runId}`;

  const run = useQuery({
    queryKey: ['run', runId],
    queryFn: () => get<RunSummary>(base),
    // A run being prepared in the background gains items every few seconds.
    refetchInterval: (q) => (q.state.data?.status === 'preparing' ? 3000 : false),
  });
  const items = useQuery({
    queryKey: ['run-items', runId],
    queryFn: () => get<RunItemRow[]>(`${base}/items`),
    refetchInterval: run.data?.status === 'preparing' ? 3000 : false,
  });
  const [itemId, setItemId] = useState<string | null>(params.get('item'));
  const [filter, setFilter] = useState<Result | 'all'>('all');
  const [search, setSearch] = useState('');

  // Start on the first untested item assigned to me, else the first untested one, else the first.
  useEffect(() => {
    if (itemId || !items.data?.length) return;
    const first = items.data.find((i) => i.status === 'untested' && i.assignee?.id === me.user.id)
      ?? items.data.find((i) => i.status === 'untested') ?? items.data[0]!;
    setItemId(first.id);
  }, [items.data, itemId, me.user.id]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items.data ?? []).filter((i) => (filter === 'all' || i.status === filter) && (!q || `${i.caseKey} ${i.title}`.toLowerCase().includes(q)));
  }, [items.data, filter, search]);

  const detail = useQuery({ queryKey: ['run-item', runId, itemId], queryFn: () => get<RunItemDetail>(`${base}/items/${itemId}`), enabled: !!itemId });
  const item = detail.data;

  const [step, setStep] = useState(0);
  const [pending, setPending] = useState<{ stepIndex: number; status: 'failed' | 'blocked' } | null>(null);
  const [actual, setActual] = useState('');
  const [saving, setSaving] = useState(false);
  const [bugOpen, setBugOpen] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [paused, setPaused] = useState(false);
  const recordedAt = useRef(0);
  const actualRef = useRef<HTMLTextAreaElement>(null);

  // New item: jump to its first step without a result, reset the timer and any half-entered failure.
  useEffect(() => {
    if (!item) return;
    const firstOpen = item.stepStatus.findIndex((st) => st === 'untested');
    setStep(firstOpen === -1 ? 0 : firstOpen);
    setPending(null);
    setActual('');
    setSeconds(0);
    recordedAt.current = 0;
  }, [item?.id]);

  useEffect(() => {
    if (paused || !item) return;
    const timer = setInterval(() => setSeconds((sec) => sec + 1), 1000);
    return () => clearInterval(timer);
  }, [paused, item]);

  useEffect(() => { if (pending) actualRef.current?.focus(); }, [pending]);

  const readOnly = !can('run.execute') || run.data?.status === 'completed';

  /** Records one step result and applies the response to every cached view of this run. */
  const record = useCallback(async (stepIndex: number, status: RecordableResult, actualText?: string) => {
    if (!item || readOnly) return;
    setSaving(true);
    try {
      const elapsedS = seconds - recordedAt.current;
      const res = await api<RecordResultResponse>('POST', `${base}/items/${item.id}/results`, { stepIndex, status, actual: actualText, elapsedS });
      recordedAt.current = seconds;
      queryClient.setQueryData(['run-item', runId, item.id], res.item);
      queryClient.setQueryData<RunSummary>(['run', runId], (r) => (r ? { ...r, counts: res.counts } : r));
      const changes = new Map<string, { status: Result; blockedReason: string | null }>([[res.item.id, { status: res.item.status, blockedReason: res.item.blockedReason }], ...res.affected.map((a) => [a.id, a] as const)]);
      queryClient.setQueryData<RunItemRow[]>(['run-items', runId], (list) => list?.map((row) => {
        const change = changes.get(row.id);
        return change ? { ...row, status: change.status, blockedReason: change.blockedReason } : row;
      }));
      queryClient.invalidateQueries({ queryKey: ['home'] });
      if (res.affected.length) notify(`${res.affected.length} dependent item${res.affected.length === 1 ? '' : 's'} ${res.affected[0]!.status === 'blocked' ? 'blocked automatically' : 'unblocked'}`);
      setPending(null);
      setActual('');
      const nextOpen = res.item.stepStatus.findIndex((st, i) => i > stepIndex && st === 'untested');
      if (nextOpen !== -1) setStep(nextOpen);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the result', 'bad');
    } finally {
      setSaving(false);
    }
  }, [item, readOnly, seconds, base, queryClient, runId, notify]);

  const mark = (stepIndex: number, status: RecordableResult) => {
    setStep(stepIndex);
    // Failed and blocked need the tester's words; wait for them instead of saving an empty result.
    if (status === 'failed' || status === 'blocked') {
      setPending({ stepIndex, status });
      setActual(item?.actuals[stepIndex] ?? '');
    } else {
      void record(stepIndex, status);
    }
  };

  const passAll = async () => {
    if (!item) return;
    for (let i = 0; i < item.steps.length; i++) {
      if (item.stepStatus[i] === 'untested') await record(i, 'passed');
    }
  };

  const moveItem = useCallback((delta: 1 | -1) => {
    const at = visible.findIndex((i) => i.id === itemId);
    const next = visible[Math.min(Math.max(at + delta, 0), visible.length - 1)];
    if (next && next.id !== itemId) {
      setItemId(next.id);
      router.replace(`/runs/${runId}?item=${next.id}`, { scroll: false });
    }
  }, [visible, itemId, router, runId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (bugOpen || !item) return;
      const action = executeAction(e, isTypingTarget(e.target));
      if (!action) return;
      e.preventDefault();
      if (action.type === 'mark' && !readOnly) mark(step, action.status);
      if (action.type === 'pass-all' && !readOnly) void passAll();
      if (action.type === 'step') setStep((st) => Math.min(Math.max(st + action.delta, 0), item.steps.length - 1));
      if (action.type === 'item') moveItem(action.delta);
      if (action.type === 'log-bug') setBugOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const upload = async (files: File[], stepIndex: number) => {
    if (!item) return;
    for (const file of files) {
      if (!(EVIDENCE_TYPES as readonly string[]).includes(file.type)) { notify(`${file.name}: only images, videos, text and JSON files can be attached`, 'bad'); continue; }
      if (file.size > EVIDENCE_MAX_BYTES) { notify(`${file.name} is larger than 100 MB`, 'bad'); continue; }
      try {
        const up = await api<EvidenceUpload>('POST', `${base}/items/${item.id}/evidence`, { stepIndex, fileName: file.name || 'screenshot.png', contentType: file.type, sizeBytes: file.size });
        const put = await fetch(up.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
        if (!put.ok) throw new Error(`upload failed (${put.status})`);
        notify(`Attached ${file.name || 'screenshot'} to step ${stepIndex + 1}`);
      } catch (err) {
        notify(err instanceof ApiError ? err.message : `Could not upload ${file.name}`, 'bad');
      }
    }
    await queryClient.invalidateQueries({ queryKey: ['run-item', runId, item.id] });
  };

  const counts = run.data?.counts;
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = { all: items.data?.length ?? 0 };
    for (const i of items.data ?? []) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [items.data]);

  if (run.error) return <div className="page"><div className="empty" style={{ flex: 1 }}><Icon name="alert" size={20} /><div>This run was not found.</div><Link className="btn" href="/runs">All runs</Link></div></div>;

  const done = counts ? counts.total - counts.untested : 0;
  const autoBlocked = item?.status === 'blocked' && item.blockedReason?.startsWith('Prerequisite');

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <div className="row" style={{ height: 42, gap: 10 }}>
          <Link href="/runs" className="mono" style={{ fontSize: 12 }}>{run.data?.key ?? '…'}</Link>
          <span className="t3">/</span>
          <h1 className="h1 trunc" style={{ fontSize: 16 }}>{run.data?.name}</h1>
          {item && <span className="pill">{item.config}</span>}
          <div className="f1" />
          {item && <span className="t3 hide-phone" style={{ fontSize: 12 }}>On <span className="mono">{item.caseKey}</span></span>}
          <span className={s.timer} title="Time on the current case">
            <Icon name="clock" size={14} /><span className="num">{clock(seconds)}</span>
            <button className="ib sm" aria-label={paused ? 'Resume timer' : 'Pause timer'} onClick={() => setPaused((p) => !p)}><Icon name={paused ? 'play' : 'pause'} size={12} /></button>
          </span>
        </div>
        {counts && (
          <div className="row" style={{ height: 34, gap: 14, fontSize: 12 }}>
            <StackedBar counts={counts} width={260} height={8} />
            <span className="num"><b>{fmt(done)}</b> / {fmt(counts.total)} done · {counts.total ? Math.round((done / counts.total) * 100) : 0}%</span>
            <span className="st st-passed hide-tab"><Icon name="check" size={13} /><span className="num">{fmt(counts.passed)}</span> Passed</span>
            <span className="st st-failed hide-tab"><Icon name="x" size={13} /><span className="num">{fmt(counts.failed)}</span> Failed</span>
            <span className="st st-blocked hide-tab"><Icon name="blocked" size={13} /><span className="num">{fmt(counts.blocked)}</span> Blocked</span>
            <span className="st st-untested hide-tab"><Icon name="circle" size={13} /><span className="num">{fmt(counts.untested)}</span> Untested</span>
            <div className="f1" />
            <span className="t3 hide-tab">{run.data?.environment} · build <span className="mono">{run.data?.build}</span></span>
            {run.data && <Avatars users={run.data.assignees} />}
          </div>
        )}
      </header>

      <div className={s.body}>
        <section className={s.list} aria-label="Run items">
          <div className={s.listTools}>
            <div className="row" style={{ position: 'relative' }}>
              <span className="t3" style={{ position: 'absolute', left: 8, display: 'flex' }}><Icon name="search" size={14} /></span>
              <input className="inp f1" style={{ paddingLeft: 28 }} placeholder="Filter items" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filter run items" />
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
              {FILTERS.map((f) => (
                <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : resultLabel(f)} <span className="n">{fmt(statusCounts[f] ?? 0)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className={s.items}>
            {visible.map((i) => (
              <button key={i.id} className={`${s.li} ${i.id === itemId ? s.cur : ''}`} onClick={() => { setItemId(i.id); router.replace(`/runs/${runId}?item=${i.id}`, { scroll: false }); }} title={i.blockedReason ?? i.title}>
                <ResultStatus result={i.status} label={false} size={14} />
                <span className={s.k}>{i.caseKey}</span>
                <span className="trunc f1">{i.title}</span>
                {run.data && run.data.configs.length > 1 && <span className="t3" style={{ fontSize: 11 }}>{i.config.split(' · ')[0]}</span>}
              </button>
            ))}
            {items.data && visible.length === 0 && <div className="empty t3" style={{ padding: 24, fontSize: 12.5 }}>No items match.</div>}
          </div>
          <div className={s.listFoot}><span className="kbd">J</span><span className="kbd">K</span> move<div className="f1" /><span className="num">{fmt(visible.length)} shown</span></div>
        </section>

        <section className={s.center} aria-label="Current case">
          <div className={s.scroll}>
            {!item && <div className="empty t3" style={{ flex: 1 }}>{detail.isLoading || items.isLoading ? 'Loading…' : 'Pick an item on the left.'}</div>}
            {item && (
              <>
                {autoBlocked && (
                  <div className="banner bad" role="alert"><Icon name="blocked" size={16} /><div className="f1"><b>Blocked automatically.</b> {item.blockedReason}. It unblocks when the prerequisite passes; you can still record results.</div></div>
                )}
                {item.needsReview && (
                  <div className="banner warn" role="status"><Icon name="alert" size={16} /><div className="f1"><b>This case is marked Needs review.</b> Its steps may be out of date; check with <Link href={`/cases/${item.caseKey}`}>the case</Link> before failing it.</div></div>
                )}
                {run.data?.status === 'preparing' && (
                  <div className="banner info" role="status"><Icon name="refresh" size={16} className="spin" />Preparing this run: {fmt(items.data?.length ?? 0)} of {fmt(run.data.counts.total)} items ready. You can start on them now.</div>
                )}
                {readOnly && <div className="banner info"><Icon name="info" size={16} />{run.data?.status === 'completed' ? 'This run is completed, so results are read-only.' : 'You can view this run but not record results.'}</div>}

                <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                  <div className="f1">
                    <div className="row" style={{ gap: 8, fontSize: 12 }}>
                      <Link className="mono" href={`/cases/${item.caseKey}`}>{item.caseKey}</Link>
                      <PriorityTag priority={item.priority} />
                      <span className="t3">{item.modulePath}</span>
                      <span className="t3">· v{item.caseVersion}</span>
                    </div>
                    <h2 style={{ margin: '4px 0 0', fontSize: 17, fontWeight: 600, lineHeight: 1.3 }}>{item.title}</h2>
                  </div>
                  <ResultStatus result={item.status} />
                </div>

                {item.preconditions && (
                  <details className={s.pre}>
                    <summary className="t3">Preconditions</summary>
                    <div className="t2" style={{ padding: '6px 0 0 18px', lineHeight: 1.5 }}>{item.preconditions}</div>
                  </details>
                )}

                <div className={s.steps}>
                  {item.steps.map((st, i) => {
                    const status = item.stepStatus[i] ?? 'untested';
                    const active = i === step;
                    const needsActual = pending?.stepIndex === i;
                    const evidence = item.evidence.filter((e) => e.stepIndex === i);
                    return (
                      <div key={i} className={`${s.stp} ${active ? s.act : ''} ${status !== 'untested' ? s.done : ''}`} onClick={() => setStep(i)}>
                        <div className={s.stpH}>
                          <span className={`${s.stpN} mono`}>{i + 1}</span>
                          <div className={`f1 ${s.stpA}`}>{st.action}</div>
                          {status !== 'untested' && <ResultStatus result={status} size={14} />}
                          {!readOnly && (
                            <div className={s.rbs} onClick={(e) => e.stopPropagation()}>
                              {(['passed', 'failed', 'blocked', 'skipped'] as const).map((r) => (
                                <button
                                  key={r} disabled={saving}
                                  className={`${s.rb} ${s[r]} ${status === r || pending?.stepIndex === i && pending.status === r ? s.on : ''}`}
                                  onClick={() => mark(i, r)} aria-label={`${resultLabel(r)} step ${i + 1}`} title={`${resultLabel(r)} (${r[0]!.toUpperCase()})`}
                                >
                                  <Icon name={r === 'passed' ? 'check' : r === 'failed' ? 'x' : r === 'blocked' ? 'blocked' : 'skip'} size={13} />{r[0]!.toUpperCase()}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className={s.stpB}>
                          <div><div className="flab">Expected result</div><div className="t2" style={{ marginTop: 2 }}>{st.expected || '—'}</div></div>
                          <div><div className="flab">Test data</div><div className="t2 mono" style={{ marginTop: 2, fontSize: 11.5 }}>{st.data || '—'}</div></div>
                        </div>
                        {(active || needsActual || evidence.length > 0 || item.actuals[i]) && (
                          <div className={s.actual} onClick={(e) => e.stopPropagation()}>
                            {needsActual ? (
                              <form className="field" onSubmit={(e) => { e.preventDefault(); if (actual.trim()) void record(i, pending.status, actual.trim()); }}>
                                <label htmlFor={`act-${i}`}>Actual result <span style={{ color: 'var(--failed)' }}>*</span></label>
                                <textarea
                                  id={`act-${i}`} ref={actualRef} className="inp" rows={2} value={actual} onChange={(e) => setActual(e.target.value)}
                                  placeholder="What happened instead? e.g. Status stayed PENDING after 60 seconds"
                                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (actual.trim()) void record(i, pending.status, actual.trim()); } if (e.key === 'Escape') setPending(null); }}
                                />
                                <div className="row">
                                  <button className="btn sm primary" type="submit" disabled={!actual.trim() || saving}>Save as {resultLabel(pending.status)}</button>
                                  <button className="btn sm" type="button" onClick={() => setPending(null)}>Cancel</button>
                                  <span className="t3" style={{ fontSize: 11.5 }}>Enter saves · Shift+Enter new line</span>
                                </div>
                              </form>
                            ) : item.actuals[i] && <div style={{ fontSize: 12.5 }}><span className="flab">Actual result · </span>{item.actuals[i]}</div>}
                            {!readOnly && active && <EvidenceDrop onFiles={(files) => upload(files, i)} />}
                            {evidence.length > 0 && (
                              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                                {evidence.map((e) => (
                                  <a key={e.id} className={s.thumb} href={e.url} target="_blank" rel="noreferrer" title={e.fileName}>
                                    {e.contentType.startsWith('image/') ? <img src={e.url} alt={e.fileName} /> : <Icon name="paperclip" size={18} />}
                                    <span className="trunc">{e.fileName}</span>
                                    <span className="t3">{bytes(e.sizeBytes)}</span>
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="row t3" style={{ gap: 6, fontSize: 11.5, padding: '4px 2px 0' }}>
                  <span className="kbd">P</span><span className="kbd">F</span><span className="kbd">B</span><span className="kbd">S</span> mark the active step
                  <span className="dotsep">·</span><span className="kbd">↑</span><span className="kbd">↓</span> change step
                  <span className="dotsep">·</span>paste a screenshot into the evidence box
                </div>
              </>
            )}
          </div>
          <div className={s.abar}>
            <button className="btn" onClick={passAll} disabled={!item || readOnly || saving}><Icon name="check" size={14} />Pass all<span className="kbd">⇧P</span></button>
            <div className="f1" />
            <button className="btn danger" onClick={() => setBugOpen(true)} disabled={!item}><Icon name="bug" size={14} />Log bug<span className="kbd hide-tab">Ctrl+Shift+B</span></button>
            <button className="btn" onClick={() => moveItem(-1)}><Icon name="chevLeft" size={14} />Previous<span className="kbd">K</span></button>
            <button className="btn primary" onClick={() => moveItem(1)}>Next case<Icon name="chevRight" size={14} /><span className="kbd">J</span></button>
          </div>
        </section>

        <aside className={s.info} aria-label="Case info">
          {item && (
            <>
              <div className={s.infoSec}>
                <div className="sec">This item</div>
                <dl className={s.dl}>
                  <dt>Configuration</dt><dd>{item.config}</dd>
                  <dt>Assignee</dt><dd className="row" style={{ gap: 6 }}>{item.assignee ? <><Avatar user={item.assignee} />{item.assignee.name}</> : <span className="t3">Unassigned</span>}</dd>
                  <dt>Case version</dt><dd className="mono">v{item.caseVersion}</dd>
                  <dt>Time spent</dt><dd className="num">{clock(item.durationS + (seconds - recordedAt.current))}</dd>
                </dl>
              </div>
              <div className={s.infoSec}>
                <div className="sec">Previous results</div>
                {item.previous.length === 0 && <div className="t3" style={{ fontSize: 12, marginTop: 6 }}>First time this case runs.</div>}
                {item.previous.map((p, i) => (
                  <div key={i} className="row" style={{ height: 28, gap: 8, fontSize: 12, borderBottom: '1px solid var(--soft)' }}>
                    <ResultStatus result={p.status} label={false} />
                    <span className="mono t2">{p.runKey}</span>
                    <span className="trunc f1 t3">{p.config}</span>
                    <span className="t3" style={{ fontSize: 11 }}>{dateTimeIST(p.at).split(',')[0]}</span>
                  </div>
                ))}
              </div>
              <LinkedBugs caseId={item.caseId} onLog={() => setBugOpen(true)} />
            </>
          )}
        </aside>
      </div>

      {bugOpen && item && run.data && <LogBugDialog item={item} run={run.data} onClose={() => setBugOpen(false)} />}
    </div>
  );
}

/** Bugs already linked to this case, newest first, so a tester can see a known failure before logging it again. */
function LinkedBugs({ caseId, onLog }: { caseId: string; onLog(): void }) {
  const { project } = useSession();
  const bugs = useQuery({
    queryKey: ['defects', project.id, 'case', caseId],
    queryFn: () => get<DefectRow[]>(`/projects/${project.id}/defects?caseId=${caseId}`),
    retry: false,
  });
  return (
    <div className={s.infoSec}>
      <div className="sec">Bugs on this case</div>
      {bugs.error && <div className="t3" style={{ fontSize: 12, marginTop: 6 }}>{bugs.error instanceof ApiError ? bugs.error.message : 'Could not load bugs.'}</div>}
      {bugs.data?.length === 0 && <div className="t3" style={{ fontSize: 12, marginTop: 6 }}>No bugs linked. <button className="link" onClick={onLog}>Log one</button></div>}
      <div className="col" style={{ gap: 6, marginTop: 8 }}>
        {bugs.data?.map((b) => (
          <a key={b.id} className={s.bugl} href={b.jiraUrl} target="_blank" rel="noreferrer">
            <span className="row" style={{ gap: 6 }}><span className="mono">{b.jiraKey}</span><JiraStatus status={b.status} category={b.statusCategory} /></span>
            <span style={{ lineHeight: 1.4 }}>{b.summary}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

/** Evidence drop zone: paste from the clipboard, drop files, or pick them. */
function EvidenceDrop({ onFiles }: { onFiles(files: File[]): void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`${s.drop} ${over ? s.over : ''}`} tabIndex={0} role="button" aria-label="Attach evidence: paste a screenshot, drop files, or press Enter to choose"
      onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); onFiles(files); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}
      onKeyDown={(e) => { if (e.key === 'Enter') input.current?.click(); }}
      onClick={() => input.current?.click()}
    >
      <Icon name="paperclip" size={14} />
      <span>Paste a screenshot, drop files, or <u>choose</u></span>
      <input ref={input} type="file" multiple hidden accept={EVIDENCE_TYPES.join(',')} onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
    </div>
  );
}
