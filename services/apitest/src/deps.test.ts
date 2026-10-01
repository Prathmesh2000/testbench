import { describe, expect, it } from 'vitest';
import { applyDecisions, callOrder, inferLinks, operationsIO, orphansOf, singular, suggestWorkflows } from './deps';
import { parseSpecText } from './spec';

const SHOP = parseSpecText(`
openapi: 3.0.3
info: { title: Shop, version: '1' }
security: [{ bearer: [] }]
components:
  schemas:
    Order: { type: object, properties: { id: { type: string }, customerId: { type: string }, total: { type: number } } }
paths:
  /auth/login:
    post:
      security: []
      responses: { '200': { description: ok, content: { application/json: { schema: { type: object, properties: { token: { type: string } } } } } } }
  /customers:
    post:
      responses: { '201': { description: ok, content: { application/json: { schema: { type: object, properties: { id: { type: string } } } } } } }
  /orders:
    get:
      responses: { '200': { description: ok, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Order' } } } } } }
    post:
      requestBody: { content: { application/json: { schema: { type: object, properties: { customerId: { type: string }, qty: { type: integer } } } } } }
      responses:
        '201':
          description: ok
          content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } }
          links:
            GetInvoice: { operationId: getInvoice, parameters: { invoiceOrder: '$response.body#/id' } }
  /orders/{orderId}:
    get: { parameters: [{ name: orderId, in: path, required: true }], responses: { '200': { description: ok } } }
    patch: { parameters: [{ name: orderId, in: path, required: true }], responses: { '200': { description: ok } } }
    delete: { parameters: [{ name: orderId, in: path, required: true }], responses: { '204': { description: gone } } }
  /invoices/{invoiceOrder}:
    get: { operationId: getInvoice, parameters: [{ name: invoiceOrder, in: path, required: true }], responses: { '200': { description: ok } } }
  /reports/{reportId}:
    get: { parameters: [{ name: reportId, in: path, required: true }], responses: { '200': { description: ok } } }
`);

const ops = operationsIO(SHOP, 'spec-1', 'Shop');
const links = inferLinks(ops);
const link = (to: string, name: string) => links.find((l) => l.to === to && l.param.name === name);

describe('operationsIO', () => {
  it('reads outputs through refs and arrays, id-like body fields and declared links', () => {
    const post = ops.find((o) => o.key === 'POST /orders')!;
    expect(post.outputs).toEqual(expect.arrayContaining(['$.id', '$.customerId', '$.total']));
    expect(post.bodyIds).toEqual(['customerId']);
    expect(post.specLinks).toEqual([{ operationId: 'getInvoice', parameter: 'invoiceOrder', field: '$.id' }]);
    expect(ops.find((o) => o.key === 'GET /orders')!.outputs).toContain('$[*].id');
    expect(ops.find((o) => o.key === 'POST /auth/login')!.secured).toBe(false);
  });
});

describe('inferLinks', () => {
  it('links a create to the calls that address the resource by id', () => {
    expect(link('GET /orders/{orderId}', 'orderId')).toMatchObject({ from: 'POST /orders', field: '$.id', confidence: 0.9 });
    expect(link('DELETE /orders/{orderId}', 'orderId')?.from).toBe('POST /orders');
  });

  it('prefers a response field named like the input over a generic id', () => {
    const keyed = operationsIO(
      parseSpecText(`
openapi: 3.0.3
info: { title: T, version: '1' }
paths:
  /issues:
    post: { responses: { '201': { description: ok, content: { application/json: { schema: { type: object, properties: { id: { type: string }, key: { type: string } } } } } } } }
  /issues/{key}:
    get: { parameters: [{ name: key, in: path, required: true }], responses: { '200': { description: ok } } }
`),
      's',
      'T',
    );
    expect(inferLinks(keyed).find((l) => l.to === 'GET /issues/{key}')).toMatchObject({ from: 'POST /issues', field: '$.key', confidence: 0.9 });
  });

  it('links an id in a request body to the create of that resource', () => {
    expect(link('POST /orders', 'customerId')).toMatchObject({ from: 'POST /customers', field: '$.id', param: { in: 'body' } });
  });

  it('uses links declared in the spec as certain', () => {
    expect(link('GET /invoices/{invoiceOrder}', 'invoiceOrder')).toMatchObject({ from: 'POST /orders', confidence: 1, source: 'spec' });
  });

  it('points secured operations at the public login, and leaves unknown inputs unlinked', () => {
    expect(link('POST /orders', 'bearer')).toMatchObject({ from: 'POST /auth/login', param: { in: 'auth' } });
    expect(link('POST /auth/login', 'bearer')).toBeUndefined();
    expect(link('GET /reports/{reportId}', 'reportId')).toBeUndefined();
    expect(orphansOf(ops, links).get('GET /reports/{reportId}')).toEqual(['reportId']);
  });

  it('applies tester decisions: rejections drop a link, confirmations win', () => {
    const decided = applyDecisions(links, [
      { from: 'POST /orders', to: 'GET /orders/{orderId}', param: { in: 'path', name: 'orderId' }, field: '$.id', status: 'rejected' },
      { from: 'GET /orders', to: 'GET /reports/{reportId}', param: { in: 'path', name: 'reportId' }, field: '$[*].id', status: 'confirmed' },
    ]);
    expect(decided.find((l) => l.to === 'GET /orders/{orderId}' && l.param.name === 'orderId')).toBeUndefined();
    expect(decided.find((l) => l.to === 'GET /reports/{reportId}' && l.param.name === 'reportId')).toMatchObject({ confidence: 1, source: 'confirmed' });
  });
});

describe('order and suggestions', () => {
  it('orders every producer before its consumers', () => {
    const order = callOrder(ops.map((o) => o.key), links);
    for (const l of links) expect(order.indexOf(l.from), `${l.from} → ${l.to}`).toBeLessThan(order.indexOf(l.to));
  });

  it('still orders everything when the links form a cycle', () => {
    const cyc = [
      { ...links[0]!, from: 'A', to: 'B' },
      { ...links[0]!, from: 'B', to: 'A' },
    ];
    expect(callOrder(['A', 'B', 'C'], cyc).sort()).toEqual(['A', 'B', 'C']);
  });

  it('suggests a CRUD lifecycle that ends by checking the resource is gone', () => {
    const crud = suggestWorkflows(ops, links).find((s) => s.id === 'crud:POST /orders')!;
    expect(crud.name).toBe('Order lifecycle');
    expect(crud.steps.map((s) => s.key)).toEqual([
      'POST /auth/login',
      'POST /orders',
      'GET /orders/{orderId}',
      'PATCH /orders/{orderId}',
      'GET /orders/{orderId}',
      'DELETE /orders/{orderId}',
      'GET /orders/{orderId}',
    ]);
    expect(crud.steps.at(-1)!.expectStatus).toBe('404');
  });

  it('suggests the setup chain for an operation deep in the graph', () => {
    const setup = suggestWorkflows(ops, links).find((s) => s.id === 'setup:GET /invoices/{invoiceOrder}')!;
    expect(setup.steps.map((s) => s.key)).toEqual(['POST /auth/login', 'POST /customers', 'POST /orders', 'GET /invoices/{invoiceOrder}']);
  });

  it('makes resource names singular', () => {
    expect(['orders', 'categories', 'addresses', 'boxes', 'class'].map(singular)).toEqual(['order', 'category', 'address', 'box', 'class']);
  });
});
