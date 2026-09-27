'use client';

import type { CaseDetail } from '@tb/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { Avatar, CaseStatusPill, PriorityTag, ResultDots, ResultStatus } from '@/components/status';
import { get } from '@/lib/api';
import { ago } from '@/lib/format';
import s from './cases.module.css';

/** Quick look at one case without leaving the grid. */
export function CaseDrawer({ projectId, caseKey, onClose }: { projectId: string; caseKey: string; onClose(): void }) {
  const detail = useQuery({ queryKey: ['case', projectId, caseKey], queryFn: () => get<CaseDetail>(`/projects/${projectId}/cases/${caseKey}`) });
  const c = detail.data;

  return (
    <aside className={s.drawer} aria-label={`Case ${caseKey}`}>
      <div className="hdr">
        <span className="mono t2">{caseKey}</span>
        {c && <CaseStatusPill status={c.status} />}
        <div className="f1" />
        <Link className="btn sm" href={`/cases/${caseKey}`}>Open <span className="kbd">O</span></Link>
        <button className="ib sm" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      {!c && <div className="empty t3" style={{ padding: 40 }}>{detail.error ? 'Could not load this case.' : 'Loading…'}</div>}
      {c && (
        <div style={{ overflow: 'auto', flex: 1 }}>
          <div className={s.dsec}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>{c.title}</h2>
            <div className={s.ddl}>
              <div><div className={s.k}>Module</div><div className={s.v}>{c.modulePath}</div></div>
              <div><div className={s.k}>Priority</div><div className={s.v}><PriorityTag priority={c.priority} /></div></div>
              <div><div className={s.k}>Owner</div><div className={s.v}>{c.owner ? <><Avatar user={c.owner} />{c.owner.name}</> : <span className="t3">Unassigned</span>}</div></div>
              <div><div className={s.k}>Last result</div><div className={s.v}><ResultStatus result={c.lastResult} /></div></div>
              <div><div className={s.k}>Type</div><div className={s.v}>{c.type}</div></div>
              <div><div className={s.k}>Version</div><div className={s.v}><span className="mono">v{c.currentVersion}</span><span className="t3">· {ago(c.updatedAt)}</span></div></div>
            </div>
            {c.labels.length > 0 && <div className="row" style={{ gap: 4, marginTop: 12, flexWrap: 'wrap' }}>{c.labels.map((l) => <span key={l} className="lbl">{l}</span>)}</div>}
          </div>
          {c.recentResults.length > 0 && (
            <div className={s.dsec}>
              <div className="sec" style={{ marginBottom: 8 }}>Last {c.recentResults.length} results</div>
              <ResultDots results={c.recentResults.map((r) => r.status)} />
            </div>
          )}
          <div className={s.dsec}>
            <div className="sec" style={{ marginBottom: 6 }}>Steps · {c.version.steps.length}</div>
            {c.version.steps.map((step, i) => (
              <div key={i} className={s.dstep}>
                <span className={s.n}>{i + 1}</span>
                <div className="f1">
                  <div>{step.action}</div>
                  {step.expected && <div className="t2" style={{ marginTop: 2 }}>→ {step.expected}</div>}
                </div>
              </div>
            ))}
            {c.version.steps.length === 0 && <div className="t3">No steps yet.</div>}
          </div>
          {c.dependsOn.length > 0 && (
            <div className={s.dsec}>
              <div className="sec" style={{ marginBottom: 6 }}>Depends on</div>
              {c.dependsOn.map((d) => (
                <Link key={d.key} href={`/cases/${d.key}`} className="row" style={{ gap: 8, height: 26, fontSize: 12.5, color: 'var(--text)' }}>
                  <span className="mono t2">{d.key}</span><span className="trunc f1">{d.title}</span><ResultStatus result={d.lastResult} label={false} />
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
