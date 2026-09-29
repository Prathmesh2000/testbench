import { describe, expect, it } from 'vitest';
import { maskUrl } from './session';

describe('maskUrl', () => {
  it('masks credential-like query values and keeps the rest', () => {
    expect(maskUrl('https://shop.example.com/cart?token=abc123&qty=2')).toBe(
      'https://shop.example.com/cart?token=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2&qty=2',
    );
    expect(maskUrl('https://x.test/?email=riya@paytrail.in')).toContain('paytrail.in');
    expect(maskUrl('https://x.test/?email=riya@paytrail.in')).not.toContain('riya');
  });
});
