import { createHmac, timingSafeEqual } from 'node:crypto';

// Short-lived passes that core-api signs after checking permissions, and a separate server (live
// boards, the Test Browser) verifies with the same secret. The browser fetches them through the web
// app's authenticated proxy, so no long-lived token ever reaches a WebSocket.

const sign = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export function signTicket(secret: string, claims: { exp: number }): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** The claims, or null when the ticket is forged, malformed or expired. */
export function verifyTicket<T extends { exp: number }>(secret: string, ticket: string, now = Date.now()): T | null {
  const [payload, sig] = ticket.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as T;
    return claims.exp * 1000 > now ? claims : null;
  } catch {
    return null;
  }
}

/** A pass for one person to one board on the collaboration server. */
export interface CollabClaims {
  board: string;
  org: string;
  user: string;
  name: string;
  canEdit: boolean;
  /** Expiry, epoch seconds. */
  exp: number;
}

export const signCollabTicket = (secret: string, claims: CollabClaims) => signTicket(secret, claims);
export const verifyCollabTicket = (secret: string, ticket: string, now = Date.now()) =>
  verifyTicket<CollabClaims>(secret, ticket, now);
