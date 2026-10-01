import type { SpecOperation } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { collectionAuthFor, requestsFromOperations } from './spec-import';

const SPEC = '00000000-0000-4000-8000-000000000001';
const op = (over: Partial<SpecOperation>): SpecOperation => ({
  method: 'GET',
  path: '/orders',
  operationId: null,
  summary: '',
  tags: [],
  deprecated: false,
  parameters: [],
  requestBody: null,
  responses: [],
  security: null,
  ...over,
});

describe('requestsFromOperations', () => {
  it('makes a request per operation with path variables and the base URL as variables', () => {
    const [r] = requestsFromOperations(SPEC, [
      op({
        path: '/orders/{orderId}',
        tags: ['orders'],
        summary: 'Get an order',
        parameters: [
          { name: 'orderId', in: 'path', required: true },
          { name: 'expand', in: 'query', required: false },
          { name: 'X-Tenant', in: 'header', required: true },
        ],
        responses: ['200', '404'],
      }),
    ]);
    expect(r).toMatchObject({ folder: 'orders', name: 'Get an order' });
    expect(r!.request).toMatchObject({
      url: '{{baseUrl}}/orders/{{orderId}}',
      params: [{ key: 'expand', value: '', enabled: false }],
      headers: [{ key: 'X-Tenant', value: '', enabled: true }],
      assertions: [{ source: 'status', op: 'eq', value: '200' }],
      operation: { specId: SPEC, method: 'GET', path: '/orders/{orderId}' },
    });
  });

  it('picks the body type from the content types, and names untagged operations sensibly', () => {
    const [json, form] = requestsFromOperations(SPEC, [
      op({ method: 'POST', requestBody: { required: true, contentTypes: ['application/json'] } }),
      op({ method: 'POST', path: '/login', requestBody: { required: true, contentTypes: ['application/x-www-form-urlencoded'] } }),
    ]);
    expect(json).toMatchObject({ folder: 'Other', name: 'POST /orders', request: { body: { type: 'json', text: '{}' } } });
    expect(form!.request.body).toEqual({ type: 'form', fields: [] });
  });
});

describe('auth from the spec', () => {
  const schemes = { bearer: { type: 'bearer' as const, token: '{{token}}' }, key: { type: 'apikey' as const, key: 'X-Key', value: '{{apiKey}}', in: 'header' as const } };

  it('picks the collection auth that most secured operations use', () => {
    expect(collectionAuthFor([op({ security: ['bearer'] }), op({ security: ['bearer'] }), op({ security: ['key'] }), op({ security: [] })], schemes)).toEqual(schemes.bearer);
    expect(collectionAuthFor([op({ security: [] }), op({ security: null })], schemes)).toEqual({ type: 'none' });
  });

  it('makes public operations explicit, inherits the common scheme and spells out a different one', () => {
    const ops = [op({ path: '/login', security: [] }), op({ path: '/orders', security: ['bearer'] }), op({ path: '/hooks', security: ['key'] }), op({ path: '/misc', security: null })];
    const auths = requestsFromOperations(SPEC, ops, 1, { schemes, collection: schemes.bearer }).map((r) => r.request.auth);
    expect(auths).toEqual([{ type: 'none' }, { type: 'inherit' }, schemes.key, { type: 'inherit' }]);
  });
});
