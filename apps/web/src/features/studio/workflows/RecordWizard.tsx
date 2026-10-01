'use client';

import type { StudioComponent, Workflow, WorkflowDraft } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import type { SiteGuide } from '../ide/SitePane';
import { PrerequisiteRun } from './PrerequisiteRun';
import w from './workflows.module.css';

type Stage = 'prerequisite' | 'intent' | 'record' | 'review';
const STAGES: Array<{ id: Stage; label: string }> = [
  { id: 'prerequisite', label: 'Prerequisite' },
  { id: 'intent', label: 'Intent' },
  { id: 'record', label: 'Record' },
  { id: 'review', label: 'Review & save' },
];
type Suggestion = StudioComponent & { score: number };

/**
 * Recording a new workflow: what must be true first (a saved prerequisite run here, or one recorded
 * now), what it does, the recording itself, and a review that asks rather than guesses before saving.
 */
export function RecordWizard({ guide, onSaved, onCancel }: {
  guide: SiteGuide;
  /** `prerequisiteRan`: this browser is already past the prerequisite, so scenarios can run at once. */
  onSaved(workflow: Workflow, prerequisiteRan: boolean): void;
  onCancel(): void;
}) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const components = useQuery({ queryKey: ['studio-components', project.id], queryFn: () => get<StudioComponent[]>(`/projects/${project.id}/studio/components`) });
  const [stage, setStage] = useState<Stage>('prerequisite');
  const [reached, setReached] = useState(0);
  const [preText, setPreText] = useState('');
  const [preChoice, setPreChoice] = useState<'none' | 'record' | string>('none');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [preValues, setPreValues] = useState<Record<string, string>>({});
  const [preRan, setPreRan] = useState(false);
  const [name, setName] = useState('');
  const [intent, setIntent] = useState('');
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveAnyway, setSaveAnyway] = useState(false);

  const go = (st: Stage) => {
    setStage(st);
    const i = STAGES.findIndex((x) => x.id === st);
    if (i > reached) setReached(i);
  };
  // A new workflow starts from a clean slate: nothing recorded yet.
  useEffect(() => {
    guide.clearCapture('prereq');
    guide.clearCapture('main');
  }, []);

  // Saved workflows and segments that may already set up what the tester describes.
  useEffect(() => {
    const text = preText.trim();
    if (text.length < 3) return setSuggestions([]);
    const t = setTimeout(() => {
      api<Suggestion[]>('POST', `/projects/${project.id}/studio/intent/prerequisites`, { text }).then(setSuggestions, () => setSuggestions([]));
    }, 400);
    return () => clearTimeout(t);
  }, [preText, project.id]);

  const chosen = preChoice !== 'none' && preChoice !== 'record' ? (components.data?.find((c) => c.id === preChoice) ?? suggestions.find((c) => c.id === preChoice)) : undefined;
  const choose = (id: string) => {
    setPreChoice(id);
    setPreRan(false);
    const c = components.data?.find((x) => x.id === id) ?? suggestions.find((x) => x.id === id);
    setPreValues(c ? Object.fromEntries(c.inputs.filter((k) => !c.meta.secretInputs.includes(k)).map((k) => [k, c.meta.defaults[k] ?? ''])) : {});
  };
  // Offered without typing: saved prerequisites, and workflows that can come first. Only those of the
  // site under test, once one is open: another app's sign-in is no use here.
  const here = URL.canParse(guide.pageUrl) ? new URL(guide.pageUrl).origin : '';
  const sameSite = (c: StudioComponent) => !here || !c.meta.baseUrl || (URL.canParse(c.meta.baseUrl) && new URL(c.meta.baseUrl).origin === here);
  const offered = [
    ...suggestions.filter(sameSite),
    ...(components.data ?? []).filter((c) => (c.meta.origin === 'prerequisite' || c.meta.origin === 'workflow') && !c.meta.archived && sameSite(c) && !suggestions.some((x) => x.id === c.id)),
  ].slice(0, 8);

  const buildDraft = async (withAnswers: Record<string, string> = {}) => {
    setBusy(true);
    try {
      const d = await api<WorkflowDraft>('POST', `/projects/${project.id}/studio/workflows/draft`, {
        name: name.trim(),
        intent: intent.trim(),
        prerequisiteComponentId: chosen?.id ?? null,
        prerequisite: preChoice === 'record' ? (guide.captures.prereq ?? []) : [],
        prerequisiteValues: chosen ? preValues : {},
        recording: guide.captures.main ?? [],
        answers: withAnswers,
      });
      setDraft(d);
      setAnswers(Object.fromEntries(d.questions.filter((q) => q.answer).map((q) => [q.id, q.answer!])));
      go('review');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not read the recording', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await api<Workflow>('POST', `/projects/${project.id}/studio/workflows`, { draft });
      for (const key of [['studio-workflows', project.id], ['studio-components', project.id], ['site-graph', project.id]]) await queryClient.invalidateQueries({ queryKey: key });
      notify(`Saved “${saved.name}” v${saved.version}. Now say what to test.`);
      // Picked and run in the first step, or recorded there: either way this browser is past it.
      onSaved(saved, (preRan && chosen?.id === saved.prerequisite?.id) || (preChoice === 'record' && !!guide.captures.prereq));
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the workflow', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const capture = (kind: 'prereq' | 'main', what: string) => {
    const got = guide.captures[kind];
    const actions = got?.filter((st) => !['observed', 'facts', 'navigated'].includes(st.action)).length ?? 0;
    const on = guide.recording === kind;
    return (
      <div className={w.row}>
        <button className={`btn sm ${on ? 'primary' : ''}`} disabled={!!guide.recordHint || (guide.recording !== null && !on)} onClick={() => guide.record(kind)}>
          {on ? <Icon name="pause" size={11} /> : <Icon name="circle" size={11} />}
          {on ? 'Stop recording' : got ? `Record ${what} again` : `Record ${what}`}
        </button>
        {guide.recordHint && !on && <span className={w.warn}>{guide.recordHint}</span>}
        {got && !on && <span className={w.muted}>{actions} action{actions === 1 ? '' : 's'} recorded</span>}
      </div>
    );
  };

  const body = (() => {
    if (stage === 'prerequisite')
      return (
        <>
          <div className={w.body}>
            <p className={w.lead}>What must be true before the workflow starts? Pick a saved one and run it here, record it now, or go on without one.</p>
            <label className={w.field}>
              <span>Prerequisite <em>in your words</em></span>
              <input className="inp" value={preText} onChange={(e) => setPreText(e.target.value)} placeholder="Signed in as an admin" />
            </label>
            <div className={w.choices} role="radiogroup" aria-label="Prerequisite">
              <label className={w.choice}><input type="radio" checked={preChoice === 'none'} onChange={() => setPreChoice('none')} /> None needed</label>
              {offered.map((c) => (
                <label key={c.id} className={w.choice} title={c.meta.purpose || c.description}>
                  <input type="radio" checked={preChoice === c.id} onChange={() => choose(c.id)} />
                  <span className="f1">
                    <b>{c.name}</b> <span className={w.muted}>{c.meta.origin === 'workflow' ? 'workflow' : 'prerequisite'}</span>
                    {(c.meta.intent || c.meta.purpose) && <span className={w.muted}> · {(c.meta.intent || c.meta.purpose).slice(0, 90)}</span>}
                  </span>
                  {'score' in c && <span className={w.muted}>suggested</span>}
                </label>
              ))}
              <label className={w.choice}><input type="radio" checked={preChoice === 'record'} onChange={() => setPreChoice('record')} /> Record it now; it is saved to reuse</label>
            </div>
            {chosen && components.data && (
              <PrerequisiteRun key={chosen.id} component={chosen} components={components.data} guide={guide} values={preValues} onValues={setPreValues} onDone={setPreRan} />
            )}
            {preChoice === 'record' && (
              <div className={w.box}>
                <span className={w.muted}>Open the site, press Record, do the steps (sign in, say), then Stop.</span>
                {capture('prereq', 'the prerequisite')}
              </div>
            )}
          </div>
          <div className={w.foot}>
            {chosen && !preRan && (
              <>
                <span className={w.warn}>Run it first, so the recording starts where it leaves.</span>
                <button className="btn sm" onClick={() => setPreRan(true)} title="The browser already shows where it leaves (you signed in by hand, say)">I’m already there</button>
              </>
            )}
            <div className="f1" />
            <button
              className="btn sm primary"
              disabled={(preChoice === 'record' && !guide.captures.prereq?.length) || (!!chosen && !preRan) || guide.recording !== null}
              onClick={() => go('intent')}
            >
              Next <Icon name="arrowRight" size={11} />
            </button>
          </div>
        </>
      );

    if (stage === 'intent')
      return (
        <>
          <div className={w.body}>
            <p className={w.lead}>What does this workflow do? The name is how it is found and suggested later.</p>
            <label className={w.field}>
              <span>Name</span>
              <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Create a project" />
            </label>
            <label className={w.field}>
              <span>Intent <em>what it achieves, in a sentence</em></span>
              <textarea className="inp" rows={3} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Create a new project from the Projects page and open it" />
            </label>
          </div>
          <div className={w.foot}>
            <button className="btn sm" onClick={() => setStage('prerequisite')}>Back</button>
            <div className="f1" />
            <button className="btn sm primary" disabled={name.trim().length < 2 || intent.trim().length < 3} onClick={() => go('record')}>
              Next <Icon name="arrowRight" size={11} />
            </button>
          </div>
        </>
      );

    if (stage === 'record')
      return (
        <>
          <div className={w.body}>
            <p className={w.lead}>
              Do the workflow once in the browser, with realistic values: fill every field you want tested, submit,
              wait for the message, then open what was created. Stop when done. Passwords are never captured.
            </p>
            {capture('main', 'the workflow')}
          </div>
          <div className={w.foot}>
            <button className="btn sm" onClick={() => setStage('intent')}>Back</button>
            <div className="f1" />
            <button className="btn sm primary" disabled={busy || !guide.captures.main?.length || guide.recording !== null} onClick={() => buildDraft()}>
              {busy ? 'Reading the recording…' : 'Review it'} <Icon name="arrowRight" size={11} />
            </button>
          </div>
        </>
      );

    if (stage === 'review' && draft) {
      const open = draft.questions.filter((q) => q.required && !q.answer);
      // A recording that cannot make a useful workflow is said so before it is saved, not after.
      const problems = [
        draft.pages.some((p) => /can.t be reached|err_[a-z_]+|this page isn.t working|404 not found|502 bad gateway/i.test(`${p.title} ${p.headings.join(' ')}`)) &&
          'A page did not load while recording (“This site can’t be reached”). Record it again once the site is up.',
        !draft.submit && 'No submit was found. While recording, press the button that sends the form (Save, Add, Submit).',
        !draft.fields.some((f) => !f.secret) && 'No field was filled in, so scenarios have nothing to vary.',
      ].filter((x): x is string => !!x);
      const changed = draft.questions.some((q) => (answers[q.id]?.trim() || null) !== q.answer);
      return (
        <>
          <div className={w.body}>
            {draft.questions.length > 0 && (
              <section className={`${w.box} ${w.ask}`} aria-label="Questions">
                <b>{open.length ? 'Before saving, a few questions' : 'Your answers'} <span className={w.muted}>· asked rather than guessed</span></b>
                {draft.questions.map((q) => {
                  const given = answers[q.id] ?? '';
                  return (
                    <fieldset key={q.id} className={w.choices} style={{ border: 0, padding: 0, margin: 0 }}>
                      <legend style={{ fontWeight: 600, marginBottom: 2 }}>{q.text}</legend>
                      <span className={w.muted}>{q.why}</span>
                      {q.options.map((o) => (
                        <label key={o.value} className={w.row}>
                          <input type="radio" name={q.id} checked={given === o.value} onChange={() => setAnswers({ ...answers, [q.id]: o.value })} /> {o.label}
                        </label>
                      ))}
                      {q.allowText && (
                        <input className={`inp ${w.small}`} placeholder={q.textHint} aria-label={q.text} value={q.options.some((o) => o.value === given) ? '' : given} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
                      )}
                    </fieldset>
                  );
                })}
                <div className={w.row}>
                  <button className="btn sm primary" disabled={busy || !changed} onClick={() => buildDraft(answers)}>{busy ? 'Applying…' : 'Apply answers'}</button>
                  {open.length > 0 && <span className={w.muted}>{open.length} to answer before saving</span>}
                </div>
              </section>
            )}
            {problems.length > 0 && (
              <section className={`${w.box} ${w.problem}`} role="alert">
                <b>This recording may not make a useful workflow</b>
                {problems.map((m) => <span key={m}>{m}</span>)}
                <label className={w.row}><input type="checkbox" checked={saveAnyway} onChange={(e) => setSaveAnyway(e.target.checked)} /> Save it anyway</label>
              </section>
            )}
            {draft.notes.map((n, i) => <span key={i} className={w.muted}><Icon name="info" size={10} /> {n}</span>)}

            <section className={w.box}>
              <b>{draft.name}</b>
              <span>{draft.intent}</span>
              <span className={w.muted}>
                Prerequisite: {draft.prerequisite ? `“${draft.prerequisite.name}”, saved as new` : chosen ? `“${chosen.name}” v${chosen.version}` : draft.prerequisiteId ? 'a saved one it matched' : 'none'}
                {' · '}Submit: {draft.submit ? `“${draft.submit.label}”` : 'not found'}
                {' · '}After a success: {draft.continuation ? `${draft.continuation.steps.length} steps` : 'nothing'}
              </span>
            </section>

            <section className={w.box}>
              <b>Fields</b>
              <table className={w.table}>
                <thead><tr><th>Field</th><th>Kind</th><th>Rules</th><th>Recorded</th></tr></thead>
                <tbody>
                  {draft.fields.map((f) => (
                    <tr key={f.key}>
                      <td>{f.label}</td>
                      <td>{f.kind}</td>
                      <td>{[f.rules.required && 'required', f.rules.minLength > 0 && `min ${f.rules.minLength}`, f.rules.maxLength > 0 && `max ${f.rules.maxLength}`, f.rules.pattern && 'pattern', f.rules.options.length > 0 && `${f.rules.options.length} options`].filter(Boolean).join(', ') || '—'}</td>
                      <td>{f.secret ? '••••' : f.recorded || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className={w.box}>
              <b>Pages it goes through</b>
              {draft.pages.map((p, i) => (
                <div key={i} className={w.choices}>
                  <span><code>{p.path}</code> {p.title && <span className={w.muted}>· {p.title}</span>}</span>
                  {p.headings.length > 0 && <span className={w.muted}>Headings: {p.headings.join(', ')}</span>}
                  {p.actions.length > 0 && <span className={w.muted}>Actions: {p.actions.map((a) => a.label).join(', ')}</span>}
                  {p.messages.map((m, j) => <span key={j} className={w.muted}>{m.kind} after “{m.after}”: {m.text}</span>)}
                </div>
              ))}
            </section>
          </div>
          <div className={w.foot}>
            <button className="btn sm" onClick={() => setStage('record')}>Back</button>
            <div className="f1" />
            <button className="btn sm primary" disabled={busy || open.length > 0 || (problems.length > 0 && !saveAnyway)} onClick={save}>{busy ? 'Saving…' : 'Save workflow'}</button>
          </div>
        </>
      );
    }

    return null;
  })();

  return (
    <div className={w.guide}>
      <nav className={w.steps} aria-label="Recording steps">
        <button className={w.stepBtn} onClick={onCancel}><Icon name="chevLeft" size={10} /> Cancel</button>
        {STAGES.map((st, i) => (
          <button key={st.id} className={w.stepBtn} disabled={i > reached} aria-current={stage === st.id ? 'step' : undefined} onClick={() => setStage(st.id)}>
            <span className={w.stepNo}>{i + 1}</span>{st.label}
          </button>
        ))}
      </nav>
      {body}
    </div>
  );
}
