'use client';

import type { ApiNode, ApiSuite, ApiWorkflowSummary, SuiteBody, SuiteItem, SuiteRun, SuiteTrend } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago, dateTimeIST } from '@/lib/format';
import { METHOD_SHORT } from './model';
import s from './apistudio.module.css';

// Suites (plan §13, §15): what runs together, when, and how it went.

const EMPTY: SuiteBody = {
  name: '',
  items: [],
  settings: { environmentId: null, dataSetId: null, parallel: 1, retries: 0, stopOnFail: false, delayMs: 0, failOnDrift: false },
  schedule: { cron: null, monitor: null, onSpecChange: false },
};
const STATUS_COLOUR: Record<string, string> = { passed: 'var(--passed)', failed: 'var(--failed)', error: 'var(--failed)', cancelled: 'var(--text3)', running: 'var(--accent)' };

export function SuiteView({ base, projectBase, workspaceId, suiteId, nodes, environments, canEdit, onDeleted }: {
  base: string;
  projectBase: string;
  workspaceId: string;
  suiteId: string;
  nodes: ApiNode[];
  environments: { id: string; name: string }[];
  canEdit: boolean;
  onDeleted(): void;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const url = `${base}/suites/${suiteId}`;
  const suite = useQuery({ queryKey: ['apitest', 'suite', suiteId], queryFn: () => get<ApiSuite>(url) });
  const runs = useQuery({ queryKey: ['apitest', 'suite-runs', suiteId], queryFn: () => get<SuiteRun[]>(`${url}/runs`) });
  const [runId, setRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<'runs' | 'setup' | 'trend'>('runs');
  useEffect(() => setRunId(runs.data?.[0]?.id ?? null), [runs.data?.[0]?.id]);
  const run = useQuery({
    queryKey: ['apitest', 'suite-run', runId],
    queryFn: () => get<SuiteRun>(`${url}/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  });
  useEffect(() => {
    // When a run finishes, the list and the sidebar show its final status.
    if (run.data && run.data.status !== 'running') {
      queryClient.invalidateQueries({ queryKey: ['apitest', 'suite-runs', suiteId] });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'suites', workspaceId] });
    }
  }, [run.data?.status]);

  if (suite.error) return <div className="empty t3" style={{ flex: 1 }}>{suite.error instanceof ApiError ? suite.error.message : 'Could not load the suite.'}</div>;
  if (!suite.data) return <div className="empty t3" style={{ flex: 1 }}>Loading…</div>;
  const d = suite.data;

  const start = async () => {
    try {
      const r = await api<SuiteRun>('POST', `${url}/runs`, {});
      setRunId(r.id);
      setTab('runs');
      queryClient.invalidateQueries({ queryKey: ['apitest', 'suite-runs', suiteId] });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not start the run', 'bad');
    }
  };
  const cancel = async () => {
    if (!runId) return;
    await api('POST', `${url}/runs/${runId}/cancel`);
    run.refetch();
  };
  const remove = async () => {
    if (!window.confirm(`Delete the suite "${d.name}" and its runs?`)) return;
    await api('DELETE', url);
    queryClient.invalidateQueries({ queryKey: ['apitest', 'suites', workspaceId] });
    onDeleted();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className={s.bar}>
        <h2 style={{ margin: 0, fontSize: 15 }}>{d.name}</h2>
        <span className="t3" style={{ fontSize: 12 }}>
          {d.items.length} item{d.items.length === 1 ? '' : 's'}
          {d.schedule.cron && ` · runs on "${d.schedule.cron}" (IST)`}
          {d.schedule.monitor && ` · monitor every ${d.schedule.monitor.everyMinutes} min`}
          {d.nextRunAt && ` · next ${dateTimeIST(d.nextRunAt)}`}
        </span>
        <div className="f1" />
        {canEdit && run.data?.status === 'running' && <button className="btn" onClick={cancel}>Stop</button>}
        {canEdit && <button className="btn primary" onClick={start} disabled={run.data?.status === 'running'}><Icon name="play" size={12} />Run</button>}
        {canEdit && <button className="btn ghost danger" onClick={remove} aria-label="Delete suite"><Icon name="x" size={13} /></button>}
      </div>
      <div className={`tabs ${s.editorTabs}`} role="tablist" aria-label="Suite">
        {(['runs', 'trend', 'setup'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{{ runs: 'Runs', trend: 'Trend', setup: 'Set up' }[t]}</button>
        ))}
      </div>
      <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
        {tab === 'setup' && <SuiteEditor key={d.updatedAt} base={base} projectBase={projectBase} workspaceId={workspaceId} suite={d} nodes={nodes} environments={environments} canEdit={canEdit} />}
        {tab === 'trend' && <TrendPanel url={url} />}
        {tab === 'runs' && (
          <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', minHeight: '100%' }}>
            <div style={{ borderRight: '1px solid var(--border)' }}>
              {runs.data?.map((r) => (
                <button key={r.id} className={`${s.row} ${runId === r.id ? s.on : ''}`} style={{ height: 'auto', padding: '6px 10px', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }} onClick={() => setRunId(r.id)}>
                  <span style={{ color: STATUS_COLOUR[r.status], fontWeight: 600, fontSize: 12 }}>{r.status}</span>
                  <span className="t3" style={{ fontSize: 11.5 }}>{r.trigger} · {ago(r.startedAt)}</span>
                  <span className="t2" style={{ fontSize: 11.5 }}>{r.totals.passed + r.totals.flaky}/{r.totals.total} passed{r.totals.flaky ? ` · ${r.totals.flaky} flaky` : ''}</span>
                </button>
              ))}
              {runs.data?.length === 0 && <div className="t3" style={{ padding: 12, fontSize: 12.5 }}>No runs yet.</div>}
            </div>
            <div>{run.data ? <RunDetail base={base} url={url} suiteName={d.name} run={run.data} canEdit={canEdit} /> : <div className="empty t3" style={{ padding: 24 }}>Run the suite to see results here.</div>}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function RunDetail({ base, url, suiteName, run, canEdit }: { base: string; url: string; suiteName: string; run: SuiteRun; canEdit: boolean }) {
  const { notify } = useToast();
  const t = run.totals;
  const bug = async (r: SuiteRun['results'][number]) => {
    if (!r.historyId) return;
    const summary = window.prompt('Bug summary', `${r.name} fails: ${r.message.slice(0, 120)}`);
    if (!summary?.trim()) return;
    try {
      const d = await api<{ jiraKey: string }>('POST', `${base}/history/${r.historyId}/bug`, { summary: summary.trim(), failures: [r.message], found: `suite ${suiteName}` });
      notify(`Logged ${d.jiraKey} in Jira`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not log the bug', 'bad');
    }
  };
  return (
    <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
        <b style={{ color: STATUS_COLOUR[run.status] }}>{run.status === 'running' ? <><span className="spin" /> Running</> : run.status}</b>
        <span>{t.total} results</span>
        <span className={s.pass}>{t.passed} passed</span>
        {t.flaky > 0 && <span style={{ color: 'var(--blocked)' }}>{t.flaky} flaky</span>}
        {t.failed + t.errored > 0 && <span className={s.fail}>{t.failed + t.errored} failed</span>}
        {t.skipped > 0 && <span className="t3">{t.skipped} skipped</span>}
        <span className="t2">p50 {t.p50Ms} ms · p95 {t.p95Ms} ms</span>
        {t.drift > 0 && <span className={s.fail}>{t.drift} differences from the spec</span>}
        <div className="f1" />
        <a className="btn sm" href={`/api/core${url}/runs/${run.id}/junit`}>JUnit</a>
        <a className="btn sm" href={`/api/core${url}/runs/${run.id}/report`}>HTML report</a>
      </div>
      {run.error && <div className="err">{run.error}</div>}
      <table className="tbl">
        <thead><tr><th>Result</th><th>Test</th><th>Status</th><th>Time</th><th>Tries</th><th>Message</th><th /></tr></thead>
        <tbody>
          {run.results.map((r, i) => (
            <tr key={i}>
              <td style={{ color: r.flaky ? 'var(--blocked)' : STATUS_COLOUR[r.status] ?? 'var(--text3)', fontWeight: 600 }}>{r.flaky ? 'flaky' : r.status}</td>
              <td style={{ whiteSpace: 'normal' }}>
                {r.method && <span className="mono t2" style={{ fontSize: 11, marginRight: 6 }}>{METHOD_SHORT[r.method]}</span>}
                {r.name}{r.row !== null && <span className="t3"> · row {r.row + 1}</span>}
                <div className="t3" style={{ fontSize: 11 }}>{r.group}{r.driftIssues ? ` · ${r.driftIssues} spec differences` : ''}</div>
              </td>
              <td className="mono">{r.httpStatus ?? ''}</td>
              <td>{r.durationMs} ms</td>
              <td>{r.attempts}</td>
              <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{r.message}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.historyId && <a className="btn ghost sm" href={`/api?side=history&h=${r.historyId}`}>History</a>}
                {canEdit && r.historyId && (r.status === 'failed' || r.status === 'error') && <button className="btn ghost sm" onClick={() => bug(r)}><Icon name="bug" size={12} />Log bug</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Pass rate per run as one series of bars, with the numbers in the table below it. */
function TrendPanel({ url }: { url: string }) {
  const t = useQuery({ queryKey: ['apitest', 'suite-trend', url], queryFn: () => get<SuiteTrend>(`${url}/trend`) });
  const [hover, setHover] = useState<number | null>(null);
  if (!t.data) return <div className="t3" style={{ padding: 16 }}>Loading…</div>;
  const runs = t.data.runs;
  if (!runs.length) return <div className="t3" style={{ padding: 16 }}>Finished runs show here.</div>;
  const W = 640;
  const H = 140;
  const bw = Math.max(6, Math.min(28, W / runs.length - 2));
  const h = hover === null ? null : runs[hover]!;
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <b style={{ fontSize: 13 }}>Pass rate per run</b>
        <span className="t3" style={{ fontSize: 12 }}> · last {runs.length} runs, oldest first{h ? ` · ${dateTimeIST(h.startedAt)}: ${h.passRate}% (${h.status}, ${h.trigger}, p95 ${h.p95Ms} ms${h.flaky ? `, ${h.flaky} flaky` : ''})` : ''}</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Pass rate per run" style={{ maxWidth: W }}>
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--border)" strokeWidth={1} />
        <line x1={0} x2={W} y1={0} y2={0} stroke="var(--soft)" strokeWidth={1} />
        <text x={W} y={10} textAnchor="end" fontSize={10} fill="var(--text3)">100%</text>
        {runs.map((r, i) => {
          const x = i * (bw + 2);
          const bh = Math.max(2, (r.passRate / 100) * (H - 14));
          return (
            <g key={r.id} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={0} width={bw + 2} height={H} fill="transparent" />
              <path d={`M${x},${H} V${H - bh + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${H} Z`} fill="var(--accent)" opacity={hover === null || hover === i ? 1 : 0.45} />
              {r.status !== 'passed' && <text x={x + bw / 2} y={H + 13} textAnchor="middle" fontSize={10} fill="var(--text2)">✕</text>}
            </g>
          );
        })}
      </svg>
      <span className="t3" style={{ fontSize: 12 }}>✕ under a bar: that run did not pass.</span>
      <b style={{ fontSize: 13 }}>Least reliable requests</b>
      <table className="tbl">
        <thead><tr><th>Request</th><th>Runs</th><th>Failures</th><th>Flaky</th><th>p95</th></tr></thead>
        <tbody>
          {t.data.requests.map((r) => (
            <tr key={r.key}><td>{r.name}</td><td>{r.runs}</td><td style={{ color: r.failures ? 'var(--failed)' : undefined }}>{r.failures}</td><td>{r.flaky}</td><td>{r.p95Ms} ms</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SuiteEditor({ base, projectBase, workspaceId, suite, nodes, environments, canEdit }: {
  base: string;
  projectBase: string;
  workspaceId: string;
  suite: ApiSuite | null;
  nodes: ApiNode[];
  environments: { id: string; name: string }[];
  canEdit: boolean;
  onSaved?(id: string): void;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [draft, setDraft] = useState<SuiteBody>(suite ? { name: suite.name, items: suite.items, settings: suite.settings, schedule: suite.schedule } : EMPTY);
  const [error, setError] = useState<string | null>(null);
  const workflows = useQuery({ queryKey: ['apitest', 'workflows', workspaceId], queryFn: () => get<ApiWorkflowSummary[]>(`${base}/workflows`) });
  const dataSets = useQuery({ queryKey: ['data-sets', projectBase], queryFn: () => get<{ id: string; name: string; rowCount: number }[]>(`${projectBase.replace('/apitest', '')}/data-sets`) });
  const has = (pred: (i: SuiteItem) => boolean) => draft.items.some(pred);
  const toggle = (item: SuiteItem, on: boolean, same: (i: SuiteItem) => boolean) =>
    setDraft({ ...draft, items: on ? [...draft.items, item] : draft.items.filter((i) => !same(i)) });
  const containers = useMemo(() => nodes.filter((n) => n.kind !== 'request'), [nodes]);
  const requests = useMemo(() => nodes.filter((n) => n.kind === 'request'), [nodes]);
  const set = <K extends keyof SuiteBody['settings']>(k: K, v: SuiteBody['settings'][K]) => setDraft({ ...draft, settings: { ...draft.settings, [k]: v } });

  const save = async () => {
    setError(null);
    try {
      if (suite) await api('PUT', `${base}/suites/${suite.id}`, draft);
      queryClient.invalidateQueries({ queryKey: ['apitest', 'suite', suite?.id] });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'suites', workspaceId] });
      notify('Saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };
  const ci = suite ? `curl -s -X POST -H "Authorization: Bearer $TESTBENCH_TOKEN" -H "content-type: application/json" \\\n  -d '{"wait": true}' ${typeof window === 'undefined' ? '' : window.location.origin}/api/core${base}/suites/${suite.id}/runs | jq -e '.status == "passed"'` : '';

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 880 }}>
      <label className="field"><span className="flab">Name</span><input className="inp" value={draft.name} readOnly={!canEdit} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <section>
        <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>What runs</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="panel" style={{ padding: 8, maxHeight: 260, overflow: 'auto' }}>
            <div className="flab">Folders and collections (every request inside, with its variations)</div>
            {containers.map((c) => (
              <label key={c.id} style={{ display: 'flex', gap: 6, fontSize: 12.5, padding: '2px 0' }}>
                <input type="checkbox" disabled={!canEdit} checked={has((i) => i.kind === 'folder' && i.nodeId === c.id)} onChange={(e) => toggle({ kind: 'folder', nodeId: c.id }, e.target.checked, (i) => i.kind === 'folder' && i.nodeId === c.id)} />
                {c.kind === 'collection' ? <b>{c.name}</b> : c.name}
              </label>
            ))}
            <div className="flab" style={{ marginTop: 8 }}>Single requests (with all their variations)</div>
            {requests.map((r) => (
              <label key={r.id} style={{ display: 'flex', gap: 6, fontSize: 12.5, padding: '2px 0' }}>
                <input type="checkbox" disabled={!canEdit} checked={has((i) => (i.kind === 'request_all' || i.kind === 'request') && i.requestId === r.id)} onChange={(e) => toggle({ kind: 'request_all', requestId: r.id }, e.target.checked, (i) => (i.kind === 'request_all' || i.kind === 'request') && i.requestId === r.id)} />
                <span className="mono t2" style={{ fontSize: 11 }}>{METHOD_SHORT[r.method ?? 'GET']}</span>{r.name}{r.variationCount ? <span className="t3"> +{r.variationCount}</span> : null}
              </label>
            ))}
          </div>
          <div className="panel" style={{ padding: 8, maxHeight: 260, overflow: 'auto' }}>
            <div className="flab">Workflows</div>
            {workflows.data?.map((w) => (
              <label key={w.id} style={{ display: 'flex', gap: 6, fontSize: 12.5, padding: '2px 0' }}>
                <input type="checkbox" disabled={!canEdit} checked={has((i) => i.kind === 'workflow' && i.workflowId === w.id)} onChange={(e) => toggle({ kind: 'workflow', workflowId: w.id }, e.target.checked, (i) => i.kind === 'workflow' && i.workflowId === w.id)} />
                {w.name}
              </label>
            ))}
            {workflows.data?.length === 0 && <div className="t3" style={{ fontSize: 12 }}>No workflows in this workspace.</div>}
          </div>
        </div>
      </section>
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        <label className="field"><span className="flab">Environment</span>
          <select className="inp" value={draft.settings.environmentId ?? ''} disabled={!canEdit} onChange={(e) => set('environmentId', e.target.value || null)}>
            <option value="">No environment</option>
            {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className="field"><span className="flab">Data set (one run per row)</span>
          <select className="inp" value={draft.settings.dataSetId ?? ''} disabled={!canEdit} onChange={(e) => set('dataSetId', e.target.value || null)}>
            <option value="">None</option>
            {dataSets.data?.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.rowCount} rows)</option>)}
          </select>
        </label>
        <label className="field"><span className="flab">At the same time (1–10)</span><input className="inp" type="number" min={1} max={10} value={draft.settings.parallel} readOnly={!canEdit} onChange={(e) => set('parallel', Math.min(10, Math.max(1, Number(e.target.value) || 1)))} /></label>
        <label className="field"><span className="flab">Retries on failure (0–3)</span><input className="inp" type="number" min={0} max={3} value={draft.settings.retries} readOnly={!canEdit} onChange={(e) => set('retries', Math.min(3, Math.max(0, Number(e.target.value) || 0)))} /></label>
        <label className="field"><span className="flab">Pause between requests (ms)</span><input className="inp" type="number" min={0} max={10000} value={draft.settings.delayMs} readOnly={!canEdit} onChange={(e) => set('delayMs', Math.max(0, Number(e.target.value) || 0))} /></label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, paddingTop: 16 }}>
          <label><input type="checkbox" checked={draft.settings.stopOnFail} disabled={!canEdit} onChange={(e) => set('stopOnFail', e.target.checked)} /> Stop at the first failure</label>
          <label><input type="checkbox" checked={draft.settings.failOnDrift} disabled={!canEdit} onChange={(e) => set('failOnDrift', e.target.checked)} /> Fail when a response differs from the spec</label>
        </div>
      </section>
      <section>
        <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>When it runs</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <label className="field"><span className="flab">Schedule (cron, IST)</span><input className="inp mono" placeholder="0 2 * * *  (02:00 daily)" value={draft.schedule.cron ?? ''} readOnly={!canEdit} onChange={(e) => setDraft({ ...draft, schedule: { ...draft.schedule, cron: e.target.value.trim() || null } })} /></label>
          <label className="field"><span className="flab">Monitor every (minutes, 5–60)</span><input className="inp" type="number" min={5} max={60} placeholder="off" value={draft.schedule.monitor?.everyMinutes ?? ''} readOnly={!canEdit} onChange={(e) => setDraft({ ...draft, schedule: { ...draft.schedule, monitor: e.target.value ? { everyMinutes: Math.min(60, Math.max(5, Number(e.target.value))), maxP95Ms: draft.schedule.monitor?.maxP95Ms ?? null } : null } })} /></label>
          <label className="field"><span className="flab">Alert when p95 is above (ms)</span><input className="inp" type="number" min={10} disabled={!draft.schedule.monitor} value={draft.schedule.monitor?.maxP95Ms ?? ''} readOnly={!canEdit} onChange={(e) => draft.schedule.monitor && setDraft({ ...draft, schedule: { ...draft.schedule, monitor: { ...draft.schedule.monitor, maxP95Ms: e.target.value ? Number(e.target.value) : null } } })} /></label>
        </div>
        <label style={{ fontSize: 12.5, display: 'block', marginTop: 6 }}><input type="checkbox" checked={draft.schedule.onSpecChange} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, schedule: { ...draft.schedule, onSpecChange: e.target.checked } })} /> Run when a spec its requests use gets a new version</label>
        <div className="t3" style={{ fontSize: 12, marginTop: 4 }}>Scheduled and monitor runs act as you: your cookies, sessions and access. Monitor failures and slow runs raise an "API monitor failed" event your notification rules can send to Slack, email or Teams.</div>
      </section>
      {suite && (
        <section>
          <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>From CI</h3>
          <pre className={s.pre} style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--field)' }}>{ci}</pre>
          <div className="t3" style={{ fontSize: 12 }}>Make a personal access token in Settings. The call waits for the run and returns it; JUnit for your CI is at …/runs/&lt;run id&gt;/junit.</div>
        </section>
      )}
      {error && <div className="err" role="alert">{error}</div>}
      {canEdit && suite && <div><button className="btn primary" onClick={save}>Save suite</button></div>}
    </div>
  );
}

/** Makes a suite from a name and the items picked, then opens it on its setup tab. */
export async function newSuite(base: string, name: string, nodes: ApiNode[]): Promise<ApiSuite> {
  const firstCollection = nodes.find((n) => n.kind === 'collection');
  if (!firstCollection) throw new ApiError(400, 'no_items', 'Make a collection with requests first.');
  return api<ApiSuite>('POST', `${base}/suites`, { ...EMPTY, name, items: [{ kind: 'folder', nodeId: firstCollection.id }] });
}
