import { createHmac, timingSafeEqual } from 'node:crypto';

// A pass for one person to one board on the collaboration server, signed by core-api (which checked
// their permissions) and verified by the collaboration server with the same secret. The browser
// fetches it through the web app's authenticated proxy, so no long-lived token reaches a WebSocket.

export interface CollabClaims {
  board: string;
  org: string;
  user: string;
  name: string;
  canEdit: boolean;
  /** Expiry, epoch seconds. */
  exp: number;
}

const sign = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export function signCollabTicket(secret: string, claims: CollabClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** The claims, or null when the ticket is forged, malformed or expired. */
export function verifyCollabTicket(secret: string, ticket: string, now = Date.now()): CollabClaims | null {
  const [payload, sig] = ticket.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as CollabClaims;
    return claims.exp * 1000 > now ? claims : null;
  } catch {
    return null;
  }
}
