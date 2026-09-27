'use client';

import type { AiAnswer, AiConfigView, AiTask, DraftCase } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { PriorityTag } from '@/components/status';
import { api, ApiError, get } from '@/lib/api';
import { useModules } from '../cases/data';
import s from './docs.module.css';

/** The model that will answer a task, for "Drafting with …" hints; undefined without ai.use or before it loads. */
export function useAiModel(task: AiTask): string | undefined {
  const { project, can } = useSession();
  const config = useQuery({
    queryKey: ['ai-config', project.id],
    queryFn: () => get<AiConfigView>(`/projects/${project.id}/ai/config`),
    enabled: can('ai.use'),
    staleTime: 5 * 60_000,
  });
  const c = config.data;
  if (!c) return undefined;
  return c.mode === 'local' ? c.localModel : c.mode === 'mock' ? 'recorded responses' : c.tasks[task].model;
}

interface Props {
  requirement: { id: string; ref: string; title: string };
  onClose(): void;
}

/** AI-drafted cases for one requirement: pick the ones to keep, choose a module, create them as drafts and link them. */
export function DraftCasesDialog({ requirement, onClose }: Props) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const model = useAiModel('generate_cases');
  const modules = useModules(project.id);
  const moduleOptions = [...(modules.data?.byId.values() ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const [moduleId, setModuleId] = useState('');
  const [rejected, setRejected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A query rather than an effect so React's dev double-mount cannot start two slow model calls; never
  // retried automatically for the same reason.
  const drafts = useQuery({
    queryKey: ['ai-draft', project.id, requirement.id],
    queryFn: () => api<AiAnswer<{ cases: DraftCase[] }>>('POST', `/projects/${project.id}/requirements/${requirement.id}/draft-cases`, { count: 5 }),
    staleTime: Infinity,
    retry: false,
  });
  const cases = drafts.data?.result.cases ?? [];
  const chosen = cases.filter((_, i) => !rejected.has(i));
  const targetModule = moduleId || moduleOptions[0]?.id || '';

  const toggle = (i: number) => setRejected((r) => {
    const next = new Set(r);
    if (!next.delete(i)) next.add(i);
    return next;
  });

  const create = async () => {
    setSaving(true);
    setError(null);
    const keys: string[] = [];
    const done: number[] = [];
    try {
      for (const [i, c] of cases.entries()) {
        if (rejected.has(i)) continue;
        const created = await api<{ key: string }>('POST', `/projects/${project.id}/cases`, {
          title: c.title, moduleId: targetModule, priority: c.priority, preconditions: c.preconditions, steps: c.steps, status: 'draft', format: 'steps',
        });
        keys.push(created.key);
        done.push(i);
      }
    } catch (err) {
      setError(`${keys.length ? `Created ${keys.join(', ')}, then stopped: ` : ''}${err instanceof ApiError ? err.message : 'could not create the case'}`);
    }
    // Untick what now exists, so pressing Create again after a failure does not duplicate it.
    setRejected((r) => new Set([...r, ...done]));
    try {
      // Link whatever was created, even after a partial failure, so no new case is left orphaned.
      if (keys.length) await api('POST', `/projects/${project.id}/requirements/${requirement.id}/cases`, { caseKeys: keys });
    } catch (err) {
      setError(`Created ${keys.join(', ')} but could not link them: ${err instanceof ApiError ? err.message : 'request failed'}`);
    }
    await queryClient.invalidateQueries({ queryKey: ['docs', project.id] });
    await queryClient.invalidateQueries({ queryKey: ['cases', project.id] });
    await queryClient.invalidateQueries({ queryKey: ['modules', project.id] });
    setSaving(false);
    if (keys.length === chosen.length) {
      notify(`${keys.length} draft case${keys.length === 1 ? '' : 's'} created and linked to ${requirement.ref}`);
      onClose();
    }
  };

  return (
    <>
      <div className="scrim" onClick={saving ? undefined : onClose} />
      <div className="modal center" style={{ width: 760, height: 620 }} role="dialog" aria-modal="true" aria-labelledby="dc-title">
        <div className={`row ${s.dlgHead}`}>
          <span id="dc-title" className="cond trunc" style={{ fontSize: 16, fontWeight: 600 }}>Draft cases for <span className="mono">{requirement.ref}</span></span>
          <div className="f1" />
          <button type="button" className="ib" aria-label="Close" onClick={onClose} disabled={saving}><Icon name="x" /></button>
        </div>
        <div className={s.dlgBody}>
          <div className="t2" style={{ fontSize: 12.5 }}>{requirement.title}</div>
          {drafts.isFetching && (
            <div className="empty t2" style={{ flex: 1 }} aria-live="polite">
              <Icon name="refresh" size={20} className="spin" />
              <div>Drafting with {model ?? 'AI'}…</div>
              <div className="t3" style={{ fontSize: 12 }}>A local model can take a minute or two.</div>
            </div>
          )}
          {drafts.error && !drafts.isFetching && (
            <div className="banner bad" role="alert">
              <Icon name="alert" />
              <span className="f1">{drafts.error instanceof ApiError ? drafts.error.message : 'Drafting failed'}</span>
              <button type="button" className="btn sm" onClick={() => drafts.refetch()}>Try again</button>
            </div>
          )}
          {!drafts.isFetching && cases.map((c, i) => (
            <div key={i} className={s.draft}>
              <label className="row" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" className="cb" style={{ marginTop: 2 }} checked={!rejected.has(i)} onChange={() => toggle(i)} />
                <span className="f1" style={{ fontWeight: 500 }}>{c.title}</span>
                <PriorityTag priority={c.priority} />
              </label>
              {c.preconditions && <div className="t3" style={{ fontSize: 12, paddingLeft: 22 }}>Preconditions: {c.preconditions}</div>}
              <details style={{ paddingLeft: 22 }}>
                <summary>{c.steps.length} step{c.steps.length === 1 ? '' : 's'}</summary>
                <ol>
                  {c.steps.map((st, n) => <li key={n}>{st.action}{st.expected && <span className="t2"> → {st.expected}</span>}</li>)}
                </ol>
              </details>
            </div>
          ))}
          {error && <div className="banner bad" role="alert"><Icon name="alert" />{error}</div>}
        </div>
        <div className={`row ${s.dlgFoot}`}>
          {drafts.data && <span className="t3 trunc" style={{ fontSize: 12 }}>Drafted by {drafts.data.provider} · {drafts.data.model}</span>}
          <div className="f1" />
          <label className="flab" htmlFor="dc-module">Module</label>
          <select id="dc-module" className="inp" style={{ maxWidth: 220 }} value={targetModule} onChange={(e) => setModuleId(e.target.value)}>
            {moduleOptions.map((m) => <option key={m.id} value={m.id}>{m.path}</option>)}
          </select>
          {drafts.data && <button type="button" className="btn" onClick={() => { setRejected(new Set()); drafts.refetch(); }} disabled={saving || drafts.isFetching}>Draft again</button>}
          <button type="button" className="btn primary" onClick={create} disabled={saving || drafts.isFetching || !chosen.length || !targetModule}>
            {saving ? 'Creating…' : `Create ${chosen.length} case${chosen.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </>
  );
}
