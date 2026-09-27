import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier, type TokenVerifier } from './auth';

const issuer = 'http://localhost:8080/realms/testbench';
let sign: (
  claims: Record<string, unknown>,
  opts?: { aud?: string; iss?: string; exp?: string },
) => Promise<string>;
let verify: TokenVerifier;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  verify = createTokenVerifier({ issuer, audience: 'core-api', keys: createLocalJWKSet({ keys: [jwk] }) });
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(opts.iss ?? issuer)
      .setAudience(opts.aud ?? 'core-api')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(privateKey);
});

describe('createTokenVerifier', () => {
  it('accepts a valid token and normalises the email', async () => {
    const token = await sign({ sub: 'kc-1', email: 'Sneha.Iyer@Paytrail.in', name: 'Sneha Iyer' });
    await expect(verify(token)).resolves.toEqual({
      subject: 'kc-1',
      email: 'sneha.iyer@paytrail.in',
      name: 'Sneha Iyer',
    });
  });

  it('falls back to the email when the name claim is missing', async () => {
    const token = await sign({ sub: 'kc-2', email: 'a@b.in' });
    expect((await verify(token)).name).toBe('a@b.in');
  });

  it.each([
    ['another audience', { aud: 'account' }],
    ['another issuer', { iss: 'http://evil.example/realms/testbench' }],
    ['an expired token', { exp: '-1m' }],
  ])('rejects %s', async (_name, opts) => {
    const token = await sign({ sub: 'kc-3', email: 'a@b.in' }, opts);
    await expect(verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token without an email', async () => {
    await expect(verify(await sign({ sub: 'kc-4' }))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token signed by a different key', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ sub: 'kc-5', email: 'a@b.in' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(issuer)
      .setAudience('core-api')
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(verify(forged)).rejects.toMatchObject({ status: 401 });
  });
});
