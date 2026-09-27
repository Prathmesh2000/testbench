import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checks a Jira webhook's X-Hub-Signature ("sha256=<hex HMAC of the raw body>"). Anyone can reach the
 * webhook URL, so an unsigned or wrongly signed request is refused before its body is trusted.
 * Compares in constant time so the signature cannot be guessed byte by byte from response timings.
 */
export function verifySignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(header.slice('sha256='.length), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
