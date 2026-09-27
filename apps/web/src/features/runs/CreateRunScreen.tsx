'use client';

import { PRIORITIES, RUN_TYPES, type CaseCount, type CaseFilter, type RunSummary, type RunType } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { Avatar } from '@/components/status';
import { api, ApiError } from '@/lib/api';
import { fmt } from '@/lib/format';
import { useMembers, useModules } from '../cases/data';
import s from './runs.module.css';

const CONFIGS = ['Chrome 128 · Win 11', 'Safari 17 · macOS 14', 'Firefox 130 · Ubuntu', 'Android 14 · Pixel 8', 'iOS 17 · iPhone 15'];
const ENVIRONMENTS = ['Staging-IN', 'UAT', 'Pre-prod', 'Perf-lab'];
const STEPS = ['Scope', 'Configuration', 'Assign', 'Schedule'] as const;
/** Matches MAX_RUN_CASES in services/execution; larger runs need the background expander (M2). */
const MAX_RUN_CASES = 5_000;

/** One-page run wizard: pick cases, where and how to run them, who runs them, and when it is due. */
export function CreateRunScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const modules = useModules(project.id);
  const members = useMembers(project.id);

  const [fromSelection, setFromSelection] = useState<CaseFilter | null>(null);
  const [moduleId, setModuleId] = useState('');
  const [priority, setPriority] = useState<string[]>([]);
  const [labels, setLabels] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<RunType>('smoke');
  const [environment, setEnvironment] = useState(ENVIRONMENTS[0]!);
  const [build, setBuild] = useState('');
  const [configs, setConfigs] = useState<string[]>([CONFIGS[0]!]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (params.get('from') !== 'selection') return;
    try {
      const raw = sessionStorage.getItem('tb.runSelection');
      if (raw) setFromSelection(JSON.parse(raw) as CaseFilter);
    } catch {
      // No stored selection: fall back to building the scope here.
    }
  }, [params]);

  const filter = useMemo<CaseFilter>(() => fromSelection ?? {
    moduleId: moduleId || undefined,
    priority: priority.length ? (priority as CaseFilter['priority']) : undefined,
    labels: labels.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean),
  }, [fromSelection, moduleId, priority, labels]);
  const count = useQuery({
    queryKey: ['cases', project.id, 'count', filter],
    queryFn: () => api<CaseCount>('POST', `/projects/${project.id}/cases/count`, filter),
  });

  const testers = (members.data ?? []).filter((m) => m.role !== 'viewer');
  const items = (count.data?.count ?? 0) * configs.length;
  const tooMany = !!count.data && (count.data.capped || count.data.count > MAX_RUN_CASES);
  const itemsLabel = count.data?.capped ? `${fmt(items)}+` : fmt(items);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const run = await api<RunSummary>('POST', `/projects/${project.id}/runs`, {
        name, type, environment, build, configs, assigneeIds: assignees, filter,
        dueAt: due ? new Date(due).toISOString() : null,
      });
      sessionStorage.removeItem('tb.runSelection');
      await queryClient.invalidateQueries({ queryKey: ['runs', project.id] });
      notify(`${run.key} created with ${fmt(run.counts.total)} items`);
      router.push(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the run');
      setSaving(false);
    }
  };

  const ready = name.trim().length >= 3 && build.trim() && configs.length > 0 && (count.data?.count ?? 0) > 0 && !tooMany;
  const moduleOptions = modules.data ? [...modules.data.byId.values()].sort((a, b) => a.path.localeCompare(b.path)) : [];

  return (
    <div className={s.wizard}>
      <nav className={s.stepsNav} aria-label="Run setup steps">
        <div className="h1" style={{ fontSize: 16, padding: '0 8px 12px' }}>New run</div>
        {STEPS.map((step, i) => <a key={step} href={`#step-${i}`} className={s.stepLink}><span className={s.stepNo}>{i + 1}</span>{step}</a>)}
      </nav>

      <div className={s.form}>
        <section id="step-0" className="panel">
          <div className="hdr"><h3>1 · Scope</h3></div>
          <div className={s.sec}>
            <div className="field"><label htmlFor="run-name">Run name</label><input id="run-name" className="inp" style={{ height: 32, fontSize: 13.5 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Release 4.18 smoke — Payments web" /></div>
            <div className="field">
              <span className="flab">Type</span>
              <div className="seg">{RUN_TYPES.filter((t) => t !== 'automated').map((t) => <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)} style={{ textTransform: 'capitalize' }}>{t}</button>)}</div>
            </div>
            {fromSelection ? (
              <div className="banner info">
                <Icon name="cases" />
                <div className="f1">Using the {fromSelection.keys ? `${fmt(fromSelection.keys.length)} cases you selected` : 'cases matching your grid filters'}.</div>
                <button className="btn sm" onClick={() => setFromSelection(null)}>Choose differently</button>
              </div>
            ) : (
              <div className={s.grid3}>
                <div className="field">
                  <label htmlFor="run-module">Module</label>
                  <select id="run-module" className="inp" value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
                    <option value="">All modules</option>
                    {moduleOptions.map((m) => <option key={m.id} value={m.id}>{m.path}</option>)}
                  </select>
                </div>
                <div className="field">
                  <span className="flab">Priority</span>
                  <div className="row" style={{ gap: 4 }}>{PRIORITIES.map((p) => <button key={p} className={`chip ${priority.includes(p) ? 'on' : ''}`} onClick={() => setPriority(toggle(priority, p))}>{p}</button>)}</div>
                </div>
                <div className="field"><label htmlFor="run-labels">Labels (all of)</label><input id="run-labels" className="inp" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="smoke" /></div>
              </div>
            )}
            <div className={s.count}>
              <b className="num">{count.data ? (count.data.capped ? `${fmt(count.data.count)}+` : fmt(count.data.count)) : '…'}</b> matching cases
              <span className="t3">· the current version of each is frozen into the run</span>
            </div>
            {tooMany && (
              <div className="banner warn" role="status">
                <Icon name="alert" />
                <div>A run can hold up to {fmt(MAX_RUN_CASES)} cases for now. Narrow the module, priority or labels, or split it into several runs.</div>
              </div>
            )}
          </div>
        </section>

        <section id="step-1" className="panel">
          <div className="hdr"><h3>2 · Configuration</h3></div>
          <div className={s.sec}>
            <div className={s.grid3}>
              <div className="field"><label htmlFor="run-env">Environment</label><select id="run-env" className="inp" value={environment} onChange={(e) => setEnvironment(e.target.value)}>{ENVIRONMENTS.map((env) => <option key={env}>{env}</option>)}</select></div>
              <div className="field"><label htmlFor="run-build">Build</label><input id="run-build" className="inp mono" value={build} onChange={(e) => setBuild(e.target.value)} placeholder="8812" /></div>
            </div>
            <div className="field">
              <span className="flab">Configurations · each case runs once per configuration</span>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{CONFIGS.map((c) => <button key={c} className={`chip ${configs.includes(c) ? 'on' : ''}`} onClick={() => setConfigs(toggle(configs, c))}>{configs.includes(c) && <Icon name="check" size={11} />}{c}</button>)}</div>
            </div>
            <div className={s.count}><b className="num">{itemsLabel}</b> run items <span className="t3">({count.data?.capped ? `${fmt(count.data.count)}+` : fmt(count.data?.count ?? 0)} cases × {configs.length} configuration{configs.length === 1 ? '' : 's'})</span></div>
          </div>
        </section>

        <section id="step-2" className="panel">
          <div className="hdr"><h3>3 · Assign</h3><span className="cnt">{assignees.length} selected</span></div>
          <div className={s.sec}>
            <div className="t3" style={{ fontSize: 12 }}>Cases are shared out in turn; every configuration of one case goes to the same tester.</div>
            <div className={s.people}>
              {testers.map((m) => (
                <label key={m.user.id} className={`${s.person} ${assignees.includes(m.user.id) ? s.personOn : ''}`}>
                  <input type="checkbox" className="cb" checked={assignees.includes(m.user.id)} onChange={() => setAssignees(toggle(assignees, m.user.id))} />
                  <Avatar user={m.user} />
                  <span className="trunc f1">{m.user.name}</span>
                  {assignees.includes(m.user.id) && count.data && <span className="mono t3">~{fmt(Math.ceil(items / assignees.length))}</span>}
                </label>
              ))}
            </div>
          </div>
        </section>

        <section id="step-3" className="panel">
          <div className="hdr"><h3>4 · Schedule</h3></div>
          <div className={s.sec}>
            <div className="field" style={{ maxWidth: 260 }}><label htmlFor="run-due">Due (optional)</label><input id="run-due" type="datetime-local" className="inp" value={due} onChange={(e) => setDue(e.target.value)} /></div>
            <div className="t3" style={{ fontSize: 12 }}>The run starts now. Recurring and dynamic runs (re-evaluated at each run) arrive with the scheduler.</div>
          </div>
        </section>

        {error && <div className="banner bad" role="alert"><Icon name="alert" />{error}</div>}
        <div className="row" style={{ paddingBottom: 24 }}>
          <button className="btn primary" disabled={!ready || saving} onClick={submit}><Icon name="play" size={14} />{saving ? 'Creating…' : `Create run with ${itemsLabel} items`}</button>
          <button className="btn" onClick={() => router.back()}>Cancel</button>
          {!ready && !tooMany && <span className="t3" style={{ fontSize: 12 }}>Needs a name, a build, at least one configuration and one matching case.</span>}
        </div>
      </div>
    </div>
  );
}
