'use client';

import type { RunSummary } from '@tb/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession } from '@/components/providers';
import { Avatars, StackedBar } from '@/components/status';
import { get } from '@/lib/api';
import { dateTimeIST, fmt } from '@/lib/format';

type Tab = 'active' | 'completed' | 'all';

export function RunsScreen() {
  const router = useRouter();
  const { project, can } = useSession();
  const [tab, setTab] = useState<Tab>('active');
  const runs = useQuery({
    queryKey: ['runs', project.id, tab],
    queryFn: () => get<RunSummary[]>(`/projects/${project.id}/runs${tab === 'all' ? '' : `?status=${tab}`}`),
  });

  return (
    <div className="page">
      <div className="page-h">
        <h1 className="h1">Runs</h1>
        <div className="f1" />
        {can('run.create') && <Link className="btn primary" href="/runs/new"><Icon name="plus" size={14} />New run</Link>}
      </div>
      <div className="tabs" role="tablist" style={{ borderBottom: '1px solid var(--border)' }}>
        {(['active', 'completed', 'all'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {{ active: 'Active', completed: 'Completed', all: 'All' }[t]}
          </button>
        ))}
      </div>
      <div className="panel" style={{ overflow: 'auto' }}>
        <table className="tbl" style={{ minWidth: 980 }}>
          <thead>
            <tr><th>Run</th><th>Type</th><th>Build</th><th>Environment</th><th>Progress</th><th style={{ textAlign: 'right' }}>Pass</th><th>Assignees</th><th>Due</th></tr>
          </thead>
          <tbody>
            {runs.data?.map((r) => {
              const done = r.counts.total - r.counts.untested;
              const passRate = done ? Math.round((r.counts.passed / done) * 100) : null;
              return (
                <tr key={r.id} className="rw" onClick={() => router.push(`/runs/${r.id}`)}>
                  <td style={{ maxWidth: 380 }}>
                    <div className="row" style={{ gap: 8 }}><span className="mono t2">{r.key}</span><Link href={`/runs/${r.id}`} className="trunc" style={{ color: 'var(--text)', fontWeight: 500 }}>{r.name}</Link></div>
                  </td>
                  <td className="t2" style={{ textTransform: 'capitalize' }}>{r.type}</td>
                  <td className="mono">{r.build}</td>
                  <td className="t2">{r.environment} · {r.configs.length} config{r.configs.length === 1 ? '' : 's'}</td>
                  <td>
                    <div className="row" style={{ gap: 8 }}>
                      <StackedBar counts={r.counts} width={140} />
                      <span className="num t3" style={{ fontSize: 11.5 }}>{fmt(done)}/{fmt(r.counts.total)}</span>
                    </div>
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>{passRate === null ? '—' : `${passRate}%`}</td>
                  <td><Avatars users={r.assignees} /></td>
                  <td className="t3">{r.status === 'completed' ? 'Completed' : r.dueAt ? dateTimeIST(r.dueAt) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {runs.data?.length === 0 && <div className="empty" style={{ padding: 40 }}><Icon name="runs" size={20} /><div>No {tab === 'all' ? '' : tab} runs.</div></div>}
        {runs.isLoading && <div className="empty t3" style={{ padding: 40 }}>Loading runs…</div>}
      </div>
    </div>
  );
}
