import { describe, expect, it } from 'vitest';
import { signCollabTicket, verifyCollabTicket } from './collab-ticket';

const secret = 'x'.repeat(40);
const claims = { board: 'b', org: 'o', user: 'u', name: 'Sneha', canEdit: true, exp: 2_000_000_000 };

describe('collab tickets', () => {
  it('round-trips', () => {
    expect(verifyCollabTicket(secret, signCollabTicket(secret, claims), 1_000)).toEqual(claims);
  });
  it('rejects tampering, another secret and expiry', () => {
    const t = signCollabTicket(secret, claims);
    const forged = `${Buffer.from(JSON.stringify({ ...claims, board: 'other' })).toString('base64url')}.${t.split('.')[1]}`;
    expect(verifyCollabTicket(secret, forged, 1_000)).toBeNull();
    expect(verifyCollabTicket('y'.repeat(40), t, 1_000)).toBeNull();
    expect(verifyCollabTicket(secret, t, 2_000_000_001_000)).toBeNull();
  });
});
