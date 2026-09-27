import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from './webhook';

const secret = 'jira-sandbox-webhook-secret';
const body = '{"webhookEvent":"jira:issue_updated","issue":{"key":"PAY-4801"}}';
const sign = (b: string, s = secret) => `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    expect(verifySignature(secret, body, sign(body))).toBe(true);
  });

  it('rejects a tampered body, a different secret, and a missing or malformed header', () => {
    expect(verifySignature(secret, body.replace('4801', '4802'), sign(body))).toBe(false);
    expect(verifySignature(secret, body, sign(body, 'other-secret'))).toBe(false);
    expect(verifySignature(secret, body, undefined)).toBe(false);
    expect(verifySignature(secret, body, 'md5=abc')).toBe(false);
    expect(verifySignature(secret, body, 'sha256=short')).toBe(false);
  });

  it('refuses everything when no secret is configured', () => {
    expect(verifySignature('', body, sign(body, ''))).toBe(false);
  });
});
