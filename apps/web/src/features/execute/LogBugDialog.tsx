'use client';

import type { RunItemDetail, RunSummary } from '@tb/contracts';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';

/**
 * Bug report prefilled from the executed steps. Creating the issue in Jira (with the duplicate check)
 * arrives with Defect Integration in M2; until then the report can be copied into Jira by hand.
 */
export function LogBugDialog({ item, run, onClose }: { item: RunItemDetail; run: RunSummary; onClose(): void }) {
  const { notify } = useToast();
  const failedAt = item.stepStatus.findIndex((st) => st === 'failed' || st === 'blocked');
  const upTo = failedAt === -1 ? item.steps.length : failedAt + 1;
  const [summary, setSummary] = useState(failedAt === -1 ? item.title : `${item.steps[failedAt]!.action}: ${item.actuals[failedAt] ?? 'unexpected result'}`);

  const report = useMemo(() => [
    `Summary: ${summary}`,
    `Environment: ${run.environment} · Build ${run.build} · ${item.config}`,
    `Found by: ${item.caseKey} in ${run.key} (${run.name})`,
    '',
    'Steps to reproduce:',
    ...item.steps.slice(0, upTo).map((st, i) => `${i + 1}. ${st.action}${st.data ? ` [${st.data}]` : ''}`),
    '',
    `Expected: ${failedAt === -1 ? '—' : item.steps[failedAt]!.expected}`,
    `Actual: ${failedAt === -1 ? '—' : item.actuals[failedAt] ?? '—'}`,
    item.evidence.length ? `Evidence: ${item.evidence.map((e) => e.fileName).join(', ')}` : '',
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n'), [summary, item, run, upTo, failedAt]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      notify('Bug report copied');
    } catch {
      notify('Copy failed; select the text and copy it manually', 'bad');
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal center" style={{ width: 760 }} role="dialog" aria-label="Log bug">
        <div className="row" style={{ height: 50, padding: '0 12px 0 18px', borderBottom: '1px solid var(--border)', gap: 10 }}>
          <span style={{ color: 'var(--failed)', display: 'flex' }}><Icon name="bug" size={18} /></span>
          <span className="cond" style={{ fontSize: 16, fontWeight: 600 }}>Log bug</span>
          <span className="t3" style={{ fontSize: 12 }}>from {item.caseKey}</span>
          <div className="f1" />
          <button className="ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="banner info"><Icon name="info" /><div>Creating the issue in Jira, with a duplicate check, arrives in M2. For now, copy this report into Jira.</div></div>
          <div className="field"><label htmlFor="bug-sum">Summary</label><input id="bug-sum" className="inp" style={{ height: 32 }} value={summary} onChange={(e) => setSummary(e.target.value)} /></div>
          <div className="field"><label htmlFor="bug-body">Report</label><textarea id="bug-body" className="inp mono" style={{ fontSize: 11.5 }} rows={12} readOnly value={report} /></div>
        </div>
        <div className="row" style={{ height: 54, padding: '0 16px', borderTop: '1px solid var(--border)' }}>
          <div className="f1" />
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={copy}><Icon name="doc" size={14} />Copy report</button>
        </div>
      </div>
    </>
  );
}
