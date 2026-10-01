import { describe, expect, it } from 'vitest';
import { detectAuth, matchRoute, parseRoutes, pathShape, retrieve } from './assist';

describe('parseRoutes', () => {
  it('reads routes from lines, router code, decorators, Spring and cURL', () => {
    const routes = parseRoutes(`
GET /orders/{orderId}
router.post('/orders', createOrder)
app.delete("/orders/:id", remove)
@app.get("/carts/<int:cart_id>")
@PatchMapping("/customers/{id}")
curl -X PUT 'https://api.test/v1/items/9?x=1' -H 'a: b'
curl 'https://api.test/health' -d '{}'
GET /orders/{orderId}
`);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /orders/{orderId}',
      'POST /orders',
      'DELETE /orders/{id}',
      'GET /carts/{cart_id}',
      'PATCH /customers/{id}',
      'PUT /v1/items/9',
      'POST /health',
    ]);
  });

  it('reads a HAR file', () => {
    const har = JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: 'https://x.test/a/b?q=1' } }] } });
    expect(parseRoutes(har)).toEqual([{ method: 'GET', path: '/a/b', source: 'GET https://x.test/a/b?q=1' }]);
  });
});

describe('matching and retrieval', () => {
  const ops = [
    { method: 'POST' as const, path: '/orders', summary: 'Create order', tag: 'orders' },
    { method: 'GET' as const, path: '/orders/{orderId}', summary: 'Get order', tag: 'orders' },
    { method: 'POST' as const, path: '/orders/{orderId}/cancel', summary: 'Cancel an order', tag: 'orders' },
    { method: 'GET' as const, path: '/refunds', summary: 'List refunds', tag: 'payments' },
    { method: 'GET' as const, path: '/invoices/{id}/pdf', summary: 'Download invoice PDF', tag: 'billing' },
  ];

  it('matches a route whatever its parameters are called', () => {
    expect(pathShape('/orders/:id'.replace(':id', '{id}'))).toBe(pathShape('/orders/{orderId}'));
    expect(matchRoute({ method: 'GET', path: '/orders/{id}' }, ops)).toBe(ops[1]);
    expect(matchRoute({ method: 'PUT', path: '/orders/{id}' }, ops)).toBeNull();
  });

  it('finds what a sentence is about', () => {
    expect(retrieve('A customer can cancel an order and gets a refund', ops).map((x) => x.op.path)).toEqual(expect.arrayContaining(['/orders/{orderId}/cancel', '/refunds']));
    expect(retrieve('Which API gives the invoice PDF?', ops)[0]!.op.path).toBe('/invoices/{id}/pdf');
    expect(retrieve('weather in Mumbai', ops)).toEqual([]);
  });
});

describe('detectAuth', () => {
  it('finds a bearer token in the body, wherever it is', () => {
    expect(detectAuth({ headers: [], body: { data: { access_token: 'x' } } })).toMatchObject({ config: { extract: { source: 'body', path: '$.data.access_token' }, apply: { as: 'bearer' } } });
  });

  it('finds a cookie session with its CSRF pair', () => {
    const d = detectAuth({ headers: [['Set-Cookie', 'connect.sid=s%3Aabc; Path=/; HttpOnly'], ['Set-Cookie', 'XSRF-TOKEN=t1; Path=/']], body: { ok: true } });
    expect(d).toMatchObject({ config: { extract: { source: 'cookie', path: 'connect.sid' }, apply: { as: 'cookie' }, csrf: { cookie: 'XSRF-TOKEN', header: 'X-XSRF-TOKEN' } } });
    expect(d!.explanation).toContain('X-XSRF-TOKEN');
  });

  it('finds a token in a response header, and says nothing when there is no credential', () => {
    expect(detectAuth({ headers: [['X-Auth-Token', 'abc']], body: null })).toMatchObject({ config: { extract: { source: 'header', path: 'X-Auth-Token' } } });
    expect(detectAuth({ headers: [['Content-Type', 'application/json']], body: { hello: 1 } })).toBeNull();
  });
});
