'use client';

import type { BuildCompare, CompareCategory, Health, HealthKind, Overview, Readiness, Workload } from '@tb/contracts';
import { COMPARE_CATEGORIES, HEALTH_KINDS } from '@tb/contracts';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { Avatar, ResultStatus } from '@/components/status';
import { api, ApiError, get, qs } from '@/lib/api';
import { dateTimeIST, fmt, minutesLabel } from '@/lib/format';
import { hoursLabel, share, toCsv } from './analytics-utils';
import { ExecutionsChart, PassRateChart } from './charts';
import s from './analytics.module.css';

const TABS = { overview: 'Overview', readiness: 'Release readiness', health: 'Test health', compare: 'Build compare', workload: 'Workload' } as const;
type Tab = keyof typeof TABS;

/** What the header's Export button downloads; each tab publishes the table it is showing. */
type CsvExport = { name: string; header: string[]; rows: (string | number | null)[][] };
type SetExport = (csv: CsvExport | null) => void;

/** Reports across runs, defects and cases (HLD §5.10, §5.16). The tab lives in the URL so views can be linked. */
export function AnalyticsScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const { project } = useSession();
  const tabParam = params.get('tab');
  const tab: Tab = tabParam && tabParam in TABS ? (tabParam as Tab) : 'overview';
  const [days, setDays] = useState(30);
  const [csv, setCsv] = useState<CsvExport | null>(null);

  const go = (t: Tab) => {
    setCsv(null);
    router.replace(`/analytics?tab=${t}`, { scroll: false });
  };

  return (
    <>
      <div className={`row ${s.head}`}>
        <h1 className="h1">Analytics</h1>
        <div className="tabs" role="tablist">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => go(t)}>{TABS[t]}</button>
          ))}
        </div>
        <div className="f1" />
        {tab === 'overview' && (
          <div className="seg" role="radiogroup" aria-label="Period">
            {[7, 30, 90].map((d) => (
              <button key={d} role="radio" aria-checked={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} days</button>
            ))}
          </div>
        )}
        <button className="btn sm" disabled={!csv} onClick={() => csv && downloadCsv(`${project.key}-${csv.name}.csv`, toCsv(csv.header, csv.rows))}>Export</button>
      </div>
      <div className={s.body}>
        {tab === 'overview' && <OverviewTab days={days} onExport={setCsv} />}
        {tab === 'readiness' && <ReadinessTab onExport={setCsv} />}
        {tab === 'health' && <HealthTab onExport={setCsv} />}
        {tab === 'compare' && <CompareTab onExport={setCsv} />}
        {tab === 'workload' && <WorkloadTab onExport={setCsv} />}
      </div>
    </>
  );
}

function downloadCsv(filename: string, csv: string) {
  // The BOM makes Excel read the file as UTF-8, so ₹ and names outside ASCII survive.
  const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff), csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Loading and error placeholder for a report query; null once data is there. */
function pending(q: UseQueryResult, what: string): ReactNode {
  if (q.error) {
    return <div className="empty" style={{ padding: 48 }}><Icon name="alert" size={20} /><div>{q.error instanceof ApiError ? q.error.message : `Could not load ${what}.`}</div><button className="btn sm" onClick={() => q.refetch()}>Try again</button></div>;
  }
  if (!q.data) return <div className="empty t3" style={{ padding: 48 }}>Loading {what}…</div>;
  return null;
}

/** Collapsible panel matching the design's details.cs blocks. */
function Panel({ title, count, extra, className = '', style, children }: { title: string; count?: ReactNode; extra?: ReactNode; className?: string; style?: React.CSSProperties; children: ReactNode }) {
  return (
    <details className={`panel ${s.cs} ${className}`} style={style} open>
      <summary className="hdr">
        <span className={s.chev}><Icon name="chevRight" size={12} /></span>
        <h3>{title}</h3>
        {count !== undefined && <span className="cnt">{count}</span>}
        <div className="f1" />
        {extra}
      </summary>
      {children}
    </details>
  );
}

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return <div><div className={s.kpL}>{label}</div><div className={`${s.kpV} num`}>{value}</div><div className={s.kpS}>{sub}</div></div>;
}

const pctLabel = (v: number | null) => (v === null ? '—' : `${v}%`);
const round1 = (v: number) => Math.round(v * 10) / 10;

function Legend({ items }: { items: [string, string][] }) {
  return <>{items.map(([label, color]) => <span key={label} className={s.lg}><i style={{ background: `var(--${color})` }} />{label}</span>)}</>;
}

// ---------- Overview ----------

function OverviewTab({ days, onExport }: { days: number; onExport: SetExport }) {
  const { project } = useSession();
  const q = useQuery({ queryKey: ['analytics', project.id, 'overview', days], queryFn: () => get<Overview>(`/projects/${project.id}/reports/overview?days=${days}`) });
  const o = q.data;

  useEffect(() => {
    onExport(o ? {
      name: `overview-${o.days}d`,
      header: ['Day', 'Passed', 'Failed', 'Blocked', 'Skipped'],
      rows: o.daily.map((d) => [d.day, d.passed, d.failed, d.blocked, d.skipped]),
    } : null);
  }, [o, onExport]);

  if (!o) return pending(q, 'the overview');
  const k = o.kpis;
  const delta = k.passRate !== null && k.passRatePrevious !== null ? round1(k.passRate - k.passRatePrevious) : null;

  return (
    <>
      <div className={s.kp}>
        <Kpi
          label={`Pass rate · ${o.days} days`}
          value={pctLabel(k.passRate)}
          sub={delta === null ? `no results in the previous ${o.days} days` : delta === 0 ? `same as previous ${o.days}` : `${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} pts vs previous ${o.days}`}
        />
        <Kpi label="Executed" value={fmt(k.executed)} sub={k.automatedShare === null ? 'nothing executed' : `manual ${round1(100 - k.automatedShare)}% · automated ${k.automatedShare}%`} />
        <Kpi label="Open defects" value={fmt(k.openDefects)} sub={`${k.openBlockers} blocker · ${k.openCriticals} critical`} />
        <Kpi label="Automation coverage" value={pctLabel(k.automationCoverage)} sub="of Ready cases" />
        <Kpi label="Mean time to retest" value={k.meanRetestHours === null ? '—' : hoursLabel(k.meanRetestHours)} sub="target under 1 day" />
      </div>

      <div className={s.pair} style={{ alignItems: 'stretch' }}>
        <Panel title={`Pass rate, last ${o.days} days`} style={{ flex: 1.35 }} extra={<><Legend items={[['Pass rate', 'accent']]} /><span className={s.lg}><i className={s.dash} />Target</span></>}>
          <div className={s.pad}><PassRateChart days={o.daily} /></div>
        </Panel>
        <Panel title="Executions per day" extra={<Legend items={[['Passed', 'passed'], ['Failed', 'failed'], ['Blocked', 'blocked'], ['Skipped', 'skipped']]} />}>
          <div className={s.pad}><ExecutionsChart days={o.daily} /></div>
        </Panel>
      </div>

      <div className={s.pair} style={{ alignItems: 'flex-start' }}>
        <Panel title="Results by module" extra={<Legend items={[['Passed', 'passed'], ['Failed', 'failed'], ['Blocked', 'blocked']]} />}>
          <div style={{ padding: '8px 14px 10px' }}>
            {o.modules.length === 0 && <div className="empty t3" style={{ padding: 24 }}>No results in this period.</div>}
            {o.modules.map((m) => {
              const n = m.passed + m.failed + m.blocked + m.skipped;
              return (
                <div key={m.name} className={s.mrow}>
                  <span className="trunc t2" title={m.name}>{m.name}</span>
                  <div className="sbar" style={{ height: 10 }} role="img" aria-label={`${m.name}: ${m.passed} passed, ${m.failed} failed, ${m.blocked} blocked of ${n}`}>
                    <i className="b-passed" style={{ width: `${share(m.passed, n)}%` }} />
                    <i className="b-failed" style={{ width: `${share(m.failed, n)}%` }} />
                    <i className="b-blocked" style={{ width: `${share(m.blocked, n)}%` }} />
                  </div>
                  <span className="num" style={{ textAlign: 'right' }}>{share(m.passed, n).toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        </Panel>
        <Panel title="Top failing cases" count={o.topFailing.length} style={{ flex: 1.2 }}>
          <div className={s.scroll}>
            <table className="tbl">
              <thead><tr><th>Key</th><th>Title</th><th>Fails · {o.days}d</th><th>Last failed</th><th>Bug</th></tr></thead>
              <tbody>
                {o.topFailing.map((c) => (
                  <tr key={c.key}>
                    <td><Link className="mono" href={`/cases/${c.key}`}>{c.key}</Link></td>
                    <td className="trunc" style={{ maxWidth: 320 }} title={c.title}>{c.title}</td>
                    <td className="num"><span className="st st-failed">{fmt(c.fails)}</span></td>
                    <td className="mono t2">{c.lastBuild}</td>
                    <td className={`mono ${c.bug ? 'acc' : 't3'}`}>{c.bug ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {o.topFailing.length === 0 && <div className="empty t3" style={{ padding: 24 }}>No failures in this period.</div>}
          </div>
        </Panel>
      </div>
    </>
  );
}

// ---------- Release readiness ----------

const CRITERION = {
  met: ['st-passed', 'Met'],
  failing: ['st-failed', 'Failing'],
  no_data: ['st-untested', 'No data'],
} as const;

function ReadinessTab({ onExport }: { onExport: SetExport }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [build, setBuild] = useState('');
  const [decision, setDecision] = useState<'go' | 'no_go' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['analytics', project.id, 'readiness', build], queryFn: () => get<Readiness>(`/projects/${project.id}/reports/readiness${qs({ build })}`) });
  const r = q.data;

  useEffect(() => {
    onExport(r?.build ? {
      name: `readiness-${r.build}`,
      header: ['Criterion', 'Target', 'Actual', 'Status', 'Evidence'],
      rows: r.criteria.map((c) => [c.label, c.target, c.actual, CRITERION[c.status][1], c.evidence]),
    } : null);
  }, [r, onExport]);

  if (!r) return pending(q, 'release readiness');
  if (!r.build) {
    return <div className="empty" style={{ padding: 48 }}><Icon name="flag" size={22} /><div>No build has been tested yet.</div><div className="t3" style={{ fontSize: 12 }}>Readiness is evaluated per build once a run records one.</div></div>;
  }

  const notMet = r.criteria.filter((c) => c.status !== 'met').length;
  const met = r.criteria.length - notMet;
  const latest = r.signoffs[0];
  const goBlocked = `Go is disabled while ${notMet} ${notMet === 1 ? 'criterion is' : 'criteria are'} failing or without data`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decision || !r.build) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/projects/${project.id}/reports/readiness/signoff`, { build: r.build, decision, note: note.trim() });
      await queryClient.invalidateQueries({ queryKey: ['analytics', project.id, 'readiness'] });
      notify(`${decision === 'go' ? 'Go' : 'No-go'} recorded for build ${r.build}`);
      setDecision(null);
      setNote('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the sign-off');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`col ${s.narrow}`} style={{ gap: 14 }}>
      <div className="row" style={{ gap: 10 }}>
        <label className="flab" htmlFor="rd-build">Build</label>
        <select id="rd-build" className="inp mono" style={{ width: 130 }} value={r.build} onChange={(e) => { setBuild(e.target.value); setDecision(null); }}>
          {r.builds.map((b) => <option key={b}>{b}</option>)}
        </select>
      </div>

      <div className={`${s.verdict} ${r.ready ? s.ok : ''}`}>
        <span className={`st ${r.ready ? 'st-passed' : 'st-failed'}`}><Icon name={r.ready ? 'check' : 'alert'} size={22} /></span>
        <div className="f1">
          <div className={`cond ${s.verdictT}`}>{r.ready ? 'Ready for release' : `Not ready — ${notMet} ${notMet === 1 ? 'criterion' : 'criteria'} failing`}</div>
          <div className="t2" style={{ fontSize: 12.5 }}>Build <span className="mono">{r.build}</span> · evaluated {dateTimeIST(r.evaluatedAt)}</div>
        </div>
        {latest && (
          <span className={`st ${latest.decision === 'go' ? 'st-passed' : 'st-failed'}`}>{latest.decision === 'go' ? 'Go' : 'No-go'} recorded by {latest.by}</span>
        )}
        {can('run.signoff') && latest?.decision !== 'go' && !decision && (
          <div className="col" style={{ alignItems: 'flex-end', gap: 6 }}>
            <div className="row">
              <button className="btn" disabled={!r.ready} title={r.ready ? 'Record a Go decision for this build' : goBlocked} onClick={() => setDecision('go')}>Go</button>
              <button className="btn primary" onClick={() => setDecision('no_go')}>Record No-go</button>
            </div>
            {!r.ready && <span className="t3" style={{ fontSize: 11.5 }}>{goBlocked}</span>}
          </div>
        )}
      </div>

      {decision && (
        <form className="panel col" style={{ gap: 8, padding: 14 }} onSubmit={submit}>
          <label className="flab" htmlFor="rd-note">{decision === 'go' ? 'Go' : 'No-go'} for build {r.build} — note (optional)</label>
          <textarea id="rd-note" className="inp" rows={2} autoFocus value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder={decision === 'go' ? 'Anything release should know' : 'What has to change before Go'} />
          {error && <div className="err">{error}</div>}
          <div className="row">
            <button className="btn sm primary" type="submit" disabled={busy}>Record {decision === 'go' ? 'Go' : 'No-go'}</button>
            <button className="btn sm" type="button" onClick={() => { setDecision(null); setError(null); }}>Cancel</button>
          </div>
        </form>
      )}

      <Panel title="Criteria" count={`${r.criteria.length} · ${met} met`}>
        <div className={s.scroll}>
          <table className="tbl">
            <thead><tr><th>Criterion</th><th>Target</th><th>Actual</th><th>Status</th><th>Evidence</th></tr></thead>
            <tbody>
              {r.criteria.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 500 }}>{c.label}</td>
                  <td className="mono t2">{c.target}</td>
                  <td className="mono">{c.actual}</td>
                  <td><span className={`st ${CRITERION[c.status][0]}`}>{CRITERION[c.status][1]}</span></td>
                  <td className="t3">{c.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Sign-off" count={r.signoffs.length}>
        <div className="col" style={{ padding: '4px 0' }}>
          {r.signoffs.length === 0 && <div className="t3" style={{ padding: '10px 14px', fontSize: 12.5 }}>No decision recorded for build {r.build} yet.</div>}
          {r.signoffs.map((so) => (
            <div key={`${so.at}-${so.by}`} className={s.srow}>
              <Avatar user={{ id: so.by, name: so.by, email: '' }} />
              <span style={{ width: 140 }} className="trunc">{so.by}</span>
              <span className={`st ${so.decision === 'go' ? 'st-passed' : 'st-failed'}`} style={{ width: 60 }}>{so.decision === 'go' ? 'Go' : 'No-go'}</span>
              <span className="t3 f1">{so.note || '—'}</span>
              <span className="t2">{dateTimeIST(so.at)}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ---------- Test health ----------

const HEALTH: Record<HealthKind, string> = { always_failing: 'Always failing', flaky: 'Flaky', needs_review: 'Needs review', stale: 'Stale' };

function HealthTab({ onExport }: { onExport: SetExport }) {
  const { project } = useSession();
  const [kind, setKind] = useState<HealthKind | null>(null);
  const q = useQuery({ queryKey: ['analytics', project.id, 'health'], queryFn: () => get<Health>(`/projects/${project.id}/reports/health`) });
  const h = q.data;
  const items = h?.items.filter((i) => !kind || i.kind === kind) ?? [];

  useEffect(() => {
    onExport(h ? {
      name: `health${kind ? `-${kind}` : ''}`,
      header: ['Health', 'Key', 'Title', 'Why', 'Owner'],
      rows: h.items.filter((i) => !kind || i.kind === kind).map((i) => [HEALTH[i.kind], i.key, i.title, i.why, i.owner?.name ?? '']),
    } : null);
  }, [h, kind, onExport]);

  if (!h) return pending(q, 'test health');
  const all = HEALTH_KINDS.reduce((n, k) => n + h.counts[k], 0);

  return (
    <>
      <div className={`${s.kp} ${s.kp4}`}>
        <Kpi label="Stale" value={fmt(h.counts.stale)} sub={`not run in ${h.staleDays}+ days`} />
        <Kpi label="Always failing" value={fmt(h.counts.always_failing)} sub="failed every run, last 5+" />
        <Kpi label="Flaky" value={fmt(h.counts.flaky)} sub="result flips 3+ times in 10" />
        <Kpi label="Needs review" value={fmt(h.counts.needs_review)} sub="linked requirement changed" />
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Filter by health">
        <button className={`chip ${kind === null ? 'on' : ''}`} aria-pressed={kind === null} onClick={() => setKind(null)}>All</button>
        {HEALTH_KINDS.map((k) => (
          <button key={k} className={`chip ${kind === k ? 'on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>
            {HEALTH[k]}<span className="n">{fmt(h.counts[k])}</span>
          </button>
        ))}
      </div>
      <Panel title="Cases needing attention" count={`${fmt(items.length)} of ${fmt(kind ? h.counts[kind] : all)}`}>
        <div className={s.scroll}>
          <table className="tbl">
            <thead><tr><th>Health</th><th>Key</th><th>Title</th><th>Why</th><th>Owner</th><th><span className={s.srOnly}>Action</span></th></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={`${i.kind}-${i.key}`}>
                  <td><span className={`${s.hb} ${s[i.kind]}`}>{HEALTH[i.kind]}</span></td>
                  <td><Link className="mono" href={`/cases/${i.key}`}>{i.key}</Link></td>
                  <td className="trunc" style={{ maxWidth: 340 }} title={i.title}>{i.title}</td>
                  <td className="t3">{i.why}</td>
                  <td>{i.owner ? <Avatar user={{ ...i.owner, email: '' }} /> : <span className="t3">—</span>}</td>
                  <td><Link className="btn sm" href={`/cases/${i.key}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && (
            <div className="empty t3" style={{ padding: 32 }}>
              {/* The API lists only the first cases, worst kinds first, so a large lower kind can have none shown. */}
              {kind && h.counts[kind] > 0
                ? `Only the first ${fmt(h.items.length)} cases, worst first, are listed; none of them are ${HEALTH[kind].toLowerCase()}.`
                : 'Nothing needs attention here.'}
            </div>
          )}
        </div>
      </Panel>
    </>
  );
}

// ---------- Build compare ----------

const CATEGORY: Record<CompareCategory, string> = { new_failure: 'New failures', fixed: 'Fixed', still_failing: 'Still failing', added: 'Newly added', not_run: 'Not run' };

function CompareTab({ onExport }: { onExport: SetExport }) {
  const { project } = useSession();
  const [pick, setPick] = useState({ base: '', head: '' });
  const [category, setCategory] = useState<CompareCategory | null>(null);
  const q = useQuery({
    queryKey: ['analytics', project.id, 'compare', pick.base, pick.head],
    queryFn: () => get<BuildCompare>(`/projects/${project.id}/reports/compare${qs(pick)}`),
  });
  const c = q.data;
  const rows = c?.rows.filter((r) => !category || r.category === category) ?? [];

  useEffect(() => {
    onExport(c?.counts ? {
      name: `compare-${c.base}-${c.head}${category ? `-${category}` : ''}`,
      header: ['Key', 'Title', 'Configuration', `Base ${c.base}`, `Head ${c.head}`, 'Change', 'Bug'],
      rows: c.rows.filter((r) => !category || r.category === category).map((r) => [r.key, r.title, r.config, r.base, r.head, CATEGORY[r.category], r.bug]),
    } : null);
  }, [c, category, onExport]);

  if (!c) return pending(q, 'the build comparison');
  if (!c.counts) {
    return <div className="empty" style={{ padding: 48 }}><Icon name="columns" size={22} /><div>Two tested builds are needed to compare.</div><div className="t3" style={{ fontSize: 12 }}>{c.builds.length ? `Only build ${c.builds[0]} has runs so far.` : 'No run has recorded a build yet.'}</div></div>;
  }
  const counts = c.counts;
  // Once a pair is chosen, keep the other side from the current answer so changing one select keeps the other.
  const choose = (side: 'base' | 'head', value: string) => setPick({ base: c.base, head: c.head, [side]: value });

  return (
    <>
      <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field">
          <label htmlFor="cmp-base">Base</label>
          <select id="cmp-base" className="inp mono" style={{ width: 130 }} value={c.base} onChange={(e) => choose('base', e.target.value)}>
            {c.builds.map((b) => <option key={b}>{b}</option>)}
          </select>
        </div>
        <span className="t3" style={{ paddingBottom: 6 }}><Icon name="arrowRight" size={14} /></span>
        <div className="field">
          <label htmlFor="cmp-head">Head</label>
          <select id="cmp-head" className="inp mono" style={{ width: 130 }} value={c.head} onChange={(e) => choose('head', e.target.value)}>
            {c.builds.map((b) => <option key={b}>{b}</option>)}
          </select>
        </div>
        <span className="t3" style={{ fontSize: 12, paddingBottom: 6 }}>{fmt(c.compared)} case · configuration pairs compared</span>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Filter by change">
        {COMPARE_CATEGORIES.map((k) => (
          <button key={k} className={`${s.cchip} ${category === k ? s.on : ''}`} aria-pressed={category === k} onClick={() => setCategory(category === k ? null : k)}>
            <b>{fmt(counts[k])}</b>{CATEGORY[k]}
          </button>
        ))}
      </div>
      <Panel title="Changed results" count={category ? `${fmt(rows.length)} ${CATEGORY[category].toLowerCase()}` : fmt(rows.length)}>
        <div className={s.scroll}>
          <table className="tbl">
            <thead><tr><th>Key</th><th>Title</th><th>Configuration</th><th>Base {c.base}</th><th><span className={s.srOnly}>to</span></th><th>Head {c.head}</th><th>Bug</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.key}-${r.config}`}>
                  <td><Link className="mono" href={`/cases/${r.key}`}>{r.key}</Link></td>
                  <td className="trunc" style={{ maxWidth: 380 }} title={r.title}>{r.title}</td>
                  <td className="t2">{r.config}</td>
                  <td>{r.base ? <ResultStatus result={r.base} /> : <span className="t3">—</span>}</td>
                  <td className="t3"><Icon name="arrowRight" size={12} /></td>
                  <td>{r.head ? <ResultStatus result={r.head} /> : <span className="t3">—</span>}</td>
                  <td className={`mono ${r.bug ? 'acc' : 't3'}`}>{r.bug ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty t3" style={{ padding: 32 }}>No changed results{category ? ` in ${CATEGORY[category].toLowerCase()}` : ''} between {c.base} and {c.head}.</div>}
        </div>
      </Panel>
    </>
  );
}

// ---------- Workload ----------

function WorkloadTab({ onExport }: { onExport: SetExport }) {
  const { project } = useSession();
  const q = useQuery({ queryKey: ['analytics', project.id, 'workload'], queryFn: () => get<Workload>(`/projects/${project.id}/reports/workload`) });
  const w = q.data;

  useEffect(() => {
    onExport(w ? {
      name: 'workload',
      header: ['Tester', 'Assigned minutes', 'Capacity minutes', 'Estimate accuracy %', 'Items'],
      rows: w.rows.map((r) => [r.user.name, r.estimateMin, r.capacityMin, r.accuracy, r.items]),
    } : null);
  }, [w, onExport]);

  if (!w) return pending(q, 'workload');
  // One scale for every row, with headroom so the capacity marker never sits on the bar's end.
  const scale = Math.max(1, ...w.rows.map((r) => Math.max(r.estimateMin, r.capacityMin))) * 1.15;

  return (
    <div className={`col ${s.narrow}`} style={{ gap: 14 }}>
      <Panel title="Workload this week" count={`${w.rows.length} ${w.rows.length === 1 ? 'tester' : 'testers'}`} extra={<Link className="btn sm" href="/runs/new" style={{ fontWeight: 400 }}>Rebalance in a run</Link>}>
        <div className={s.scroll} role="table" aria-label="Workload per tester">
          <div className={`${s.wkr} ${s.wkh}`} role="row">
            <span role="columnheader">Tester</span><span role="columnheader">Assigned vs capacity</span><span role="columnheader">Hours</span><span role="columnheader">Estimate accuracy</span><span role="columnheader"><span className={s.srOnly}>Items</span></span>
          </div>
          {w.rows.map((r) => {
            const over = r.estimateMin - r.capacityMin;
            return (
              <div key={r.user.id} className={`${s.wkr} ${over > 0 ? s.over : ''}`} role="row">
                <span className="row trunc" role="cell"><Avatar user={{ ...r.user, email: '' }} />{r.user.name}</span>
                <div className={s.wb} role="cell" aria-label={`${minutesLabel(r.estimateMin)} assigned of ${minutesLabel(r.capacityMin)} capacity`}>
                  <i style={{ width: `${share(r.estimateMin, scale)}%` }} />
                  <i className={s.cap} style={{ left: `${share(r.capacityMin, scale)}%` }} />
                </div>
                <span className="mono t2" role="cell">{minutesLabel(r.estimateMin)} / {minutesLabel(r.capacityMin)}</span>
                <span className="t2" role="cell">{r.accuracy === null ? '—' : `${r.accuracy}%`}</span>
                <span role="cell">
                  {over > 0
                    ? <span className="st st-failed" style={{ fontSize: 12 }}>+{minutesLabel(over)}</span>
                    : <span className="t3" style={{ fontSize: 12 }}>{fmt(r.items)} {r.items === 1 ? 'item' : 'items'}</span>}
                </span>
              </div>
            );
          })}
          {w.rows.length === 0 && <div className="empty t3" style={{ padding: 32 }}>Nobody has open run items assigned.</div>}
        </div>
      </Panel>
      <div className="t3" style={{ fontSize: 12 }}>
        Estimate accuracy = estimated ÷ actual time over the last 30 days. Rows over capacity are highlighted.
        {w.unassigned > 0 && ` ${fmt(w.unassigned)} open run ${w.unassigned === 1 ? 'item is' : 'items are'} unassigned.`}
      </div>
    </div>
  );
}
