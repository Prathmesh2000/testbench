'use client';

import { SEVERITIES, type DefectRow, type JiraConnection, type RunItemDetail, type RunSummary, type Severity, type SimilarDefect } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { JiraStatus } from '../defects/defect-bits';

/**
 * Log bug (HLD §5.4): a Jira bug prefilled from the executed steps, with a duplicate check first.
 * Picking a likely duplicate links this run item to that bug instead of creating another one.
 */
export function LogBugDialog({ item, run, onClose }: { item: RunItemDetail; run: RunSummary; onClose(): void }) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const failedAt = item.stepStatus.findIndex((st) => st === 'failed' || st === 'blocked');
  const upTo = failedAt === -1 ? item.steps.length : failedAt + 1;
  const [summary, setSummary] = useState(failedAt === -1 ? item.title : `${item.steps[failedAt]!.action}: ${item.actuals[failedAt] ?? 'unexpected result'}`.slice(0, 250));
  const [severity, setSeverity] = useState<Severity>(item.priority === 'P0' ? 'Critical' : 'Major');
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [debounced, setDebounced] = useState(summary);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every file is attached unless the tester unticks it (a screenshot may show data that shouldn't leave).
  const [attach, setAttach] = useState<Set<string>>(() => new Set(item.evidence.map((e) => e.id)));
  const jira = useQuery({ queryKey: ['me-jira'], queryFn: () => get<JiraConnection | null>('/me/jira'), retry: false });
  const notConnected = jira.isSuccess && (!jira.data || jira.data.status !== 'active');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(summary.trim()), 350);
    return () => clearTimeout(t);
  }, [summary]);

  const similar = useQuery({
    queryKey: ['similar-defects', project.id, debounced],
    queryFn: () => get<SimilarDefect[]>(`/projects/${project.id}/defects/similar?summary=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 3,
    retry: false,
  });

  const repro = useMemo(
    () => item.steps.slice(0, upTo).map((st, i) => `${i + 1}. ${st.action}${st.data ? ` [${st.data}]` : ''}`).join('\n'),
    [item.steps, upTo],
  );

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { runId: run.id, itemId: item.id, evidenceIds: [...attach] };
      const defect = duplicate
        ? await api<DefectRow>('POST', `/projects/${project.id}/defects/link`, { ...body, jiraKey: duplicate })
        : await api<DefectRow>('POST', `/projects/${project.id}/defects`, { ...body, summary, severity });
      await queryClient.invalidateQueries({ queryKey: ['defects', project.id] });
      notify(duplicate ? `Linked to ${defect.jiraKey}; the developer is told it was seen again` : `${defect.jiraKey} created in Jira and linked to ${item.caseKey}`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach Jira');
      setSaving(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal center" style={{ width: 1040, height: 700 }} role="dialog" aria-label="Log bug">
        <div className="row" style={{ height: 50, padding: '0 12px 0 18px', borderBottom: '1px solid var(--border)', gap: 10 }}>
          <span style={{ color: 'var(--failed)', display: 'flex' }}><Icon name="bug" size={18} /></span>
          <span className="cond" style={{ fontSize: 16, fontWeight: 600 }}>Log bug</span>
          <span className="t3" style={{ fontSize: 12 }}>from <span className="mono">{item.caseKey}</span> in {run.key}</span>
          <div className="f1" />
          <button className="ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, overflow: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14, borderRight: '1px solid var(--border)', opacity: duplicate ? 0.5 : 1 }}>
            <div className="field"><label htmlFor="bsum">Summary</label><input id="bsum" className="inp" style={{ height: 32, fontSize: 13.5 }} value={summary} onChange={(e) => setSummary(e.target.value)} disabled={!!duplicate} /></div>
            <div className="field">
              <span className="flab">Severity</span>
              <div className="row" style={{ gap: 4 }}>
                {SEVERITIES.map((v) => <button key={v} className={`chip ${severity === v ? 'on' : ''}`} onClick={() => setSeverity(v)} disabled={!!duplicate}>{v}</button>)}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <div className="field"><span className="flab">Environment</span><div className="inp row" style={{ gap: 6 }}><span className="dot ok" />{run.environment}</div></div>
              <div className="field"><span className="flab">Build</span><div className="inp row mono">{run.build}</div></div>
              <div className="field"><span className="flab">Configuration</span><div className="inp row trunc">{item.config}</div></div>
            </div>
            <div className="field"><label htmlFor="brepro">Steps to reproduce <span className="t3" style={{ fontWeight: 400 }}>· from the executed steps</span></label><textarea id="brepro" className="inp mono" rows={Math.min(8, upTo + 1)} style={{ fontSize: 11.5 }} readOnly value={repro} /></div>
            {failedAt !== -1 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                <div className="field"><span className="flab">Expected</span><div className="inp" style={{ height: 'auto', minHeight: 56, padding: 8, lineHeight: 1.45, color: 'var(--text2)' }}>{item.steps[failedAt]!.expected || '—'}</div></div>
                <div className="field"><span className="flab">Actual</span><div className="inp" style={{ height: 'auto', minHeight: 56, padding: 8, lineHeight: 1.45, background: 'var(--failed-soft)', borderColor: 'transparent' }}>{item.actuals[failedAt] ?? '—'}</div></div>
              </div>
            )}
            {item.evidence.length > 0 && (
              <div className="field">
                <span className="flab">Attach to the Jira issue <span className="t3" style={{ fontWeight: 400 }}>· untick anything that shouldn&apos;t leave Testbench</span></span>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {item.evidence.map((e) => (
                    <label key={e.id} className="pill" style={{ height: 24, gap: 6, cursor: 'pointer', opacity: attach.has(e.id) ? 1 : 0.55 }}>
                      <input
                        type="checkbox"
                        className="cb"
                        checked={attach.has(e.id)}
                        onChange={() => setAttach((prev) => { const next = new Set(prev); if (next.has(e.id)) next.delete(e.id); else next.add(e.id); return next; })}
                        aria-label={`Attach ${e.fileName}`}
                      />
                      <Icon name="paperclip" size={12} />{e.fileName}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div style={{ width: 390, flex: 'none', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
            <div className="row" style={{ height: 42, padding: '0 14px', borderBottom: '1px solid var(--soft)' }}>
              <b style={{ fontSize: 12.5 }}>Possible duplicates{similar.data ? ` (${similar.data.length})` : ''}</b>
              <div className="f1" />
              {similar.isFetching ? <Icon name="refresh" size={12} className="spin t3" /> : <span className="t3" style={{ fontSize: 11.5 }}>by text similarity</span>}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {similar.data?.length === 0 && <div className="t3" style={{ fontSize: 12.5, padding: 8 }}>No open bug looks like this one. It will be created as new.</div>}
              {similar.error && <div className="t3" style={{ fontSize: 12.5, padding: 8 }}>{similar.error instanceof ApiError ? similar.error.message : 'Duplicate check unavailable.'}</div>}
              {similar.data?.map((d) => (
                <label key={d.jiraKey} className="row" style={{ gap: 10, padding: '10px 12px', border: `1px solid ${duplicate === d.jiraKey ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, cursor: 'pointer', background: duplicate === d.jiraKey ? 'var(--accent-soft)' : 'var(--panel)', alignItems: 'flex-start' }}>
                  <input type="checkbox" className="cb" style={{ marginTop: 2 }} checked={duplicate === d.jiraKey} onChange={() => setDuplicate(duplicate === d.jiraKey ? null : d.jiraKey)} aria-label={`Link to ${d.jiraKey}`} />
                  <div className="f1 col" style={{ gap: 4 }}>
                    <div className="row" style={{ gap: 6 }}><span className="mono">{d.jiraKey}</span><JiraStatus status={d.status} category={d.statusCategory} /><div className="f1" /><span className="mono" style={{ fontSize: 11.5, fontWeight: 500, color: d.similarity >= 60 ? 'var(--failed)' : 'var(--text2)' }}>{d.similarity}%</span></div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>{d.summary}</div>
                    {d.known && <div className="t3" style={{ fontSize: 11 }}>Already linked to cases in {project.key}</div>}
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="row" style={{ height: 54, padding: '0 16px', borderTop: '1px solid var(--border)', gap: 8 }}>
          {notConnected ? (
            <span className="err">Bugs are created as you in Jira. <Link href="/settings#jira" onClick={onClose}>Connect your Jira account</Link> first.</span>
          ) : error ? <span className="err">{error}</span> : <span className="t3" style={{ fontSize: 12 }}>Created in Jira as {jira.data?.displayName ?? 'you'} and linked to <span className="mono">{item.caseKey}</span>; the result stays as recorded.</span>}
          <div className="f1" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={saving || notConnected || (!duplicate && summary.trim().length < 5)}>
            {saving ? 'Talking to Jira…' : duplicate ? `Link to ${duplicate}` : 'Create in Jira'}
          </button>
        </div>
      </div>
    </>
  );
}
