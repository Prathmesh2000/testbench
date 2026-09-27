'use client';

import type { HomeSummary, QueueItem } from '@tb/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession } from '@/components/providers';
import { Avatars, PriorityTag, ResultStatus, StackedBar } from '@/components/status';
import { get } from '@/lib/api';
import { fmt, minutesLabel } from '@/lib/format';
import s from './home.module.css';

/** "My work": what the signed-in tester should do next, and how the active runs are going. */
export function HomeScreen() {
  const { me, project } = useSession();
  const home = useQuery({ queryKey: ['home', project.id], queryFn: () => get<HomeSummary>(`/projects/${project.id}/home`) });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const byRun = new Map<string, QueueItem[]>();
  for (const item of home.data?.queue ?? []) byRun.set(item.runId, [...(byRun.get(item.runId) ?? []), item]);
  const toggle = (runId: string) => setCollapsed((c) => {
    const next = new Set(c);
    if (next.has(runId)) next.delete(runId); else next.add(runId);
    return next;
  });
  const passRate = home.data?.executedToday ? Math.round((home.data.passedToday / home.data.executedToday) * 100) : null;
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1 className="h1">My work</h1>
          <div className="t3" style={{ fontSize: 12, marginTop: 2 }}>{today} · {me.user.name} · {project.name}</div>
        </div>
        <div className="f1" />
        <Link className="btn" href="/cases"><Icon name="cases" size={14} />Test cases</Link>
        {project.permissions.includes('run.create') && <Link className="btn primary" href="/runs/new"><Icon name="plus" size={14} />New run</Link>}
      </div>

      <div className={s.kpis}>
        <div className={s.kpi}><span className={s.l}>Assigned to me</span><span className={s.v}>{home.data ? fmt(home.data.assigned) : '—'}</span><span className={s.s}>≈ {home.data ? minutesLabel(home.data.assignedMinutes) : '—'} of estimated work</span></div>
        <div className={s.kpi}><span className={s.l}>Executed today</span><span className={s.v}>{home.data ? fmt(home.data.executedToday) : '—'}</span><span className={s.s}>{home.data ? `${fmt(home.data.passedToday)} passed` : ''}</span></div>
        <div className={s.kpi}><span className={s.l}>Pass rate today</span><span className={s.v}>{passRate === null ? '—' : `${passRate}%`}</span><span className={s.s}>of cases you finished</span></div>
        <div className={s.kpi}><span className={s.l}>Active runs</span><span className={s.v}>{home.data ? home.data.activeRuns.length : '—'}</span><span className={s.s}>in {project.key}</span></div>
      </div>

      <div className={s.cols}>
        <section className="panel" style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <div className="hdr"><h3>Assigned run items</h3><span className="cnt">{home.data ? fmt(home.data.assigned) : ''}</span></div>
          {home.isLoading && <div className="empty t3" style={{ padding: 40 }}>Loading your queue…</div>}
          {home.data && home.data.queue.length === 0 && (
            <div className="empty" style={{ padding: 40 }}><Icon name="check" size={20} /><div>Nothing assigned to you right now.</div></div>
          )}
          {[...byRun.entries()].map(([runId, items]) => (
            <div key={runId}>
              <button className={s.wgrp} onClick={() => toggle(runId)} aria-expanded={!collapsed.has(runId)}>
                <span className={`${s.cv} ${collapsed.has(runId) ? '' : s.open}`}><Icon name="chevRight" size={12} /></span>
                <span className="mono t2">{items[0]!.runKey}</span>
                <span className="trunc" style={{ fontWeight: 500 }}>{items[0]!.runName}</span>
                <span className="mono t3">{items.length}</span>
                <div className="f1" />
                <Link className="btn sm" href={`/runs/${runId}`} onClick={(e) => e.stopPropagation()}><Icon name="play" size={12} />Execute</Link>
              </button>
              {!collapsed.has(runId) && items.map((item) => (
                <Link key={item.id} className={s.wrow} href={`/runs/${runId}?item=${item.id}`}>
                  <ResultStatus result={item.status} label={false} />
                  <span className="mono t2">{item.caseKey}</span>
                  <span className="trunc">{item.title}</span>
                  <span className="trunc t3 hide-phone">{item.config}</span>
                  <PriorityTag priority={item.priority} />
                  <span className="mono t3 hide-phone">{item.estimateMin ? `${item.estimateMin}m` : ''}</span>
                </Link>
              ))}
            </div>
          ))}
        </section>

        <aside className={s.right}>
          <section className="panel">
            <div className="hdr"><h3>Active runs</h3><div className="f1" /><Link href="/runs" style={{ fontSize: 12 }}>All runs</Link></div>
            {home.data?.activeRuns.length === 0 && <div className="empty t3" style={{ padding: 24 }}>No active runs.</div>}
            {home.data?.activeRuns.map((run) => {
              const done = run.counts.total - run.counts.untested;
              return (
                <Link key={run.id} className={s.run} href={`/runs/${run.id}`}>
                  <div className="row"><span className="mono t2">{run.key}</span><span className="trunc f1" style={{ fontWeight: 500 }}>{run.name}</span><Avatars users={run.assignees} max={3} /></div>
                  <StackedBar counts={run.counts} width="100%" />
                  <div className="row t3" style={{ fontSize: 11.5 }}>
                    <span className="num">{fmt(done)} / {fmt(run.counts.total)} done</span>
                    {run.counts.failed > 0 && <span className="st-failed">{fmt(run.counts.failed)} failed</span>}
                    {run.counts.blocked > 0 && <span className="st-blocked">{fmt(run.counts.blocked)} blocked</span>}
                    <div className="f1" /><span>Build <span className="mono">{run.build}</span></span>
                  </div>
                </Link>
              );
            })}
          </section>
        </aside>
      </div>
    </div>
  );
}
