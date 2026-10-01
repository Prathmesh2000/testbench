import type { SuiteResult } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { CronError, junit, nextRun, parseCron, pool, settle, totals } from './suite';

describe('cron', () => {
  it('finds the next run in IST', () => {
    // 2026-10-01 10:00 UTC is 15:30 IST; "0 2 * * *" is 02:00 IST the next day = 20:30 UTC today.
    expect(nextRun('0 2 * * *', new Date('2026-10-01T10:00:00Z')).toISOString()).toBe('2026-10-01T20:30:00.000Z');
    expect(nextRun('*/15 * * * *', new Date('2026-10-01T10:02:00Z')).toISOString()).toBe('2026-10-01T10:15:00.000Z');
    // Weekdays only: 2026-10-03 is a Saturday, so Monday 09:00 IST.
    expect(nextRun('0 9 * * 1-5', new Date('2026-10-03T00:00:00Z')).toISOString()).toBe('2026-10-05T03:30:00.000Z');
  });

  it('explains a bad schedule', () => {
    expect(() => parseCron('0 2 * *')).toThrow(/five fields/);
    expect(() => parseCron('61 * * * *')).toThrow(CronError);
    expect(() => parseCron('a * * * *')).toThrow(/not valid/);
  });
});

describe('results', () => {
  it('counts a pass after a retry as flaky, not as a plain pass', () => {
    expect(settle([true])).toEqual({ status: 'passed', flaky: false });
    expect(settle([false, true])).toEqual({ status: 'passed', flaky: true });
    expect(settle([false, false])).toEqual({ status: 'failed', flaky: false });
  });

  const r = (over: Partial<SuiteResult>): SuiteResult => ({
    key: 'k',
    group: 'Orders',
    name: 'Create order',
    row: null,
    status: 'passed',
    flaky: false,
    attempts: 1,
    httpStatus: 201,
    durationMs: 100,
    message: '',
    historyId: null,
    driftIssues: 0,
    method: 'POST',
    operation: null,
    ...over,
  });

  it('totals results with percentiles', () => {
    const t = totals([r({}), r({ flaky: true, durationMs: 300 }), r({ status: 'failed', durationMs: 900 }), r({ driftIssues: 2, durationMs: 200 })]);
    expect(t).toMatchObject({ total: 4, passed: 2, flaky: 1, failed: 1, drift: 2, p50Ms: 200, p95Ms: 900 });
  });

  it('writes JUnit with failures and escaped text', () => {
    const x = junit('Smoke <API>', [r({}), r({ status: 'failed', message: 'status is 500 & "bad"', row: 1 })], '2026-10-01T10:00:00Z');
    expect(x).toContain('<testsuites name="Smoke &lt;API&gt;" tests="2" failures="1"');
    expect(x).toContain('<failure message="status is 500 &amp; &quot;bad&quot;">');
    expect(x).toContain('name="Create order [row 2]"');
  });

  it('runs a pool with a concurrency limit, in order', async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    await pool([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((ok) => setTimeout(ok, 5));
      seen.push(n);
      running--;
    });
    expect(peak).toBe(2);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
