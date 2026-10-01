import { describe, expect, it } from 'vitest';
import { diffSpecs, hashOf, normalise, parseSpecText, readSpec, schemeAuth, SpecError } from './spec';

const OAS = `
openapi: 3.0.3
info: { title: Orders API, version: 2.3.0 }
servers: [{ url: https://api.shop.test/v2 }]
security: [{ bearer: [] }]
components:
  parameters:
    OrderId: { name: orderId, in: path, required: true, schema: { type: string } }
paths:
  /orders:
    get:
      tags: [orders]
      summary: List orders
      parameters: [{ name: page, in: query, schema: { type: integer } }]
      responses: { '200': { description: ok } }
    post:
      tags: [orders]
      operationId: createOrder
      requestBody: { required: true, content: { application/json: {} } }
      responses: { '201': { description: created }, '422': { description: invalid } }
  /orders/{orderId}:
    parameters: [{ $ref: '#/components/parameters/OrderId' }]
    get:
      security: []
      responses: { '200': { description: ok }, '404': { description: missing } }
`;

const SWAGGER = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Pets', version: '1' },
  host: 'pets.test',
  basePath: '/v1',
  schemes: ['http'],
  paths: {
    '/pets': {
      post: {
        parameters: [{ in: 'body', name: 'pet', required: true }],
        responses: { 200: { description: 'ok' } },
      },
    },
  },
});

describe('readSpec', () => {
  it('reads an OpenAPI 3 document in YAML, following local refs and inheriting security', () => {
    const spec = readSpec(parseSpecText(OAS));
    expect(spec).toMatchObject({ format: 'openapi3', title: 'Orders API', apiVersion: '2.3.0', servers: ['https://api.shop.test/v2'] });
    expect(spec.operations).toHaveLength(3);
    const [list, create, byId] = spec.operations;
    expect(list).toMatchObject({ method: 'GET', path: '/orders', summary: 'List orders', security: ['bearer'] });
    expect(list!.parameters).toEqual([{ name: 'page', in: 'query', required: false }]);
    expect(create).toMatchObject({ operationId: 'createOrder', requestBody: { required: true, contentTypes: ['application/json'] }, responses: ['201', '422'] });
    expect(byId!.parameters).toEqual([{ name: 'orderId', in: 'path', required: true }]);
    expect(byId!.security).toEqual([]);
  });

  it('reads Swagger 2.0, with the body parameter as a request body and the host as a server', () => {
    const spec = readSpec(parseSpecText(SWAGGER));
    expect(spec.format).toBe('swagger2');
    expect(spec.servers).toEqual(['http://pets.test/v1']);
    expect(spec.operations[0]).toMatchObject({ requestBody: { required: true, contentTypes: ['application/json'] }, parameters: [], security: null });
  });

  it('explains why a document is not a spec', () => {
    expect(() => readSpec(parseSpecText('{"hello": 1}'))).toThrow(SpecError);
    expect(() => readSpec(parseSpecText('openapi: 3.0.0\ninfo: {}'))).toThrow(/paths/);
    expect(() => parseSpecText('{ not json')).toThrow(/not valid JSON/);
  });

  it('hashes the same document the same whatever the key order', () => {
    expect(hashOf(normalise({ a: 1, b: { c: 2, d: 3 } }))).toBe(hashOf(normalise({ b: { d: 3, c: 2 }, a: 1 })));
  });
});

describe('diffSpecs', () => {
  const before = readSpec(parseSpecText(OAS)).operations;

  it('flags removed operations and responses and new required inputs as breaking', () => {
    const next = structuredClone(before);
    next.splice(0, 1); // GET /orders removed
    next[0]!.responses = ['201']; // 422 no longer documented
    next[1]!.parameters.push({ name: 'X-Tenant', in: 'header', required: true });
    next.push({ ...next[1]!, method: 'DELETE', parameters: [] });
    const diff = diffSpecs(before, next, 1);
    expect(diff).toMatchObject({ fromVersion: 1, added: 1, removed: 1, changed: 2, breaking: 3 });
    expect(diff.changes.filter((c) => c.breaking).map((c) => c.kind).sort()).toEqual(['operation_removed', 'parameter_added', 'response_removed']);
  });

  it('treats a public operation becoming protected as breaking, and the reverse as not', () => {
    const locked = structuredClone(before);
    locked[2]!.security = ['bearer'];
    expect(diffSpecs(before, locked, 1).changes[0]).toMatchObject({ kind: 'security_changed', breaking: true });
    expect(diffSpecs(locked, before, 2).changes[0]).toMatchObject({ kind: 'security_changed', breaking: false });
  });

  it('reports nothing for an unchanged spec', () => {
    expect(diffSpecs(before, structuredClone(before), 1)).toMatchObject({ added: 0, removed: 0, changed: 0, breaking: 0, changes: [] });
  });
});

describe('schemeAuth', () => {
  it('reads OpenAPI 3 schemes', () => {
    expect(
      schemeAuth({
        components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' }, ba: { type: 'http', scheme: 'Basic' }, k: { type: 'apiKey', name: 'X-Api-Key', in: 'header' }, q: { type: 'apiKey', name: 'key', in: 'query' }, o: { type: 'oauth2', flows: {} } } },
      }),
    ).toEqual({
      b: { type: 'bearer', token: '{{token}}' },
      ba: { type: 'basic', username: '{{username}}', password: '{{password}}' },
      k: { type: 'apikey', key: 'X-Api-Key', value: '{{apiKey}}', in: 'header' },
      q: { type: 'apikey', key: 'key', value: '{{apiKey}}', in: 'query' },
      o: { type: 'bearer', token: '{{token}}' },
    });
  });
  it('reads Swagger 2 definitions, and nothing from a spec without any', () => {
    expect(schemeAuth({ securityDefinitions: { b: { type: 'basic' }, k: { type: 'apiKey', name: 'k', in: 'header' } } })).toMatchObject({ b: { type: 'basic' }, k: { type: 'apikey' } });
    expect(schemeAuth({ openapi: '3.0.0' })).toEqual({});
  });
});
