import { AuthProfileConfig } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import type { ResponseFacts } from './assert';
import { storeCookies } from './cookies';
import { applyCredential, certFor, csrfHeader, extractCredential, hasSessionCookie, inspectBundle, jwtExpiry, ProfileError, sessionExpiry } from './profiles';
import { makeTestPki } from './test-pki';

const NOW = Date.parse('2026-09-30T10:00:00Z');
const cfg = (over: Partial<AuthProfileConfig> = {}) => AuthProfileConfig.parse({ extract: { source: 'body', path: '$.token' }, apply: { as: 'bearer' }, ...over });
const facts = (json: unknown, headers: [string, string][] = []): ResponseFacts => ({ status: 200, timeMs: 1, sizeBytes: 1, headers, bodyText: JSON.stringify(json), json });
const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

describe('sessions', () => {
  it('uses the TTL, else the JWT exp with slack, else no expiry', () => {
    expect(sessionExpiry('opaque', 600, NOW)).toBe(NOW + 600_000);
    expect(jwtExpiry(jwt(1_800_000_000))).toBe(1_800_000_000_000);
    expect(sessionExpiry(jwt(1_800_000_000), null, NOW)).toBe(1_800_000_000_000 - 30_000);
    expect(sessionExpiry('opaque', null, NOW)).toBeNull();
  });

  it('reads the credential from the body, a header or a cookie, and says why when it is missing', () => {
    const url = new URL('https://api.test/login');
    expect(extractCredential(cfg(), facts({ token: 't1' }), [], url, NOW)).toBe('t1');
    expect(extractCredential(cfg({ extract: { source: 'header', path: 'x-auth' } }), facts({}, [['X-Auth', 'h1']]), [], url, NOW)).toBe('h1');
    const { jar } = storeCookies([], ['sid=c1; Path=/'], url, NOW);
    expect(extractCredential(cfg({ extract: { source: 'cookie', path: 'sid' } }), facts({}), jar, url, NOW)).toBe('c1');
    expect(() => extractCredential(cfg(), facts({ other: 1 }), [], url, NOW)).toThrow(ProfileError);
  });

  it('puts the credential on as Bearer or a named header, replacing one already there', () => {
    expect(applyCredential([['authorization', 'Bearer old']], { as: 'bearer' }, 'new')).toEqual([['Authorization', 'Bearer new']]);
    expect(applyCredential([], { as: 'header', header: 'X-Token', prefix: 'Token ' }, 'n')).toEqual([['X-Token', 'Token n']]);
    expect(applyCredential([['A', '1']], { as: 'cookie' }, 'n')).toEqual([['A', '1']]);
  });

  it('copies the CSRF cookie into its header on writes only', () => {
    const url = new URL('https://api.test/orders');
    const { jar } = storeCookies([], ['XSRF-TOKEN=a%2Bb; Path=/', 'sid=s; Path=/'], url, NOW);
    const c = cfg({ csrf: { cookie: 'XSRF-TOKEN', header: 'X-XSRF-TOKEN' } });
    expect(csrfHeader(c, jar, url, 'POST', NOW)).toEqual(['X-XSRF-TOKEN', 'a+b']);
    expect(csrfHeader(c, jar, url, 'GET', NOW)).toBeNull();
    expect(hasSessionCookie(cfg({ extract: { source: 'cookie', path: 'sid' }, apply: { as: 'cookie' } }), jar, url, NOW)).toBe(true);
  });
});

describe('client certificates', () => {
  const pki = makeTestPki();

  it('accepts a matching certificate and key, including an encrypted key with its passphrase', () => {
    expect(inspectBundle({ cert: pki.clientCert, key: pki.clientKey }).subject).toBe('CN=api-tester');
    expect(inspectBundle({ cert: pki.clientCert, key: pki.clientKeyEncrypted, passphrase: 'pass' }).expiresAt).toBeInstanceOf(Date);
    expect(inspectBundle({ ca: pki.ca }).subject).toBe('CN=Testbench Test CA');
  });

  it('refuses a key that does not belong to the certificate, or a wrong passphrase', () => {
    expect(() => inspectBundle({ cert: pki.clientCert, key: pki.serverKey })).toThrow(/does not belong/);
    expect(() => inspectBundle({ cert: pki.clientCert, key: pki.clientKeyEncrypted, passphrase: 'nope' })).toThrow(/passphrase/);
    expect(() => inspectBundle({ cert: '-----BEGIN CERTIFICATE-----\nxx\n-----END CERTIFICATE-----', key: pki.clientKey })).toThrow(/could not be read/);
  });

  it('picks the most specific host, and honours a port when one is given', () => {
    const certs = [{ host: '*.bank.test' }, { host: 'api.bank.test' }, { host: 'api.bank.test:8443' }];
    expect(certFor(certs, new URL('https://api.bank.test/x'))).toBe(certs[1]);
    expect(certFor(certs, new URL('https://api.bank.test:8443/x'))).toBe(certs[2]);
    expect(certFor(certs, new URL('https://eu.bank.test/x'))).toBe(certs[0]);
    expect(certFor(certs, new URL('https://bank.test/x'))).toBeNull();
    expect(certFor(certs, new URL('https://other.test/x'))).toBeNull();
  });
});
