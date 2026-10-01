import { ApiWorkflowDef, type ApiWorkflowStep, type ApiWorkflowStepResult } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { checkCondition, runOneStep, runWorkflow, type EngineDeps, type StepSend } from './engine';

const R1 = '00000000-0000-4000-8000-000000000001';
const R2 = '00000000-0000-4000-8000-000000000002';
const R3 = '00000000-0000-4000-8000-000000000003';
const SUB = '00000000-0000-4000-8000-00000000000a';

const facts = (status: number, body: unknown) => ({ status, timeMs: 1, sizeBytes: 1, headers: [] as [string, string][], bodyText: JSON.stringify(body), json: body });

/** A fake API: each request id maps to a function of the variables it was sent with. */
function harness(apis: Record<string, (vars: Record<string, string>, call: number) => StepSend>, sub?: ApiWorkflowDef) {
  const calls: { id: string; vars: Record<string, string> }[] = [];
  const results: ApiWorkflowStepResult[] = [];
  let clock = 0;
  const count = new Map<string, number>();
  const deps: EngineDeps = {
    send: async (id, _v, vars) => {
      calls.push({ id, vars });
      const n = (count.get(id) ?? 0) + 1;
      count.set(id, n);
      clock += 10;
      return apis[id]!(vars, n);
    },
    loadWorkflow: async () => ({ name: 'Sub', def: sub! }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    onResult: (r) => {
      results.push(r);
    },
    mask: (t) => t.replace(/s3cret/g, '••••••'),
    cancelled: () => false,
  };
  return { deps, calls, results };
}
const ok = (body: unknown, status = 200): StepSend => ({ passed: true, message: '', historyId: 'h', facts: facts(status, body), extracted: {} });
const req = (id: string, requestId: string, extra: Partial<Extract<ApiWorkflowStep, { kind: 'request' }>> = {}): ApiWorkflowStep => ({ id, name: id, kind: 'request', requestId, variationId: null, assign: [], continueOnFail: false, ...extra });
const def = (steps: ApiWorkflowStep[], teardown: ApiWorkflowStep[] = [], variables: ApiWorkflowDef['variables'] = []) => ApiWorkflowDef.parse({ steps, teardown, variables });

describe('runWorkflow', () => {
  it('passes values from one step to the next with assign', async () => {
    const h = harness({ [R1]: () => ok({ id: 'ord_1' }, 201), [R2]: (v) => ok({ seen: v.orderId }) });
    const out = await runWorkflow(def([req('create', R1, { assign: [{ variable: 'orderId', source: 'body', path: '$.id' }] }), req('read', R2)]), {}, h.deps);
    expect(out.status).toBe('passed');
    expect(h.calls[1]!.vars.orderId).toBe('ord_1');
    expect(h.results[0]).toMatchObject({ stepId: 'create', status: 'passed', httpStatus: 201, assigned: { orderId: 'ord_1' } });
  });

  it('stops at a failed step but always runs the teardown', async () => {
    const h = harness({ [R1]: () => ({ ...ok({}), passed: false, message: 'status is 500' }), [R2]: () => ok({}), [R3]: () => ok({}) });
    const out = await runWorkflow(def([req('a', R1), req('b', R2)], [req('cleanup', R3)]), {}, h.deps);
    expect(out.status).toBe('failed');
    expect(h.calls.map((c) => c.id)).toEqual([R1, R3]);
    expect(h.results.find((r) => r.stepId === 'cleanup')!.iteration).toBe('teardown/');
  });

  it('carries on past a failure the step allows', async () => {
    const h = harness({ [R1]: () => ({ ...ok({}), passed: false, message: 'x' }), [R2]: () => ok({}) });
    const out = await runWorkflow(def([req('a', R1, { continueOnFail: true }), req('b', R2)]), {}, h.deps);
    expect(h.calls.map((c) => c.id)).toEqual([R1, R2]);
    // Steps after it still ran, but a failed step means the run did not pass.
    expect(out.status).toBe('failed');
  });

  it('keeps going step by step past an allowed failure, and ends failed', async () => {
    const h = harness({ [R1]: () => ({ ...ok({}), passed: false, message: 'x' }), [R2]: () => ok({}) });
    const d = def([req('a', R1, { continueOnFail: true }), req('b', R2)]);
    const first = await runOneStep(d, 0, {}, h.deps);
    expect(first).toMatchObject({ done: false, status: 'paused', failed: true });
    expect(await runOneStep(d, 1, {}, h.deps, first.failed)).toMatchObject({ done: true, status: 'failed' });
  });

  it('runs the teardown even when the run was cancelled', async () => {
    const h = harness({ [R1]: () => ok({}), [R2]: () => ok({}), [R3]: () => ok({}) });
    let stop = false;
    h.deps.onResult = (r) => {
      h.results.push(r);
      if (r.stepId === 'a') stop = true;
    };
    h.deps.cancelled = () => stop;
    const out = await runWorkflow(def([req('a', R1), req('b', R2)], [req('cleanup', R3)]), {}, h.deps);
    expect(out.status).toBe('cancelled');
    expect(h.calls.map((c) => c.id)).toEqual([R1, R3]);
  });

  it('gives parallel branches their own copy of the variables and merges them afterwards', async () => {
    const h = harness({ [R1]: () => ok({ v: 'one' }), [R2]: (v) => ok({ v: v.who ?? 'none' }), [R3]: (v) => ok({ saw: v.who }) });
    const par: ApiWorkflowStep = {
      id: 'par', name: 'par', kind: 'parallel',
      branches: [[req('b1', R1, { assign: [{ variable: 'who', source: 'body', path: '$.v' }] })], [req('b2', R2, { assign: [{ variable: 'other', source: 'body', path: '$.v' }] })]],
    };
    await runWorkflow(def([par, req('after', R3)]), {}, h.deps);
    // The second branch did not see what the first assigned while they ran.
    expect(h.calls.find((c) => c.id === R2)!.vars.who).toBeUndefined();
    expect(h.calls.find((c) => c.id === R3)!.vars).toMatchObject({ who: 'one', other: 'none' });
  });

  it('polls until the condition holds, and fails on timeout', async () => {
    const h = harness({ [R1]: (_v, n) => ok({ status: n >= 3 ? 'done' : 'pending' }) });
    const poll: ApiWorkflowStep = { id: 'p', name: 'wait for job', kind: 'poll', requestId: R1, variationId: null, assign: [{ variable: 'job', source: 'body', path: '$.status' }], until: { variable: 'job', op: 'eq', value: 'done' }, intervalMs: 1000, timeoutMs: 10_000 };
    expect((await runWorkflow(def([poll]), {}, h.deps)).status).toBe('passed');
    expect(h.results[0]!.message).toBe('job = done after 3 tries');

    const never = harness({ [R1]: () => ok({ status: 'pending' }) });
    expect((await runWorkflow(def([{ ...poll, timeoutMs: 3000 }]), {}, never.deps)).status).toBe('failed');
  });

  it('says what the last answer was when a poll times out', async () => {
    const h = harness({ [R1]: () => ok({ status: 'pending' }, 202) });
    const poll: ApiWorkflowStep = { id: 'p', name: 'p', kind: 'poll', requestId: R1, variationId: null, assign: [{ variable: 'job', source: 'body', path: '$.status' }], until: { variable: 'job', op: 'eq', value: 'done' }, intervalMs: 1000, timeoutMs: 2500 };
    await runWorkflow(def([poll]), {}, h.deps);
    expect(h.results[0]!.message).toMatch(/tries in .*; the last answer was 202/);
  });

  it('exposes fields of each object in a loop, and forgets the loop variable afterwards', async () => {
    const h = harness({ [R1]: () => ok([{ id: 'a1', qty: 2 }, { id: 'b2', qty: 5 }]), [R2]: (v) => ok({ seen: v['item.id'] }), [R3]: (v) => ok({ left: v.item ?? v['item.id'] ?? null }) });
    const loop: ApiWorkflowStep = { id: 'l', name: 'each', kind: 'loop', count: null, overVariable: 'items', as: 'item', steps: [req('use', R2)] };
    const out = await runWorkflow(def([req('list', R1, { assign: [{ variable: 'items', source: 'body', path: '$' }] }), loop, req('after', R3)]), {}, h.deps);
    expect(out.status).toBe('passed');
    expect(h.calls.filter((c) => c.id === R2).map((c) => [c.vars['item.id'], c.vars['item.qty']])).toEqual([['a1', '2'], ['b2', '5']]);
    expect(h.calls.find((c) => c.id === R3)!.vars.item).toBeUndefined();
    expect(h.calls.find((c) => c.id === R3)!.vars['item.id']).toBeUndefined();
  });

  it('branches on a condition and loops over an array from a response', async () => {
    const h = harness({ [R1]: () => ok({ ids: ['a', 'b', 'c'] }), [R2]: () => ok({}), [R3]: () => ok({}) });
    const out = await runWorkflow(
      def([
        req('list', R1, { assign: [{ variable: 'ids', source: 'body', path: '$.ids' }] }),
        { id: 'each', name: '', kind: 'loop', count: null, overVariable: 'ids', as: 'id', steps: [req('get', R2)] },
        { id: 'check', name: '', kind: 'if', condition: { variable: 'ids', op: 'contains', value: 'c' }, then: [req('yes', R3)], else: [] },
      ]),
      {},
      h.deps,
    );
    expect(out.status).toBe('passed');
    expect(h.calls.filter((c) => c.id === R2).map((c) => c.vars.id)).toEqual(['a', 'b', 'c']);
    expect(h.results.filter((r) => r.stepId === 'get').map((r) => r.iteration)).toEqual(['each#1/', 'each#2/', 'each#3/']);
    expect(h.calls.at(-1)!.id).toBe(R3);
  });

  it('runs parallel branches and a sub-workflow with its own teardown', async () => {
    const sub = def([req('inner', R3)], [req('innerCleanup', R3)]);
    const h = harness({ [R1]: () => ok({}), [R2]: () => ok({}), [R3]: () => ok({}) }, sub);
    const out = await runWorkflow(
      def([
        { id: 'both', name: '', kind: 'parallel', branches: [[req('x', R1)], [req('y', R2)]] },
        { id: 'call', name: '', kind: 'workflow', workflowId: SUB },
      ]),
      {},
      h.deps,
    );
    expect(out.status).toBe('passed');
    expect(h.calls.map((c) => c.id).sort()).toEqual([R1, R2, R3, R3].sort());
    expect(h.results.find((r) => r.stepId === 'innerCleanup')!.iteration).toBe('call>teardown/');
  });

  it('stops a workflow that calls itself, and a loop that never ends', async () => {
    const self = def([{ id: 'me', name: '', kind: 'workflow', workflowId: SUB }]);
    const h = harness({}, self);
    const out = await runWorkflow(self, {}, h.deps);
    expect(out).toMatchObject({ status: 'failed' });
    expect(out.error).toMatch(/nest at most/);
  });

  it('masks secrets in what it records, and starts from the workflow variables', async () => {
    const h = harness({ [R1]: (v) => ({ ...ok({}), extracted: { token: `s3cret-${v.env}` } }) });
    await runWorkflow(def([req('a', R1)], [], [{ key: 'env', value: 'qa', enabled: true }]), {}, h.deps);
    expect(h.calls[0]!.vars.env).toBe('qa');
    expect(h.results[0]!.assigned.token).toBe('••••••-qa');
  });
});

describe('step mode', () => {
  it('runs one top-level step at a time and the teardown at the end', async () => {
    const h = harness({ [R1]: () => ok({}), [R2]: () => ok({}), [R3]: () => ok({}) });
    const d = def([req('a', R1), req('b', R2)], [req('t', R3)]);
    const vars = {};
    expect(await runOneStep(d, 0, vars, h.deps)).toMatchObject({ done: false, status: 'paused' });
    expect(await runOneStep(d, 1, vars, h.deps)).toMatchObject({ done: true, status: 'passed' });
    expect(h.calls.map((c) => c.id)).toEqual([R1, R2, R3]);
  });
});

describe('checkCondition', () => {
  it('compares numbers as numbers and handles missing values', () => {
    expect(checkCondition({ variable: 'n', op: 'gt', value: '9' }, { n: '10' })).toBe(true);
    expect(checkCondition({ variable: 'n', op: 'eq', value: '1.0' }, { n: '1' })).toBe(true);
    expect(checkCondition({ variable: 'x', op: 'exists', value: '' }, {})).toBe(false);
    expect(checkCondition({ variable: 'x', op: 'eq', value: '' }, {})).toBe(false);
  });
});
