'use client';

import type { Step } from '@tb/contracts';
import { Icon } from '@/components/Icon';
import s from './cases.module.css';

/**
 * Editable step table. Enter in the last "expected" cell adds a new step, so a tester can write a
 * whole case from the keyboard, the way they would in a spreadsheet.
 */
export function StepsEditor({ steps, onChange }: { steps: Step[]; onChange(steps: Step[]): void }) {
  const update = (i: number, patch: Partial<Step>) => onChange(steps.map((st, j) => (j === i ? { ...st, ...patch } : st)));
  const add = () => onChange([...steps, { action: '', expected: '', data: '' }]);
  const remove = (i: number) => onChange(steps.filter((_, j) => j !== i));
  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  return (
    <div className={s.steps}>
      <div className={`${s.stepRow} ${s.stepHead}`}>
        <span>#</span><span>Action</span><span>Expected result</span><span>Test data</span><span />
      </div>
      {steps.map((st, i) => (
        <div key={i} className={s.stepRow}>
          <span className="mono t3">{i + 1}</span>
          <textarea className="inp" rows={2} value={st.action} placeholder="What the tester does" aria-label={`Step ${i + 1} action`} onChange={(e) => update(i, { action: e.target.value })} />
          <textarea
            className="inp" rows={2} value={st.expected} placeholder="What should happen" aria-label={`Step ${i + 1} expected result`}
            onChange={(e) => update(i, { expected: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && i === steps.length - 1) { e.preventDefault(); add(); } }}
          />
          <textarea className="inp mono" rows={2} value={st.data} placeholder="vpa: qa@okaxis" aria-label={`Step ${i + 1} test data`} onChange={(e) => update(i, { data: e.target.value })} />
          <span className="col" style={{ gap: 2 }}>
            <button type="button" className="ib sm" aria-label={`Move step ${i + 1} up`} onClick={() => move(i, -1)} disabled={i === 0}><Icon name="chevDown" size={12} className={s.flip} /></button>
            <button type="button" className="ib sm" aria-label={`Remove step ${i + 1}`} onClick={() => remove(i)}><Icon name="x" size={12} /></button>
          </span>
        </div>
      ))}
      <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={add}><Icon name="plus" size={12} />Add step</button>
    </div>
  );
}
