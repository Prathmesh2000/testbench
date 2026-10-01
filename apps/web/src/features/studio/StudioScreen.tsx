'use client';

import {
  ASSERTIONS,
  CHANGING_ACTIONS,
  LOCATOR_STRATEGIES,
  PAGE_ASSERTIONS,
  BROWSER_ASSERTIONS,
  STEP_ACTIONS,
  type Assertion,
  type AssertionKind,
  type AutoRun,
  type AutoRunDetail,
  type AutoStep,
  type DataSetSummary,
  type GeneratedCode,
  type LiveFrame,
  type Locator,
  type LocatorStrategy,
  type PageElement,
  type PickerSession,
  type StepIssue,
  type StudioComponent,
  type StudioTest,
} from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { ResultStatus } from '@/components/status';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago, bytes, dateTimeIST, fmt } from '@/lib/format';
import { Ide } from './ide/Ide';
import { UiReview } from './ui/UiReview';
import { WorkflowsScreen } from './workflows/WorkflowsScreen';
import { JourneyBuilder } from './journeys/JourneyBuilder';
import { SiteMap } from './sitemap/SiteMap';
import s from './studio.module.css';

type Tab = 'sitemap' | 'workflows' | 'tests' | 'code' | 'runs' | 'elements' | 'ui';
/** The testing flow first (map the site, record workflows, make tests, run them), then the tools. */
const TAB_GROUPS: Array<Array<{ id: Tab; label: string; hint: string }>> = [
  [
    { id: 'sitemap', label: 'Site map', hint: 'Pages, the workflows between them, their APIs and validations' },
    { id: 'workflows', label: 'Workflows', hint: 'Record what users do once, then agree how to test it' },
    { id: 'tests', label: 'Tests', hint: 'Journeys of workflows, and tests built step by step' },
    { id: 'runs', label: 'Runs', hint: 'Results, evidence and live runs' },
  ],
  [
    { id: 'code', label: 'Code', hint: 'Playwright code, with the site beside it' },
    { id: 'elements', label: 'Page library', hint: 'Saved elements and their locators' },
    { id: 'ui', label: 'UI review', hint: 'Layout and accessibility review of a page' },
  ],
];
interface TestRow { id: string; key: string; title: string; status: string; version: number; updatedAt: string }

const ACTION_LABEL: Record<AutoStep['action'], string> = {
  open: 'Open page', click: 'Click', type: 'Type', select: 'Choose option', check: 'Tick', uncheck: 'Untick',
  hover: 'Hover', press: 'Press key', store: 'Store value', verify: 'Check only', use_component: 'Use component', api_request: 'API request', manual: 'Manual step',
};
const ASSERT_LABEL: Record<AssertionKind, string> = {
  visible: 'is visible', hidden: 'is hidden', enabled: 'is enabled', disabled: 'is disabled', checked: 'is ticked',
  text_equals: 'text is', text_contains: 'text contains', value_equals: 'value is', count_equals: 'count is',
  url_contains: 'page URL contains', title_contains: 'page title contains', status_equals: 'response status is', validation_message: 'field is refused with',
  cookie: 'cookie is set', local_storage: 'local storage has', session_storage: 'session storage has', api_called: 'page called the API',
};
const NEEDS_EXPECTED: AssertionKind[] = ['text_equals', 'text_contains', 'value_equals', 'count_equals', 'url_contains', 'title_contains', 'status_equals'];
const NEEDS_TARGET: AutoStep['action'][] = ['click', 'type', 'select', 'check', 'uncheck', 'hover', 'store', 'verify'];
const NEEDS_VALUE: AutoStep['action'][] = ['open', 'type', 'select', 'press', 'store', 'manual'];

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const blankStep = (action: AutoStep['action'] = 'click'): AutoStep => ({ id: newId(), action, assertions: [], noCheck: false, intent: '' });

/** Automation (testing-studio-plan §3–§5): tests as steps, the page library, and headless runs. */
export function StudioScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'tests';
  const go = (t: Tab, id?: string) => router.replace(`/automation?tab=${t}${id ? `&id=${encodeURIComponent(id)}` : ''}`);
  const tabs = (
    <div className={s.tabs} role="tablist">
      {TAB_GROUPS.map((group, g) => (
        <div key={g} className={s.tabGroup}>
          {group.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} title={t.hint} className={`chip ${tab === t.id ? 'on' : ''}`} onClick={() => go(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
  // The code workspace is a full IDE: explorer, editor and run panel take the whole screen.
  if (tab === 'code') return <Ide header={tabs} initial={params.get('id')} />;
  if (tab === 'workflows') return <WorkflowsScreen header={tabs} />;
  if (tab === 'sitemap') return <SiteMap header={tabs} />;
  if (tab === 'ui') return <UiReview header={tabs} />;
  return (
    <div className={s.layout}>
      <aside className={s.list}>
        {tabs}
        {tab === 'tests' && <TestList selected={params.get('id')} onSelect={(id) => go('tests', id)} onJourney={() => router.replace('/automation?tab=tests&journey=new')} />}
        {tab === 'runs' && <RunList selected={params.get('id')} onSelect={(id) => go('runs', id)} />}
        {tab === 'elements' && <ElementList />}
      </aside>
      <section className={s.main}>
        {tab === 'tests' && params.get('journey') && <JourneyBuilder start={params.get('journey') === 'new' ? null : params.get('journey')} onDone={(id) => go('tests', id)} />}
        {tab === 'tests' && !params.get('journey') && <TestEditor key={params.get('id') ?? 'new'} testId={params.get('id')} onSaved={(id) => go('tests', id)} onRun={(id) => go('runs', id)} onEjected={(path) => go('code', path)} onDeleted={() => go('tests')} />}
        {tab === 'runs' && (params.get('id') ? <RunDetail runId={params.get('id')!} /> : <div className="empty t3" style={{ flex: 1 }}>Pick a run on the left.</div>)}
        {tab === 'elements' && <ElementForm />}
      </section>
    </div>
  );
}

// ---------- tests ----------

function TestList({ selected, onSelect, onJourney }: { selected: string | null; onSelect(id: string | undefined): void; onJourney(): void }) {
  const { project } = useSession();
  const tests = useQuery({ queryKey: ['studio-tests', project.id], queryFn: () => get<TestRow[]>(`/projects/${project.id}/studio/tests`) });
  return (
    <>
      <div className="hdr"><h3>Automated tests</h3>{tests.data && <span className="cnt">{tests.data.length}</span>}<div className="f1" /><button className="btn sm primary" onClick={onJourney} title="Workflows in order, as a test case"><Icon name="plus" size={12} />Journey</button><button className="btn sm" onClick={() => onSelect(undefined)} title="A test built step by step"><Icon name="plus" size={12} />Steps</button></div>
      <div className={s.scroll}>
        {tests.data?.map((t) => (
          <button key={t.id} className={`${s.item} ${selected === t.id ? s.on : ''}`} onClick={() => onSelect(t.id)}>
            <span className="row" style={{ gap: 6 }}><span className="mono t3">{t.key}</span><span className="pill" style={{ height: 18, fontSize: 10.5 }}>{t.status}</span></span>
            <span className="trunc">{t.title}</span>
            <span className="t3" style={{ fontSize: 11.5 }}>v{t.version} · {ago(t.updatedAt)}</span>
          </button>
        ))}
        {tests.data?.length === 0 && <div className="empty t3" style={{ padding: 24, fontSize: 12.5 }}>No automated tests yet. Build one step by step on the right.</div>}
      </div>
    </>
  );
}

function TestEditor({ testId, onSaved, onRun, onEjected, onDeleted }: { testId: string | null; onSaved(id: string): void; onRun(runId: string): void; onEjected(path: string): void; onDeleted(): void }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const existing = useQuery({ queryKey: ['studio-test', testId], queryFn: () => get<StudioTest>(`/projects/${project.id}/studio/tests/${testId}`), enabled: !!testId });
  const elements = useQuery({ queryKey: ['studio-elements', project.id], queryFn: () => get<PageElement[]>(`/projects/${project.id}/studio/elements`) });
  const dataSets = useQuery({ queryKey: ['data-sets', project.id], queryFn: () => get<DataSetSummary[]>(`/projects/${project.id}/data-sets`) });
  const components = useQuery({ queryKey: ['studio-components', project.id], queryFn: () => get<StudioComponent[]>(`/projects/${project.id}/studio/components`) });
  // This test's runs, newest first; refreshed while one is still going.
  const runs = useQuery({
    queryKey: ['studio-runs', project.id, testId],
    queryFn: () => get<AutoRun[]>(`/projects/${project.id}/studio/runs?testId=${testId}`),
    enabled: !!testId,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'queued' || r.status === 'running') ? 3_000 : false),
  });
  const [title, setTitle] = useState('');
  const [dataSetId, setDataSetId] = useState<string | null>(null);
  const [secrets, setSecrets] = useState('');
  const [steps, setSteps] = useState<AutoStep[]>([blankStep('open')]);
  const [issues, setIssues] = useState<StepIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [code, setCode] = useState<GeneratedCode | null>(null);
  const [runUrl, setRunUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!existing.data) return;
    setTitle(existing.data.title);
    setDataSetId(existing.data.dataSetId);
    setSecrets(existing.data.secrets.join(', '));
    setSteps(existing.data.steps);
    setIssues(existing.data.warnings);
  }, [existing.data]);

  const edit = (i: number, patch: Partial<AutoStep>) => setSteps((all) => all.map((st, n) => (n === i ? { ...st, ...patch } : st)));
  const move = (i: number, d: -1 | 1) => setSteps((all) => {
    const j = i + d;
    if (j < 0 || j >= all.length) return all;
    const next = [...all];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });

  const save = async () => {
    setSaving(true);
    try {
      const body = { title, dataSetId, secrets: secrets.split(',').map((x) => x.trim()).filter(Boolean), steps };
      const saved = testId
        ? await api<StudioTest>('PUT', `/projects/${project.id}/studio/tests/${testId}`, body)
        : await api<StudioTest>('POST', `/projects/${project.id}/studio/tests`, body);
      setIssues(saved.warnings);
      setCode(null);
      await queryClient.invalidateQueries({ queryKey: ['studio-tests', project.id] });
      queryClient.setQueryData(['studio-test', saved.id], saved);
      notify(`${saved.key} saved as version ${saved.version}${saved.warnings.length ? ` with ${saved.warnings.length} warning${saved.warnings.length === 1 ? '' : 's'}` : ''}`);
      if (!testId) onSaved(saved.id);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) setIssues(err.details as StepIssue[]);
      notify(err instanceof ApiError ? err.message : 'Could not save the test', 'bad');
    } finally {
      setSaving(false);
    }
  };

  const showCode = async () => {
    if (!testId) return;
    setCode(code ? null : await get<GeneratedCode>(`/projects/${project.id}/studio/tests/${testId}/code`));
  };

  const run = async () => {
    if (!testId || !runUrl) return;
    try {
      localStorage.setItem(RUN_URL, runUrl);
    } catch {
      // Private browsing: the address just isn't remembered.
    }
    try {
      const started = await api<AutoRun>('POST', `/projects/${project.id}/studio/runs`, { name: title || 'Test run', testIds: [testId], baseUrl: runUrl });
      await queryClient.invalidateQueries({ queryKey: ['studio-runs', project.id] });
      onRun(started.id);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not start the run', 'bad');
    }
  };

  const remove = async () => {
    if (!testId || !existing.data) return;
    if (!confirm(`Delete ${existing.data.key} "${existing.data.title}"? Past runs keep their results.`)) return;
    try {
      await api('DELETE', `/projects/${project.id}/studio/tests/${testId}`);
      await queryClient.invalidateQueries({ queryKey: ['studio-tests', project.id] });
      notify(`${existing.data.key} deleted`);
      onDeleted();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not delete the test', 'bad');
    }
  };

  const eject = async () => {
    if (!testId) return;
    try {
      const { path } = await api<{ path: string }>('POST', `/projects/${project.id}/studio/tests/${testId}/eject`);
      await queryClient.invalidateQueries({ queryKey: ['studio-tests', project.id] });
      await queryClient.invalidateQueries({ queryKey: ['studio-code', project.id] });
      notify(`Converted to ${path}; the step version is archived`);
      onEjected(path);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not convert to code', 'bad');
    }
  };

  const testIssues = issues.filter((i) => i.stepIndex === null);
  const editable = can('run.execute');

  return (
    <>
      <div className={s.head}>
        {existing.data && <span className="mono t3">{existing.data.key} · v{existing.data.version}</span>}
        <input className="inp f1" style={{ minWidth: 220, fontSize: 15, fontWeight: 600 }} placeholder="What this test proves, e.g. Customer can pay with a saved card" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Test title" disabled={!editable} />
        {testId && <button className="btn" onClick={showCode}>{code ? 'Hide code' : 'View code'}</button>}
        {testId && editable && existing.data?.status !== 'archived' && <button className="btn" onClick={eject} title="One way: the test becomes a spec file you edit as code">Convert to code</button>}
        {testId && can('run.create') && <button className="btn" onClick={() => setRunUrl(runUrl === null ? lastRunUrl() : null)}><Icon name="play" size={12} />Run</button>}
        {testId && editable && existing.data?.status !== 'archived' && <button className="btn" onClick={remove} title="Removes it from the list; past runs keep their results">Delete</button>}
        {editable && <button className="btn primary" onClick={save} disabled={saving || title.trim().length < 3}>{saving ? 'Checking…' : 'Save'}</button>}
      </div>
      <div className={s.body}>
        {runUrl !== null && (
          <div className="row" style={{ gap: 8 }}>
            <label htmlFor="run-url" className="t3" style={{ fontSize: 12 }}>Run against</label>
            <input id="run-url" className="inp f1" value={runUrl} onChange={(e) => setRunUrl(e.target.value)} placeholder="https://staging.example.com" />
            <button className="btn primary" onClick={run} disabled={!/^https?:\/\/.+/.test(runUrl)}>Start headless run</button>
          </div>
        )}
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="field">
            <label htmlFor="t-data">Data set</label>
            <select id="t-data" className="inp" value={dataSetId ?? ''} onChange={(e) => setDataSetId(e.target.value || null)} disabled={!editable}>
              <option value="">None (runs once)</option>
              {dataSets.data?.map((d) => <option key={d.id} value={d.id}>{d.name} · {fmt(d.rowCount)} rows</option>)}
            </select>
          </div>
          <div className="field f1">
            <label htmlFor="t-secrets">Secrets used <span className="t3" style={{ fontWeight: 400 }}>· names only, e.g. password</span></label>
            <input id="t-secrets" className="inp" value={secrets} onChange={(e) => setSecrets(e.target.value)} disabled={!editable} />
          </div>
        </div>
        <div className="t3" style={{ fontSize: 12 }}>
          Values can use <span className="mono">{'{data.column}'}</span>, <span className="mono">{'{secret.name}'}</span>, <span className="mono">{'{env.baseUrl}'}</span> and <span className="mono">{'{vars.name}'}</span>.
          {dataSetId && dataSets.data && <> Columns: <span className="mono">{dataSets.data.find((d) => d.id === dataSetId)?.columns.join(', ')}</span></>}
        </div>
        {testIssues.map((i, n) => <div key={n} className={i.severity === 'error' ? 'err' : 't3'} style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {i.message}</div>)}

        {existing.data?.intent && (
          <div className={s.intent}>
            <div><b>Intent</b> {existing.data.intent.intent}</div>
            <div><b>Goal</b> {existing.data.intent.goal}</div>
            {existing.data.intent.prerequisites && <div><b>Prerequisites</b> {existing.data.intent.prerequisites}</div>}
          </div>
        )}
        {steps.map((st, i) =>
          st.action === 'use_component' ? (
            <SegmentStep key={st.id} step={st} index={i} components={components.data ?? []} issues={issues.filter((x) => x.stepIndex === i)} editable={editable}
              onChange={(patch) => edit(i, patch)} onMove={(d) => move(i, d)} onRemove={() => setSteps((all) => all.filter((_, n) => n !== i))} />
          ) : (
            <StepEditor key={st.id} step={st} index={i} elements={elements.data ?? []} issues={issues.filter((x) => x.stepIndex === i)} editable={editable}
              onChange={(patch) => edit(i, patch)} onMove={(d) => move(i, d)} onRemove={() => setSteps((all) => all.filter((_, n) => n !== i))} />
          ),
        )}
        {editable && <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setSteps((all) => [...all, blankStep()])}><Icon name="plus" size={12} />Add step</button>}
        {testId && (
          <section className="col" style={{ gap: 6 }}>
            <b style={{ fontSize: 13 }}>Runs of this test</b>
            {runs.isLoading ? (
              <span className="t3" style={{ fontSize: 12 }}>Loading…</span>
            ) : !runs.data?.length ? (
              <span className="t3" style={{ fontSize: 12 }}>Not run yet. Press Run, give the address of the site to test, then Start headless run.</span>
            ) : (
              <div className={s.testRuns}>
                {runs.data.slice(0, 10).map((r) => (
                  <button key={r.id} className={s.testRun} onClick={() => onRun(r.id)} title="Open the run: each data row, its steps, screenshots and trace">
                    <span className="mono">{r.key}</span>
                    {r.status === 'done' ? <ResultStatus result={r.counts.failed + r.counts.error > 0 ? 'failed' : 'passed'} size={12} /> : <span className="pill" style={{ height: 18, fontSize: 10.5 }}>{r.status}</span>}
                    <span className="t3">{r.counts.passed}/{r.counts.total} passed{r.counts.failed ? ` · ${r.counts.failed} failed` : ''}{r.counts.flaky ? ` · ${r.counts.flaky} flaky` : ''}</span>
                    <span className="t3 trunc f1">{r.baseUrl}</span>
                    <span className="t3">{ago(r.createdAt)}</span>
                    <Icon name="chevRight" size={11} />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {code && (
          <div className="col" style={{ gap: 6 }}>
            <span className="t3" style={{ fontSize: 12 }}>{code.runnable ? 'Generated Playwright code (what the runner executes):' : 'Has a manual step: unattended runs skip this test.'}</span>
            <pre className={s.code}>{code.code}</pre>
          </div>
        )}
      </div>
    </>
  );
}

const RUN_URL = 'tb.studio.runUrl';
/** The last address a test was run against, so the next run starts from it. */
function lastRunUrl(): string {
  try {
    return localStorage.getItem(RUN_URL) || 'https://';
  } catch {
    return 'https://';
  }
}

/**
 * A step that runs a saved segment (component). Shown as the segment it is, with its inputs, rather
 * than as an ordinary step: its own steps are edited on the segment, where every test using it shares them.
 */
function SegmentStep({ step, index, components, issues, editable, onChange, onMove, onRemove }: {
  step: AutoStep; index: number; components: StudioComponent[]; issues: StepIssue[]; editable: boolean;
  onChange(patch: Partial<AutoStep>): void; onMove(d: -1 | 1): void; onRemove(): void;
}) {
  const use = step.component;
  const comp = use && components.find((c) => c.id === use.id);
  const setInput = (k: string, v: string) => use && onChange({ component: { ...use, inputs: { ...use.inputs, [k]: v } } });
  return (
    <div className={`${s.step} ${issues.some((i) => i.severity === 'error') ? s.bad : ''}`}>
      <div className={s.stepRow}>
        <span className={s.no}>{index + 1}</span>
        <div className="col f1" style={{ gap: 2 }}>
          <span><span className="t3">Uses segment</span> <b>{comp?.name ?? 'Unknown segment'}</b> <span className="t3">v{use?.version}{comp && comp.version !== use?.version ? ` (v${comp.version} is newer)` : ''}</span></span>
          {comp && (comp.meta.purpose || comp.meta.leaves) && (
            <span className="t3" style={{ fontSize: 12 }}>
              {comp.meta.purpose}
              {comp.meta.leaves ? `${comp.meta.purpose ? ' · ' : ''}leaves: ${comp.meta.leaves}` : ''} · {comp.steps.length} steps
            </span>
          )}
        </div>
        {editable && (
          <span className="row" style={{ gap: 2 }}>
            <button className="ib sm" aria-label="Move up" onClick={() => onMove(-1)}><Icon name="back" size={12} /></button>
            <button className="ib sm" aria-label="Move down" onClick={() => onMove(1)}><Icon name="forward" size={12} /></button>
            <button className="ib sm" aria-label="Remove step" onClick={onRemove}><Icon name="x" size={12} /></button>
          </span>
        )}
      </div>
      {use && Object.keys(use.inputs).length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', paddingLeft: 30 }}>
          {Object.entries(use.inputs).map(([k, v]) => (
            <div key={k} className="field">
              <label htmlFor={`in-${step.id}-${k}`}>{k}{comp?.meta.inputKinds[k] ? <span className="t3" style={{ fontWeight: 400 }}> · {comp.meta.inputKinds[k]}</span> : null}</label>
              <input id={`in-${step.id}-${k}`} className="inp mono" value={v} onChange={(e) => setInput(k, e.target.value)} disabled={!editable} />
            </div>
          ))}
        </div>
      )}
      {issues.map((i, n) => <div key={n} className={i.severity === 'error' ? 'err' : 't3'} style={{ fontSize: 12, paddingLeft: 30 }}><Icon name="alert" size={12} /> {i.message}</div>)}
    </div>
  );
}

function StepEditor({ step, index, elements, issues, editable, onChange, onMove, onRemove }: {
  step: AutoStep; index: number; elements: PageElement[]; issues: StepIssue[]; editable: boolean;
  onChange(patch: Partial<AutoStep>): void; onMove(d: -1 | 1): void; onRemove(): void;
}) {
  const target = step.target;
  const inline = target && 'locator' in target ? target.locator : null;
  const setTarget = (v: string) => {
    if (v === '') onChange({ target: undefined });
    else if (v === 'inline') onChange({ target: { locator: { strategy: 'testid', value: '' } } });
    else onChange({ target: { elementId: v } });
  };
  const setLocator = (patch: Partial<Locator>) => onChange({ target: { locator: { ...(inline ?? { strategy: 'testid', value: '' }), ...patch } } });
  const setAssertion = (n: number, patch: Partial<Assertion>) => onChange({ assertions: step.assertions.map((a, k) => (k === n ? { ...a, ...patch } : a)) });
  const changing = CHANGING_ACTIONS.includes(step.action);

  return (
    <div className={`${s.step} ${issues.some((i) => i.severity === 'error') ? s.bad : ''}`}>
      <div className={s.stepRow}>
        <span className={s.no}>{index + 1}</span>
        <div className="field">
          <label htmlFor={`a-${step.id}`}>Action</label>
          <select id={`a-${step.id}`} className="inp" value={step.action} onChange={(e) => onChange({ action: e.target.value as AutoStep['action'] })} disabled={!editable}>
            {STEP_ACTIONS.filter((a) => a !== 'use_component' && a !== 'api_request').map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
          </select>
        </div>
        {NEEDS_TARGET.includes(step.action) && (
          <div className="field">
            <label htmlFor={`t-${step.id}`}>Element</label>
            <select id={`t-${step.id}`} className="inp" value={!target ? '' : 'elementId' in target ? target.elementId : 'inline'} onChange={(e) => setTarget(e.target.value)} disabled={!editable}>
              <option value="">Choose…</option>
              {elements.map((el) => <option key={el.id} value={el.id}>{el.page} › {el.name}</option>)}
              <option value="inline">Locate it here…</option>
            </select>
          </div>
        )}
        {inline && (
          <>
            <div className="field">
              <label htmlFor={`ls-${step.id}`}>Find by</label>
              <select id={`ls-${step.id}`} className="inp" value={inline.strategy} onChange={(e) => setLocator({ strategy: e.target.value as LocatorStrategy })} disabled={!editable}>
                {LOCATOR_STRATEGIES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor={`lv-${step.id}`}>{inline.strategy === 'role' ? 'Role' : 'Value'}</label><input id={`lv-${step.id}`} className="inp" value={inline.value} onChange={(e) => setLocator({ value: e.target.value })} disabled={!editable} /></div>
            {inline.strategy === 'role' && <div className="field"><label htmlFor={`ln-${step.id}`}>Name</label><input id={`ln-${step.id}`} className="inp" value={inline.name ?? ''} onChange={(e) => setLocator({ name: e.target.value || undefined })} disabled={!editable} /></div>}
          </>
        )}
        {NEEDS_VALUE.includes(step.action) && (
          <div className="field f1" style={{ minWidth: 180 }}>
            <label htmlFor={`v-${step.id}`}>{step.action === 'open' ? 'Address' : step.action === 'press' ? 'Key' : step.action === 'manual' ? 'What the tester does' : 'Value'}</label>
            <input id={`v-${step.id}`} className="inp mono" value={step.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} placeholder={step.action === 'open' ? '{env.baseUrl}/login' : step.action === 'press' ? 'Enter' : ''} disabled={!editable} />
          </div>
        )}
        {editable && (
          <span className="row" style={{ gap: 2 }}>
            <button className="ib sm" aria-label="Move up" onClick={() => onMove(-1)}><Icon name="back" size={12} /></button>
            <button className="ib sm" aria-label="Move down" onClick={() => onMove(1)}><Icon name="forward" size={12} /></button>
            <button className="ib sm" aria-label="Remove step" onClick={onRemove}><Icon name="x" size={12} /></button>
          </span>
        )}
      </div>
      <div className={s.assert}>
        <input className="inp f1" style={{ height: 26, fontSize: 12 }} placeholder="Why: what this step is for (helps heal and explain failures)" value={step.intent} onChange={(e) => onChange({ intent: e.target.value })} disabled={!editable} aria-label="Intent" />
      </div>
      {step.assertions.map((a, n) => (
        <div key={n} className={s.assert}>
          <Icon name="check" size={12} />
          <span className="t3">{PAGE_ASSERTIONS.includes(a.kind) || BROWSER_ASSERTIONS.includes(a.kind) ? 'Then' : 'Then the element'}</span>
          <select className="inp" style={{ height: 26 }} value={a.kind} onChange={(e) => setAssertion(n, { kind: e.target.value as AssertionKind })} disabled={!editable} aria-label="Check">
            {ASSERTIONS.filter((k) => k !== 'status_equals').map((k) => <option key={k} value={k}>{ASSERT_LABEL[k]}</option>)}
          </select>
          {NEEDS_EXPECTED.includes(a.kind) && <input className="inp mono" style={{ height: 26 }} value={a.expected ?? ''} onChange={(e) => setAssertion(n, { expected: e.target.value })} aria-label="Expected" disabled={!editable} />}
          {BROWSER_ASSERTIONS.includes(a.kind) && (
            <>
              <input className="inp mono" style={{ height: 26 }} value={a.key ?? ''} placeholder={a.kind === 'api_called' ? 'POST /api/projects' : 'key'} onChange={(e) => setAssertion(n, { key: e.target.value })} aria-label={a.kind === 'api_called' ? 'Method and path' : 'Key'} disabled={!editable} />
              <input className="inp mono" style={{ height: 26 }} value={a.expected ?? ''} placeholder={a.kind === 'api_called' ? 'status (optional)' : 'value (optional)'} onChange={(e) => setAssertion(n, { expected: e.target.value || undefined })} aria-label={a.kind === 'api_called' ? 'Status' : 'Value'} disabled={!editable} />
            </>
          )}
          <label className="row t3" style={{ gap: 4 }}><input type="checkbox" className="cb" checked={a.soft} onChange={(e) => setAssertion(n, { soft: e.target.checked })} disabled={!editable} />keep going if it fails</label>
          {editable && <button className="ib sm" aria-label="Remove check" onClick={() => onChange({ assertions: step.assertions.filter((_, k) => k !== n) })}><Icon name="x" size={11} /></button>}
        </div>
      ))}
      {editable && (
        <div className={s.assert}>
          <button className="btn sm" onClick={() => onChange({ assertions: [...step.assertions, { kind: step.action === 'open' ? 'title_contains' : 'visible', soft: false }] })}><Icon name="plus" size={11} />Add check</button>
          {changing && step.assertions.length === 0 && (
            <label className="row t3" style={{ gap: 4 }}><input type="checkbox" className="cb" checked={step.noCheck} onChange={(e) => onChange({ noCheck: e.target.checked })} />no check needed</label>
          )}
        </div>
      )}
      {issues.map((i, n) => <div key={n} className={`${s.issue} ${i.severity === 'error' ? 'err' : 't3'}`}>{i.message}</div>)}
    </div>
  );
}

// ---------- runs ----------

function RunList({ selected, onSelect }: { selected: string | null; onSelect(id: string): void }) {
  const { project } = useSession();
  const runs = useQuery({ queryKey: ['studio-runs', project.id], queryFn: () => get<AutoRun[]>(`/projects/${project.id}/studio/runs`), refetchInterval: 5_000 });
  return (
    <>
      <div className="hdr"><h3>Headless runs</h3></div>
      <div className={s.scroll}>
        {runs.data?.map((r) => (
          <button key={r.id} className={`${s.item} ${selected === r.id ? s.on : ''}`} onClick={() => onSelect(r.id)}>
            <span className="row" style={{ gap: 6 }}><span className="mono t3">{r.key}</span><span className="pill" style={{ height: 18, fontSize: 10.5 }}>{r.status}</span></span>
            <span className="trunc">{r.name}</span>
            <span className="t3" style={{ fontSize: 11.5 }}>{r.counts.passed} passed · {r.counts.failed} failed{r.counts.flaky ? ` · ${r.counts.flaky} flaky` : ''} · {ago(r.createdAt)}</span>
          </button>
        ))}
        {runs.data?.length === 0 && <div className="empty t3" style={{ padding: 24, fontSize: 12.5 }}>No runs yet. Open a test and press Run.</div>}
      </div>
    </>
  );
}

/** An address as a person reads it: masked values show as ••••, not %E2%80%A2. */
function readableUrl(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

/**
 * A running test as it happens: its page a few times a second and the step it is on. There is no
 * frame before the browser opens or for a code spec (which shows its step only); once the test
 * ends, its screenshots, video and trace below take over.
 */
function LiveView({ runId, itemId }: { runId: string; itemId: string }) {
  const { project } = useSession();
  const live = useQuery({
    queryKey: ['studio-live', itemId],
    queryFn: async () => (await api<LiveFrame | undefined>('GET', `/projects/${project.id}/studio/runs/${runId}/items/${itemId}/live`)) ?? null,
    refetchInterval: 500,
    // Keep the last frame on screen between polls instead of flashing empty.
    placeholderData: (prev) => prev,
  });
  const f = live.data;
  return (
    <div className={s.live} aria-live="polite">
      <div className="row" style={{ gap: 8 }}>
        <span className={s.liveDot} aria-hidden />
        <b style={{ fontSize: 12 }}>Live</b>
        <span className="trunc f1 t3" style={{ fontSize: 12 }}>{f?.step ?? 'Starting the browser…'}</span>
        {f?.url && <span className="trunc t3 mono" style={{ fontSize: 11, maxWidth: '40%' }} title={readableUrl(f.url)}>{readableUrl(f.url)}</span>}
      </div>
      {f?.frame ? (
        <img src={`data:image/jpeg;base64,${f.frame}`} alt={`What the test sees now${f.step ? `: ${f.step}` : ''}`} className={s.liveFrame} />
      ) : (
        <div className={`${s.liveFrame} ${s.liveEmpty}`}>{f ? 'This is a code spec: its steps show here, its page does not.' : 'Waiting for the first picture…'}</div>
      )}
    </div>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const run = useQuery({
    queryKey: ['studio-run', runId],
    queryFn: () => get<AutoRunDetail>(`/projects/${project.id}/studio/runs/${runId}`),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'queued' || q.state.data.status === 'running') ? 3_000 : false),
  });
  const r = run.data;
  if (!r) return <div className="empty t3" style={{ flex: 1 }}>Loading…</div>;
  const cancel = async () => {
    try {
      await api('POST', `/projects/${project.id}/studio/runs/${runId}/cancel`);
      await run.refetch();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not cancel', 'bad');
    }
  };
  return (
    <>
      <div className={s.head}>
        <span className="mono t3">{r.key}</span>
        <b className="f1">{r.name}</b>
        <span className="t3" style={{ fontSize: 12 }}>{r.baseUrl} · up to {r.maxParallel} at once</span>
        {(r.status === 'queued' || r.status === 'running') && can('run.create') && <button className="btn" onClick={cancel}>Cancel</button>}
      </div>
      <div className={s.body}>
        <div className="row" style={{ gap: 14, fontSize: 12.5 }}>
          <span className="pill">{r.status}</span>
          <span>{r.counts.passed} passed</span><span>{r.counts.failed} failed</span><span>{r.counts.flaky} flaky</span>
          <span>{r.counts.skipped} skipped</span><span>{r.counts.queued + r.counts.running} waiting</span>
        </div>
        {r.items.map((i) => (
          <div key={i.id} className={s.runItem}>
            <div className="row" style={{ gap: 8 }}>
              <span className={i.status === 'passed' ? 'st st-passed' : i.status === 'failed' || i.status === 'error' ? 'st st-failed' : 'st st-untested'}>{i.status}{i.flaky ? ' · flaky' : ''}</span>
              <span className="mono t3">{i.testKey} v{i.testVersion}</span>
              <span className="trunc f1">{i.title}{i.dataRow !== null ? ` · row ${i.dataRow + 1}` : ''}</span>
              {i.durationMs !== null && <span className="t3">{(i.durationMs / 1000).toFixed(1)} s</span>}
              {i.attempt > 1 && <span className="t3">attempt {i.attempt}</span>}
            </div>
            {i.status === 'running' && <LiveView runId={runId} itemId={i.id} />}
            {i.steps.map((st, n) => (
              <div key={n} className={s.stepResult}>
                <Icon name={st.status === 'passed' ? 'check' : 'x'} size={12} />
                <span className="f1">{st.title}</span>
                <span className="t3">{(st.durationMs / 1000).toFixed(1)} s</span>
              </div>
            ))}
            {i.error && <pre className={s.code} style={{ maxHeight: 180 }}>{i.error}</pre>}
            {i.evidence.length > 0 && (
              <div className="col" style={{ gap: 8, paddingLeft: 22 }}>
                {/* What the browser showed: the last screen of each attempt, and the recording when it failed. */}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  {i.evidence.filter((e) => e.kind === 'screenshot').map((e, n) => (
                    <a key={n} href={e.url} target="_blank" rel="noreferrer" title="Open full size">
                      <img src={e.url} alt={`Screen at the end of ${i.title}`} style={{ width: 280, borderRadius: 4, border: '1px solid var(--border)' }} />
                    </a>
                  ))}
                  {i.evidence.filter((e) => e.kind === 'video').map((e, n) => (
                    <video key={n} src={e.url} controls preload="metadata" style={{ width: 360, borderRadius: 4, border: '1px solid var(--border)' }} />
                  ))}
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {i.evidence.filter((e) => e.kind === 'trace').map((e, n) => (
                    <span key={n} className="row" style={{ gap: 6 }}>
                      <a className="pill" style={{ height: 24 }} href={`https://trace.playwright.dev/?trace=${encodeURIComponent(e.url)}`} target="_blank" rel="noreferrer" title="Replays every action with the page as it looked, network and console">
                        <Icon name="play" size={12} />Replay in trace viewer
                      </a>
                      <a className="t3" style={{ fontSize: 11.5 }} href={e.url} download>download trace · {bytes(e.sizeBytes)}</a>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- page library ----------

function ElementList() {
  const { project } = useSession();
  const elements = useQuery({ queryKey: ['studio-elements', project.id], queryFn: () => get<PageElement[]>(`/projects/${project.id}/studio/elements`) });
  return (
    <>
      <div className="hdr"><h3>Page library</h3>{elements.data && <span className="cnt">{elements.data.length}</span>}</div>
      <div className={s.scroll}>
        {elements.data?.map((el) => (
          <div key={el.id} className={s.item} style={{ cursor: 'default' }}>
            <span>{el.page} › <b>{el.name}</b></span>
            <span className="mono t3" style={{ fontSize: 11 }}>{el.locators[0]?.strategy}: {el.locators[0]?.value}{el.locators[0]?.name ? ` "${el.locators[0].name}"` : ''}</span>
          </div>
        ))}
        {elements.data?.length === 0 && <div className="empty t3" style={{ padding: 24, fontSize: 12.5 }}>Name the elements your tests use once, here; fixing a locator then fixes every test.</div>}
      </div>
    </>
  );
}

/**
 * Starts a picking session. The tester runs the bookmarklet on their own site in their own browser:
 * hovering shows ranked locators with how many elements each matches, and what they keep lands here.
 */
function PickFromSite() {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<PickerSession | null>(null);
  const [starting, setStarting] = useState(false);
  // React refuses to render a javascript: href, so the bookmarklet is set on the node itself.
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (session && link.current) link.current.setAttribute('href', session.bookmarklet);
  }, [session]);

  const start = async () => {
    setStarting(true);
    try {
      setSession(await api<PickerSession>('POST', `/projects/${project.id}/studio/picker`));
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not start picking', 'bad');
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="hdr"><h3>Pick from your site</h3><div className="f1" /><span className="t3" style={{ fontSize: 11.5 }}>Runs in your own browser; nothing is sent except what you keep</span></div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!session ? (
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={start} disabled={starting}>{starting ? 'Starting…' : 'Start picking'}</button>
            <span className="t3" style={{ fontSize: 12 }}>You get a bookmarklet to run on any page of your site.</span>
          </div>
        ) : (
          <>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.9 }}>
              <li>Drag this to your bookmarks bar: <a ref={link} onClick={(e) => e.preventDefault()} className="btn sm" style={{ textDecoration: 'none', cursor: 'grab' }} draggable>Pick locators · {project.key}</a></li>
              <li>Open your site in another tab and click the bookmark.</li>
              <li>Hover an element, click it, name it, then press <b>Send to Testbench</b>.</li>
            </ol>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => { void navigator.clipboard.writeText(session.consoleSnippet).then(() => notify('Loader copied; paste it into your browser console'), () => notify('Could not copy', 'bad')); }}>Copy console loader</button>
              <button className="btn sm" onClick={() => queryClient.invalidateQueries({ queryKey: ['studio-elements', project.id] })}>Refresh list</button>
              <span className="t3" style={{ fontSize: 11.5 }}>Expires {dateTimeIST(session.expiresAt)}. Use the console loader if your site's security policy blocks the bookmarklet.</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function ElementForm() {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState('');
  const [name, setName] = useState('');
  const [locator, setLocator] = useState<Locator>({ strategy: 'testid', value: '' });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api<PageElement>('PUT', `/projects/${project.id}/studio/elements`, { page, name, locators: [locator] });
      await queryClient.invalidateQueries({ queryKey: ['studio-elements', project.id] });
      notify(`${page} › ${name} saved`);
      setName('');
      setLocator({ strategy: locator.strategy, value: '' });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the element', 'bad');
    }
  };
  if (!can('run.execute')) return <div className="empty t3" style={{ flex: 1 }}>You can view the page library but not change it.</div>;
  return (
    <div className={s.body} style={{ maxWidth: 680 }}>
    <PickFromSite />
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Add or update an element</h2>
      <span className="t3" style={{ fontSize: 12 }}>Prefer a test id, then role and accessible name, then label. Saving an existing page + name updates it everywhere.</span>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="field f1"><label htmlFor="el-page">Page</label><input id="el-page" className="inp" value={page} onChange={(e) => setPage(e.target.value)} placeholder="Checkout" required /></div>
        <div className="field f1"><label htmlFor="el-name">Element name</label><input id="el-name" className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pay button" required /></div>
      </div>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="field">
          <label htmlFor="el-strategy">Find by</label>
          <select id="el-strategy" className="inp" value={locator.strategy} onChange={(e) => setLocator({ ...locator, strategy: e.target.value as LocatorStrategy })}>
            {LOCATOR_STRATEGIES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <div className="field f1"><label htmlFor="el-value">{locator.strategy === 'role' ? 'Role (button, link, textbox…)' : 'Value'}</label><input id="el-value" className="inp mono" value={locator.value} onChange={(e) => setLocator({ ...locator, value: e.target.value })} required /></div>
        {locator.strategy === 'role' && <div className="field f1"><label htmlFor="el-rname">Accessible name</label><input id="el-rname" className="inp" value={locator.name ?? ''} onChange={(e) => setLocator({ ...locator, name: e.target.value || undefined })} /></div>}
      </div>
      <button className="btn primary" style={{ alignSelf: 'flex-start' }}>Save element</button>
    </form>
    </div>
  );
}
