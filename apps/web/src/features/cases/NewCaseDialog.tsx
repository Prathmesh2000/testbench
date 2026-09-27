'use client';

import { PRIORITIES, type CaseDetail, type Priority, type Step } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import type { ModuleInfo } from './data';
import { StepsEditor } from './StepsEditor';

interface Props {
  modules: Map<string, ModuleInfo>;
  defaultModuleId?: string;
  onClose(): void;
  onCreated(c: CaseDetail): void;
}

export function NewCaseDialog({ modules, defaultModuleId, onClose, onCreated }: Props) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const moduleOptions = [...modules.values()].sort((a, b) => a.path.localeCompare(b.path));
  const [moduleId, setModuleId] = useState(defaultModuleId ?? moduleOptions[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [labels, setLabels] = useState('');
  const [preconditions, setPreconditions] = useState('');
  const [steps, setSteps] = useState<Step[]>([{ action: '', expected: '', data: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await api<CaseDetail>('POST', `/projects/${project.id}/cases`, {
        moduleId, title, priority, preconditions,
        labels: labels.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean),
        steps: steps.filter((st) => st.action.trim()),
      });
      await queryClient.invalidateQueries({ queryKey: ['cases', project.id] });
      await queryClient.invalidateQueries({ queryKey: ['modules', project.id] });
      notify(`${created.key} created in ${created.modulePath}`);
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the case');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="modal center" style={{ width: 860, height: 640 }} role="dialog" aria-label="New test case" onSubmit={submit}>
        <div className="row" style={{ height: 48, padding: '0 12px 0 18px', borderBottom: '1px solid var(--border)' }}>
          <span className="cond" style={{ fontSize: 16, fontWeight: 600 }}>New test case</span>
          <div className="f1" />
          <button type="button" className="ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field">
            <label htmlFor="nc-title">Title</label>
            <input id="nc-title" className="inp" style={{ height: 32, fontSize: 13.5 }} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Verify collect request expiry after 5 minutes on Safari 17" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr', gap: 12 }}>
            <div className="field">
              <label htmlFor="nc-module">Module</label>
              <select id="nc-module" className="inp" value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
                {moduleOptions.map((m) => <option key={m.id} value={m.id}>{m.path}</option>)}
              </select>
            </div>
            <div className="field">
              <span className="flab">Priority</span>
              <div className="seg" role="radiogroup" aria-label="Priority">
                {PRIORITIES.map((p) => <button key={p} type="button" role="radio" aria-checked={priority === p} className={priority === p ? 'on' : ''} onClick={() => setPriority(p)}>{p}</button>)}
              </div>
            </div>
            <div className="field">
              <label htmlFor="nc-labels">Labels</label>
              <input id="nc-labels" className="inp" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="smoke, release-4.18" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="nc-pre">Preconditions</label>
            <textarea id="nc-pre" className="inp" rows={2} value={preconditions} onChange={(e) => setPreconditions(e.target.value)} placeholder="Merchant is onboarded on Staging-IN with UPI enabled" />
          </div>
          <div className="field">
            <span className="flab">Steps</span>
            <StepsEditor steps={steps} onChange={setSteps} />
          </div>
          {error && <div className="banner bad" role="alert"><Icon name="alert" />{error}</div>}
        </div>
        <div className="row" style={{ height: 52, padding: '0 16px', borderTop: '1px solid var(--border)' }}>
          <span className="t3" style={{ fontSize: 12 }}>Saved as version 1 in Draft.</span>
          <div className="f1" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={saving || title.trim().length < 3 || !moduleId}>{saving ? 'Creating…' : 'Create case'}</button>
        </div>
      </form>
    </>
  );
}
