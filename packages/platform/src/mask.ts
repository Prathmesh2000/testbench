// Masking for anything that leaves Testbench as evidence: bug reports, attachments, captured traffic.
// Applied before storage or sending, never after, so an unmasked copy never exists outside the source.

const MASK = '••••';

/** Field names whose values are credentials or card data whatever they contain. */
const SENSITIVE_KEY = /pass(word|wd|code)?|secret|token|otp|pin\b|cvv|cvc|card.?num|api.?key|auth|cookie|session/i;

const PATTERNS: [RegExp, (m: string) => string][] = [
  // Bearer / Basic credentials in headers or pasted text.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (m) => `${m.split(/\s+/)[0]} ${MASK}`],
  // JWTs: three base64url segments, the first starting with the encoded '{"'.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, () => MASK],
  // Emails keep their domain: which tenant or provider is often what a developer needs.
  [/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (m) => `${MASK}@${m.split('@')[1]}`],
  // Card numbers (13–19 digits, optionally grouped) keep the last four digits.
  [/\b(?:\d[ -]?){12,18}\d\b/g, (m) => `${MASK}${m.replace(/\D/g, '').slice(-4)}`],
  // Indian mobile numbers, with or without +91, keep the last two digits.
  [/(?:\+91[ -]?)?\b[6-9]\d{9}\b/g, (m) => `${MASK}${m.slice(-2)}`],
];

/** Masks credentials, emails, card and phone numbers inside free text. */
export function maskText(text: string): string {
  return PATTERNS.reduce((out, [re, fn]) => out.replace(re, fn), text);
}

/** Masks one named value: sensitive field names are hidden entirely, everything else pattern-masked. */
export function maskValue(key: string, value: string): string {
  return SENSITIVE_KEY.test(key) ? MASK : maskText(value);
}

/** A copy of a flat record (a data-set row, a header map) with every value masked. */
export function maskRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, maskValue(k, v)]));
}
