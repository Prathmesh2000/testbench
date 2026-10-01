import { describe, expect, it } from 'vitest';
import { cookieHeader, parseSetCookie, storeCookies } from './cookies';

const NOW = Date.parse('2026-09-30T10:00:00Z');
const at = (u: string) => new URL(u);

describe('parseSetCookie', () => {
  it('defaults domain to the exact host and path to the request directory', () => {
    const c = parseSetCookie('sid=abc; HttpOnly', at('https://api.shop.test/auth/login'), NOW)!;
    expect(c).toMatchObject({ name: 'sid', value: 'abc', domain: 'api.shop.test', path: '/auth', hostOnly: true, httpOnly: true });
  });

  it('accepts a parent Domain and rejects an unrelated one', () => {
    expect(parseSetCookie('a=1; Domain=.shop.test', at('https://api.shop.test/'), NOW)).toMatchObject({ domain: 'shop.test', hostOnly: false });
    expect(parseSetCookie('a=1; Domain=evil.test', at('https://api.shop.test/'), NOW)).toBeNull();
  });

  it('refuses a Secure cookie over plain http, except on localhost', () => {
    expect(parseSetCookie('a=1; Secure', at('http://api.shop.test/'), NOW)).toBeNull();
    expect(parseSetCookie('a=1; Secure', at('http://localhost:4000/'), NOW)).not.toBeNull();
  });

  it('lets Max-Age win over Expires', () => {
    const c = parseSetCookie('a=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Max-Age=60', at('https://x.test/'), NOW)!;
    expect(c.expires).toBe(NOW + 60_000);
  });
});

describe('jar', () => {
  it('sends a login cookie on the next request, and replaces it when set again', () => {
    let { jar } = storeCookies([], ['sid=one; Path=/'], at('https://api.test/auth/login'), NOW);
    expect(cookieHeader(jar, at('https://api.test/orders'), NOW).header).toBe('sid=one');
    ({ jar } = storeCookies(jar, ['sid=two; Path=/'], at('https://api.test/auth/refresh'), NOW));
    expect(jar).toHaveLength(1);
    expect(cookieHeader(jar, at('https://api.test/orders'), NOW).header).toBe('sid=two');
  });

  it('deletes a cookie on Max-Age=0 (logout)', () => {
    let { jar } = storeCookies([], ['sid=one; Path=/'], at('https://api.test/'), NOW);
    ({ jar } = storeCookies(jar, ['sid=; Path=/; Max-Age=0'], at('https://api.test/logout'), NOW));
    expect(jar).toEqual([]);
  });

  it('keeps host-only cookies off subdomains and respects paths', () => {
    const { jar } = storeCookies([], ['a=1; Path=/admin', 'b=2; Domain=api.test; Path=/'], at('https://api.test/admin/x'), NOW);
    expect(cookieHeader(jar, at('https://api.test/admin/users'), NOW).header).toBe('a=1; b=2');
    expect(cookieHeader(jar, at('https://api.test/administrator'), NOW).header).toBe('b=2');
    expect(cookieHeader(jar, at('https://eu.api.test/admin/users'), NOW).header).toBe('b=2');
  });

  it('drops expired cookies', () => {
    const { jar } = storeCookies([], ['a=1; Max-Age=10'], at('https://api.test/'), NOW);
    expect(cookieHeader(jar, at('https://api.test/'), NOW + 11_000).header).toBeNull();
  });
});
