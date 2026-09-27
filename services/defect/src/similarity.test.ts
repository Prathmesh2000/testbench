import { describe, expect, it } from 'vitest';
import { searchTerms, similarity, words } from './similarity';

describe('similarity', () => {
  it('is 1 for the same text and near 0 for unrelated text', () => {
    expect(similarity('OTP resend is disabled', 'otp resend is disabled')).toBe(1);
    // Word-start trigrams ("  r") can overlap even between unrelated titles, as in pg_trgm.
    expect(similarity('OTP resend is disabled', 'Settlement report timezone')).toBeLessThan(0.1);
  });

  it('ranks a reworded duplicate above a different bug', () => {
    const newBug = 'Collect request expiry ignored on Safari';
    const duplicate = 'Collect request expiry after 5 minutes is ignored on Safari 17';
    const other = 'Refund SMS shows untranslated text in Hindi locale';
    expect(similarity(newBug, duplicate)).toBeGreaterThan(0.5);
    expect(similarity(newBug, duplicate)).toBeGreaterThan(similarity(newBug, other) + 0.3);
  });

  it('ignores case, punctuation and filler words', () => {
    expect(similarity('The OTP: resend, is disabled!', 'otp resend disabled')).toBe(1);
  });

  it('handles empty input', () => {
    expect(similarity('', 'anything')).toBe(0);
  });
});

describe('searchTerms', () => {
  it('keeps the most distinctive words', () => {
    expect(searchTerms('Collect request expiry after 5 minutes is ignored on Safari 17', 4)).toEqual([
      'collect',
      'request',
      'minutes',
      'ignored',
    ]);
  });

  it('drops duplicates and stop words', () => {
    expect(words('The the OTP and otp')).toEqual(['otp', 'otp']);
    expect(searchTerms('The the OTP and otp')).toEqual(['otp']);
  });
});
