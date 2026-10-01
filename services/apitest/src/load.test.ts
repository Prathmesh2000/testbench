import { describe, expect, it } from 'vitest';
import { abortReason, Collector, compareRuns, jsAccessor, judge, k6Script, percentile, stagesFor, statusOk, vusAt } from './load';

const th = { p95Ms: 800 as number | null, errorPercent: 1 as number | null, minRps: null as number | null };

describe('stages', () => {
  it('ramps, holds and stops for a load profile', () => {
    const s = stagesFor('load', 50, 100);
    expect([0, 10, 20, 50, 80, 90, 100].map((t) => vusAt(s, t))).toEqual([0, 25, 50, 50, 50, 25, 0]);
  });
  it('steps up for stress and jumps for spike', () => {
    const stress = stagesFor('stress', 100, 100);
    expect([10, 30, 60, 90].map((t) => vusAt(stress, t))).toEqual([25, 50, 75, 100]);
    const spike = stagesFor('spike', 100, 100);
    expect([10, 50, 70].map((t) => vusAt(spike, t))).toEqual([10, 100, 10]);
  });
  it('keeps a smoke test tiny', () => {
    expect(vusAt(stagesFor('smoke', 80, 30), 15)).toBe(2);
    expect(vusAt(stagesFor('smoke', 1, 30), 15)).toBe(1);
  });
});

describe('measuring', () => {
  it('computes nearest-rank percentiles', () => {
    const l = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(l, 50), percentile(l, 95), percentile(l, 99), percentile([], 95)]).toEqual([50, 95, 99, 0]);
  });
  it('summarises endpoints and seconds', () => {
    const c = new Collector();
    for (let i = 0; i < 10; i++) c.record({ key: 'a', name: 'A', second: i % 2, vus: 3, ms: 100 + i, ok: true, bytes: 10 });
    c.record({ key: 'b', name: 'B', second: 1, vus: 4, ms: 900, ok: false, bytes: 5 });
    const m = c.snapshot(2);
    expect(m).toMatchObject({ requests: 11, errors: 1, errorPercent: 9.1, rps: 5.5, bytes: 105, max: 900 });
    expect(m.endpoints.map((e) => e.key)).toEqual(['b', 'a']);
    expect(m.timeline.map((t) => [t.t, t.rps, t.vus])).toEqual([[0, 5, 3], [1, 6, 4]]);
  });
  it('lists a whole workflow run with the endpoints but keeps it out of the totals', () => {
    const c = new Collector();
    c.record({ key: 'a', name: 'A', second: 0, vus: 1, ms: 20, ok: true, bytes: 1 });
    c.record({ key: 'b', name: 'B', second: 0, vus: 1, ms: 30, ok: false, bytes: 1 });
    c.record({ key: 'wf', name: 'Flow (whole workflow)', second: 0, vus: 1, ms: 900, ok: false, bytes: 0, whole: true });
    const m = c.snapshot(1);
    expect(m).toMatchObject({ requests: 2, errors: 1, max: 30 });
    expect(m.endpoints.find((e) => e.key === 'wf')).toMatchObject({ requests: 1, errors: 1, p95: 900 });
    expect(m.timeline.map((t) => t.rps)).toEqual([2]);
    expect(c.recent(1, 5).requests).toBe(2);
  });

  it('looks at the recent window only', () => {
    const c = new Collector();
    for (let i = 0; i < 30; i++) c.record({ key: 'a', name: 'A', second: 0, vus: 1, ms: 5000, ok: false, bytes: 0 });
    for (let i = 0; i < 30; i++) c.record({ key: 'a', name: 'A', second: 20, vus: 1, ms: 10, ok: true, bytes: 0 });
    expect(c.recent(25, 10)).toEqual({ requests: 30, errorPercent: 0, p95: 10 });
  });
});

describe('verdicts', () => {
  const m = { requests: 100, errors: 5, errorPercent: 5, rps: 40, p50: 100, p95: 900, p99: 1000, max: 1200, bytes: 0, endpoints: [], timeline: [] };
  it('judges each threshold', () => {
    expect(judge(m, { p95Ms: 800, errorPercent: 1, minRps: 50 }).map((v) => v.passed)).toEqual([false, false, false]);
    expect(judge(m, { p95Ms: 1000, errorPercent: 10, minRps: null }).every((v) => v.passed)).toBe(true);
    expect(judge({ ...m, requests: 0 }, th).some((v) => !v.passed && v.name === 'sent requests')).toBe(true);
  });
  it('aborts on errors or latency, but not on too little traffic', () => {
    expect(abortReason({ requests: 5, errorPercent: 100, p95: 0 }, { errorPercent: 50, p95Ms: null })).toBeNull();
    expect(abortReason({ requests: 50, errorPercent: 60, p95: 0 }, { errorPercent: 50, p95Ms: null })).toMatch(/60%/);
    expect(abortReason({ requests: 50, errorPercent: 0, p95: 3000 }, { errorPercent: 50, p95Ms: 2000 })).toMatch(/3000 ms/);
  });
  it('compares to the run before', () => {
    expect(compareRuns({ id: 'p', metrics: { p95: 800, errorPercent: 1, rps: 50 } }, { p95: 900, errorPercent: 0.5, rps: 55 })).toEqual({ previousId: 'p', p95Delta: 100, errorDelta: -0.5, rpsDelta: 5 });
  });
});

describe('k6 export', () => {
  it('writes stages, thresholds and calls, with secrets as environment variables', () => {
    const script = k6Script({
      name: 'Checkout\nload',
      stages: stagesFor('load', 10, 60),
      thresholds: { p95Ms: 500, errorPercent: 2, minRps: 5 },
      requests: [{ name: 'Create order', method: 'POST', url: 'https://api.shop.test/orders', headers: [['Authorization', 'Bearer s3cr"et']], body: 'token=s3cr"et&x=1' }],
      secrets: ['s3cr"et'],
    });
    expect(script).toContain("{ duration: '12s', target: 10 }");
    expect(script).toContain("'p(95)<500'");
    expect(script).toContain("'rate<0.02'");
    expect(script).toContain("'rate>5'");
    expect(script).toContain('__ENV.TB_SECRET_0');
    expect(script).not.toContain('s3cr');
    expect(script.split('\n')[0]).toBe('// Checkout load: exported from Testbench.');
  });
});

describe('k6 export of a workflow', () => {
  it('keeps values from one request for the next and carries no secret', () => {
    expect(jsAccessor('$.id')).toBe('j["id"]');
    expect(jsAccessor('$.data.items[0].id')).toBe('j["data"]["items"][0]["id"]');
    expect(jsAccessor('$.items[*].id')).toBeNull();
    const script = k6Script({
      name: 'Orders',
      stages: stagesFor('smoke', 2, 10),
      thresholds: th as never,
      secrets: ['tok'],
      requests: [
        { name: 'Create', workflow: 'Lifecycle', method: 'POST', url: 'https://api.test/orders', headers: [['Authorization', 'Bearer tok']], body: '{}', assign: [{ variable: 'orderId', path: '$.id' }, { variable: 'odd', path: '$.a[*]' }] },
        { name: 'Read', workflow: 'Lifecycle', method: 'GET', url: 'https://api.test/orders/%7B%7BorderId%7D%7D', headers: [], body: null },
      ],
    });
    expect(script).toContain('vars["orderId"] = String(j["id"]);');
    expect(script).toContain('// odd: $.a[*] needs a script in k6');
    expect(script).toContain('"https://api.test/orders/" + (vars["orderId"] ?? "") + ""');
    expect(script).toContain('group("Lifecycle › Create"');
    expect(script).toContain('Workflows (Lifecycle)');
    expect(script).toContain('const vars = {};');
    expect(script).not.toContain('Bearer tok');
  });
});

describe('statusOk', () => {
  const eq = (value: string) => ({ id: 's', source: 'status' as const, path: '', op: 'eq' as const, value, enabled: true });
  it('uses the request’s own status check, or below 400', () => {
    expect(statusOk([], 200)).toBe(true);
    expect(statusOk([], 404)).toBe(false);
    expect(statusOk([eq('404')], 404)).toBe(true);
    expect(statusOk([eq('404')], 200)).toBe(false);
    expect(statusOk([{ ...eq('404'), enabled: false }], 404)).toBe(false);
  });
});
