'use client';

import type { DefectDetail, DefectRow, SyncStatus } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { Avatar } from '@/components/status';
import { api, ApiError, get, qs } from '@/lib/api';
import { ago, dateTimeIST, fmt } from '@/lib/format';
import { JiraStatus, RetestState, SeverityTag } from './defect-bits';
import s from './defects.module.css';

type View = 'all' | 'retest' | 'mine';
type StatusFilter = 'open' | 'done' | 'any';

/** Bugs logged from Testbench, their Jira status, and the retest queue (HLD §5.14). */
export function DefectsScreen() {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('all');
  const [status, setStatus] = useState<StatusFilter>('any');
  const [openId, setOpenId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const sync = useQuery({ queryKey: ['defect-sync', project.id], queryFn: () => get<SyncStatus>(`/projects/${project.id}/defects/sync`), refetchInterval: 60_000 });
  const defects = useQuery({
    queryKey: ['defects', project.id, view, status],
    queryFn: () => get<DefectRow[]>(`/projects/${project.id}/defects${qs({ view, status })}`),
    enabled: sync.data?.connected !== false,
  });
  const retestCount = useQuery({
    queryKey: ['defects', project.id, 'retest', 'any'],
    queryFn: () => get<DefectRow[]>(`/projects/${project.id}/defects?view=retest`),
    enabled: sync.data?.connected !== false,
  });

  const syncNow = async () => {
    setSyncing(true);
    try {
      const { changed } = await api<{ changed: number }>('POST', `/projects/${project.id}/defects/sync`);
      await queryClient.invalidateQueries({ queryKey: ['defects', project.id] });
      await queryClient.invalidateQueries({ queryKey: ['defect-sync', project.id] });
      notify(changed ? `${changed} bug${changed === 1 ? '' : 's'} updated from Jira` : 'Everything is already in sync with Jira');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Sync failed', 'bad');
    } finally {
      setSyncing(false);
    }
  };

  if (sync.data && !sync.data.connected) {
    return <div className="page"><div className="empty" style={{ flex: 1 }}><Icon name="plug" size={22} /><div className="h1">Jira is not connected</div><div className="t2">Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN for core-api to log and track bugs.</div></div></div>;
  }

  return (
    <div className={s.layout}>
      <section className="f1" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className={s.head}>
          <div className="row" style={{ gap: 10 }}>
            <h1 className="h1">Defects</h1>
            <span className="t3" style={{ fontSize: 12 }}>
              {sync.data?.lastError
                ? <span className="st-failed">Jira sync failed: {sync.data.lastError}</span>
                : sync.data?.lastSyncAt ? `Jira synced ${ago(sync.data.lastSyncAt)} · status changes also arrive by webhook` : 'Status changes arrive from Jira by webhook'}
            </span>
            <div className="f1" />
            {can('run.execute') && <button className="btn sm" onClick={syncNow} disabled={syncing}><Icon name="refresh" size={12} className={syncing ? 'spin' : ''} />Sync now</button>}
          </div>
          <div className="row" style={{ gap: 10 }}>
            <div className="tabs" role="tablist">
              {(['all', 'retest', 'mine'] as View[]).map((v) => (
                <button key={v} role="tab" aria-selected={view === v} className={`tab ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>
                  {{ all: 'All', retest: 'Retest queue', mine: 'Reported by me' }[v]}
                  {v === 'retest' && retestCount.data && <span className="n">{retestCount.data.length}</span>}
                </button>
              ))}
            </div>
            <div className="f1" />
            <div className="seg" role="radiogroup" aria-label="Jira status">
              {(['open', 'done', 'any'] as StatusFilter[]).map((st) => (
                <button key={st} role="radio" aria-checked={status === st} className={status === st ? 'on' : ''} onClick={() => setStatus(st)}>{{ open: 'Open', done: 'Done', any: 'Any status' }[st]}</button>
              ))}
            </div>
          </div>
        </div>
        <div className={`${s.table} ${openId ? s.narrow : ''}`} role="grid" aria-label="Defects">
          <div className={`${s.dg} ${s.dgh}`} role="row">
            <span>Key</span><span>Summary</span><span>Status</span><span>Severity</span>
            <span className={s.opt}>Assignee</span><span className={s.opt}>Cases</span><span className={s.opt}>Fix</span><span className={s.opt}>Age</span><span>Retest</span>
          </div>
          {defects.data?.map((d) => (
            <div key={d.id} role="row" className={`${s.dg} ${d.id === openId ? s.on : ''}`} onClick={() => setOpenId(d.id)}>
              <a className="mono" href={d.jiraUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{d.jiraKey}</a>
              <span className="trunc">{d.summary}</span>
              <span><JiraStatus status={d.status} category={d.statusCategory} /></span>
              <SeverityTag severity={d.severity} />
              <span className={`${s.opt} trunc t2`}>{d.assignee ?? '—'}</span>
              <span className={`${s.opt} trunc mono t2`}>{d.linkedCases.map((c) => c.key).join(', ')}</span>
              <span className={`${s.opt} mono t3`}>{d.fixVersion ?? '—'}</span>
              <span className={`${s.opt} t3`}>{ago(d.createdAt).replace(' ago', '')}</span>
              <RetestState retest={d.retest} />
            </div>
          ))}
          {defects.data?.length === 0 && (
            <div className="empty" style={{ padding: 48 }}>
              <Icon name="bug" size={22} />
              <div>{view === 'retest' ? 'Nothing waiting for a retest.' : 'No bugs here yet.'}</div>
              <div className="t3" style={{ fontSize: 12 }}>Log a bug from a failed step in <Link href="/runs">a run</Link>.</div>
            </div>
          )}
          {defects.isLoading && <div className="empty t3" style={{ padding: 40 }}>Loading bugs…</div>}
        </div>
      </section>
      {openId && <DefectDrawer defectId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function DefectDrawer({ defectId, onClose }: { defectId: string; onClose(): void }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['defect', project.id, defectId], queryFn: () => get<DefectDetail>(`/projects/${project.id}/defects/${defectId}`) });
  const [form, setForm] = useState<{ id: string; status: 'passed' | 'failed'; build: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = detail.data;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    try {
      await api('POST', `/projects/${project.id}/retests/${form.id}`, { status: form.status, build: form.build, note: form.note || undefined });
      await queryClient.invalidateQueries({ queryKey: ['defect', project.id, defectId] });
      await queryClient.invalidateQueries({ queryKey: ['defects', project.id] });
      notify(form.status === 'passed' ? `Verified; commented on ${d?.jiraKey}` : `${d?.jiraKey} reopened in Jira with your note`);
      setForm(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the retest');
    }
  };

  return (
    <aside className={s.drawer} aria-label="Defect">
      <div className="hdr">
        {d && <a className="mono" href={d.jiraUrl} target="_blank" rel="noreferrer">{d.jiraKey} ↗</a>}
        {d && <JiraStatus status={d.status} category={d.statusCategory} />}
        <div className="f1" />
        <button className="ib sm" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      {!d && <div className="empty t3" style={{ padding: 40 }}>Loading…</div>}
      {d && (
        <div style={{ overflow: 'auto', flex: 1 }}>
          <div className={s.dsec}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>{d.summary}</h2>
            <div className="row" style={{ gap: 10, marginTop: 8, flexWrap: 'wrap', fontSize: 12 }}>
              <SeverityTag severity={d.severity} />
              <span className="t3">Assignee</span><span>{d.assignee ?? '—'}</span>
              <span className="t3">Reported by</span><span className="row" style={{ gap: 4 }}><Avatar user={d.reporter} />{d.reporter.name}</span>
            </div>
          </div>

          <div className={s.dsec}>
            <div className="sec" style={{ marginBottom: 6 }}>Retests</div>
            {d.retests.length === 0 && <div className="t3" style={{ fontSize: 12 }}>A retest is queued for each linked case once Jira marks this bug done.</div>}
            {d.retests.map((r) => (
              <div key={r.id} className={s.retest}>
                <div className="row" style={{ gap: 8 }}>
                  <Link className="mono" href={`/cases/${r.caseKey}`}>{r.caseKey}</Link>
                  <span className="trunc f1">{r.caseTitle}</span>
                  <RetestState retest={r.status} />
                </div>
                {r.status !== 'pending' && <div className="t3" style={{ fontSize: 12 }}>Build {r.build}{r.note ? ` · ${r.note}` : ''}</div>}
                {r.status === 'pending' && can('run.execute') && form?.id !== r.id && (
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm" onClick={() => setForm({ id: r.id, status: 'passed', build: '', note: '' })}><Icon name="check" size={12} />Passed</button>
                    <button className="btn sm danger" onClick={() => setForm({ id: r.id, status: 'failed', build: '', note: '' })}><Icon name="x" size={12} />Still failing</button>
                  </div>
                )}
                {form?.id === r.id && (
                  <form className="col" style={{ gap: 6 }} onSubmit={submit}>
                    <div className="row" style={{ gap: 6 }}>
                      <input className="inp mono" style={{ width: 110 }} autoFocus placeholder="Fix build" value={form.build} onChange={(e) => setForm({ ...form, build: e.target.value })} aria-label="Build you retested on" />
                      <span className={form.status === 'passed' ? 'st st-passed' : 'st st-failed'}>{form.status === 'passed' ? 'Passed' : 'Still failing'}</span>
                    </div>
                    <textarea className="inp" rows={2} placeholder={form.status === 'failed' ? 'What still fails? This goes to Jira.' : 'Note (optional)'} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} aria-label="Retest note" />
                    {error && <div className="err">{error}</div>}
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn sm primary" type="submit" disabled={!form.build.trim() || (form.status === 'failed' && !form.note.trim())}>Record retest</button>
                      <button className="btn sm" type="button" onClick={() => setForm(null)}>Cancel</button>
                    </div>
                  </form>
                )}
              </div>
            ))}
          </div>

          <div className={s.dsec}>
            <div className="sec" style={{ marginBottom: 6 }}>Found in</div>
            {d.items.map((i, n) => (
              <div key={n} className="row" style={{ gap: 8, height: 26, fontSize: 12.5 }}>
                <span className="mono t2">{i.caseKey}</span><span className="mono t3">{i.runKey}</span><span className="trunc f1 t2">{i.config}</span><span className="mono t3">{i.build}</span>
              </div>
            ))}
          </div>

          <div className={s.dsec}>
            <div className="sec" style={{ marginBottom: 10 }}>History · {fmt(d.timeline.length)}</div>
            <div className={s.tl}>
              {d.timeline.map((e, i) => (
                <div key={i} className={`${s.te} ${e.kind === 'retest' ? s.rt : e.kind === 'status' ? s.jira : e.kind === 'created' ? s.ok : ''}`}>
                  <span className={s.ic}><Icon name={e.kind === 'created' ? 'bug' : e.kind === 'status' ? 'refresh' : e.kind === 'retest' ? 'check' : 'link'} size={11} /></span>
                  <div>{e.detail}</div>
                  <div className="t3" style={{ fontSize: 11.5 }}>{e.actor ? `${e.actor.name} · ` : ''}{dateTimeIST(e.at)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
