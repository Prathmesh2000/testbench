import type { ApiWorkflowStep } from '@tb/contracts';

// Places a workflow's steps on a canvas top to bottom: a sequence stacks, an if splits into then and
// else columns that join again, a loop indents its body with an edge back to the loop, and parallel
// branches sit side by side. Pure, so the canvas and its tests agree on where things go.

export const NODE_W = 230;
export const NODE_H = 58;
const GAP_Y = 34;
const GAP_X = 40;

export interface FlowNode {
  /** The step's path in the tree ("steps.2.then.0"), unique even when step ids repeat. */
  id: string;
  step: ApiWorkflowStep | null;
  kind: ApiWorkflowStep['kind'] | 'start' | 'end' | 'teardown';
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Loop-back edges are drawn dashed. */
  back?: boolean;
}

interface Block {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
  /** Node ids that flow on to whatever comes next. */
  exits: { id: string; label?: string }[];
  entry: string | null;
}

let edgeSeq = 0;
const edge = (from: string, to: string, label?: string, back?: boolean): FlowEdge => ({ id: `e${edgeSeq++}`, from, to, label, back });

function sequence(steps: ApiWorkflowStep[], path: string, x: number, y: number): Block {
  const block: Block = { nodes: [], edges: [], width: NODE_W, height: 0, exits: [], entry: null };
  let cy = y;
  let pending: Block['exits'] = [];
  steps.forEach((s, i) => {
    const b = stepBlock(s, `${path}.${i}`, x, cy);
    block.nodes.push(...b.nodes);
    block.edges.push(...b.edges);
    if (block.entry === null) block.entry = b.entry;
    if (b.entry) for (const p of pending) block.edges.push(edge(p.id, b.entry, p.label));
    pending = b.exits;
    block.width = Math.max(block.width, b.width);
    cy += b.height + GAP_Y;
  });
  block.height = steps.length ? cy - y - GAP_Y : 0;
  block.exits = pending;
  return block;
}

function stepBlock(s: ApiWorkflowStep, path: string, x: number, y: number): Block {
  const head: FlowNode = { id: path, step: s, kind: s.kind, x, y };
  if (s.kind === 'if') {
    const below = y + NODE_H + GAP_Y;
    const yes = sequence(s.then, `${path}.then`, x, below);
    const no = sequence(s.else, `${path}.else`, x + Math.max(yes.width, NODE_W) + GAP_X, below);
    const edges = [...yes.edges, ...no.edges];
    if (yes.entry) edges.push(edge(path, yes.entry, 'then'));
    if (no.entry) edges.push(edge(path, no.entry, 'else'));
    const exits = [
      ...(yes.entry ? yes.exits : [{ id: path, label: 'then' }]),
      ...(no.entry ? no.exits : [{ id: path, label: 'else' }]),
    ];
    return {
      nodes: [head, ...yes.nodes, ...no.nodes],
      edges,
      width: Math.max(yes.width, NODE_W) + GAP_X + Math.max(no.width, NODE_W),
      height: NODE_H + GAP_Y + Math.max(yes.height, no.height, 0),
      exits,
      entry: path,
    };
  }
  if (s.kind === 'loop') {
    const body = sequence(s.steps, `${path}.steps`, x + GAP_X, y + NODE_H + GAP_Y);
    const edges = [...body.edges];
    if (body.entry) {
      edges.push(edge(path, body.entry, 'each'));
      for (const e of body.exits) edges.push(edge(e.id, path, 'next', true));
    }
    return { nodes: [head, ...body.nodes], edges, width: Math.max(NODE_W, body.width + GAP_X), height: NODE_H + (body.entry ? GAP_Y + body.height : 0), exits: [{ id: path, label: 'done' }], entry: path };
  }
  if (s.kind === 'parallel') {
    let cx = x;
    const nodes: FlowNode[] = [head];
    const edges: FlowEdge[] = [];
    const exits: Block['exits'] = [];
    let height = 0;
    s.branches.forEach((b, i) => {
      const blk = sequence(b, `${path}.branches.${i}`, cx, y + NODE_H + GAP_Y);
      nodes.push(...blk.nodes);
      edges.push(...blk.edges);
      if (blk.entry) edges.push(edge(path, blk.entry, `branch ${i + 1}`));
      exits.push(...(blk.entry ? blk.exits : [{ id: path }]));
      height = Math.max(height, blk.height);
      cx += Math.max(blk.width, NODE_W) + GAP_X;
    });
    return { nodes, edges, width: cx - x - GAP_X, height: NODE_H + GAP_Y + height, exits, entry: path };
  }
  return { nodes: [head], edges: [], width: NODE_W, height: NODE_H, exits: [{ id: path }], entry: path };
}

/** The whole canvas: start, the steps, then the teardown (reached whatever happened), then end. */
export function flowLayout(steps: ApiWorkflowStep[], teardown: ApiWorkflowStep[]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  edgeSeq = 0;
  const start: FlowNode = { id: 'start', step: null, kind: 'start', x: 0, y: 0 };
  const main = sequence(steps, 'steps', 0, NODE_H + GAP_Y);
  const nodes = [start, ...main.nodes];
  const edges = [...main.edges];
  if (main.entry) edges.push(edge('start', main.entry));
  let exits = main.entry ? main.exits : [{ id: 'start' }];
  let y = NODE_H + GAP_Y + (main.height ? main.height + GAP_Y : 0);
  if (teardown.length) {
    const td: FlowNode = { id: 'teardown', step: null, kind: 'teardown', x: 0, y };
    nodes.push(td);
    for (const e of exits) edges.push(edge(e.id, 'teardown', e.label));
    const tb = sequence(teardown, 'teardown', 0, y + NODE_H + GAP_Y);
    nodes.push(...tb.nodes);
    edges.push(...tb.edges);
    if (tb.entry) edges.push(edge('teardown', tb.entry, 'always'));
    exits = tb.entry ? tb.exits : [{ id: 'teardown' }];
    y += NODE_H + GAP_Y + tb.height + GAP_Y;
  }
  nodes.push({ id: 'end', step: null, kind: 'end', x: 0, y });
  for (const e of exits) edges.push(edge(e.id, 'end', e.label));
  return { nodes, edges };
}

/** The step at a tree path, and a copy of the list with that step replaced or removed. */
export function stepAt(steps: ApiWorkflowStep[], path: string): ApiWorkflowStep | null {
  const parts = path.split('.').slice(1);
  let list: ApiWorkflowStep[] = steps;
  let found: ApiWorkflowStep | null = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (/^\d+$/.test(p)) {
      found = list[Number(p)] ?? null;
      if (!found) return null;
    } else if (found) {
      const next = parts[i + 1];
      if (p === 'branches' && found.kind === 'parallel') {
        list = found.branches[Number(next)] ?? [];
        i++;
      } else list = ((found as unknown as Record<string, ApiWorkflowStep[]>)[p] ?? []) as ApiWorkflowStep[];
    }
  }
  return found;
}
