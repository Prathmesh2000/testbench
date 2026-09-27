import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseCommand, verifySlackSignature } from './slack';

const secret = 'test-signing-secret-1234';
const sign = (ts: string, body: string) =>
  `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;

describe('verifySlackSignature', () => {
  const now = 1_790_000_000_000;
  const ts = String(now / 1000);
  it('accepts a correctly signed, fresh request', () => {
    expect(verifySlackSignature(secret, ts, sign(ts, 'text=help'), 'text=help', now)).toBe(true);
  });
  it('rejects a changed body, a wrong secret and a replay', () => {
    expect(verifySlackSignature(secret, ts, sign(ts, 'text=help'), 'text=run', now)).toBe(false);
    expect(verifySlackSignature('other-secret-123456', ts, sign(ts, 'x'), 'x', now)).toBe(false);
    expect(verifySlackSignature(secret, ts, sign(ts, 'x'), 'x', now + 6 * 60_000)).toBe(false);
    expect(verifySlackSignature(secret, undefined, undefined, 'x', now)).toBe(false);
  });
});

describe('parseCommand', () => {
  it.each([
    ['', { kind: 'help' }],
    ['status run-88', { kind: 'status', run: 'RUN-88', project: undefined }],
    ['status RUN-7 PAY', { kind: 'status', run: 'RUN-7', project: 'PAY' }],
    ['run smoke PAY 8812', { kind: 'run', type: 'smoke', project: 'PAY', build: '8812' }],
    ['login tbp_abc', { kind: 'login', token: 'tbp_abc' }],
  ])('%s', (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it('refuses what it does not understand, including a login without a token', () => {
    expect(parseCommand('login hunter2').kind).toBe('unknown');
    expect(parseCommand('run nightly PAY').kind).toBe('unknown');
  });
});
