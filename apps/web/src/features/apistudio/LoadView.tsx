'use client';

import { LOAD_LIMITS, LOAD_PROFILES, type ApiLoadTest, type ApiNode, type ApiSuite, type ApiWorkflowSummary, type LoadProfile, type LoadRunView, type LoadSecond, type LoadSource, type LoadTestBody } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { dateTimeIST } from '@/lib/format';
import { METHOD_SHORT } from './model';
import s from './apistudio.module.css';

// Load tests (plan §14): the same requests sent by many virtual users, with what that did to latency.

const PROFILE_HELP: Record<LoadProfile, string> = {
  smoke: 'One or two users for the whole time: does it work at all.',
  load: 'Ramp up, hold at the peak, ramp down: the traffic you expect.',
  stress: 'Climb in four steps to the peak: where does it start to hurt.',
  spike: 'Quiet, then a sudden jump to the peak, then quiet: does it recover.',
  soak: 'Hold the peak for a long time: leaks and slow decay.',
};
const STATUS_COLOUR: Record<string, string> = { passed: 'var(--passed)', failed: 'var(--failed)', error: 'var(--failed)', aborted: 'var(--failed)', cancelled: 'var(--text3)', running: 'var(--accent)' };

export async function newLoadTest(base: string, name: string, nodes: ApiNode[], environments: { id: string }[]): Promise<ApiLoadTest> {
  const request = nodes.find((n) => n.kind === 'request');
  if (!request) throw new ApiError(400, 'no_items', 'Make a request first: a load test sends requests.');
  if (!environments[0]) throw new ApiError(400, 'no_env', 'Make an environment first (workspace settings): it says which server to send to.');
  const body: LoadTestBody = {
    name,
    source: [{ kind: 'request', requestId: request.id, variationId: null }],
    environmentId: environments[0].id,
    dataSetId: null,
    profile: 'smoke',
    vus: 5,
    seconds: 30,
    thresholds: { p95Ms: 800, errorPercent: 1, minRps: null },
    abort: { errorPercent: 50, p95Ms: null },
  };
  return api<ApiLoadTest>('POST', `${base}/load-tests`, body);
}

export function LoadView({ base, projectBase, workspaceId, testId, nodes, environments, canEdit, canOverride, onDeleted }: {
  base: string;
  projectBase: string;
  workspaceId: string;
  testId: string;
  nodes: ApiNode[];
  environments: { id: string; name: string }[];
  canEdit: boolean;
  canOverride: boolean;
  onDeleted(): void;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const url = `${base}/load-tests/${testId}`;
  const test = useQuery({ queryKey: ['apitest', 'load-test', testId], queryFn: () => get<ApiLoadTest>(url) });
  const runs = useQuery({ queryKey: ['apitest', 'load-runs', testId], queryFn: () => get<LoadRunView[]>(`${url}/runs`) });
  const [runId, setRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<'results' | 'setup'>('results');
  useEffect(() => setRunId(runs.data?.[0]?.id ?? null), [runs.data?.[0]?.id]);
  const run = useQuery({
    queryKey: ['apitest', 'load-run', runId],
    queryFn: () => get<LoadRunView>(`${url}/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });
  useEffect(() => {
    if (run.data && run.data.status !== 'running') {
      queryClient.invalidateQueries({ queryKey: ['apitest', 'load-runs', testId] });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'load-tests', workspaceId] });
    }
  }, [run.data?.status]);

  if (test.error) return <div className="empty t3" style={{ flex: 1 }}>{test.error instanceof ApiError ? test.error.message : 'Could not load the load test.'}</div>;
  if (!test.data) return <div className="empty t3" style={{ flex: 1 }}>Loading…</div>;
  const d = test.data;
  const running = run.data?.status === 'running';

  const start = async () => {
    const send = (productionOverride: boolean) => api<LoadRunView>('POST', `${url}/runs`, { productionOverride });
    try {
      let r: LoadRunView;
      try {
        r = await send(false);
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'production_guard' || !canOverride) throw err;
        if (!window.confirm(`${err.message}\n\nSend this load to production anyway? It is recorded in the audit log with your name.`)) return;
        r = await send(true);
      }
      queryClient.setQueryData(['apitest', 'load-run', r.id], r);
      setRunId(r.id);
      setTab('results');
      queryClient.invalidateQueries({ queryKey: ['apitest', 'load-runs', testId] });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not start the run', 'bad');
    }
  };
  const stop = async () => {
    if (!runId) return;
    await api('POST', `${url}/runs/${runId}/cancel`);
    run.refetch();
  };
  const remove = async () => {
    if (!window.confirm(`Delete the load test "${d.name}" and its runs?`)) return;
    await api('DELETE', url);
    queryClient.invalidateQueries({ queryKey: ['apitest', 'load-tests', workspaceId] });
    onDeleted();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className={s.bar}>
        <h2 style={{ margin: 0, fontSize: 15 }}>{d.name}</h2>
        <span className="t3" style={{ fontSize: 12 }}>{d.body.profile} · up to {d.body.vus} users · {d.body.seconds} s</span>
        <div className="f1" />
        <a className="btn sm" href={`/api/core${url}/k6`} download={`${d.name.replace(/[^\w-]+/g, '-')}.k6.js`} title="The same test as a script for k6, to run with more capacity than Testbench has">k6 script</a>
        {canEdit && running && <button className="btn" onClick={stop}>Stop</button>}
        {canEdit && <button className="btn primary" onClick={start} disabled={running}><Icon name="play" size={12} />Run</button>}
        {canEdit && <button className="btn ghost danger" onClick={remove} aria-label="Delete load test"><Icon name="x" size={13} /></button>}
      </div>
      <div className={`tabs ${s.editorTabs}`} role="tablist" aria-label="Load test">
        {(['results', 'setup'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{{ results: 'Results', setup: 'Set up' }[t]}</button>
        ))}
      </div>
      <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
        {tab === 'setup' && <LoadEditor key={d.updatedAt} base={base} projectBase={projectBase} workspaceId={workspaceId} test={d} nodes={nodes} environments={environments} canEdit={canEdit} />}
        {tab === 'results' && (
          <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0, 1fr)', minHeight: '100%' }}>
            <div style={{ borderRight: '1px solid var(--border)' }}>
              {runs.data?.map((r) => (
                <button key={r.id} className={`${s.row} ${runId === r.id ? s.on : ''}`} style={{ height: 'auto', padding: '8px 12px', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} onClick={() => setRunId(r.id)}>
                  <b style={{ color: STATUS_COLOUR[r.status] }}>{r.status}</b>
                  <span className="t3" style={{ fontSize: 11.5 }}>{dateTimeIST(r.startedAt)} · p95 {r.metrics.p95} ms · {r.metrics.rps}/s</span>
                </button>
              ))}
              {runs.data?.length === 0 && <div className="t3" style={{ padding: 14, fontSize: 12.5 }}>No runs yet. Run it to see how the API holds up.</div>}
            </div>
            <div style={{ minWidth: 0 }}>{run.data ? <RunResults run={run.data} /> : <div className="t3" style={{ padding: 16 }}>{runs.data?.length ? 'Loading…' : ''}</div>}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div style={{ border: '1px solid var(--soft)', borderRadius: 'var(--r-sm)', padding: '6px 10px', minWidth: 92 }}>
      <div className="t3" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 600, color: tone === 'bad' ? 'var(--failed)' : undefined }}>{value}</div>
    </div>
  );
}

function RunResults({ run }: { run: LoadRunView }) {
  const m = run.metrics;
  const c = run.compare;
  const delta = (n: number, unit: string, worseWhenUp: boolean) => {
    if (!n) return <span className="t3">no change</span>;
    const worse = worseWhenUp ? n > 0 : n < 0;
    return <span style={{ color: worse ? 'var(--failed)' : 'var(--passed)' }}>{n > 0 ? '+' : ''}{n}{unit}</span>;
  };
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
        <b style={{ color: STATUS_COLOUR[run.status] }}>{run.status === 'running' ? <><span className="spin" /> Running</> : run.status}</b>
        <span className="t3">sent to {run.host || '…'} · {dateTimeIST(run.startedAt)}</span>
      </div>
      {run.error && <div className="err" role="alert">{run.error}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Tile label="Requests" value={String(m.requests)} />
        <Tile label="Per second" value={String(m.rps)} />
        <Tile label="p50" value={`${m.p50} ms`} />
        <Tile label="p95" value={`${m.p95} ms`} />
        <Tile label="p99" value={`${m.p99} ms`} />
        <Tile label="Slowest" value={`${m.max} ms`} />
        <Tile label="Failed" value={`${m.errorPercent}%`} tone={m.errors ? 'bad' : undefined} />
      </div>
      {run.verdicts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12.5 }}>
          {run.verdicts.map((v) => (
            <div key={v.name}><span className={v.passed ? s.pass : s.fail} aria-label={v.passed ? 'Met' : 'Missed'}>{v.passed ? '✓' : '✗'}</span> {v.name} <span className="t3">· {v.detail}</span></div>
          ))}
        </div>
      )}
      {c && (
        <div style={{ fontSize: 12.5 }}>
          Against the run before: p95 {delta(c.p95Delta, ' ms', true)} · failures {delta(c.errorDelta, ' points', true)} · requests per second {delta(c.rpsDelta, '', false)}
        </div>
      )}
      {m.timeline.length > 1 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
          <Chart title="Requests per second" points={m.timeline} pick={(p) => p.rps} unit="/s" />
          <Chart title="Latency p95 (ms)" points={m.timeline} pick={(p) => p.p95} unit=" ms" />
        </div>
      )}
      {m.endpoints.length > 0 && (
        <table className="tbl">
          <thead><tr><th>Request</th><th>Requests</th><th>Failed</th><th>p50</th><th>p95</th><th>p99</th><th>Slowest</th></tr></thead>
          <tbody>
            {m.endpoints.map((e) => (
              <tr key={e.key}>
                <td style={{ whiteSpace: 'normal' }}>{e.name}</td>
                <td>{e.requests}</td>
                <td className={e.errors ? s.fail : ''}>{e.errors}</td>
                <td>{e.p50} ms</td>
                <td>{e.p95} ms</td>
                <td>{e.p99} ms</td>
                <td>{e.max} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** One measure over time as a line, with a hover that also says how many users there were. */
function Chart({ title, points, pick, unit }: { title: string; points: LoadSecond[]; pick(p: LoadSecond): number; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 420;
  const H = 120;
  const max = Math.max(1, ...points.map(pick));
  const last = points[points.length - 1]!.t || 1;
  const x = (t: number) => (t / last) * (W - 8) + 4;
  const y = (v: number) => H - 4 - (v / max) * (H - 12);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(' ');
  const h = hover === null ? null : points[hover]!;
  return (
    <div>
      <b style={{ fontSize: 13 }}>{title}</b>
      <span className="t3" style={{ fontSize: 12 }}>{h ? ` · at ${h.t} s: ${pick(h)}${unit}, ${h.vus} users, ${h.errors} failed` : ` · peak ${max}${unit}`}</span>
      <svg width="100%" viewBox={`0 0 ${W} ${H + 16}`} role="img" aria-label={title} style={{ maxWidth: W, display: 'block' }}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const t = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          points.forEach((p, i) => { if (Math.abs(x(p.t) - t) < Math.abs(x(points[best]!.t) - t)) best = i; });
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--border)" strokeWidth={1} />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        {h && <><line x1={x(h.t)} x2={x(h.t)} y1={0} y2={H} stroke="var(--text3)" strokeWidth={1} /><circle cx={x(h.t)} cy={y(pick(h))} r={4} fill="var(--accent)" stroke="var(--panel)" strokeWidth={2} /></>}
        <text x={4} y={H + 12} fontSize={10} fill="var(--text3)">0 s</text>
        <text x={W - 4} y={H + 12} fontSize={10} fill="var(--text3)" textAnchor="end">{last} s</text>
      </svg>
    </div>
  );
}

function LoadEditor({ base, projectBase, workspaceId, test, nodes, environments, canEdit }: {
  base: string;
  projectBase: string;
  workspaceId: string;
  test: ApiLoadTest;
  nodes: ApiNode[];
  environments: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [draft, setDraft] = useState<LoadTestBody>(test.body);
  const [error, setError] = useState<string | null>(null);
  const suites = useQuery({ queryKey: ['apitest', 'suites', workspaceId], queryFn: () => get<ApiSuite[]>(`${base}/suites`) });
  const workflows = useQuery({ queryKey: ['apitest', 'workflows', workspaceId], queryFn: () => get<ApiWorkflowSummary[]>(`${base}/workflows`) });
  const dataSets = useQuery({ queryKey: ['data-sets', projectBase], queryFn: () => get<{ id: string; name: string; rowCount: number }[]>(`${projectBase.replace('/apitest', '')}/data-sets`) });
  const requests = useMemo(() => nodes.filter((n) => n.kind === 'request'), [nodes]);
  const has = (pred: (i: LoadSource) => boolean) => draft.source.some(pred);
  const toggle = (item: LoadSource, on: boolean, same: (i: LoadSource) => boolean) => setDraft({ ...draft, source: on ? [...draft.source, item] : draft.source.filter((i) => !same(i)) });
  const th = (k: keyof LoadTestBody['thresholds'], v: string) => setDraft({ ...draft, thresholds: { ...draft.thresholds, [k]: v === '' ? null : Number(v) } });
  const tooBig = draft.vus > LOAD_LIMITS.vus || draft.seconds > LOAD_LIMITS.seconds;

  const save = async () => {
    setError(null);
    try {
      await api('PUT', `${base}/load-tests/${test.id}`, draft);
      queryClient.invalidateQueries({ queryKey: ['apitest', 'load-test', test.id] });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'load-tests', workspaceId] });
      notify('Saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || min)));

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 880 }}>
      <label className="field"><span className="flab">Name</span><input className="inp" value={draft.name} readOnly={!canEdit} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <section>
        <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>What it sends</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="panel" style={{ padding: 8, maxHeight: 240, overflow: 'auto' }}>
            <div className="flab">Requests</div>
            {requests.map((r) => (
              <label key={r.id} style={{ display: 'flex', gap: 6, fontSize: 12.5, padding: '2px 0' }}>
                <input type="checkbox" disabled={!canEdit} checked={has((i) => i.kind === 'request' && i.requestId === r.id)} onChange={(e) => toggle({ kind: 'request', requestId: r.id, variationId: null }, e.target.checked, (i) => i.kind === 'request' && i.requestId === r.id)} />
                <span className="mono t2" style={{ fontSize: 11 }}>{METHOD_SHORT[r.method ?? 'GET']}</span>{r.name}
              </label>
            ))}
          </div>
          <div className="panel" style={{ padding: 8, maxHeight: 240, overflow: 'auto' }}>
            <div className="flab">Suites (their requests)</div>
            {suites.data?.map((x) => (
              <label key={x.id} style={{ display: 'flex', gap: 6, fontSize: 12.5, padding: '2px 0' }}>
                <input type="checkbox" disabled={!canEdit} checked={has((i) => i.kind === 'suite' && i.suiteId === x.id)} onChange={(e) => toggle({ kind: 'suite', suiteId: x.id }, e.target.checked, (i) => i.kind === 'suite' && i.suiteId === x.id)} />{x.name}
              </label>
            ))}
            <div className="flab" style={{ marginTop: 8 }}>Workflows (their requests, in order)</div>
            {workflows.data?.map((w) => (
              <label key={w.id} style={{ display: 'flex', gap: 6, fontSize: 12.5, padding: '2px 0' }}>
                <input type="checkbox" disabled={!canEdit} checked={has((i) => i.kind === 'workflow' && i.workflowId === w.id)} onChange={(e) => toggle({ kind: 'workflow', workflowId: w.id }, e.target.checked, (i) => i.kind === 'workflow' && i.workflowId === w.id)} />{w.name}
              </label>
            ))}
          </div>
        </div>
        <div className="t3" style={{ fontSize: 12, marginTop: 4 }}>Each user sends them in turn, over and over. Pre-request scripts run once before the test and post scripts do not run, so values a workflow passes from step to step are not carried: use requests that stand on their own.</div>
      </section>
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        <label className="field"><span className="flab">Environment</span>
          <select className="inp" value={draft.environmentId} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, environmentId: e.target.value })}>
            {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className="field"><span className="flab">Data set (rows rotate through the requests)</span>
          <select className="inp" value={draft.dataSetId ?? ''} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, dataSetId: e.target.value || null })}>
            <option value="">None</option>
            {dataSets.data?.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.rowCount} rows)</option>)}
          </select>
        </label>
        <label className="field"><span className="flab">Shape</span>
          <select className="inp" value={draft.profile} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, profile: e.target.value as LoadProfile })}>
            {LOAD_PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="field"><span className="flab">Most users at once</span><input className="inp" type="number" min={1} value={draft.vus} readOnly={!canEdit} onChange={(e) => setDraft({ ...draft, vus: num(e.target.value, 1, 10_000) })} /></label>
        <label className="field"><span className="flab">Duration (seconds)</span><input className="inp" type="number" min={5} value={draft.seconds} readOnly={!canEdit} onChange={(e) => setDraft({ ...draft, seconds: num(e.target.value, 5, 86_400) })} /></label>
        <div className="t3" style={{ fontSize: 12, paddingTop: 16 }}>{PROFILE_HELP[draft.profile]}</div>
      </section>
      {tooBig && <div className={s.notice} style={{ margin: 0 }}><Icon name="alert" size={14} />Testbench runs up to {LOAD_LIMITS.vus} users for {LOAD_LIMITS.seconds} seconds itself. This one can be saved and exported as a k6 script, but not run here.</div>}
      <section>
        <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>It passes when</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <label className="field"><span className="flab">p95 is under (ms)</span><input className="inp" type="number" min={1} placeholder="no limit" value={draft.thresholds.p95Ms ?? ''} readOnly={!canEdit} onChange={(e) => th('p95Ms', e.target.value)} /></label>
          <label className="field"><span className="flab">Failures are under (%)</span><input className="inp" type="number" min={0} max={100} step={0.1} placeholder="no limit" value={draft.thresholds.errorPercent ?? ''} readOnly={!canEdit} onChange={(e) => th('errorPercent', e.target.value)} /></label>
          <label className="field"><span className="flab">At least (requests per second)</span><input className="inp" type="number" min={0} placeholder="no minimum" value={draft.thresholds.minRps ?? ''} readOnly={!canEdit} onChange={(e) => th('minRps', e.target.value)} /></label>
        </div>
        <div className="t3" style={{ fontSize: 12, marginTop: 4 }}>A response of 400 or above, or none, counts as a failure.</div>
      </section>
      <section>
        <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Stop early when</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <label className="field"><span className="flab">Failures in the last 10 s reach (%)</span><input className="inp" type="number" min={1} max={100} value={draft.abort.errorPercent} readOnly={!canEdit} onChange={(e) => setDraft({ ...draft, abort: { ...draft.abort, errorPercent: num(e.target.value, 1, 100) } })} /></label>
          <label className="field"><span className="flab">p95 in the last 10 s reaches (ms)</span><input className="inp" type="number" min={100} placeholder="never" value={draft.abort.p95Ms ?? ''} readOnly={!canEdit} onChange={(e) => setDraft({ ...draft, abort: { ...draft.abort, p95Ms: e.target.value ? num(e.target.value, 100, 300_000) : null } })} /></label>
        </div>
      </section>
      {error && <div className="err" role="alert">{error}</div>}
      {canEdit && <div><button className="btn primary" onClick={save}>Save load test</button></div>}
    </div>
  );
}
