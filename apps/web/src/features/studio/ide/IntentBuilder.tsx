'use client';

import type { DraftCheck, DraftRow, IntentCommitResult, IntentDraft, RecordedStep, StudioComponent } from '@tb/contracts';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import s from './ide.module.css';

export type CaptureKind = 'prereq' | 'main';

type Suggestion = StudioComponent & { score: number };

/**
 * Building a test from what the tester means (testing-studio-plan §3.3): they describe the
 * prerequisites, the intent and the goal, set up the prerequisites (a saved segment, or a recording),
 * record the journey once, and review the draft the build makes of it before anything is saved.
 * Recording itself is the Site pane's; this panel only asks for it and keeps what comes back.
 */
export function IntentBuilder({
  captures,
  recording,
  canRecord,
  recordHint,
  onRecord,
  onClearCapture,
}: {
  captures: Record<CaptureKind, RecordedStep[] | null>;
  /** Which capture is being recorded now, if any. */
  recording: CaptureKind | null;
  canRecord: boolean;
  /** Why recording is not possible right now, in words the tester can act on; null when it is. */
  recordHint: string | null;
  onRecord(kind: CaptureKind): void;
  onClearCapture(kind: CaptureKind): void;
}) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [prerequisites, setPrerequisites] = useState('');
  const [intent, setIntent] = useState('');
  const [goal, setGoal] = useState('');
  const [setup, setSetup] = useState<'none' | 'record' | string>('none');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [useAi, setUseAi] = useState(true);
  const [building, setBuilding] = useState(false);
  const [draft, setDraft] = useState<IntentDraft | null>(null);
  const [rejectedChecks, setRejectedChecks] = useState(new Set<string>());
  const [rejectedRows, setRejectedRows] = useState(new Set<string>());
  const [renamed, setRenamed] = useState<Record<string, { name: string; purpose: string }>>({});
  const [saving, setSaving] = useState(false);
  // Answers being given in review; applied by building again.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<IntentCommitResult | null>(null);

  // Saved segments that may already set up the prerequisites, as the tester describes them.
  useEffect(() => {
    const text = prerequisites.trim();
    if (text.length < 4) return setSuggestions([]);
    const t = setTimeout(() => {
      api<Suggestion[]>('POST', `/projects/${project.id}/studio/intent/prerequisites`, { text })
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 400);
    return () => clearTimeout(t);
  }, [prerequisites, project.id]);

  const ready = title.trim().length >= 3 && intent.trim().length >= 3 && goal.trim().length >= 3 && !!captures.main?.length;
  const needsPrereq = setup === 'record' && !captures.prereq?.length;

  /** Builds the draft; with answers, the same recording is built again with what the tester decided. */
  const build = async (withAnswers: Record<string, string> = {}) => {
    setBuilding(true);
    setSaved(null);
    try {
      const d = await api<IntentDraft>('POST', `/projects/${project.id}/studio/intent/build`, {
        title: title.trim(),
        intent: { prerequisites: prerequisites.trim(), intent: intent.trim(), goal: goal.trim() },
        prerequisiteComponentId: setup !== 'none' && setup !== 'record' ? setup : null,
        prerequisite: setup === 'record' ? (captures.prereq ?? []) : [],
        recording: captures.main ?? [],
        useAi,
        answers: withAnswers,
      });
      setDraft(d);
      setAnswers(Object.fromEntries(d.questions.filter((q) => q.answer).map((q) => [q.id, q.answer!])));
      setRejectedChecks(new Set());
      setRejectedRows(new Set());
      setRenamed({});
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not build the test', 'bad');
    } finally {
      setBuilding(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api<IntentCommitResult>('POST', `/projects/${project.id}/studio/intent/commit`, {
        draft,
        rejectedChecks: [...rejectedChecks],
        rejectedRows: [...rejectedRows].map((k) => ({ list: k.split(':')[0], index: Number(k.split(':')[1]) })),
        renamed,
      });
      setSaved(result);
      // The Tests tab, the data set list and the segments must show what was just made.
      for (const key of [['studio-tests', project.id], ['data-sets', project.id], ['studio-components', project.id]])
        await queryClient.invalidateQueries({ queryKey: key });
      notify(`Saved: ${result.componentIds.length} segment${result.componentIds.length === 1 ? '' : 's'}, ${result.negativeTestId ? 'two tests' : 'one test'}, ${result.dataSetIds.length} data set${result.dataSetIds.length === 1 ? '' : 's'}`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the test', 'bad');
    } finally {
      setSaving(false);
    }
  };

  const toggle = <T,>(set: Set<T>, key: T, update: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    update(next);
  };

  // Required questions not yet answered in a build: saving waits for them.
  const open = draft?.questions.filter((q) => q.required && !q.answer) ?? [];
  const changedAnswers = !!draft && draft.questions.some((q) => (answers[q.id]?.trim() || null) !== q.answer);

  const byWhere = useMemo(() => {
    const groups = new Map<string, DraftCheck[]>();
    for (const c of draft?.checks ?? []) groups.set(c.where, [...(groups.get(c.where) ?? []), c]);
    return groups;
  }, [draft]);
  const whereLabel = (w: string) =>
    w === 'test' ? 'Goal' : w === 'negative' ? 'Invalid input test' : (renamed[w]?.name ?? draft?.segments.find((x) => x.key === w)?.component.name ?? w);

  const capture = (kind: CaptureKind, label: string) => {
    const got = captures[kind];
    const actions = got?.filter((st) => !['observed', 'facts', 'navigated'].includes(st.action)).length ?? 0;
    return (
      <div className="row" style={{ gap: 6 }}>
        <button className={`btn sm ${recording === kind ? 'primary' : ''}`} disabled={!canRecord || (recording !== null && recording !== kind)} onClick={() => onRecord(kind)}>
          {recording === kind ? <Icon name="pause" size={11} /> : <span className={s.recDot} aria-hidden />}
          {recording === kind ? 'Stop' : got ? `Record ${label} again` : `Record ${label}`}
        </button>
        {!got && recordHint && recording === null && <span className={s.hint}>{recordHint}</span>}
        {got && recording !== kind && (
          <>
            <span className="t3">{actions} action{actions === 1 ? '' : 's'} recorded</span>
            <button className="ib sm" aria-label={`Discard the ${label} recording`} onClick={() => onClearCapture(kind)}><Icon name="x" size={10} /></button>
          </>
        )}
      </div>
    );
  };

  if (!can('run.execute')) return <div className="t3" style={{ padding: 10 }}>Building tests needs permission to run tests in this project.</div>;

  return (
    <div className={s.builder}>
      {!draft ? (
        <>
          <label className={s.field}>
            <span>Test title</span>
            <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Search opens the first hotel" />
          </label>
          <label className={s.field}>
            <span>Prerequisites <em className="t3">what must be true first</em></span>
            <textarea className="inp" rows={2} value={prerequisites} onChange={(e) => setPrerequisites(e.target.value)} placeholder="Signed in as a buyer with an empty cart" />
          </label>
          <div className={s.choices} role="radiogroup" aria-label="How to set up the prerequisites">
            <label><input type="radio" checked={setup === 'none'} onChange={() => setSetup('none')} /> None needed</label>
            {suggestions.map((c) => (
              <label key={c.id} title={c.meta.purpose || c.description}>
                <input type="radio" checked={setup === c.id} onChange={() => setSetup(c.id)} /> Use <b>{c.name}</b> v{c.version}
                {c.meta.leaves && <span className="t3"> · leaves {c.meta.leaves}</span>}
              </label>
            ))}
            <label><input type="radio" checked={setup === 'record'} onChange={() => setSetup('record')} /> Record them now, as a reusable segment</label>
          </div>
          {setup === 'record' && capture('prereq', 'prerequisites')}
          <label className={s.field}>
            <span>Intent <em className="t3">what you are testing</em></span>
            <textarea className="inp" rows={2} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Search for a city and open the first result" />
          </label>
          <label className={s.field}>
            <span>Goal <em className="t3">what proves it; put exact words in quotes</em></span>
            <textarea className="inp" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder='The hotel page shows the hotel name' />
          </label>
          {capture('main', 'the test')}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn sm primary" disabled={!ready || needsPrereq || building || recording !== null} onClick={() => build()}>
              {building ? 'Building…' : 'Build test'}
            </button>
            <label className="row t3" style={{ gap: 4, fontSize: 11 }} title="Rules always run. With AI, the configured model also names segments, adds checks for the intent and suggests data; a local model can take a minute.">
              <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> Refine with AI
            </label>
            {!ready && <span className="t3" style={{ fontSize: 11 }}>Fill in the title, intent and goal, and record the test.</span>}
          </div>
        </>
      ) : saved ? (
        <div className={s.pairs}>
          <b>Saved</b>
          <span>{saved.componentIds.length} new segment{saved.componentIds.length === 1 ? '' : 's'} and {saved.dataSetIds.length} data set{saved.dataSetIds.length === 1 ? '' : 's'}.</span>
          <div className="row" style={{ gap: 6 }}>
            <Link className="btn sm primary" href={`/automation?tab=tests&id=${saved.testId}`}>Open the test</Link>
            {saved.negativeTestId && <Link className="btn sm" href={`/automation?tab=tests&id=${saved.negativeTestId}`}>Open the invalid input test</Link>}
            <button className="btn sm" onClick={() => { setDraft(null); setSaved(null); }}>Build another</button>
          </div>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 6 }}>
            <b className="f1">Review: {draft.title}</b>
            <span className={`${s.aiBadge} ${draft.ai.status === 'used' ? s.aiOn : ''}`} title={draft.ai.message ?? undefined}>
              {draft.ai.status === 'used' ? 'AI refined' : draft.ai.status === 'unavailable' ? 'Rules only (AI unavailable)' : 'Rules only'}
            </span>
            <button className="btn sm" onClick={() => setDraft(null)}>Back</button>
            <button
              className="btn sm primary"
              disabled={saving || open.length > 0}
              title={open.length ? 'Answer the questions first' : undefined}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save test'}
            </button>
          </div>
          {draft.ai.status === 'unavailable' && draft.ai.message && <div className="t3" style={{ fontSize: 11 }}>{draft.ai.message}</div>}
          {draft.questions.length > 0 && (
            <section className={s.questions} aria-label="Questions from the build">
              <b>
                {open.length ? 'The build needs your answers' : 'Your answers'}
                <span className="t3"> · it asks rather than guess what the recording does not show</span>
              </b>
              {draft.questions.map((q) => {
                const given = answers[q.id] ?? '';
                const isOption = q.options.some((o) => o.value === given);
                return (
                  <fieldset key={q.id} className={s.question}>
                    <legend>{q.text}{q.required && !q.answer ? <span className={s.hint}> required</span> : null}</legend>
                    <span className="t3" style={{ fontSize: 11 }}>{q.why}</span>
                    {q.options.map((o) => (
                      <label key={o.value} className={s.check}>
                        <input type="radio" name={q.id} checked={given === o.value} onChange={() => setAnswers({ ...answers, [q.id]: o.value })} />
                        <span className="f1">{o.label}</span>
                      </label>
                    ))}
                    {q.allowText && (
                      <input
                        className="inp"
                        aria-label={`Answer: ${q.text}`}
                        placeholder={q.textHint}
                        value={isOption ? '' : given}
                        onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                      />
                    )}
                  </fieldset>
                );
              })}
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm primary" disabled={building || !changedAnswers} onClick={() => build(answers)}>
                  {building ? 'Applying…' : 'Apply answers'}
                </button>
                {open.length > 0 && <span className="t3" style={{ fontSize: 11 }}>{open.length} still to answer before you can save.</span>}
              </div>
            </section>
          )}
          {draft.notes.map((n, i) => (
            <div key={i} className={s.note} role="note"><Icon name="info" size={11} /> {n}</div>
          ))}

          <section className={s.pairs}>
            <b>Segments</b>
            {draft.segments.map((seg) => {
              const r = renamed[seg.key] ?? { name: seg.component.name, purpose: seg.component.meta.purpose };
              return (
                <div key={seg.key} className={s.segment}>
                  <span className={s.segRole}>{seg.role === 'prerequisite' ? 'Prerequisite' : 'Segment'}</span>
                  {seg.reuse ? (
                    <span><b>{seg.reuse.name}</b> v{seg.reuse.version} <span className="t3">reused · {seg.reuse.why}</span></span>
                  ) : (
                    <>
                      <input className="inp" aria-label="Segment name" value={r.name} onChange={(e) => setRenamed({ ...renamed, [seg.key]: { ...r, name: e.target.value } })} />
                      <input className="inp" aria-label="What the segment does" value={r.purpose} placeholder="What it does" onChange={(e) => setRenamed({ ...renamed, [seg.key]: { ...r, purpose: e.target.value } })} />
                    </>
                  )}
                  <span className="t3" style={{ fontSize: 10.5 }}>
                    {seg.component.steps.length} steps{seg.component.inputs.length ? ` · inputs ${seg.component.inputs.join(', ')}` : ''}
                    {seg.component.meta.leaves ? ` · leaves ${seg.component.meta.leaves}` : ''}
                  </span>
                </div>
              );
            })}
          </section>

          <section className={s.pairs}>
            <b>Checks <span className="t3">untick any you do not want</span></b>
            {[...byWhere.entries()].map(([where, list]) => (
              <div key={where} className={s.checkGroup}>
                <span className="t3" style={{ fontSize: 10.5 }}>{whereLabel(where)}</span>
                {list.map((c) => (
                  <label key={c.id} className={s.check} title={c.why}>
                    <input type="checkbox" checked={!rejectedChecks.has(c.id)} onChange={() => toggle(rejectedChecks, c.id, setRejectedChecks)} />
                    <span className={`${s.aiBadge} ${c.source === 'ai' ? s.aiOn : ''}`}>{c.source === 'ai' ? 'AI' : 'Rule'}</span>
                    <span className="f1">{c.label}</span>
                  </label>
                ))}
              </div>
            ))}
          </section>

          {(draft.valid.length > 0 || draft.invalid.length > 0) && (
            <section className={s.pairs}>
              <b>Test data <span className="t3">{draft.fields.map((f) => `${f.label} (${f.kind}${f.rules ? `, ${f.rules}` : ''})`).join(' · ')}</span></b>
              {(
                [
                  ['valid', draft.valid, 'Valid: the goal must be reached'],
                  ['invalid', draft.invalid, 'Invalid: must be refused'],
                ] as Array<['valid' | 'invalid', DraftRow[], string]>
              ).map(([list, rows, label]) =>
                rows.length ? (
                  <div key={list} className={s.checkGroup}>
                    <span className="t3" style={{ fontSize: 10.5 }}>{label}</span>
                    {rows.map((row, i) => (
                      <label key={i} className={s.check}>
                        <input type="checkbox" checked={!rejectedRows.has(`${list}:${i}`)} onChange={() => toggle(rejectedRows, `${list}:${i}`, setRejectedRows)} />
                        <span className={`${s.aiBadge} ${row.source === 'ai' ? s.aiOn : ''}`}>{row.source === 'ai' ? 'AI' : row.source === 'recorded' ? 'Recorded' : 'Rule'}</span>
                        <span className="f1">{row.case}</span>
                        <code className="t3 trunc" style={{ maxWidth: '45%' }}>{Object.entries(row.values).map(([k, v]) => `${k}=${v === '' ? '∅' : v}`).join(' ')}</code>
                      </label>
                    ))}
                  </div>
                ) : null,
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
