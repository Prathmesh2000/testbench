import { describe, expect, it } from 'vitest';
import { classifyChange, classifyHistory, criterion } from './rules';

describe('classifyHistory', () => {
  it('needs five straight failures for always failing', () => {
    expect(classifyHistory(['failed', 'failed', 'failed', 'failed', 'failed', 'passed']).alwaysFailing).toBe(
      true,
    );
    expect(classifyHistory(['failed', 'failed', 'failed', 'failed']).alwaysFailing).toBe(false);
  });

  it('calls 3+ flips in the last 10 flaky, but never an always-failing case', () => {
    expect(classifyHistory(['passed', 'failed', 'passed', 'failed']).flaky).toBe(true);
    expect(classifyHistory(['passed', 'passed', 'failed', 'failed']).flaky).toBe(false);
    const v = classifyHistory([
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'passed',
      'failed',
      'passed',
      'failed',
    ]);
    expect(v).toMatchObject({ alwaysFailing: true, flaky: false });
  });

  it('ignores results older than the last 10', () => {
    const old = Array<'passed' | 'failed'>(10).fill('passed');
    expect(classifyHistory([...old, 'failed', 'passed', 'failed', 'passed']).flips).toBe(0);
  });
});

describe('classifyChange', () => {
  it.each([
    ['passed', 'failed', 'new_failure'],
    ['blocked', 'failed', 'new_failure'],
    ['failed', 'passed', 'fixed'],
    ['failed', 'failed', 'still_failing'],
    [null, 'passed', 'added'],
    ['untested', 'failed', 'added'],
    ['passed', 'untested', 'not_run'],
    ['passed', null, 'not_run'],
    ['passed', 'passed', null],
    [null, 'untested', null],
  ] as const)('%s → %s is %s', (base, head, expected) => {
    expect(classifyChange(base, head)).toBe(expected);
  });
});

describe('criterion', () => {
  it('compares against the target and formats it', () => {
    expect(criterion('smoke', 'Smoke', 97.6, '>=', 100, '%', '')).toMatchObject({
      target: '100%',
      actual: '97.6%',
      status: 'failing',
    });
    expect(criterion('blockers', 'Blockers', 0, '<=', 0, '', '')).toMatchObject({
      target: '0',
      status: 'met',
    });
    expect(criterion('review', 'Review', 14, '<=', 10, '', '')).toMatchObject({
      target: '≤ 10',
      status: 'failing',
    });
  });

  it('reports no data instead of passing silently', () => {
    expect(criterion('smoke', 'Smoke', null, '>=', 100, '%', '')).toMatchObject({
      actual: '—',
      status: 'no_data',
    });
  });
});
