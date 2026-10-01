'use client';

import type { ChatAnswer, FieldCheck, FieldCheckOffer, FieldValidation, Workflow, WorkflowPlan } from '@tb/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import w from './workflows.module.css';

export interface Plan {
  intent: string;
  validations: FieldValidation[];
}

interface FieldAnswer {
  required: FieldValidation['required'];
  unique: boolean;
  /** Offered checks by id: whether picked, and the outcome the tester expects (they may flip it). */
  picked: Record<string, { on: boolean; outcome: FieldCheck['outcome'] }>;
  custom: FieldCheck[];
  message: string;
  notes: string;
}


/** The offered checks this field's answers make relevant: empty is refused or accepted by "required". */
function visible(o: FieldCheckOffer, a: FieldAnswer) {
  return o.suggestions.filter((s) =>
    s.when === 'always' || (s.when === 'unique' && a.unique) || (s.when === 'required' && a.required !== 'no') || (s.when === 'optional' && a.required === 'no'),
  );
}

/** A field's answers as saved: its picks are the checks kept for it, the rest of the offer unpicked. */
function answersFrom(o: FieldCheckOffer, v: FieldValidation | undefined): FieldAnswer {
  if (!v) return fresh(o);
  const kept = new Map(v.checks.map((c) => [c.id, c]));
  return {
    required: v.required,
    unique: v.unique,
    picked: Object.fromEntries(o.suggestions.map((s) => [s.id, { on: kept.has(s.id), outcome: kept.get(s.id)?.outcome ?? s.outcome }])),
    custom: v.checks.filter((c) => !o.suggestions.some((s) => s.id === c.id)),
    message: v.message,
    notes: v.notes,
  };
}

function fresh(o: FieldCheckOffer): FieldAnswer {
  return {
    required: o.domRequired ? 'yes' : 'unknown',
    unique: false,
    picked: Object.fromEntries(o.suggestions.map((s) => [s.id, { on: s.selected, outcome: s.outcome }])),
    custom: [],
    message: '',
    notes: '',
  };
}

/**
 * What to test, from the tester: their intent in words, then for each field whether it is required
 * or unique, which values to try (suggested from its type, role and rules in the page) and the error
 * it shows. Scenarios are built from these answers only.
 */
export function TestPlan({ workflow, saved, onBuilt }: { workflow: Workflow; saved: WorkflowPlan | null; onBuilt(plan: Plan, answer: ChatAnswer): void }) {
  const { project } = useSession();
  const { notify } = useToast();
  const offers = useQuery({
    queryKey: ['workflow-validations', project.id, workflow.id, workflow.version],
    queryFn: () => get<FieldCheckOffer[]>(`/projects/${project.id}/studio/workflows/${workflow.id}/validations`),
  });
  const [intent, setIntent] = useState(saved?.intent ?? '');
  const [answers, setAnswers] = useState<Record<string, FieldAnswer>>({});
  const [building, setBuilding] = useState(false);

  // Each field starts from what was saved for it, or else from what the page says about it.
  useEffect(() => {
    if (!offers.data) return;
    setAnswers((a) => ({ ...Object.fromEntries(offers.data.map((o) => [o.key, answersFrom(o, saved?.validations.find((v) => v.key === o.key))])), ...a }));
  }, [offers.data]);

  const set = (key: string, change: Partial<FieldAnswer>) => setAnswers((a) => ({ ...a, [key]: { ...a[key]!, ...change } }));

  const validations = (): FieldValidation[] =>
    (offers.data ?? []).flatMap((o) => {
      const a = answers[o.key];
      if (!a) return [];
      const checks = [
        ...visible(o, a).filter((s) => a.picked[s.id]?.on).map((s) => ({ id: s.id, label: s.label, value: s.value, outcome: a.picked[s.id]!.outcome })),
        ...a.custom.filter((c) => c.label.trim().length >= 2),
      ];
      return [{ key: o.key, required: a.required, unique: a.unique, checks, message: a.message.trim(), notes: a.notes.trim() }];
    });
  const count = validations().reduce((n, v) => n + v.checks.length, 0);

  const build = async () => {
    setBuilding(true);
    try {
      const plan = { intent: intent.trim(), validations: validations() };
      const answer = await api<ChatAnswer>('POST', `/projects/${project.id}/studio/workflows/${workflow.id}/scenarios`, plan);
      onBuilt(plan, answer);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not build the scenarios', 'bad');
    } finally {
      setBuilding(false);
    }
  };

  return (
    <>
      <div className={w.body}>
        <label className={w.field}>
          <span>What do you want to test? <em>scenarios follow this and your answers below, nothing else</em></span>
          <textarea
            className="inp"
            rows={3}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="Project creation: required fields and their errors, the name limit, and that a duplicate name is refused"
          />
        </label>

        {offers.isLoading && <span className={w.muted}>Reading the fields…</span>}
        {offers.data?.length === 0 && <span className={w.muted}>This workflow has no fields to vary; the chat can still add scenarios.</span>}
        {offers.data?.map((o) => {
          const a = answers[o.key];
          if (!a) return null;
          const shown = visible(o, a);
          return (
            <details key={o.key} className={w.group} open>
              <summary>
                <b>{o.label}</b> <span className={w.kind}>{o.kind}</span>
                <span className={w.muted}> {o.facts.join(' · ')}</span>
              </summary>
              <div className={w.groupBody}>
                <div className={w.row}>
                  <span className={w.muted}>Required?</span>
                  {(['yes', 'no', 'unknown'] as const).map((r) => (
                    <label key={r} className={w.row}>
                      <input type="radio" name={`req-${o.key}`} checked={a.required === r} onChange={() => set(o.key, { required: r })} />
                      {r === 'yes' ? 'Required' : r === 'no' ? 'Optional' : 'Not sure'}
                    </label>
                  ))}
                  {o.domRequired && a.required !== 'yes' && <span className={w.warn}>the page marks it required</span>}
                </div>
                {o.kind !== 'select' && (
                  <label className={w.row} title="The app refuses a value already used. Every scenario then gets a value new on each run, except the duplicate check.">
                    <input type="checkbox" checked={a.unique} onChange={(e) => set(o.key, { unique: e.target.checked })} />
                    Must be unique {o.uniqueLikely && !a.unique && <span className={w.muted}>(its name suggests so)</span>}
                  </label>
                )}
                <div className={w.choices}>
                  <span className={w.muted}>Values to try</span>
                  {shown.map((sg) => {
                    const p = a.picked[sg.id] ?? { on: false, outcome: sg.outcome };
                    return (
                      <div key={sg.id} className={w.checkRow} title={sg.why}>
                        <input type="checkbox" aria-label={sg.label} checked={p.on} onChange={(e) => set(o.key, { picked: { ...a.picked, [sg.id]: { ...p, on: e.target.checked } } })} />
                        <span className="f1">{sg.label} <code className={w.muted}>{sg.value === '' ? '(empty)' : sg.value.length > 24 ? `${sg.value.slice(0, 24)}…` : sg.value}</code></span>
                        <select className={`inp ${w.small}`} aria-label={`${sg.label}: expected`} value={p.outcome} onChange={(e) => set(o.key, { picked: { ...a.picked, [sg.id]: { on: true, outcome: e.target.value as FieldCheck['outcome'] } } })}>
                          <option value="rejected">refused</option>
                          <option value="success">accepted</option>
                        </select>
                      </div>
                    );
                  })}
                  {a.custom.map((c, i) => {
                    const change = (x: Partial<FieldCheck>) => set(o.key, { custom: a.custom.map((y, j) => (j === i ? { ...y, ...x } : y)) });
                    return (
                      <div key={c.id} className={w.checkRow}>
                        <input className={`inp f1 ${w.small}`} placeholder="What it tests" value={c.label} onChange={(e) => change({ label: e.target.value })} />
                        <input className={`inp f1 ${w.small}`} placeholder="Value" value={c.value} onChange={(e) => change({ value: e.target.value })} />
                        <select className={`inp ${w.small}`} value={c.outcome} onChange={(e) => change({ outcome: e.target.value as FieldCheck['outcome'] })}>
                          <option value="rejected">refused</option>
                          <option value="success">accepted</option>
                        </select>
                        <button className="ib sm" aria-label="Remove" onClick={() => set(o.key, { custom: a.custom.filter((_, j) => j !== i) })}><Icon name="x" size={10} /></button>
                      </div>
                    );
                  })}
                  <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set(o.key, { custom: [...a.custom, { id: `custom-${Date.now().toString(36)}`, label: '', value: '', outcome: 'rejected' }] })}>
                    <Icon name="plus" size={10} /> Your own value
                  </button>
                </div>
                <div className={w.grid2}>
                  <label className={w.field}>
                    <span>Error it shows <em>if you know</em></span>
                    <input className={`inp ${w.small}`} value={a.message} placeholder="Project name is required" onChange={(e) => set(o.key, { message: e.target.value })} />
                  </label>
                  <label className={w.field}>
                    <span>Other rules <em>for the AI</em></span>
                    <input className={`inp ${w.small}`} value={a.notes} placeholder="No emoji; trimmed" onChange={(e) => set(o.key, { notes: e.target.value })} />
                  </label>
                </div>
              </div>
            </details>
          );
        })}
      </div>
      <div className={w.foot}>
        <span className={w.muted}>{count} check{count === 1 ? '' : 's'} picked</span>
        <div className="f1" />
        <button className="btn sm primary" disabled={building || intent.trim().length < 3 || !offers.data} onClick={build}>
          {building ? 'Building scenarios…' : 'Build scenarios'} <Icon name="arrowRight" size={11} />
        </button>
      </div>
    </>
  );
}
