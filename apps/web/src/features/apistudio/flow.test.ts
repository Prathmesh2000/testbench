import type { ApiWorkflowStep } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { flowLayout, NODE_H, stepAt } from './flow';

const R = '00000000-0000-4000-8000-000000000001';
const req = (id: string): ApiWorkflowStep => ({ id, name: id, kind: 'request', requestId: R, variationId: null, assign: [], continueOnFail: false });

describe('flowLayout', () => {
  it('stacks a sequence between start and end', () => {
    const { nodes, edges } = flowLayout([req('a'), req('b')], []);
    expect(nodes.map((n) => n.id)).toEqual(['start', 'steps.0', 'steps.1', 'end']);
    expect(nodes[2]!.y).toBeGreaterThan(nodes[1]!.y + NODE_H);
    expect(edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(['start>steps.0', 'steps.0>steps.1', 'steps.1>end'].sort());
  });

  it('splits an if into columns that both flow on, and draws a loop back', () => {
    const { nodes, edges } = flowLayout(
      [
        { id: 'c', name: '', kind: 'if', condition: { variable: 'x', op: 'exists', value: '' }, then: [req('t')], else: [req('e')] },
        { id: 'l', name: '', kind: 'loop', count: 2, overVariable: null, as: 'item', steps: [req('body')] },
      ],
      [req('clean')],
    );
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    expect(at('steps.0.else.0').x).toBeGreaterThan(at('steps.0.then.0').x);
    expect(edges.filter((e) => e.to === 'steps.1' && !e.back).map((e) => e.from).sort()).toEqual(['steps.0.else.0', 'steps.0.then.0']);
    expect(edges.find((e) => e.from === 'steps.1.steps.0' && e.to === 'steps.1')!.back).toBe(true);
    expect(edges.find((e) => e.from === 'teardown')!.label).toBe('always');
  });

  it('puts parallel branches side by side', () => {
    const { nodes } = flowLayout([{ id: 'p', name: '', kind: 'parallel', branches: [[req('a')], [req('b')]] }], []);
    const a = nodes.find((n) => n.id === 'steps.0.branches.0.0')!;
    const b = nodes.find((n) => n.id === 'steps.0.branches.1.0')!;
    expect(a.y).toBe(b.y);
    expect(b.x).toBeGreaterThan(a.x);
  });
});

describe('stepAt', () => {
  it('finds a step by its tree path', () => {
    const steps: ApiWorkflowStep[] = [req('a'), { id: 'p', name: '', kind: 'parallel', branches: [[req('x')], [req('y')]] }];
    expect(stepAt(steps, 'steps.0')!.id).toBe('a');
    expect(stepAt(steps, 'steps.1.branches.1.0')!.id).toBe('y');
    expect(stepAt(steps, 'steps.9')).toBeNull();
  });
});
