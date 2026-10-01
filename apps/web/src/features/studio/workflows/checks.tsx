'use client';

import type { Assertion, WorkflowPlan } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import w from './workflows.module.css';

export const EMPTY_PLAN: WorkflowPlan = { intent: '', validations: [], messages: [], scenarios: [], checks: [] };

/**
 * A workflow's saved plan (what to test, field validation, chat, scenarios, checks), shared by
 * everyone on the project. Edits show at once and are saved after a short pause, the last one winning.
 */
export function useWorkflowPlan(workflowId: string | null) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const key = ['workflow-plan', project.id, workflowId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => get<WorkflowPlan>(`/projects/${project.id}/studio/workflows/${workflowId}/plan`),
    enabled: !!workflowId,
    staleTime: 30_000,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<WorkflowPlan | null>(null);
  const flush = (leaving = false) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const body = pending.current;
    pending.current = null;
    if (!body || !workflowId) return;
    // The page is going: keepalive lets the save outlive it, so the last edit is not lost.
    if (leaving) {
      void fetch(`/api/core/projects/${project.id}/studio/workflows/${workflowId}/plan`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
      return;
    }
    void api('PUT', `/projects/${project.id}/studio/workflows/${workflowId}/plan`, body)
      .then(() => queryClient.invalidateQueries({ queryKey: ['site-graph', project.id] }))
      .catch((err) => notify(err instanceof ApiError ? err.message : 'Could not save the workflow’s scenarios', 'bad'));
  };
  // Leaving the workflow, or the page, saves what was still waiting.
  useEffect(() => {
    const leave = () => flush(true);
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      flush();
    };
  }, [workflowId]);
  const update = (patch: Partial<WorkflowPlan> | ((p: WorkflowPlan) => Partial<WorkflowPlan>)) => {
    const before = queryClient.getQueryData<WorkflowPlan>(key) ?? EMPTY_PLAN;
    const next = { ...before, ...(typeof patch === 'function' ? patch(before) : patch) };
    queryClient.setQueryData(key, next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(), 700);
  };
  return { plan: query.data ?? null, loading: query.isLoading, update, flush };
}

export const CHECK_KINDS = { api_called: 'API call', cookie: 'Cookie', local_storage: 'Local storage', session_storage: 'Session storage' } as const;
export type CheckKind = keyof typeof CHECK_KINDS;

/** A check in words: "API POST /api/projects answers 201", "cookie session is set". */
export function describeCheck(c: Assertion): string {
  if (c.kind === 'api_called') return `${c.key ?? '?'} is called${c.expected ? ` and answers ${c.expected}` : ''}`;
  const what = c.kind === 'cookie' ? 'Cookie' : c.kind === 'local_storage' ? 'Local storage' : 'Session storage';
  return `${what} “${c.key ?? '?'}” ${c.expected ? `is “${c.expected}”` : 'is set'}`;
}

/**
 * Checks on what the browser keeps and the APIs the page calls: kind, key (a cookie or storage key,
 * or "POST /api/projects"), and what it must be. Suggestions come from what runs saw.
 */
export function ChecksEditor({
  checks,
  onChange,
  apis = [],
  storage = [],
  compact = false,
}: {
  checks: Assertion[];
  onChange(next: Assertion[]): void;
  apis?: Array<{ method: string; path: string; status: number | null }>;
  storage?: Array<{ area: 'cookie' | 'local' | 'session'; key: string }>;
  compact?: boolean;
}) {
  const id = useId();
  const set = (i: number, change: Partial<Assertion>) => onChange(checks.map((c, j) => (j === i ? { ...c, ...change } : c)));
  const keysFor = (kind: Assertion['kind']) =>
    kind === 'api_called'
      ? [...new Set(apis.map((a) => `${a.method} ${a.path}`))]
      : [...new Set(storage.filter((s) => s.area === (kind === 'cookie' ? 'cookie' : kind === 'local_storage' ? 'local' : 'session')).map((s) => s.key))];
  return (
    <div className={w.choices}>
      {checks.map((c, i) => (
        <div key={i} className={w.checkEdit}>
          <select className={`inp ${w.small}`} aria-label="Check" value={c.kind} onChange={(e) => set(i, { kind: e.target.value as CheckKind, key: '', expected: undefined })}>
            {Object.entries(CHECK_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input
            className={`inp ${w.small}`}
            list={`${id}-${i}`}
            aria-label={c.kind === 'api_called' ? 'Method and path' : 'Key'}
            placeholder={c.kind === 'api_called' ? 'POST /api/projects' : c.kind === 'cookie' ? 'cookie name' : 'storage key'}
            value={c.key ?? ''}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <datalist id={`${id}-${i}`}>{keysFor(c.kind).map((k) => <option key={k} value={k} />)}</datalist>
          <input
            className={`inp ${w.small}`}
            aria-label={c.kind === 'api_called' ? 'Status' : 'Value'}
            placeholder={c.kind === 'api_called' ? 'status, e.g. 201' : 'value (blank: just set)'}
            value={c.expected ?? ''}
            onChange={(e) => set(i, { expected: e.target.value || undefined })}
          />
          <button className="ib sm" aria-label="Remove the check" onClick={() => onChange(checks.filter((_, j) => j !== i))}><Icon name="x" size={10} /></button>
        </div>
      ))}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...checks, { kind: apis.length ? 'api_called' : 'local_storage', key: '', soft: false }])}>
        <Icon name="plus" size={10} /> {compact ? 'Check' : 'Add a check'}
      </button>
    </div>
  );
}
