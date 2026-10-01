import { describe, expect, it } from 'vitest';
import { bolaVerdict, corsVerdict, evidenceOf, injectionVerdict, INJECTION, looksPrivileged, massAssignmentFields, massAssignmentVerdict, passiveChecks, rateVerdict, tamperedAuth, type Exchange } from './security';

const x = (over: Partial<Exchange> = {}): Exchange => ({
  method: 'GET',
  url: 'https://api.shop.test/orders/1',
  requestHeaders: [['Authorization', 'Bearer sekret-token']],
  requestBody: null,
  status: 200,
  responseHeaders: [['Content-Type', 'application/json'], ['Strict-Transport-Security', 'max-age=1'], ['X-Content-Type-Options', 'nosniff'], ['Cache-Control', 'no-store']],
  responseBody: '{}',
  ...over,
});
const rules = (e: Exchange, json: unknown = {}, authSent = true) => passiveChecks(e, { operation: 'GET /orders/{id}', authSent, json }, ['sekret-token']).map((f) => f.rule).sort();

describe('passive checks', () => {
  it('say nothing about a well configured response', () => {
    expect(rules(x())).toEqual([]);
  });

  it('flag missing headers, a cacheable authenticated response and server versions', () => {
    expect(rules(x({ responseHeaders: [['Content-Type', 'application/json'], ['Server', 'nginx/1.18.0']] }))).toEqual(['cache-sensitive', 'missing-hsts', 'missing-nosniff', 'server-version']);
    // http has no HSTS to expect.
    expect(rules(x({ url: 'http://api.shop.test/x', responseHeaders: [['Content-Type', 'application/json'], ['X-Content-Type-Options', 'nosniff'], ['Cache-Control', 'no-store']] }))).toEqual([]);
  });

  it('flag CORS with credentials, verbose errors and weak cookies', () => {
    expect(rules(x({ responseHeaders: [...x().responseHeaders, ['Access-Control-Allow-Origin', '*'], ['Access-Control-Allow-Credentials', 'true']] }))).toContain('cors-wildcard-credentials');
    expect(rules(x({ status: 500, responseBody: 'Error\n    at Object.run (/app/node_modules/x/index.js:10:5)' }))).toContain('verbose-error');
    const cookie = passiveChecks(x({ responseHeaders: [...x().responseHeaders, ['Set-Cookie', 'sessionid=abc; Path=/']] }), { operation: null, authSent: false, json: {} }, []);
    expect(cookie.find((f) => f.rule === 'cookie-flags')).toMatchObject({ severity: 'medium', title: 'Cookie sessionid lacks HttpOnly, Secure, SameSite' });
  });

  it('flag secrets in a response body, but expect a token from a login', () => {
    expect(rules(x(), { id: 1, user: { email: 'a@b.test', password: 'hunter2', cvv: '123' } })).toContain('sensitive-field-exposed');
    expect(rules(x(), { access_token: 'abc' })).toContain('sensitive-field-exposed');
    expect(rules(x({ url: 'https://api.shop.test/auth/login' }), { access_token: 'abc' })).not.toContain('sensitive-field-exposed');
    expect(rules(x(), { password: '' })).not.toContain('sensitive-field-exposed');
  });

  it('keep evidence masked, and one fingerprint per problem per operation', () => {
    const f = passiveChecks(x({ responseHeaders: [['Content-Type', 'application/json']], responseBody: 'sekret-token' }), { operation: 'GET /o', authSent: true, json: {} }, ['sekret-token']);
    const json = JSON.stringify(f);
    expect(json).not.toContain('sekret-token');
    expect(json).toContain('Bearer ••••••');
    const again = passiveChecks(x({ responseHeaders: [['Content-Type', 'application/json']] }), { operation: 'GET /o', authSent: true, json: {} }, ['sekret-token']);
    expect(again.map((a) => a.fingerprint)).toEqual(f.map((a) => a.fingerprint));
    expect(evidenceOf(x(), []).request.split('\n')[0]).toBe('GET https://api.shop.test/orders/1');
  });
});

describe('active probes and verdicts', () => {
  it('builds the credentials that must all be refused', () => {
    const jwt = `h.${Buffer.from('{"sub":"1"}').toString('base64url')}.signature123`;
    const t = tamperedAuth(`Bearer ${jwt}`);
    expect(t.map((v) => v.label)).toEqual(['no credential', 'an invalid token', 'an empty token', 'a token with a broken signature', 'an unsigned token (alg none)']);
    expect(t[3]!.value).not.toBe(`Bearer ${jwt}`);
    expect(t[4]!.value!.endsWith('.')).toBe(true);
    expect(tamperedAuth('Bearer opaque')).toHaveLength(3);
  });

  it('knows which operations look like admin ones', () => {
    expect(looksPrivileged({ path: '/admin/users', tag: 'users', summary: '' })).toBe(true);
    expect(looksPrivileged({ path: '/users', tag: 'Internal', summary: '' })).toBe(true);
    expect(looksPrivileged({ path: '/orders', tag: 'orders', summary: 'Create an order' })).toBe(false);
    expect(looksPrivileged({ path: '/administrators-guide', tag: '', summary: '' })).toBe(false);
  });

  it('finds mass assignment only when the injected value comes back', () => {
    const sent = massAssignmentFields({ name: 'x', role: 'user' });
    expect(sent.map(([k]) => k)).not.toContain('role');
    expect(massAssignmentVerdict(sent, 201, { id: 1, name: 'x', isAdmin: true }).map(([k]) => k)).toEqual(['isAdmin']);
    expect(massAssignmentVerdict(sent, 201, { data: { is_admin: true } }).map(([k]) => k)).toEqual(['is_admin']);
    expect(massAssignmentVerdict(sent, 201, { id: 1, isAdmin: false })).toEqual([]);
    expect(massAssignmentVerdict(sent, 400, { isAdmin: true })).toEqual([]);
  });

  it('judges injection probes by what came back', () => {
    const sql = INJECTION[0]!;
    expect(injectionVerdict(sql, 200, 500, 'You have an error in your SQL syntax near', 'text/plain')).toMatchObject({ severity: 'high', title: 'A probe produced a database error' });
    expect(injectionVerdict(sql, 200, 500, 'oops', 'text/plain')).toMatchObject({ severity: 'medium' });
    expect(injectionVerdict(sql, 500, 500, 'oops', 'text/plain')).toBeNull();
    expect(injectionVerdict(sql, 200, 400, 'invalid input', 'application/json')).toBeNull();
    expect(injectionVerdict(INJECTION[2]!, 200, 200, '<p><script>tb-xss</script></p>', 'text/html')).toMatchObject({ severity: 'high' });
    expect(injectionVerdict(INJECTION[2]!, 200, 200, '{"q":"<script>tb-xss</script>"}', 'application/json')).toBeNull();
    expect(injectionVerdict(INJECTION[3]!, 200, 200, 'root:x:0:0:root:/root', 'text/plain')).toMatchObject({ severity: 'high' });
  });

  it('judges CORS and rate limiting', () => {
    expect(corsVerdict('https://evil.example', [['Access-Control-Allow-Origin', 'https://evil.example'], ['Access-Control-Allow-Credentials', 'true']])).toMatchObject({ severity: 'high' });
    expect(corsVerdict('https://evil.example', [['Access-Control-Allow-Origin', 'https://evil.example']])).toMatchObject({ severity: 'low' });
    expect(corsVerdict('https://evil.example', [['Access-Control-Allow-Origin', 'https://app.example']])).toBeNull();
    expect(rateVerdict([200, 200, 200], [])).toMatchObject({ severity: 'low' });
    expect(rateVerdict([200, 429], [])).toBeNull();
    expect(rateVerdict([200], [['X-RateLimit-Remaining', '9']])).toBeNull();
  });

  it('calls a cross-account read a leak only when the same data came back', () => {
    expect(bolaVerdict({ status: 200, body: '{"id":1,"owner":"a"}' }, { status: 200, body: '{"id":1,"owner":"a"}' })).toBe('leak');
    expect(bolaVerdict({ status: 200, body: '{"id":1,"owner":"a"}' }, { status: 403, body: '' })).toBeNull();
    expect(bolaVerdict({ status: 200, body: '{"id":1,"owner":"a"}' }, { status: 200, body: '{"items":[]}' })).toBe('unclear');
    expect(bolaVerdict({ status: 200, body: '{"id":1}' }, { status: 200, body: '' })).toBe('unclear');
  });
});
