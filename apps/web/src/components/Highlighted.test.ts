import { describe, expect, it } from 'vitest';
import { splitMarks } from './Highlighted';

describe('splitMarks', () => {
  it('separates matched and plain text', () => {
    expect(splitMarks('Verify <mark>OTP</mark> retry <mark>limit</mark>')).toEqual([
      { text: 'Verify ', match: false },
      { text: 'OTP', match: true },
      { text: ' retry ', match: false },
      { text: 'limit', match: true },
    ]);
  });

  it('keeps any other markup as literal text, never as HTML', () => {
    expect(splitMarks('<img src=x onerror=alert(1)> <mark>otp</mark>')).toEqual([
      { text: '<img src=x onerror=alert(1)> ', match: false },
      { text: 'otp', match: true },
    ]);
  });
});
