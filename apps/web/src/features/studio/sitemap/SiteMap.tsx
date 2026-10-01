'use client';

import '@xyflow/react/dist/style.css';
import type { GraphWorkflow, SiteGraph, SitePage } from '@tb/contracts';
import { useQuery } from '@tanstack/react-query';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { usePrefs, useSession } from '@/components/providers';
import { get } from '@/lib/api';
import { ago } from '@/lib/format';
import { ChecksEditor, describeCheck, useWorkflowPlan } from '../workflows/checks';
import { layers } from './layout';
import m from './sitemap.module.css';

type PageData = { page: SitePage; starts: GraphWorkflow[] };
type WorkflowData = { workflow: GraphWorkflow };
type ApiData = { call: string; status: number | null };

const X = 270;
const Y = 118;

function PageNode({ data, selected }: NodeProps<Node<PageData>>) {
  const p = data.page;
  return (
    <div className={`${m.node} ${m.page} ${selected ? m.on : ''}`}>
      <Handle type="target" position={Position.Left} />
      <span className={m.kind}>Page</span>
      <b className={m.title}>{p.title || p.path}</b>
      <code className={m.path}>{p.path}</code>
      <span className={m.meta}>
        {p.actions.length} buttons · {p.fields.length} fields · {p.apis.length} APIs
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function WorkflowNode({ data, selected }: NodeProps<Node<WorkflowData>>) {
  const wf = data.workflow;
  const pos = wf.scenarios.filter((s) => s.expect.outcome === 'success').length;
  const neg = wf.scenarios.length - pos;
  return (
    <div className={`${m.node} ${wf.kind === 'prerequisite' ? m.prerequisite : m.workflow} ${selected ? m.on : ''}`}>
      <Handle type="target" position={Position.Left} />
      <span className={m.kind}>{wf.kind === 'prerequisite' ? 'Prerequisite' : 'Workflow'}</span>
      <b className={m.title}>{wf.name}</b>
      <span className={m.meta}>
        <span className={m.okText}>+{pos}</span> <span className={m.badText}>−{neg}</span> scenarios · {wf.apis.length} APIs
      </span>
      <span className={m.meta}>{wf.usedBy.length} test{wf.usedBy.length === 1 ? '' : 's'}{wf.checks.length ? ` · ${wf.checks.length} checks` : ''}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ApiNode({ data }: NodeProps<Node<ApiData>>) {
  return (
    <div className={`${m.node} ${m.api}`}>
      <Handle type="target" position={Position.Left} />
      <code>{data.call}</code>
      {data.status !== null && <span className={m.meta}>{data.status}</span>}
    </div>
  );
}

const NODE_TYPES = { page: PageNode, workflow: WorkflowNode, api: ApiNode };

/** Pages as nodes, workflows between them, and what each validates: the project's picture of its site. */
function graphOf(g: SiteGraph, show: { links: boolean; apis: boolean }, q: string) {
  const pageId = (path: string) => `p:${path}`;
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const edges: Edge[] = [];
  const edge = (id: string, source: string, target: string, extra: Partial<Edge> = {}) =>
    edges.push({ id, source, target, markerEnd: { type: MarkerType.ArrowClosed }, ...extra });
  for (const wf of g.workflows) {
    edge(`e:${wf.id}:in`, pageId(wf.from), `w:${wf.id}`, { label: wf.startAction ?? undefined, className: m.flow });
    edge(`e:${wf.id}:out`, `w:${wf.id}`, pageId(wf.to), { className: m.flow });
    if (wf.prerequisiteId && g.workflows.some((x) => x.id === wf.prerequisiteId))
      edge(`e:${wf.id}:pre`, `w:${wf.prerequisiteId}`, `w:${wf.id}`, { label: 'first', className: m.pre, animated: true });
  }
  if (show.links) for (const l of g.links) edge(`l:${l.from}:${l.to}`, pageId(l.from), pageId(l.to), { label: l.label, className: m.link });
  const apiNodes: Array<{ id: string; call: string; status: number | null }> = [];
  if (show.apis)
    for (const wf of g.workflows)
      for (const a of wf.apis) {
        const id = `a:${a.method} ${a.path}`;
        if (!apiNodes.some((x) => x.id === id)) apiNodes.push({ id, call: `${a.method} ${a.path}`, status: a.status });
        edge(`a:${wf.id}:${id}`, `w:${wf.id}`, id, { className: m.apiEdge });
      }
  // Pages in the order the journeys reach them, so the map reads left to right like a user goes.
  const ids = [...g.pages.map((p) => pageId(p.path)), ...g.workflows.map((wf) => `w:${wf.id}`), ...apiNodes.map((a) => a.id)];
  const placed = layers(ids, edges.filter((e) => !e.id.startsWith('l:')).map((e) => ({ from: e.source, to: e.target })));
  const at = (id: string) => {
    const p = placed.get(id) ?? { layer: 0, row: 0 };
    return { x: p.layer * X, y: p.row * Y };
  };
  const nodes: Node[] = [
    ...g.pages.map((p) => ({
      id: pageId(p.path),
      type: 'page',
      position: at(pageId(p.path)),
      data: { page: p, starts: g.workflows.filter((wf) => wf.from === p.path) },
      className: match(`${p.path} ${p.title}`) ? '' : m.dim,
    })),
    ...g.workflows.map((wf) => ({ id: `w:${wf.id}`, type: 'workflow', position: at(`w:${wf.id}`), data: { workflow: wf }, className: match(`${wf.name} ${wf.intent}`) ? '' : m.dim })),
    ...apiNodes.map((a) => ({ id: a.id, type: 'api', position: at(a.id), data: { call: a.call, status: a.status }, className: match(a.call) ? '' : m.dim })),
  ];
  return { nodes, edges };
}

/**
 * The site map (testing-studio-plan §3.3): every page the Test Browser has reached, the workflows
 * that lead from one to another, the APIs they call and what is validated in each. Pages come in as
 * testers browse, record and run; workflows as they are saved.
 */
export function SiteMap({ header }: { header: ReactNode }) {
  const { project } = useSession();
  const prefs = usePrefs();
  const params = useSearchParams();
  const graph = useQuery({ queryKey: ['site-graph', project.id], queryFn: () => get<SiteGraph>(`/projects/${project.id}/studio/site/graph`) });
  const [show, setShow] = useState({ links: false, apis: false });
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(params.get('focus'));
  const flow = useMemo(() => (graph.data ? graphOf(graph.data, show, q) : { nodes: [], edges: [] }), [graph.data, show, q]);
  const g = graph.data;
  const totals = g && {
    validations: g.workflows.reduce((n, wf) => n + wf.scenarios.length, 0),
    apis: new Set([...g.workflows.flatMap((wf) => wf.apis.map((a) => `${a.method} ${a.path}`)), ...g.pages.flatMap((p) => p.apis.map((a) => `${a.method} ${a.path}`))]).size,
  };

  return (
    <div className={m.screen}>
      <div className={m.top}>{header}</div>
      <div className={m.bar}>
        <input className="inp" style={{ height: 26, width: 220 }} placeholder="Find a page or workflow" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a page or workflow" />
        <label className="row t3" style={{ gap: 4 }}><input type="checkbox" checked={show.links} onChange={(e) => setShow({ ...show, links: e.target.checked })} /> Links between pages</label>
        <label className="row t3" style={{ gap: 4 }}><input type="checkbox" checked={show.apis} onChange={(e) => setShow({ ...show, apis: e.target.checked })} /> APIs</label>
        <div className="f1" />
        {g && totals && (
          <span className="t3">
            {g.pages.length} pages · {g.workflows.length} workflows · {totals.validations} scenarios · {totals.apis} APIs
          </span>
        )}
        <button className="ib sm" aria-label="Reload the map" onClick={() => void graph.refetch()}><Icon name="refresh" size={12} /></button>
      </div>
      <div className={m.body}>
        <div className={m.canvas}>
          {graph.isLoading ? (
            <div className="empty t3">Loading the site map…</div>
          ) : !g || (!g.pages.length && !g.workflows.length) ? (
            <div className="empty t3" style={{ flexDirection: 'column', gap: 8, padding: 24, textAlign: 'center' }}>
              <span>Nothing on the map yet. Open your site in the Test Browser (Workflows or Code) and move around it: every page you reach is added, with its buttons, fields and APIs.</span>
              <Link className="btn sm primary" href="/automation?tab=workflows&new=1">Record a workflow</Link>
            </div>
          ) : (
            <ReactFlow
              nodes={flow.nodes.map((n) => ({ ...n, selected: n.id === selected }))}
              edges={flow.edges}
              nodeTypes={NODE_TYPES}
              onNodeClick={(_, n) => setSelected(n.id)}
              onPaneClick={() => setSelected(null)}
              fitView
              colorMode={prefs.theme}
              minZoom={0.2}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} />
              <MiniMap pannable zoomable className={m.minimap} nodeColor={(n) => (n.type === 'page' ? '#3b82f6' : n.type === 'workflow' ? '#8b5cf6' : '#888')} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
        <aside className={m.side} aria-label="Details">
          {g && selected ? <Details graph={g} id={selected} onSelect={setSelected} /> : (
            <div className={m.hint}>
              <b>How to read it</b>
              <span>Blue boxes are pages, purple ones workflows, grey ones prerequisites (signing in): a user goes from a page, through a workflow, to the page it leads to. A dashed arrow means “runs first”.</span>
              <span>Pick one to see its buttons, fields and APIs, or the scenarios a workflow is tested with, and add checks.</span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Details({ graph, id, onSelect }: { graph: SiteGraph; id: string; onSelect(id: string): void }) {
  if (id.startsWith('p:')) {
    const page = graph.pages.find((p) => `p:${p.path}` === id);
    return page ? <PageDetails page={page} graph={graph} onSelect={onSelect} /> : null;
  }
  if (id.startsWith('w:')) {
    const wf = graph.workflows.find((x) => `w:${x.id}` === id);
    return wf ? <WorkflowDetails key={wf.id} workflow={wf} graph={graph} onSelect={onSelect} /> : null;
  }
  const call = id.slice(2);
  const users = graph.workflows.filter((wf) => wf.apis.some((a) => `${a.method} ${a.path}` === call));
  return (
    <div className={m.details}>
      <span className={m.kind}>API</span>
      <b><code>{call}</code></b>
      <span className="t3">Called by</span>
      {users.map((wf) => <button key={wf.id} className={m.linkBtn} onClick={() => onSelect(`w:${wf.id}`)}>{wf.name}</button>)}
    </div>
  );
}

function PageDetails({ page, graph, onSelect }: { page: SitePage; graph: SiteGraph; onSelect(id: string): void }) {
  const starts = graph.workflows.filter((wf) => wf.from === page.path);
  const arrives = graph.workflows.filter((wf) => wf.to === page.path);
  return (
    <div className={m.details}>
      <span className={m.kind}>Page</span>
      <b>{page.title || page.path}</b>
      <code className="t3">{page.path}</code>
      <span className="t3">{page.visits ? `Reached ${page.visits} time${page.visits === 1 ? '' : 's'}, last ${ago(page.lastSeen)}` : 'Known from a recording only'}</span>
      {page.headings.length > 0 && <Section title="Headings">{page.headings.slice(0, 10).map((h) => <span key={h}>{h}</span>)}</Section>}
      <Section title={`Buttons and links (${page.actions.length})`}>
        {page.actions.slice(0, 60).map((a) => {
          const wf = starts.find((x) => x.startAction === a.label);
          return (
            <div key={`${a.role}${a.label}`} className={m.action}>
              <span className={m.role}>{a.role}</span>
              <span className="f1">{a.label}</span>
              {wf ? <button className={m.linkBtn} onClick={() => onSelect(`w:${wf.id}`)}>starts {wf.name}</button> : a.to ? <button className={m.linkBtn} onClick={() => onSelect(`p:${a.to}`)}>→ {a.to}</button> : null}
            </div>
          );
        })}
      </Section>
      {page.fields.length > 0 && (
        <Section title={`Fields (${page.fields.length})`}>
          {page.fields.map((f) => (
            <span key={f.key}>
              {f.label} <span className="t3">· {f.kind}{f.rules.required ? ' · required' : ''}{f.rules.maxLength > 0 ? ` · max ${f.rules.maxLength}` : ''}{f.rules.minLength > 0 ? ` · min ${f.rules.minLength}` : ''}</span>
            </span>
          ))}
        </Section>
      )}
      {page.apis.length > 0 && (
        <Section title={`APIs it called (${page.apis.length})`}>
          {page.apis.map((a) => <code key={`${a.method}${a.path}${a.status}`}>{a.method} {a.path} → {a.status ?? '–'}</code>)}
        </Section>
      )}
      <Section title="Workflows">
        {starts.map((wf) => <button key={wf.id} className={m.linkBtn} onClick={() => onSelect(`w:${wf.id}`)}>▸ starts here: {wf.name}</button>)}
        {arrives.filter((wf) => !starts.includes(wf)).map((wf) => <button key={wf.id} className={m.linkBtn} onClick={() => onSelect(`w:${wf.id}`)}>◂ leads here: {wf.name}</button>)}
        {!starts.length && !arrives.length && <span className="t3">None yet.</span>}
        <Link className="btn sm" style={{ alignSelf: 'flex-start' }} href="/automation?tab=workflows&new=1"><Icon name="plus" size={11} /> Record one from here</Link>
      </Section>
    </div>
  );
}

function WorkflowDetails({ workflow: wf, graph, onSelect }: { workflow: GraphWorkflow; graph: SiteGraph; onSelect(id: string): void }) {
  const { plan, update } = useWorkflowPlan(wf.id);
  const pre = wf.prerequisiteId ? graph.workflows.find((x) => x.id === wf.prerequisiteId) : undefined;
  const label = (k: string) => wf.fields.find((f) => f.key === k)?.label ?? k;
  const group = (outcome: 'success' | 'rejected') => wf.scenarios.filter((s) => s.expect.outcome === outcome);
  return (
    <div className={m.details}>
      <span className={m.kind}>{wf.kind === 'prerequisite' ? 'Prerequisite' : 'Workflow'}</span>
      <b>{wf.name} <span className="t3">v{wf.version}</span></b>
      <span>{wf.intent}</span>
      <span className="t3">
        {pre ? <>After <button className={m.linkBtn} onClick={() => onSelect(`w:${pre.id}`)}>{pre.name}</button> · </> : null}
        <button className={m.linkBtn} onClick={() => onSelect(`p:${wf.from}`)}>{wf.from}</button>
        {wf.startAction && <> via “{wf.startAction}”</>} → <button className={m.linkBtn} onClick={() => onSelect(`p:${wf.to}`)}>{wf.to}</button>
      </span>
      {wf.kind === 'prerequisite' && <span className="t3">Run first by the workflows that need it. Record it again as a workflow to test it with scenarios.</span>}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', display: wf.kind === 'prerequisite' ? 'none' : undefined }}>
        <Link className="btn sm primary" href={`/automation?tab=workflows&id=${wf.id}&view=plan`}>Test it</Link>
        <Link className="btn sm" href={`/automation?tab=workflows&id=${wf.id}&view=scenarios`}>Scenarios</Link>
        <Link className="btn sm" href={`/automation?tab=tests&journey=${wf.id}`}>Use in a journey</Link>
      </div>
      <Section title={`Fields (${wf.fields.length})`}>
        {wf.fields.map((f) => (
          <span key={f.key}>{f.label} <span className="t3">· {f.kind}{f.rules.required ? ' · required' : ''}{f.rules.maxLength > 0 ? ` · max ${f.rules.maxLength}` : ''}{f.rules.minLength > 0 ? ` · min ${f.rules.minLength}` : ''}</span></span>
        ))}
      </Section>
      {(['success', 'rejected'] as const).map((o) => (
        <Section key={o} title={`${o === 'success' ? 'Positive' : 'Negative'} validations (${group(o).length})`}>
          {group(o).map((s) => (
            <div key={s.id} className={m.validation}>
              <span className="f1">{s.title}</span>
              <span className={`${m.status} ${s.status === 'confirmed' ? m.okText : ''}`}>{s.status}</span>
              <span className="t3" style={{ gridColumn: '1 / -1' }}>
                {[
                  s.expect.message && `“${s.expect.message}”`,
                  ...s.expect.fieldErrors.map((e) => `${label(e.field)}: “${e.message || 'an error'}”`),
                  s.expect.stop && `stops at a ${s.expect.stop.kind} step`,
                  ...s.expect.checks.map(describeCheck),
                ].filter(Boolean).join(' · ') || (o === 'success' ? 'accepted' : 'refused')}
              </span>
            </div>
          ))}
          {!group(o).length && <span className="t3">None agreed yet.</span>}
        </Section>
      ))}
      <Section title={`APIs it calls (${wf.apis.length})`}>
        {wf.apis.map((a, i) => <code key={i}>{a.method} {a.path} → {a.status ?? '–'} <span className="t3">after {a.after}</span></code>)}
      </Section>
      <Section title="Checked on every success">
        {plan ? <ChecksEditor checks={plan.checks} onChange={(next) => update({ checks: next })} apis={wf.apis} /> : <span className="t3">Loading…</span>}
      </Section>
      <Section title={`Used by (${wf.usedBy.length})`}>
        {wf.usedBy.map((u) => (
          <Link key={u.testId} className={m.linkBtn} href={`/automation?tab=tests&id=${u.testId}`}>{u.key} {u.title}{u.caseId ? ' · test case' : ''}</Link>
        ))}
        {!wf.usedBy.length && <span className="t3">No tests yet.</span>}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className={m.section} open>
      <summary>{title}</summary>
      <div className={m.sectionBody}>{children}</div>
    </details>
  );
}
