'use client';

import { SCENARIO_KINDS, UNIQUE_TOKEN, type ChatAnswer, type Expectation, type GeneratedTests, type Scenario, type Seen, type StudioComponent, type Workflow, type WorkflowPlan } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import type { RunDone, SiteGuide } from '../ide/SitePane';
import { ChecksEditor, describeCheck } from './checks';
import { PrerequisiteRun } from './PrerequisiteRun';
import w from './workflows.module.css';

type Message = { role: 'tester' | 'assistant'; text: string };
type Check = { proposed: Expectation; differences: string[] };

const OUTCOME = { success: 'Accepted', rejected: 'Refused' } as const;
const PAGE = { any: 'Either', moves_on: 'Moves to another page', stays: 'Stays on the page' } as const;
const DIALOG = { any: 'No dialog / either', closes: 'Closes', stays_open: 'Stays open' } as const;
const blankExpect: Expectation = { outcome: 'success', message: '', fieldErrors: [], page: 'any', dialog: 'any', stop: null, checks: [] };

/** The tester's expectation with the blanks filled from what the run saw: exact texts, page and dialog. */
function mergeExpect(mine: Expectation, seen: Expectation): Expectation {
  const seenOn = (field: string) => seen.fieldErrors.filter((x) => x.field === field);
  return {
    outcome: mine.outcome,
    message: mine.message || seen.message,
    // A field can show the browser's bubble and the app's text at once: both are kept, as two checks.
    fieldErrors: [
      ...mine.fieldErrors.flatMap((e) => (e.message || !seenOn(e.field).length ? [e] : seenOn(e.field))),
      ...seen.fieldErrors.filter((x) => !mine.fieldErrors.some((e) => e.field === x.field)),
    ],
    page: mine.page === 'any' ? seen.page : mine.page,
    dialog: mine.dialog === 'any' ? seen.dialog : mine.dialog,
    stop: mine.stop ?? seen.stop,
    checks: mine.checks,
  };
}

/** This run's stand-in for {unique}: 8 characters, as the generated test makes at run time. */
const uniqueId = () => (Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 4)).padEnd(8, '0');

/**
 * What a run saw, as Seen: capped as Seen caps it, where it stopped, and this run's unique value put
 * back as {unique}, so a message quoting it ("Project Alpha x1y2z3ab created") holds on every run.
 */
function seenOf(done: RunDone, stepIds: string[], unique: string): Seen {
  const back = (t: string) => t.split(unique).join(UNIQUE_TOKEN);
  const snap = done.snapshot;
  const at = done.failedAt === null ? undefined : stepIds[done.failedAt];
  return {
    url: back(snap?.url ?? '').slice(0, 4000),
    title: back(snap?.title ?? '').slice(0, 300),
    dialogs: (snap?.dialogs ?? []).slice(0, 5).map((d) => back(d).slice(0, 120)),
    messages: (snap?.messages ?? []).slice(0, 10).map((m) => back(m).slice(0, 300)),
    fieldErrors: (snap?.fieldErrors ?? []).slice(0, 30).map((e) => ({ ...e, field: e.field.slice(0, 200), message: back(e.message).slice(0, 300) })),
    failed: done.ok ? null : (done.error ? back(done.error) : 'The run stopped').slice(0, 500),
    stoppedAt: at ? { stepId: at, kind: done.blocked ?? 'error' } : null,
    storage: (snap?.storage ?? []).map((x) => ({ ...x, value: back(x.value) })),
    apis: (done.apis ?? []).slice(0, 60),
  };
}

/**
 * Testing a saved workflow: agree the scenarios in a chat (the AI asks what the recording cannot
 * show), run each one in the Test Browser to see what the app really does, confirm or correct the
 * expectation, then turn the confirmed ones into data-driven tests.
 */
export function Scenarios({ workflow, components, guide, stage, onStage, plan, update: updatePlan, autoRun, prerequisiteRan, onPlan }: {
  workflow: Workflow;
  components: StudioComponent[];
  guide: SiteGuide;
  stage: 'scenarios' | 'tests';
  onStage(s: 'scenarios' | 'tests'): void;
  /** The workflow's saved plan: what to test, the chat and the scenarios, shared with the project. */
  plan: WorkflowPlan;
  update(patch: Partial<WorkflowPlan> | ((p: WorkflowPlan) => Partial<WorkflowPlan>)): void;
  /** The scenarios were just built: run them all as soon as the browser is ready. */
  autoRun: boolean;
  /** The prerequisite already ran in this browser (in the first step). */
  prerequisiteRan: boolean;
  onPlan(): void;
}) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const messages = plan.messages;
  const scenarios = plan.scenarios;
  const setMessages = (next: Message[]) => updatePlan({ messages: next });
  const setScenarios = (next: Scenario[] | ((list: Scenario[]) => Scenario[])) =>
    updatePlan((p) => ({ scenarios: typeof next === 'function' ? next(p.scenarios) : next }));
  const [checks, setChecks] = useState<Record<string, Check>>({});
  // What each saved run disagrees with is worked out again on opening, from what it saw.
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const sc of plan.scenarios.filter((x) => x.seen)) {
        const check = await api<Check>('POST', `/projects/${project.id}/studio/workflows/${workflow.id}/seen`, { scenario: sc }).catch(() => null);
        if (!live) return;
        if (check) setChecks((c) => ({ ...c, [sc.id]: check }));
      }
    })();
    return () => {
      live = false;
    };
  }, [workflow.id]);
  const [say, setSay] = useState('');
  const [chatting, setChatting] = useState(false);
  const [ai, setAi] = useState<ChatAnswer['ai'] | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [preReady, setPreReady] = useState(!workflow.prerequisite || prerequisiteRan);
  const [title, setTitle] = useState(workflow.name);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GeneratedTests | null>(null);

  const part = components.find((c) => c.id === workflow.id);
  const pre = workflow.prerequisite ? components.find((c) => c.id === workflow.prerequisite!.id) : undefined;
  const [preValues, setPreValues] = useState<Record<string, string>>(() =>
    pre ? Object.fromEntries(pre.inputs.filter((k) => !pre.meta.secretInputs.includes(k)).map((k) => [k, pre.meta.defaults[k] || part?.meta.defaults[k] || ''])) : {},
  );
  const fields = workflow.fields.filter((f) => !f.secret);
  const label = (k: string) => workflow.fields.find((f) => f.key === k)?.label ?? k;
  const stepName = (id: string) => workflow.steps.find((x) => x.id === id)?.label ?? id;


  const chat = async (text: string | null) => {
    const next = text ? [...messages, { role: 'tester' as const, text }] : messages;
    setMessages(next);
    setSay('');
    setChatting(true);
    try {
      const answer = await api<ChatAnswer>('POST', `/projects/${project.id}/studio/workflows/${workflow.id}/chat`, {
        messages: next,
        scenarios,
        intent: plan.intent,
        validations: plan.validations,
      });
      setMessages([...next, { role: 'assistant', text: answer.reply }]);
      setScenarios(answer.scenarios);
      setAi(answer.ai);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'The chat could not answer', 'bad');
    } finally {
      setChatting(false);
    }
  };


  const update = (id: string, change: Partial<Scenario>) => setScenarios((list) => list.map((x) => (x.id === id ? { ...x, ...change } : x)));
  // A run is only evidence for the values it ran with; a changed expectation is compared with it again.
  const recheck = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const edit = (id: string, change: Partial<Scenario>) => {
    const sc = scenarios.find((x) => x.id === id);
    if (!sc) return;
    const next: Scenario = { ...sc, ...change, status: 'draft' };
    const valuesChanged = !!change.values && JSON.stringify(change.values) !== JSON.stringify(sc.values);
    if (valuesChanged) next.seen = null;
    update(id, next);
    setChecks(({ [id]: _, ...rest }) => rest);
    clearTimeout(recheck.current.get(id));
    if (!next.seen || !change.expect) return;
    recheck.current.set(
      id,
      setTimeout(() => {
        api<Check>('POST', `/projects/${project.id}/studio/workflows/${workflow.id}/seen`, { scenario: next })
          .then((check) => setChecks((c) => ({ ...c, [id]: check })))
          .catch(() => {});
      }, 500),
    );
  };
  /** Confirming a run that matched takes what it saw, which is as specific as the tester's words or more. */
  const confirm = (sc: Scenario) => {
    if (sc.status === 'confirmed') return update(sc.id, { status: sc.seen ? 'seen' : 'draft' });
    const check = checks[sc.id];
    update(sc.id, { status: 'confirmed', ...(sc.seen && check && !check.differences.length ? { expect: mergeExpect(sc.expect, check.proposed) } : {}) });
  };

  const discover = async (sc: Scenario) => {
    if (!part) return;
    setRunning(sc.id);
    try {
      const unique = uniqueId();
      const values = Object.fromEntries(Object.entries(sc.values).map(([k, v]) => [k, v.split(UNIQUE_TOKEN).join(unique)]));
      // A workflow that carries on in place (no start page of its own) gets its page reloaded, so a
      // toast or dialog left by the scenario before is not taken for this one's.
      const done = await guide.run(part.steps, values, {}, workflow.baseUrl, undefined, part.steps[0]?.action !== 'open');
      const next: Scenario = { ...sc, seen: seenOf(done, part.steps.map((x) => x.id), unique), status: 'seen' };
      const check = await api<Check>('POST', `/projects/${project.id}/studio/workflows/${workflow.id}/seen`, { scenario: next });
      setScenarios((list) => list.map((x) => (x.id === sc.id ? next : x)));
      setChecks((c) => ({ ...c, [sc.id]: check }));
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not run the scenario', 'bad');
    } finally {
      setRunning(null);
    }
  };
  const discoverAll = async () => {
    for (const sc of scenarios) await discover(sc);
  };
  // Each scenario changes what the form must do, so each is run and watched before anything is written.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !autoRun || !part || !guide.connected || !preReady || running) return;
    autoRan.current = true;
    void discoverAll();
  }, [autoRun, part, guide.connected, preReady]);

  const confirmed = scenarios.filter((x) => x.status === 'confirmed');
  const generate = async () => {
    setGenerating(true);
    try {
      const out = await api<GeneratedTests>('POST', `/projects/${project.id}/studio/workflows/${workflow.id}/tests`, { title: title.trim(), scenarios: confirmed });
      setGenerated(out);
      for (const key of [['studio-tests', project.id], ['data-sets', project.id]]) await queryClient.invalidateQueries({ queryKey: key });
      notify(`${out.tests.length} test${out.tests.length === 1 ? '' : 's'} made from ${confirmed.length} scenarios`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not make the tests', 'bad');
    } finally {
      setGenerating(false);
    }
  };

  if (!part) return <div className={w.body}><span className={w.muted}>Loading the workflow…</span></div>;

  if (stage === 'tests') {
    const unconfirmed = scenarios.length - confirmed.length;
    return (
      <>
        <div className={w.body}>
          <p className={w.lead}>
            Confirmed scenarios become tests. Those that expect the same things share one data-driven test, a row each;
            a refusal by a different field, or a success, is a test of its own.
          </p>
          <label className={w.field}>
            <span>Test title</span>
            <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <table className={w.table}>
            <thead><tr><th>Scenario</th><th>Expected</th></tr></thead>
            <tbody>
              {confirmed.map((sc) => (
                <tr key={sc.id}>
                  <td>{sc.title}</td>
                  <td>
                    {OUTCOME[sc.expect.outcome]}
                    {sc.expect.message && ` · “${sc.expect.message}”`}
                    {sc.expect.fieldErrors.map((e) => ` · ${label(e.field)}: “${e.message || 'an error'}”`).join('')}
                    {sc.expect.stop && ` · stops at “${stepName(sc.expect.stop.stepId)}” (${sc.expect.stop.kind})`}
                    {sc.expect.checks.map((c) => ` · ${describeCheck(c)}`).join('')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {unconfirmed > 0 && <span className={w.warn}>{unconfirmed} scenario{unconfirmed === 1 ? ' is' : 's are'} not confirmed and will be left out.</span>}
          {pre && pre.meta.secretInputs.length > 0 && (
            <span className={w.muted}>
              Test runs read the prerequisite’s secret{pre.meta.secretInputs.length === 1 ? '' : 's'} from the runner’s environment:{' '}
              {pre.meta.secretInputs.map((k) => <code key={k}>TB_SECRET_{k} </code>)}
            </span>
          )}
          {generated && (
            <div className={w.box}>
              <b className={w.ok}>Made {generated.tests.length} test{generated.tests.length === 1 ? '' : 's'}</b>
              {generated.tests.map((t) => (
                <Link key={t.id} className={w.row} href={`/automation?tab=tests&id=${t.id}`}>
                  <b>{t.key}</b> {t.title} <span className={w.muted}>{t.rows} row{t.rows === 1 ? '' : 's'}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className={w.foot}>
          <button className="btn sm" onClick={() => onStage('scenarios')}>Back to scenarios</button>
          <div className="f1" />
          <button className="btn sm primary" disabled={generating || !confirmed.length || title.trim().length < 3} onClick={generate}>
            {generating ? 'Making tests…' : `Make tests from ${confirmed.length} scenario${confirmed.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={w.body}>
        <section className={w.chat} aria-label="Scenario chat" aria-live="polite">
          {messages.map((m, i) => (
            <div key={i} className={`${w.msg} ${m.role === 'assistant' ? w.fromAi : w.fromTester}`}>{m.text}</div>
          ))}
          {chatting && <div className={`${w.msg} ${w.fromAi} ${w.muted}`}>Thinking… a local model can take a minute.</div>}
          {ai && ai.status !== 'used' && <span className={w.warn}>{ai.message ?? 'The AI is off; scenarios come from the fields’ rules.'}</span>}
          <div className={w.say}>
            <textarea
              className="inp"
              rows={2}
              value={say}
              onChange={(e) => setSay(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && say.trim() && !chatting && chat(say.trim())}
              placeholder="What should be tested? e.g. “an empty name shows ‘Project name is required’ under the field”"
              aria-label="Message to the scenario chat"
            />
            <button className="btn sm primary" disabled={!say.trim() || chatting} onClick={() => chat(say.trim())}>Send</button>
          </div>
        </section>

        {pre && (
          <PrerequisiteRun component={pre} components={components} guide={guide} values={preValues} onValues={setPreValues} onDone={setPreReady} site={workflow.baseUrl} />
        )}

        <div className={w.row}>
          <b className="f1">Scenarios ({scenarios.length})</b>
          <button className="btn sm" onClick={() => setScenarios([...scenarios, { id: `t${Date.now().toString(36)}`, title: 'New scenario', kind: 'positive', values: Object.fromEntries(fields.map((f) => [f.key, f.recorded])), expect: blankExpect, seen: null, status: 'draft', source: 'tester' }])}>
            <Icon name="plus" size={11} /> Add
          </button>
          <button className="btn sm" disabled={!guide.connected || !!running || !scenarios.length} title={preReady ? undefined : 'Run the prerequisite first, so each scenario starts where it leaves'} onClick={discoverAll}>
            <Icon name="play" size={11} /> Run all
          </button>
        </div>
        {!guide.connected && <span className={w.muted}>Open the site in the Test Browser to run scenarios and see what the app does.</span>}
        {autoRun && guide.connected && !preReady && <span className={w.warn}>Run the prerequisite above: the scenarios then run by themselves.</span>}
        {!scenarios.length && (
          <div className={w.box}>
            <span>No scenarios yet. Say what you want to test and how each field is validated; scenarios are built from that.</span>
            <button className="btn sm primary" style={{ alignSelf: 'flex-start' }} onClick={onPlan}>What to test</button>
          </div>
        )}

        {(
          [
            ['Positive', scenarios.filter((x) => x.expect.outcome === 'success')],
            ['Negative', scenarios.filter((x) => x.expect.outcome === 'rejected')],
          ] as const
        ).map(([name, list]) =>
          list.length ? (
            <details key={name} className={w.section} open>
              <summary>
                {name} ({list.length})
                <span className={w.muted}>
                  {list.filter((x) => x.status === 'confirmed').length} confirmed
                  {list.some((x) => checks[x.id]?.differences.length) ? ` · ${list.filter((x) => checks[x.id]?.differences.length).length} differ` : ''}
                </span>
              </summary>
              {list.map((sc) => (
                <ScenarioCard
                  key={sc.id}
                  sc={sc}
                  workflow={workflow}
                  check={checks[sc.id]}
                  running={running === sc.id}
                  canRun={guide.connected && !running}
                  onEdit={(change) => edit(sc.id, change)}
                  onRemove={() => setScenarios(scenarios.filter((x) => x.id !== sc.id))}
                  onRun={() => discover(sc)}
                  onAdopt={() => checks[sc.id] && update(sc.id, { expect: { ...checks[sc.id]!.proposed, checks: sc.expect.checks }, status: 'confirmed' })}
                  onConfirm={() => confirm(sc)}
                />
              ))}
            </details>
          ) : null,
        )}
      </div>
      <div className={w.foot}>
        <span className={w.muted}>{confirmed.length} of {scenarios.length} confirmed</span>
        <div className="f1" />
        <button className="btn sm primary" disabled={!confirmed.length} onClick={() => onStage('tests')}>
          Make tests <Icon name="arrowRight" size={11} />
        </button>
      </div>
    </>
  );
}

function ScenarioCard({ sc, workflow, check, running, canRun, onEdit, onRemove, onRun, onAdopt, onConfirm }: {
  sc: Scenario;
  workflow: Workflow;
  check: Check | undefined;
  running: boolean;
  canRun: boolean;
  onEdit(change: Partial<Scenario>): void;
  onRemove(): void;
  onRun(): void;
  onAdopt(): void;
  onConfirm(): void;
}) {
  const fields = workflow.fields.filter((f) => !f.secret);
  const e = sc.expect;
  const setExpect = (change: Partial<Expectation>) => onEdit({ expect: { ...e, ...change } });
  const differs = !!check && check.differences.length > 0;
  const dialogs = workflow.pages.some((p) => p.messages.some((m) => m.kind === 'dialog'));
  // Where a refusal can stop the workflow: any step that acts on an element, up to the submit.
  const stoppable = workflow.steps.filter((x) => x.action !== 'open');
  const toggleUnique = (key: string) => {
    const v = sc.values[key] ?? '';
    onEdit({ values: { ...sc.values, [key]: v.includes(UNIQUE_TOKEN) ? v.split(UNIQUE_TOKEN).join('').trim() : `${v.trim()} ${UNIQUE_TOKEN}`.trim() } });
  };

  return (
    <article className={`${w.scenario} ${sc.status === 'confirmed' ? w.agreed : differs && sc.seen ? w.differs : ''}`} aria-label={sc.title}>
      <div className={w.row}>
        <select className={`inp ${w.small}`} style={{ width: 'auto' }} value={sc.kind} aria-label="Kind" onChange={(ev) => onEdit({ kind: ev.target.value as Scenario['kind'] })}>
          {SCENARIO_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input className={`inp f1 ${w.small}`} value={sc.title} aria-label="Scenario title" onChange={(ev) => onEdit({ title: ev.target.value })} />
        <span className={`${w.badge} ${sc.status === 'confirmed' ? w.ok : sc.status === 'seen' ? w.warn : w.muted}`}>
          {sc.status === 'confirmed' ? 'Confirmed' : sc.status === 'seen' ? 'Run' : sc.source === 'ai' ? 'AI draft' : 'Draft'}
        </span>
        <button className="ib sm" aria-label={`Remove ${sc.title}`} onClick={onRemove}><Icon name="x" size={10} /></button>
      </div>

      <div className={w.values}>
        {fields.map((f) => (
          <label key={f.key}>
            {f.label}{f.rules.required ? ' *' : ''}
            {f.kind === 'select' && f.rules.options.length ? (
              <select className={`inp ${w.small}`} value={sc.values[f.key] ?? ''} onChange={(ev) => onEdit({ values: { ...sc.values, [f.key]: ev.target.value } })}>
                {[...new Set(['', ...f.rules.options, sc.values[f.key] ?? ''])].map((o) => <option key={o} value={o}>{o || '(empty)'}</option>)}
              </select>
            ) : (
              <span className={w.row} style={{ flexWrap: 'nowrap' }}>
                <input
                  className={`inp f1 ${w.small}`}
                  type={f.kind === 'date' ? 'date' : 'text'}
                  maxLength={f.rules.maxLength > 0 ? f.rules.maxLength : undefined}
                  value={sc.values[f.key] ?? ''}
                  placeholder="(empty)"
                  onChange={(ev) => onEdit({ values: { ...sc.values, [f.key]: ev.target.value } })}
                />
                {f.kind !== 'date' && (
                  <button
                    type="button"
                    className={w.uniq}
                    aria-pressed={(sc.values[f.key] ?? '').includes(UNIQUE_TOKEN)}
                    title="Add {unique}: replaced on every run by a new value of 8 characters, for an app that refuses a value already used"
                    onClick={() => toggleUnique(f.key)}
                  >
                    unique
                  </button>
                )}
              </span>
            )}
          </label>
        ))}
      </div>

      <div className={w.expect}>
        <label>
          The form is
          <select className={`inp ${w.small}`} value={e.outcome} onChange={(ev) => setExpect({ outcome: ev.target.value as Expectation['outcome'] })}>
            {Object.entries(OUTCOME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>
          Toast or message
          <input className={`inp ${w.small}`} value={e.message} placeholder="none" onChange={(ev) => setExpect({ message: ev.target.value })} />
        </label>
        <label>
          Page after submit
          <select className={`inp ${w.small}`} value={e.page} onChange={(ev) => setExpect({ page: ev.target.value as Expectation['page'] })}>
            {Object.entries(PAGE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {e.outcome === 'rejected' && stoppable.length > 0 && (
          <label title="Some of the workflow still works: it runs as far as this step, which the form keeps disabled (or hides) while a field is invalid">
            Stops at
            <select
              className={`inp ${w.small}`}
              value={e.stop ? `${e.stop.stepId}|${e.stop.kind}` : ''}
              onChange={(ev) => {
                const [stepId, kind] = ev.target.value.split('|');
                setExpect({ stop: stepId ? { stepId, kind: kind as 'disabled' | 'missing' } : null });
              }}
            >
              <option value="">Runs to the submit</option>
              {stoppable.flatMap((x) => [
                <option key={`${x.id}d`} value={`${x.id}|disabled`}>{x.label}: disabled</option>,
                <option key={`${x.id}m`} value={`${x.id}|missing`}>{x.label}: not there</option>,
              ])}
            </select>
          </label>
        )}
        {dialogs && (
          <label>
            Dialog
            <select className={`inp ${w.small}`} value={e.dialog} onChange={(ev) => setExpect({ dialog: ev.target.value as Expectation['dialog'] })}>
              {Object.entries(DIALOG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className={w.choices}>
        <span className={w.muted}>Inline errors</span>
        {e.fieldErrors.map((fe, i) => {
          const set = (change: Partial<typeof fe>) => setExpect({ fieldErrors: e.fieldErrors.map((x, j) => (j === i ? { ...x, ...change } : x)) });
          return (
            <div key={i} className={w.errRow}>
              <select className={`inp ${w.small}`} value={fe.field} aria-label="Field" onChange={(ev) => set({ field: ev.target.value })}>
                {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
              <input className={`inp ${w.small}`} value={fe.message} placeholder="any error text" aria-label="Error message" onChange={(ev) => set({ message: ev.target.value })} />
              <select className={`inp ${w.small}`} value={fe.source} aria-label="Shown by" title="The browser's own bubble, or text the app shows by the field" onChange={(ev) => set({ source: ev.target.value as 'native' | 'page' })}>
                <option value="page">page</option>
                <option value="native">browser</option>
              </select>
              <button className="ib sm" aria-label="Remove the error" onClick={() => setExpect({ fieldErrors: e.fieldErrors.filter((_, j) => j !== i) })}><Icon name="x" size={10} /></button>
            </div>
          );
        })}
        {fields.length > 0 && (
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setExpect({ fieldErrors: [...e.fieldErrors, { field: fields[0]!.key, message: '', source: 'page' }] })}>
            <Icon name="plus" size={10} /> Error
          </button>
        )}
      </div>

      <div className={w.choices}>
        <span className={w.muted}>Also check <em>cookies, storage and the APIs the page calls</em></span>
        <ChecksEditor
          compact
          checks={e.checks}
          onChange={(next) => setExpect({ checks: next })}
          apis={[...(sc.seen?.apis ?? []), ...workflow.apis]}
          storage={sc.seen?.storage ?? []}
        />
      </div>

      {sc.seen && (
        <details className={w.seen} open={differs || sc.status !== 'confirmed'}>
          <summary>
            What the app did{' '}
            {check && (differs ? <span className={w.warn}>· differs ({check.differences.length})</span> : <span className={w.ok}>· matches</span>)}
          </summary>
          {sc.seen.stoppedAt && sc.seen.stoppedAt.kind !== 'error' && (
            <span className={w.warn}>
              Ran up to “{workflow.steps.find((x) => x.id === sc.seen!.stoppedAt!.stepId)?.label ?? 'a step'}”, which was {sc.seen.stoppedAt.kind === 'disabled' ? 'disabled' : 'not there'}; the steps before it worked.
            </span>
          )}
          {sc.seen.failed && (!sc.seen.stoppedAt || sc.seen.stoppedAt.kind === 'error') && <span className={w.bad}>A step failed: {sc.seen.failed}</span>}
          <span>Messages: {sc.seen.messages.length ? sc.seen.messages.map((m) => `“${m}”`).join(', ') : 'none'}</span>
          <span>Inline errors: {sc.seen.fieldErrors.length ? sc.seen.fieldErrors.map((x) => `${x.field}: “${x.message}” (${x.source === 'native' ? 'browser' : 'page'})`).join('; ') : 'none'}</span>
          {sc.seen.dialogs.length > 0 && <span>Dialog still open: {sc.seen.dialogs.join(', ')}</span>}
          {sc.seen.apis.length > 0 && <span>APIs called: {sc.seen.apis.map((x) => `${x.method} ${x.path} → ${x.status ?? '–'}`).join(', ')}</span>}
          {sc.seen.storage.length > 0 && (
            <span>Stored: {sc.seen.storage.map((x) => `${x.area === 'cookie' ? 'cookie' : x.area === 'local' ? 'local' : 'session'} ${x.key}`).join(', ')}</span>
          )}
          <span className={w.muted}>Ended on {sc.seen.url}</span>
          {check && (check.differences.length ? (
            <>
              <b className={w.warn}>Differs from what you expect</b>
              <ul>{check.differences.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </>
          ) : (
            <span className={w.ok}>Matches what you expect.</span>
          ))}
        </details>
      )}

      <div className={w.row}>
        <button className="btn sm" disabled={!canRun} onClick={onRun}>
          <Icon name="play" size={10} /> {running ? 'Running…' : sc.seen ? 'Run again' : 'Run'}
        </button>
        {differs && sc.status !== 'confirmed' && (
          <button className="btn sm" onClick={onAdopt} title="Expect what the app did: it is the intended behaviour">Use what the app did</button>
        )}
        <button className={`btn sm ${sc.status === 'confirmed' ? '' : 'primary'}`} onClick={onConfirm} title={differs ? 'Keep your expectation: the test will fail until the app does it (a bug)' : undefined}>
          {sc.status === 'confirmed' ? 'Unconfirm' : differs ? 'Keep mine (a bug)' : 'Confirm'}
        </button>
        {!sc.seen && sc.status !== 'confirmed' && <span className={w.muted}>Run it first to see what the app does.</span>}
      </div>
    </article>
  );
}
