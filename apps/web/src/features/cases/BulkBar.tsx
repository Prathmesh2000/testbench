'use client';

import { CASE_STATUSES, PRIORITIES, type BulkPatch, type CaseFilter, type JobStatus } from '@tb/contracts';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useJobs, useSession, useToast } from '@/components/providers';
import { caseStatusLabel } from '@/components/status';
import { api, ApiError } from '@/lib/api';
import { fmt } from '@/lib/format';
import s from './cases.module.css';

interface Props {
  /** What the action applies to: explicit keys, or everything matching the current filter. */
  target: { kind: 'keys'; keys: string[] } | { kind: 'all'; filter: CaseFilter; count: number; capped: boolean };
  canSelectAll: { count: number; capped: boolean } | null;
  onSelectAll(): void;
  onClear(): void;
}

/**
 * Floating bar for bulk actions. Changes are sent as one filter-driven background job (HLD §3.1), so
 * "all 12,480 matching" costs the browser one request, and progress shows in the status bar.
 */
export function BulkBar({ target, canSelectAll, onSelectAll, onClear }: Props) {
  const router = useRouter();
  const { project, can } = useSession();
  const { track } = useJobs();
  const { notify } = useToast();
  const [menu, setMenu] = useState<'status' | 'priority' | 'label' | null>(null);
  const [label, setLabel] = useState('');

  const size = target.kind === 'keys' ? target.keys.length : target.count;
  const sizeLabel = target.kind === 'all' && target.capped ? `${fmt(size)}+` : fmt(size);
  const filter: CaseFilter = target.kind === 'keys' ? { keys: target.keys } : target.filter;

  const apply = async (patch: BulkPatch, describe: string) => {
    setMenu(null);
    try {
      const job = await api<JobStatus>('POST', `/projects/${project.id}/cases/bulk`, { filter, patch });
      track(project.id, job.id, `${describe} on ${fmt(job.total)} cases`);
      onClear();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not start the bulk update', 'bad');
    }
  };

  const createRun = () => {
    // Hand the selection to the run wizard without squeezing thousands of keys into a URL.
    sessionStorage.setItem('tb.runSelection', JSON.stringify(filter));
    router.push('/runs/new?from=selection');
  };

  return (
    <div className={s.bulk} role="toolbar" aria-label="Bulk actions">
      <b className="num">{sizeLabel} selected</b>
      {canSelectAll && target.kind === 'keys' && (
        <button className="link" style={{ fontSize: 12.5 }} onClick={onSelectAll}>
          Select all {canSelectAll.capped ? `${fmt(canSelectAll.count)}+` : fmt(canSelectAll.count)} matching
        </button>
      )}
      <span className="dotsep">|</span>
      {can('case.write') && (
        <>
          <span style={{ position: 'relative' }}>
            <button className="btn sm" onClick={() => setMenu(menu === 'status' ? null : 'status')}>Set status<Icon name="chevDown" size={11} /></button>
            {menu === 'status' && (
              <div className="menu" style={{ bottom: 30, left: 0 }} role="menu">
                {CASE_STATUSES.map((st) => <button key={st} className="mi" onClick={() => apply({ status: st }, `Status → ${caseStatusLabel(st)}`)}>{caseStatusLabel(st)}</button>)}
              </div>
            )}
          </span>
          <span style={{ position: 'relative' }}>
            <button className="btn sm" onClick={() => setMenu(menu === 'priority' ? null : 'priority')}>Priority<Icon name="chevDown" size={11} /></button>
            {menu === 'priority' && (
              <div className="menu" style={{ bottom: 30, left: 0, minWidth: 100 }} role="menu">
                {PRIORITIES.map((p) => <button key={p} className="mi" onClick={() => apply({ priority: p }, `Priority → ${p}`)}><span className={`prio prio-${p}`}>{p}</span></button>)}
              </div>
            )}
          </span>
          <span style={{ position: 'relative' }}>
            <button className="btn sm" onClick={() => setMenu(menu === 'label' ? null : 'label')}>Add label</button>
            {menu === 'label' && (
              <form className="menu" style={{ bottom: 30, left: 0, padding: 8 }} onSubmit={(e) => { e.preventDefault(); if (label.trim()) apply({ addLabels: [label.trim().toLowerCase()] }, `Label +${label.trim()}`); }}>
                <input className="inp" autoFocus placeholder="release-4.18" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label to add" />
              </form>
            )}
          </span>
        </>
      )}
      {can('run.create') && <button className="btn sm primary" onClick={createRun}><Icon name="play" size={12} />Create run</button>}
      <button className="ib sm" aria-label="Clear selection" onClick={onClear}><Icon name="x" size={14} /></button>
    </div>
  );
}
