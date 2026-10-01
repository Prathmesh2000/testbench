'use client';

import '@xyflow/react/dist/style.css';
import type { ApiWorkflow, DependencyLink, MapOperation, ProjectMap } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { usePrefs, useToast } from '@/components/providers';
import { layers } from '@/features/studio/sitemap/layout';
import { api, ApiError, get } from '@/lib/api';
import g from './graph.module.css';

// The project map (plan §12): every operation in the project's specs, which feeds which, the order to
// call them in, and workflows it suggests. Links are guesses with reasons until a tester confirms them.

type OpData = { op: MapOperation; step: number };

function OperationNode({ data, selected }: NodeProps<Node<OpData>>) {
  const o = data.op;
  return (
    <div className={`${g.node} ${g[`m-${o.method}`]} ${selected ? g.on : ''}`}>
      <Handle type="target" position={Position.Left} />
      <span className={g.kind}><span>{o.tag}</span><span>#{data.step}</span>{o.secured && <span>auth</span>}</span>
      <b className={g.title}>{o.summary || o.path}</b>
      <code className={g.path}>{o.method} {o.path}</code>
      {o.orphans.length > 0 && <span className={g.orphan}>needs {o.orphans.join(', ')}</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const NODE_TYPES = { op: OperationNode };

const X = 280;
const Y = 104;

export function MapView({ projectId, workspaceId, canEdit, onWorkflow }: { projectId: string; workspaceId: string | null; canEdit: boolean; onWorkflow(id: string): void }) {
  const prefs = usePrefs();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const map = useQuery({ queryKey: ['apitest', 'map', projectId], queryFn: () => get<ProjectMap>(`/projects/${projectId}/apitest/map`) });
  const [showAuth, setShowAuth] = useState(false);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ kind: 'op'; key: string } | { kind: 'link'; id: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const flow = useMemo(() => {
    const m = map.data;
    if (!m) return { nodes: [] as Node[], edges: [] as Edge[] };
    const links = m.links.filter((l) => showAuth || l.param.in !== 'auth');
    const placed = layers(m.order, links.map((l) => ({ from: l.from, to: l.to })));
    const needle = q.trim().toLowerCase();
    const nodes: Node[] = m.operations.map((o) => {
      const p = placed.get(o.key) ?? { layer: 0, row: 0 };
      return {
        id: o.key,
        type: 'op',
        position: { x: p.layer * X, y: p.row * Y },
        data: { op: o, step: m.order.indexOf(o.key) + 1 },
        className: !needle || `${o.method} ${o.path} ${o.summary} ${o.tag}`.toLowerCase().includes(needle) ? '' : g.dim,
        selected: picked?.kind === 'op' && picked.key === o.key,
      };
    });
    const edges: Edge[] = links.map((l) => ({
      id: l.id,
      source: l.from,
      target: l.to,
      label: l.param.in === 'auth' ? 'token' : l.param.name,
      markerEnd: { type: MarkerType.ArrowClosed },
      className:
        picked?.kind === 'link' && picked.id === l.id
          ? g.selectedEdge
          : l.param.in === 'auth'
            ? g.authEdge
            : l.source !== 'inferred'
              ? g.confirmed
              : l.confidence < 0.75
                ? g.weak
                : g.edge,
      labelStyle: { fontSize: 10.5 },
    }));
    return { nodes, edges };
  }, [map.data, showAuth, q, picked]);

  const decide = async (l: DependencyLink, status: 'confirmed' | 'rejected') => {
    try {
      await api('POST', `/projects/${projectId}/apitest/map/links`, { from: l.from, to: l.to, param: l.param, field: l.field, status });
      await queryClient.invalidateQueries({ queryKey: ['apitest', 'map', projectId] });
      notify(status === 'confirmed' ? 'Confirmed' : 'Rejected: it will not be suggested again');
      if (status === 'rejected') setPicked(null);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save', 'bad');
    }
  };
  const makeWorkflow = async (suggestionId: string) => {
    if (!workspaceId) return notify('Pick or make a workspace first', 'bad');
    setBusy(true);
    try {
      const wf = await api<ApiWorkflow>('POST', `/projects/${projectId}/apitest/workspaces/${workspaceId}/workflows/from-suggestion`, { suggestionId });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'workflows', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'tree', workspaceId] });
      onWorkflow(wf.id);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not make the workflow', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const m = map.data;
  const op = picked?.kind === 'op' ? m?.operations.find((o) => o.key === picked.key) : null;
  const link = picked?.kind === 'link' ? m?.links.find((l) => l.id === picked.id) : null;
  const suggestions = m?.suggestions.filter((s) => !op || s.steps.some((x) => x.key === op.key)) ?? [];

  return (
    <div className={g.screen}>
      <div className={g.bar}>
        <b style={{ fontSize: 13 }}>Project map</b>
        <input className="inp" style={{ height: 26, width: 220 }} placeholder="Find an operation" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find an operation" />
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={showAuth} onChange={(e) => setShowAuth(e.target.checked)} /> Login links</label>
        <div className="f1" />
        {m && <span className="t3">{m.operations.length} operations · {m.links.filter((l) => l.param.in !== 'auth').length} links · {m.suggestions.length} suggested workflows</span>}
        <button className="btn ghost sm" aria-label="Reload the map" onClick={() => void map.refetch()}><Icon name="refresh" size={12} /></button>
      </div>
      <div className={g.body}>
        <div className={g.canvas}>
          {map.isLoading ? (
            <div className="empty t3" style={{ height: '100%' }}>Reading the specs…</div>
          ) : map.error ? (
            <div className="empty t3" style={{ height: '100%' }}>{map.error instanceof ApiError ? map.error.message : 'Could not load the map.'}</div>
          ) : !m?.operations.length ? (
            <div className="empty t3" style={{ height: '100%', padding: 24, textAlign: 'center' }}>
              <Icon name="tree" size={20} />
              <div>No operations yet. Add an OpenAPI spec in the Specs tab: the map shows which API feeds which, and the order to call them.</div>
            </div>
          ) : (
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={NODE_TYPES}
              onNodeClick={(_, n) => setPicked({ kind: 'op', key: n.id })}
              onEdgeClick={(_, e) => setPicked({ kind: 'link', id: e.id })}
              onPaneClick={() => setPicked(null)}
              fitView
              fitViewOptions={{ maxZoom: 1 }}
              colorMode={prefs.theme}
              minZoom={0.15}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} />
              <MiniMap pannable zoomable className={g.minimap} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
        <aside className={g.side} aria-label="Details">
          {link && (
            <div className={g.card}>
              <b>{link.param.in === 'auth' ? 'Login' : `${link.param.name} (${link.param.in})`}</b>
              <span className={g.mono}>{link.from}</span>
              <span className="t3">{link.field ? <>response <span className={g.mono}>{link.field}</span> fills</> : 'gives the credential for'}</span>
              <span className={g.mono}>{link.to}</span>
              <span className="t2">{link.reason}</span>
              <span className="t3">{link.source === 'inferred' ? `A guess, ${Math.round(link.confidence * 100)}% sure` : link.source === 'spec' ? 'Declared in the spec' : 'Confirmed by a tester'}</span>
              {canEdit && link.source === 'inferred' && (
                <div className={g.row}>
                  <button className="btn sm primary" onClick={() => decide(link, 'confirmed')}><Icon name="check" size={12} />Confirm</button>
                  <button className="btn sm" onClick={() => decide(link, 'rejected')}><Icon name="x" size={12} />Not related</button>
                </div>
              )}
            </div>
          )}
          {op && (
            <div className={g.card}>
              <b>{op.summary || op.path}</b>
              <span className={g.mono}>{op.method} {op.path}</span>
              <span className="t3">{op.specName} · {op.tag} · step {m!.order.indexOf(op.key) + 1} of {m!.order.length}</span>
              {op.orphans.length > 0 && <span className={g.orphan}>Nothing produces {op.orphans.join(', ')}: set it in an environment or a data set.</span>}
              <span className="t2">Needs: {m!.links.filter((l) => l.to === op.key).map((l) => `${l.param.in === 'auth' ? 'login' : l.param.name} from ${l.from}`).join('; ') || 'nothing from other calls'}</span>
              <span className="t2">Feeds: {m!.links.filter((l) => l.from === op.key).map((l) => l.to).filter((v, i, a) => a.indexOf(v) === i).join('; ') || 'nothing'}</span>
            </div>
          )}
          {!picked && m && m.operations.length > 0 && (
            <div className="t2" style={{ lineHeight: 1.5 }}>
              <b>How to read it</b>
              <div>Operations run left to right in the order they can be called; the number is their place in that order. An arrow means the response of one fills an input of the next, labelled with the input. Dashed arrows are less sure: pick one to confirm or reject it.</div>
            </div>
          )}
          {suggestions.length > 0 && (
            <>
              <b style={{ marginTop: 4 }}>{op ? 'Workflows through this operation' : 'Suggested workflows'}</b>
              {suggestions.slice(0, 30).map((s) => (
                <div key={s.id} className={g.card}>
                  <div className={g.row}>
                    <b className="trunc" style={{ flex: 1 }}>{s.name}</b>
                    <span className="lbl">{s.kind === 'crud' ? 'lifecycle' : 'setup'}</span>
                  </div>
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    {s.steps.map((x, i) => <li key={i} className={g.mono}>{x.key}{x.expectStatus ? ` → ${x.expectStatus}` : ''}</li>)}
                  </ol>
                  {canEdit && <div><button className="btn sm" disabled={busy || !workspaceId} onClick={() => makeWorkflow(s.id)}><Icon name="plus" size={12} />Make workflow</button></div>}
                </div>
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
