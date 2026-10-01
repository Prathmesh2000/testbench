import type { MockConfig } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { answer, compile, matchOperation, requestedStatus, type MockRequest } from './mock';
import { parseSpecText } from './spec';

const DOC = parseSpecText(`
openapi: 3.0.3
info: { title: Shop, version: '1' }
components:
  schemas:
    Problem: { type: object, properties: { error: { type: string }, code: { type: integer } } }
    Order: { type: object, required: [id], properties: { id: { type: string }, qty: { type: integer, minimum: 2 }, status: { type: string, enum: [open, paid] } } }
paths:
  /orders:
    get:
      security: [{ bearer: [] }]
      parameters: [{ name: status, in: query, required: true, schema: { type: string } }]
      responses: { '200': { description: ok, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Order' } } } } } }
    post:
      requestBody: { required: true, content: { application/json: { schema: { type: object, required: [qty], properties: { qty: { type: integer } } } } } }
      responses:
        '201': { description: ok, headers: { Location: { schema: { type: string } } }, content: { application/json: { example: { id: o-1, qty: 2, status: open } } } }
        '422': { description: bad, content: { application/json: { schema: { $ref: '#/components/schemas/Problem' }, example: { error: 'invalid', code: 42 } } } }
  /orders/{orderId}:
    get: { responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } } }, '404': { description: none } } }
    delete: { responses: { '204': { description: gone } } }
  /orders/latest:
    get: { responses: { '200': { description: ok, content: { application/json: { example: { id: latest } } } } } }
`) as Record<string, unknown>;

const c = compile(DOC);
const cfg = (over: Partial<MockConfig> = {}): MockConfig => ({ latencyMs: 0, validate: false, enforceAuth: false, ...over });
const req = (method: string, path: string, over: Partial<MockRequest> = {}): MockRequest => ({ method, path, query: {}, headers: {}, body: undefined, ...over });
const ask = (r: MockRequest, config = cfg(), overrides = {}) => answer(c, DOC, config, overrides, r);

describe('matching', () => {
  it('prefers the literal path over a parameter, and reads parameters', () => {
    expect(matchOperation(c, 'GET', '/orders/latest')!.op.key).toBe('GET /orders/latest');
    expect(matchOperation(c, 'GET', '/orders/o-9')).toMatchObject({ op: { key: 'GET /orders/{orderId}' }, params: { orderId: 'o-9' } });
    expect(matchOperation(c, 'GET', '/orders/o-9/')!.op.key).toBe('GET /orders/{orderId}');
    expect(matchOperation(c, 'PUT', '/orders/o-9')).toBeNull();
  });
});

describe('answers', () => {
  it('uses the documented example, then a schema-built value, with documented headers', () => {
    const created = ask(req('POST', '/orders'));
    expect(created).toMatchObject({ status: 201, body: { id: 'o-1', qty: 2, status: 'open' }, operation: 'POST /orders' });
    expect(created.headers.location).toBe('sample');
    const one = ask(req('GET', '/orders/o-9'));
    expect(one.body).toEqual({ id: 'sample', qty: 2, status: 'open' });
    expect(ask(req('DELETE', '/orders/o-9'))).toMatchObject({ status: 204, body: undefined });
  });

  it('answers a status the client asks for with its documented body', () => {
    expect(requestedStatus({ prefer: 'code=404' })).toBe(404);
    expect(requestedStatus({ 'x-mock-status': '503' })).toBe(503);
    expect(requestedStatus({ prefer: 'return=minimal' })).toBeNull();
    expect(ask(req('POST', '/orders', { headers: { prefer: 'code=422' } }))).toMatchObject({ status: 422, body: { error: 'invalid', code: 42 } });
    expect(ask(req('GET', '/orders/x', { headers: { 'x-mock-status': '500' } }))).toMatchObject({ status: 500 });
  });

  it('applies overrides: status, body and delay', () => {
    const a = ask(req('GET', '/orders/x'), cfg({ latencyMs: 100 }), { 'GET /orders/{orderId}': { status: 200, body: '{"id":"fixed"}', delayMs: 50 } });
    expect(a).toMatchObject({ status: 200, body: { id: 'fixed' }, delayMs: 150 });
    expect(ask(req('GET', '/orders/x'), cfg(), { 'GET /orders/{orderId}': { status: null, body: '{nope', delayMs: 0 } }).status).toBe(500);
  });

  it('validates required inputs when asked, with the spec’s documented error', () => {
    const v = cfg({ validate: true });
    expect(ask(req('GET', '/orders'), v)).toMatchObject({ status: 400, body: { error: 'Missing required query parameter status.' } });
    expect(ask(req('GET', '/orders', { query: { status: 'open' } }), v).status).toBe(200);
    expect(ask(req('POST', '/orders'), v)).toMatchObject({ status: 422, body: { error: 'invalid', message: 'The request body is required.' } });
    expect(ask(req('POST', '/orders', { body: { note: 'x' } }), v)).toMatchObject({ status: 422 });
    expect(ask(req('POST', '/orders', { body: { qty: 1 } }), v).status).toBe(201);
    // Off by default: the same bad request gets the happy answer.
    expect(ask(req('POST', '/orders')).status).toBe(201);
  });

  it('can insist on a credential for secured operations', () => {
    const a = cfg({ enforceAuth: true });
    expect(ask(req('GET', '/orders', { query: { status: 'x' } }), a).status).toBe(401);
    expect(ask(req('GET', '/orders', { query: { status: 'x' }, headers: { authorization: 'Bearer t' } }), a).status).toBe(200);
    expect(ask(req('GET', '/orders/latest'), a).status).toBe(200);
  });

  it('says what it could not place, with the nearest operations', () => {
    const a = ask(req('GET', '/orders/a/b/c'));
    expect(a).toMatchObject({ status: 404, operation: null });
    expect((a.body as { nearest: string[] }).nearest).toContain('GET /orders');
  });
});
