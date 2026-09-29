import { describe, expect, it } from 'vitest';
import { maskRecord, maskText, maskValue } from './mask';

describe('masking', () => {
  it('hides credentials in headers and pasted text', () => {
    expect(maskText('Authorization: Bearer abc.def-123_XYZ')).toBe('Authorization: Bearer ••••');
    expect(maskText('Basic cWEtYm90OnNlY3JldA==')).toBe('Basic ••••');
    expect(maskText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sflKxwRJSMeKKF2QT4fwpM')).toBe('token ••••');
  });

  it('keeps the domain of an email and the tail of cards and phones', () => {
    expect(maskText('mail riya.sharma@paytrail.in now')).toBe('mail ••••@paytrail.in now');
    expect(maskText('card 4111 1111 1111 1234')).toBe('card ••••1234');
    expect(maskText('call +91 9876543210')).toBe('call ••••10');
    expect(maskText('call 9876543210.')).toBe('call ••••10.');
  });

  it('leaves ordinary values alone', () => {
    expect(maskText('Amount ₹1,20,000 for order 4821 on build 8812')).toBe('Amount ₹1,20,000 for order 4821 on build 8812');
  });

  it('hides sensitive fields whatever their value', () => {
    expect(maskValue('Password', 'hunter2')).toBe('••••');
    expect(maskValue('otp', '123456')).toBe('••••');
    expect(maskValue('apiKey', 'x')).toBe('••••');
    expect(maskValue('product', 'Dell XPS 13')).toBe('Dell XPS 13');
    expect(maskRecord({ user: 'a@b.co', pin: '1234', qty: '2' })).toEqual({ user: '••••@b.co', pin: '••••', qty: '2' });
  });
});
