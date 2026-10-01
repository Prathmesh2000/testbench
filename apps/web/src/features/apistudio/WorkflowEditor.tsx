'use client';

import '@xyflow/react/dist/style.css';
import type { ApiNode, ApiWorkflow, ApiWorkflowAssign, ApiWorkflowCondition, ApiWorkflowDef, ApiWorkflowRun, ApiWorkflowStep, ApiWorkflowSummary, ApiNodeDetail } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { usePrefs, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago } from '@/lib/format';
import { flowLayout, stepAt, type FlowNode } from './flow';
import { KeyValueTable } from './fields';
import { useLocals } from './locals';
import { METHOD_SHORT, newId } from './model';
import g from './graph.module.css';

// A workflow (plan §12): steps that call requests in order and pass values along, drawn as a canvas
// and edited as a list; both are views of the same draft.

type Kind = ApiWorkflowStep['kind'];
const KIND_LABEL: Record<Kind, string> = { request: 'Request', wait: 'Wait', poll: 'Poll until', if: 'If', loop: 'Loop', parallel: 'In parallel', workflow: 'Run workflow' };

function blank(kind: Kind, firstRequest: string | null, firstWorkflow: string | null): ApiWorkflowStep {
  const base = { id: newId(), name: '' };
  const cond: ApiWorkflowCondition = { variable: 'status', op: 'eq', value: 'done' };
  switch (kind) {
    case 'request':
      return { ...base, kind, requestId: firstRequest ?? '', variationId: null, assign: [], continueOnFail: false };
    case 'wait':
      return { ...base, kind, ms: 1000 };
    case 'poll':
      return { ...base, kind, requestId: firstRequest ?? '', variationId: null, assign: [{ variable: 'status', source: 'body', path: '$.status' }], until: cond, intervalMs: 2000, timeoutMs: 60_000 };
    case 'if':
      return { ...base, kind, condition: { variable: '', op: 'exists', value: '' }, then: [], else: [] };
    case 'loop':
      return { ...base, kind, count: 3, overVariable: null, as: 'item', steps: [] };
    case 'parallel':
      return { ...base, kind, branches: [[], []] };
    case 'workflow':
      return { ...base, kind, workflowId: firstWorkflow ?? '' };
  }
}

/** A copy of the step tree with the step at `path` replaced (or removed when `next` is null). */
function replaceAt(steps: ApiWorkflowStep[], path: string, next: ApiWorkflowStep | null): ApiWorkflowStep[] {
  const parts = path.split('.').slice(1);
  const walk = (list: ApiWorkflowStep[], i: number): ApiWorkflowStep[] => {
    const idx = Number(parts[i]);
    if (i === parts.length - 1) return next ? list.map((s, j) => (j === idx ? next : s)) : list.filter((_, j) => j !== idx);
    const s = list[idx]!;
    const field = parts[i + 1]!;
    if (field === 'branches' && s.kind === 'parallel') {
      const b = Number(parts[i + 2]);
      return list.map((x, j) => (j === idx ? { ...s, branches: s.branches.map((br, k) => (k === b ? walk(br, i + 3) : br)) } : x));
    }
    const child = (s as unknown as Record<string, ApiWorkflowStep[]>)[field]!;
    return list.map((x, j) => (j === idx ? ({ ...s, [field]: walk(child, i + 2) } as ApiWorkflowStep) : x));
  };
  return walk(steps, 0);
}

type StepData = { node: FlowNode; label: string; detail: string; status: string | null; message: string | null };

function StepNode({ data, selected }: NodeProps<Node<StepData>>) {
  const { node } = data;
  if (node.kind === 'start' || node.kind === 'end' || node.kind === 'teardown')
    return (
      <div className={`${g.node} ${g.marker}`}>
        <Handle type="target" position={Position.Top} />
        <b className={g.title}>{node.kind === 'start' ? 'Start' : node.kind === 'end' ? 'End' : 'Teardown (always runs)'}</b>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  return (
    <div className={`${g.node} ${g[`r-${data.status ?? 'none'}`]} ${selected ? g.on : ''}`} title={data.message ?? undefined}>
      <Handle type="target" position={Position.Top} />
      <span className={g.kind}><span>{KIND_LABEL[node.kind as Kind]}</span>{data.status && <span>{data.status}</span>}</span>
      <b className={g.title}>{data.label}</b>
      <span className={g.path}>{data.detail}</span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
const NODE_TYPES = { step: StepNode };

export function WorkflowEditor({ base, workspaceId, workflowId, nodes, environmentId, canEdit, onDeleted }: {
  base: string;
  workspaceId: string;
  workflowId: string;
  nodes: ApiNode[];
  environmentId: string | null;
  canEdit: boolean;
  onDeleted(): void;
}) {
  const prefs = usePrefs();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const locals = useLocals(workspaceId, environmentId);
  const url = `${base}/workflows/${workflowId}`;
  const wf = useQuery({ queryKey: ['apitest', 'workflow', workflowId], queryFn: () => get<ApiWorkflow>(url) });
  const workflows = useQuery({ queryKey: ['apitest', 'workflows', workspaceId], queryFn: () => get<ApiWorkflowSummary[]>(`${base}/workflows`) });
  const [draft, setDraft] = useState<ApiWorkflowDef | null>(null);
  const [name, setName] = useState('');
  const [view, setView] = useState<'canvas' | 'list'>('canvas');
  const [selected, setSelected] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (wf.data) {
      setDraft(wf.data.def);
      setName(wf.data.name);
    }
    // Reset when another workflow or version loads, not on every refetch.
  }, [wf.data?.id, wf.data?.version]);
  useEffect(() => setRunId(wf.data?.lastRun?.id ?? null), [wf.data?.id, wf.data?.lastRun?.id]);

  const run = useQuery({
    queryKey: ['apitest', 'workflow-run', runId],
    queryFn: () => get<ApiWorkflowRun>(`${url}/runs/${runId}`),
    enabled: !!runId,
    // Watch a background run until it finishes.
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 800 : false),
  });

  const requests = nodes.filter((n) => n.kind === 'request');
  const requestName = (id: string) => {
    const r = requests.find((n) => n.id === id);
    return r ? `${METHOD_SHORT[r.method ?? 'GET']} ${r.name}` : 'a deleted request';
  };
  const workflowName = (id: string) => workflows.data?.find((w) => w.id === id)?.name ?? 'a deleted workflow';
  const describe = (s: ApiWorkflowStep): [string, string] => {
    switch (s.kind) {
      case 'request':
        return [s.name || requestName(s.requestId), `${requestName(s.requestId)}${s.assign.length ? ` → ${s.assign.map((a) => a.variable).join(', ')}` : ''}`];
      case 'wait':
        return [s.name || `Wait ${s.ms} ms`, `${s.ms} ms`];
      case 'poll':
        return [s.name || `Until ${s.until.variable} ${s.until.op} ${s.until.value}`, `${requestName(s.requestId)} every ${s.intervalMs / 1000} s`];
      case 'if':
        return [s.name || `If ${s.condition.variable || '…'} ${s.condition.op} ${s.condition.value}`, `then ${s.then.length} · else ${s.else.length}`];
      case 'loop':
        return [s.name || (s.overVariable ? `For each ${s.as} in ${s.overVariable}` : `${s.count} times`), `${s.steps.length} steps inside`];
      case 'parallel':
        return [s.name || `${s.branches.length} branches at once`, s.branches.map((b) => b.length).join(' + ') + ' steps'];
      case 'workflow':
        return [s.name || workflowName(s.workflowId), 'sub-workflow'];
    }
  };

  const lastByStep = useMemo(() => {
    const out = new Map<string, { status: string; message: string }>();
    for (const r of run.data?.results ?? []) out.set(r.stepId, { status: r.status, message: r.message });
    return out;
  }, [run.data]);

  const flow = useMemo(() => {
    if (!draft) return { nodes: [] as Node[], edges: [] as Edge[] };
    const layout = flowLayout(draft.steps, draft.teardown);
    const flowNodes: Node[] = layout.nodes.map((n) => {
      const [label, detail] = n.step ? describe(n.step) : ['', ''];
      const last = n.step ? lastByStep.get(n.step.id) : undefined;
      return { id: n.id, type: 'step', position: { x: n.x, y: n.y }, data: { node: n, label, detail, status: last?.status ?? null, message: last?.message ?? null }, selected: n.id === selected, draggable: false };
    });
    const edges: Edge[] = layout.edges.map((e) => ({ id: e.id, source: e.from, target: e.to, label: e.label, className: e.back ? g.back : g.edge, markerEnd: { type: MarkerType.ArrowClosed }, labelStyle: { fontSize: 10.5 } }));
    return { nodes: flowNodes, edges };
    // describe reads requests and workflows; both are in the dependency list through their data.
  }, [draft, selected, lastByStep, nodes, workflows.data]);

  if (wf.error) return <div className="empty t3" style={{ flex: 1 }}>{wf.error instanceof ApiError ? wf.error.message : 'Could not load the workflow.'}</div>;
  if (!wf.data || !draft) return <div className="empty t3" style={{ flex: 1 }}>Loading…</div>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(wf.data.def) || name !== wf.data.name;
  const firstRequest = requests[0]?.id ?? null;
  const otherWorkflows = (workflows.data ?? []).filter((w) => w.id !== workflowId);

  const save = async () => {
    setError(null);
    try {
      await api('PUT', url, { name, description: wf.data!.description, def: draft });
      await queryClient.invalidateQueries({ queryKey: ['apitest', 'workflow', workflowId] });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'workflows', workspaceId] });
      notify('Saved as a new version');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };
  const start = async (mode: 'all' | 'step') => {
    setError(null);
    if (dirty) return setError('Save the workflow first: a run uses the saved version.');
    try {
      const r = await api<ApiWorkflowRun>('POST', `${url}/runs`, { environmentId, mode, locals: locals.values });
      setRunId(r.id);
      queryClient.setQueryData(['apitest', 'workflow-run', r.id], r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the run');
    }
  };
  const next = async () => {
    try {
      const r = await api<ApiWorkflowRun>('POST', `${url}/runs/${runId}/step`);
      queryClient.setQueryData(['apitest', 'workflow-run', r.id], r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the step');
    }
  };
  const cancel = async () => {
    const r = await api<ApiWorkflowRun>('POST', `${url}/runs/${runId}/cancel`);
    queryClient.setQueryData(['apitest', 'workflow-run', r.id], r);
  };
  const remove = async () => {
    if (!window.confirm(`Delete the workflow "${wf.data!.name}" and its runs?`)) return;
    try {
      await api('DELETE', url);
      queryClient.invalidateQueries({ queryKey: ['apitest', 'workflows', workspaceId] });
      onDeleted();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not delete', 'bad');
    }
  };

  const selectedStep = selected && (selected.startsWith('steps') || selected.startsWith('teardown')) ? stepAt(selected.startsWith('steps') ? draft.steps : draft.teardown, selected.startsWith('steps') ? selected : selected.replace(/^teardown/, 'steps')) : null;
  const updateSelected = (s: ApiWorkflowStep | null) => {
    if (!selected) return;
    if (selected.startsWith('teardown')) setDraft({ ...draft, teardown: replaceAt(draft.teardown, selected.replace(/^teardown/, 'steps'), s) });
    else setDraft({ ...draft, steps: replaceAt(draft.steps, selected, s) });
    if (!s) setSelected(null);
  };
  const r = run.data;
  const running = r?.status === 'running';
  const editor = { requests, workflows: otherWorkflows, requestName, readOnly: !canEdit, firstRequest, base };

  return (
    <div className={g.screen}>
      <div className={g.bar}>
        <input className="inp" style={{ height: 28, fontWeight: 600, width: 260 }} value={name} aria-label="Workflow name" readOnly={!canEdit} onChange={(e) => setName(e.target.value)} />
        <span className="t3">v{wf.data.version}</span>
        <div className="seg" role="radiogroup" aria-label="View">
          <button role="radio" aria-checked={view === 'canvas'} className={view === 'canvas' ? 'on' : ''} onClick={() => setView('canvas')}>Canvas</button>
          <button role="radio" aria-checked={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button>
        </div>
        <div className="f1" />
        {canEdit && <button className="btn" disabled={!dirty} onClick={save}>{dirty ? 'Save' : 'Saved'}</button>}
        {canEdit && !running && r?.status !== 'paused' && (
          <>
            <button className="btn" onClick={() => start('step')} title="Run one step at a time"><Icon name="forward" size={12} />Step through</button>
            <button className="btn primary" onClick={() => start('all')}><Icon name="play" size={12} />Run</button>
          </>
        )}
        {canEdit && r?.status === 'paused' && <button className="btn primary" onClick={next}><Icon name="forward" size={12} />Next step ({r.next + 1} of {draft.steps.length})</button>}
        {canEdit && (running || r?.status === 'paused') && <button className="btn" onClick={cancel}>Stop</button>}
        {canEdit && <button className="btn ghost danger" onClick={remove} aria-label="Delete workflow"><Icon name="x" size={13} /></button>}
      </div>
      {error && <div className="err" role="alert" style={{ padding: '6px 12px' }}>{error}</div>}
      <div className={g.body}>
        <div className={g.canvas} style={view === 'list' ? { overflow: 'auto', padding: 14, background: 'var(--panel)' } : undefined}>
          {view === 'canvas' ? (
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={NODE_TYPES}
              onNodeClick={(_, n) => setSelected(n.id === 'start' || n.id === 'end' || n.id === 'teardown' ? null : n.id)}
              onPaneClick={() => setSelected(null)}
              fitView
              fitViewOptions={{ maxZoom: 1 }}
              colorMode={prefs.theme}
              minZoom={0.2}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} />
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 820 }}>
              <section>
                <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Starting variables</h3>
                <KeyValueTable rows={draft.variables} onChange={(variables) => setDraft({ ...draft, variables })} readOnly={!canEdit} keyLabel="Variable" />
              </section>
              <section>
                <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Steps</h3>
                <StepList steps={draft.steps} onChange={(steps) => setDraft({ ...draft, steps })} {...editor} describe={describe} />
              </section>
              <section>
                <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Teardown</h3>
                <div className="t3" style={{ fontSize: 12, marginBottom: 6 }}>Runs after the steps even when one failed, so data a run made is cleaned up.</div>
                <StepList steps={draft.teardown} onChange={(teardown) => setDraft({ ...draft, teardown })} {...editor} describe={describe} />
              </section>
            </div>
          )}
          {view === 'canvas' && canEdit && (
            <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', gap: 6, zIndex: 5 }}>
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <button key={k} className="btn sm" disabled={(k === 'request' || k === 'poll') && !firstRequest} onClick={() => {
                  const s = blank(k, firstRequest, otherWorkflows[0]?.id ?? null);
                  setDraft({ ...draft, steps: [...draft.steps, s] });
                  setSelected(`steps.${draft.steps.length}`);
                }}><Icon name="plus" size={11} />{KIND_LABEL[k]}</button>
              ))}
            </div>
          )}
        </div>
        <aside className={g.side} aria-label="Step and run">
          {view === 'canvas' && selectedStep && (
            <div className={g.card}>
              <div className={g.row}>
                <b style={{ flex: 1 }}>{KIND_LABEL[selectedStep.kind]}</b>
                {canEdit && <button className="btn ghost sm danger" onClick={() => updateSelected(null)}>Remove</button>}
              </div>
              <StepForm step={selectedStep} onChange={updateSelected} {...editor} />
              {(selectedStep.kind === 'if' || selectedStep.kind === 'loop' || selectedStep.kind === 'parallel') && <span className="t3" style={{ fontSize: 12 }}>Add the steps inside in the List view.</span>}
            </div>
          )}
          {view === 'canvas' && !selectedStep && !r && (
            <div className="t2" style={{ lineHeight: 1.5 }}>
              <b>Build it</b>
              <div>Add steps with the buttons on the canvas, pick one to change it, or switch to List to arrange nested steps. Values move between steps as variables: a step's <i>assign</i> saves a response value, and later requests use it as {'{{name}}'}.</div>
            </div>
          )}
          {r && (
            <>
              <div className={g.row}>
                <b style={{ flex: 1 }}>Run {r.mode === 'step' ? 'step by step' : ''}</b>
                <span className={`lbl`} style={{ color: r.status === 'passed' ? 'var(--passed)' : r.status === 'failed' || r.status === 'error' ? 'var(--failed)' : undefined }}>{r.status}</span>
              </div>
              <span className="t3">v{r.version} · started {ago(r.startedAt)}</span>
              {r.error && <div className="err">{r.error}</div>}
              {r.results.map((x, i) => (
                <div key={i} className={g.card} style={{ borderLeft: `3px solid var(${x.status === 'passed' ? '--passed' : x.status === 'failed' || x.status === 'error' ? '--failed' : '--border'})` }}>
                  <div className={g.row}>
                    <b className="trunc" style={{ flex: 1 }}>{x.name || KIND_LABEL[x.kind]}</b>
                    {x.httpStatus !== null && <span className={g.mono}>{x.httpStatus}</span>}
                    <span className="t3">{x.durationMs} ms</span>
                  </div>
                  {x.iteration && <span className="t3">{x.iteration.replace(/\/$/, '')}</span>}
                  {x.message && <span className="t2">{x.message}</span>}
                  {Object.keys(x.assigned).length > 0 && <span className={g.mono}>{Object.entries(x.assigned).map(([k, v]) => `${k} = ${v.length > 30 ? `${v.slice(0, 30)}…` : v}`).join(', ')}</span>}
                </div>
              ))}
              {running && <span className="t3"><span className="spin" /> Running…</span>}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

interface EditorProps {
  requests: ApiNode[];
  workflows: ApiWorkflowSummary[];
  requestName(id: string): string;
  readOnly: boolean;
  firstRequest: string | null;
  base: string;
}

/** The fields of one step. Nested steps (if, loop, parallel) are edited in the list view. */
function StepForm({ step, onChange, requests, workflows, readOnly, base }: EditorProps & { step: ApiWorkflowStep; onChange(s: ApiWorkflowStep): void }) {
  const set = (patch: Partial<ApiWorkflowStep>) => onChange({ ...step, ...patch } as ApiWorkflowStep);
  const requestPicker = (s: Extract<ApiWorkflowStep, { kind: 'request' | 'poll' }>) => (
    <>
      <label className="field">
        <span className="flab">Request</span>
        <select className="inp" value={s.requestId} disabled={readOnly} onChange={(e) => set({ requestId: e.target.value, variationId: null })}>
          {!requests.some((r) => r.id === s.requestId) && <option value={s.requestId}>A deleted request</option>}
          {requests.map((r) => <option key={r.id} value={r.id}>{METHOD_SHORT[r.method ?? 'GET']} {r.name}</option>)}
        </select>
      </label>
      <VariationPicker base={base} requestId={s.requestId} value={s.variationId} readOnly={readOnly} onChange={(variationId) => set({ variationId })} />
      <AssignTable rows={s.assign} readOnly={readOnly} onChange={(assign) => set({ assign })} />
    </>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label className="field">
        <span className="flab">Label</span>
        <input className="inp" value={step.name} placeholder="Optional" readOnly={readOnly} onChange={(e) => set({ name: e.target.value })} />
      </label>
      {step.kind === 'request' && (
        <>
          {requestPicker(step)}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={step.continueOnFail} disabled={readOnly} onChange={(e) => set({ continueOnFail: e.target.checked })} />
            Carry on if this step fails
          </label>
        </>
      )}
      {step.kind === 'wait' && (
        <label className="field"><span className="flab">Milliseconds</span><input className="inp" type="number" min={0} max={60000} value={step.ms} readOnly={readOnly} onChange={(e) => set({ ms: Number(e.target.value) || 0 })} /></label>
      )}
      {step.kind === 'poll' && (
        <>
          {requestPicker(step)}
          <ConditionForm c={step.until} readOnly={readOnly} onChange={(until) => set({ until })} label="Until" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label className="field"><span className="flab">Every (ms)</span><input className="inp" type="number" min={200} value={step.intervalMs} readOnly={readOnly} onChange={(e) => set({ intervalMs: Number(e.target.value) || 2000 })} /></label>
            <label className="field"><span className="flab">Give up after (ms)</span><input className="inp" type="number" min={1000} max={120000} value={step.timeoutMs} readOnly={readOnly} onChange={(e) => set({ timeoutMs: Number(e.target.value) || 60000 })} /></label>
          </div>
        </>
      )}
      {step.kind === 'if' && <ConditionForm c={step.condition} readOnly={readOnly} onChange={(condition) => set({ condition })} label="If" />}
      {step.kind === 'loop' && (
        <>
          <div className="seg" role="radiogroup" aria-label="Loop over">
            <button role="radio" aria-checked={step.overVariable === null} className={step.overVariable === null ? 'on' : ''} disabled={readOnly} onClick={() => set({ overVariable: null, count: step.count ?? 3 })}>A number of times</button>
            <button role="radio" aria-checked={step.overVariable !== null} className={step.overVariable !== null ? 'on' : ''} disabled={readOnly} onClick={() => set({ overVariable: 'items', count: null })}>Each item of a list</button>
          </div>
          {step.overVariable === null ? (
            <label className="field"><span className="flab">Times</span><input className="inp" type="number" min={1} max={100} value={step.count ?? 1} readOnly={readOnly} onChange={(e) => set({ count: Math.max(1, Number(e.target.value) || 1) })} /></label>
          ) : (
            <label className="field"><span className="flab">Variable holding a JSON array</span><input className="inp mono" value={step.overVariable} readOnly={readOnly} onChange={(e) => set({ overVariable: e.target.value })} /></label>
          )}
          <label className="field"><span className="flab">Each item as</span><input className="inp mono" value={step.as} readOnly={readOnly} onChange={(e) => set({ as: e.target.value })} /></label>
        </>
      )}
      {step.kind === 'parallel' && <span className="t2">{step.branches.length} branches run at the same time. They share variables: when two set the same one, the last to finish wins.</span>}
      {step.kind === 'workflow' && (
        <label className="field">
          <span className="flab">Workflow</span>
          <select className="inp" value={step.workflowId} disabled={readOnly} onChange={(e) => set({ workflowId: e.target.value })}>
            {!workflows.some((w) => w.id === step.workflowId) && <option value={step.workflowId}>Pick a workflow</option>}
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

function VariationPicker({ base, requestId, value, readOnly, onChange }: { base: string; requestId: string; value: string | null; readOnly: boolean; onChange(v: string | null): void }) {
  const node = useQuery({ queryKey: ['apitest', 'node-variations', requestId], queryFn: () => get<ApiNodeDetail>(`${base}/nodes/${requestId}`), enabled: !!requestId });
  if (!node.data?.variations.length) return null;
  return (
    <label className="field">
      <span className="flab">Variation</span>
      <select className="inp" value={value ?? ''} disabled={readOnly} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Base request</option>
        {node.data.variations.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
    </label>
  );
}

function AssignTable({ rows, onChange, readOnly }: { rows: ApiWorkflowAssign[]; onChange(r: ApiWorkflowAssign[]): void; readOnly: boolean }) {
  const set = (i: number, patch: Partial<ApiWorkflowAssign>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="field">
      <span className="flab">Save from the response</span>
      {rows.map((a, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 1.3fr 26px', gap: 4 }}>
          <input className="inp mono" value={a.variable} placeholder="variable" aria-label="Variable" readOnly={readOnly} onChange={(e) => set(i, { variable: e.target.value })} />
          <select className="inp" value={a.source} disabled={readOnly} aria-label="From" onChange={(e) => set(i, { source: e.target.value as ApiWorkflowAssign['source'] })}>
            <option value="body">Body</option>
            <option value="header">Header</option>
            <option value="status">Status</option>
          </select>
          <input className="inp mono" value={a.path} placeholder="$.id" aria-label="Path" disabled={readOnly || a.source === 'status'} onChange={(e) => set(i, { path: e.target.value })} />
          {!readOnly && <button className="btn ghost sm" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Icon name="x" size={11} /></button>}
        </div>
      ))}
      {!readOnly && <div><button className="btn sm" onClick={() => onChange([...rows, { variable: '', source: 'body', path: '$.' }])}><Icon name="plus" size={11} />Save a value</button></div>}
    </div>
  );
}

function ConditionForm({ c, onChange, readOnly, label }: { c: ApiWorkflowCondition; onChange(c: ApiWorkflowCondition): void; readOnly: boolean; label: string }) {
  return (
    <div className="field">
      <span className="flab">{label}</span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 1fr', gap: 4 }}>
        <input className="inp mono" value={c.variable} placeholder="variable" aria-label={`${label} variable`} readOnly={readOnly} onChange={(e) => onChange({ ...c, variable: e.target.value })} />
        <select className="inp" value={c.op} disabled={readOnly} aria-label="Comparison" onChange={(e) => onChange({ ...c, op: e.target.value as ApiWorkflowCondition['op'] })}>
          {(['eq', 'ne', 'lt', 'gt', 'contains', 'exists', 'notExists'] as const).map((o) => <option key={o} value={o}>{{ eq: 'equals', ne: 'is not', lt: 'less than', gt: 'more than', contains: 'contains', exists: 'is set', notExists: 'is not set' }[o]}</option>)}
        </select>
        <input className="inp mono" value={c.value} aria-label={`${label} value`} readOnly={readOnly} disabled={c.op === 'exists' || c.op === 'notExists'} onChange={(e) => onChange({ ...c, value: e.target.value })} />
      </div>
    </div>
  );
}

/** Steps as an editable list; if, loop and parallel hold nested lists of their own. */
function StepList(props: EditorProps & { steps: ApiWorkflowStep[]; onChange(s: ApiWorkflowStep[]): void; describe(s: ApiWorkflowStep): [string, string] }) {
  const { steps, onChange, readOnly, firstRequest, workflows } = props;
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  const set = (i: number, s: ApiWorkflowStep) => onChange(steps.map((x, j) => (j === i ? s : x)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {steps.map((s, i) => {
        const [label, detail] = props.describe(s);
        return (
          <div key={s.id} className={g.card}>
            <div className={g.row}>
              <span className="lbl">{i + 1}</span>
              <span className="lbl">{KIND_LABEL[s.kind]}</span>
              <button className="btn ghost sm" style={{ flex: 1, justifyContent: 'flex-start', minWidth: 0 }} onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
                <span className="trunc"><b>{label}</b> <span className="t3">{detail}</span></span>
              </button>
              {!readOnly && (
                <>
                  <button className="btn ghost sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="btn ghost sm" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button className="btn ghost sm" aria-label="Remove step" onClick={() => onChange(steps.filter((_, j) => j !== i))}><Icon name="x" size={11} /></button>
                </>
              )}
            </div>
            {open === s.id && <StepForm {...props} step={s} onChange={(x) => set(i, x)} />}
            {s.kind === 'if' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingLeft: 12 }}>
                <div><span className="flab">Then</span><StepList {...props} steps={s.then} onChange={(then) => set(i, { ...s, then })} /></div>
                <div><span className="flab">Else</span><StepList {...props} steps={s.else} onChange={(els) => set(i, { ...s, else: els })} /></div>
              </div>
            )}
            {s.kind === 'loop' && <div style={{ paddingLeft: 12 }}><StepList {...props} steps={s.steps} onChange={(inner) => set(i, { ...s, steps: inner })} /></div>}
            {s.kind === 'parallel' && (
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${s.branches.length}, minmax(0, 1fr))`, gap: 8, paddingLeft: 12 }}>
                {s.branches.map((b, k) => (
                  <div key={k}>
                    <span className="flab">Branch {k + 1}</span>
                    <StepList {...props} steps={b} onChange={(br) => set(i, { ...s, branches: s.branches.map((x, j) => (j === k ? br : x)) })} />
                  </div>
                ))}
                {!readOnly && s.branches.length < 10 && <div><button className="btn sm" onClick={() => set(i, { ...s, branches: [...s.branches, []] })}><Icon name="plus" size={11} />Branch</button></div>}
              </div>
            )}
          </div>
        );
      })}
      {!readOnly && (
        adding ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <button key={k} className="btn sm" disabled={((k === 'request' || k === 'poll') && !firstRequest) || (k === 'workflow' && !workflows.length)} onClick={() => {
                const s = blank(k, firstRequest, workflows[0]?.id ?? null);
                onChange([...steps, s]);
                setOpen(s.id);
                setAdding(false);
              }}>{KIND_LABEL[k]}</button>
            ))}
            <button className="btn ghost sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        ) : (
          <div><button className="btn sm" onClick={() => setAdding(true)}><Icon name="plus" size={11} />Add step</button></div>
        )
      )}
    </div>
  );
}
