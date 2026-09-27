import { describe, expect, it } from 'vitest';
import { bugDescription, reproSteps, type BugContext } from './bug-report';

const ctx: BugContext = {
  caseKey: 'TC-10457',
  caseTitle: 'Verify collect request expiry',
  runKey: 'RUN-3',
  runName: 'Release 4.18 smoke',
  environment: 'Staging-IN',
  build: '8812',
  config: 'Safari 17 · macOS 14',
  preconditions: 'Merchant is onboarded',
  steps: [
    { action: 'Open the payment page', expected: 'Page loads', data: '' },
    { action: 'Pay with UPI collect', expected: 'Status is PENDING', data: 'vpa: qa@okaxis' },
    { action: 'Wait 5 minutes', expected: 'Status is EXPIRED', data: '' },
    { action: 'Refresh the page', expected: 'Still EXPIRED', data: '' },
  ],
  failedAt: 2,
  actual: 'Status stayed PENDING',
  evidence: ['pending.png'],
  reporter: 'Sneha Iyer',
  link: 'http://localhost:3000/runs/x',
};
const plain = (doc: unknown) =>
  JSON.stringify(doc)
    .match(/"text":"([^"]*)"/g)!
    .map((t) => t.slice(8, -1));

describe('bug report', () => {
  it('stops the reproduction steps at the failing step', () => {
    expect(reproSteps(ctx).map((s) => s.action)).toEqual([
      'Open the payment page',
      'Pay with UPI collect',
      'Wait 5 minutes',
    ]);
    expect(reproSteps({ ...ctx, failedAt: -1 })).toHaveLength(4);
  });

  it('includes environment, expected versus actual, test data and evidence', () => {
    const text = plain(bugDescription(ctx));
    expect(text).toContain('Staging-IN · build 8812 · Safari 17 · macOS 14');
    expect(text).toContain('Pay with UPI collect [vpa: qa@okaxis]');
    expect(text).toContain('Status is EXPIRED');
    expect(text).toContain('Status stayed PENDING');
    expect(text).toContain('pending.png');
    expect(text).not.toContain('Refresh the page');
  });

  it('omits expected and actual when no step failed', () => {
    const text = plain(bugDescription({ ...ctx, failedAt: -1, actual: null }));
    expect(text).not.toContain('Actual: ');
  });

  it('produces valid ADF: a doc with version 1 and no empty text nodes', () => {
    const doc = bugDescription({ ...ctx, preconditions: '' });
    expect(doc).toMatchObject({ type: 'doc', version: 1 });
    expect(JSON.stringify(doc)).not.toContain('"text":""');
  });
});
