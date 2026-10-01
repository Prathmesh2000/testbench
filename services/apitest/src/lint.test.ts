import { describe, expect, it } from 'vitest';
import { lintSpec, RULES } from './lint';
import { parseSpecText } from './spec';

const GOOD = parseSpecText(`
openapi: 3.0.3
info: { title: Good, version: '1' }
servers: [{ url: 'https://api.shop.test/v1' }]
components:
  securitySchemes: { bearer: { type: http, scheme: bearer } }
  schemas:
    Problem: { type: object, properties: { type: { type: string }, title: { type: string }, detail: { type: string } } }
    Order: { type: object, properties: { id: { type: string }, totalAmount: { type: number } }, example: { id: o1, totalAmount: 10 } }
security: [{ bearer: [] }]
paths:
  /orders:
    get:
      operationId: listOrders
      summary: List orders
      parameters: [{ name: limit, in: query, description: Page size }]
      responses:
        '200': { description: ok, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Order' } }, example: [] } } }
        '400': { description: bad, content: { application/json: { schema: { $ref: '#/components/schemas/Problem' } } } }
    post:
      operationId: createOrder
      summary: Create order
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } } }
      responses:
        '201': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } } }
        '422': { description: bad, content: { application/json: { schema: { $ref: '#/components/schemas/Problem' } } } }
`);

const BAD = parseSpecText(`
openapi: 3.0.3
info: { title: Bad, version: '1' }
components: { securitySchemes: { key: { type: apiKey, in: query, name: api_key } } }
paths:
  /getOrders/:
    get:
      parameters: [{ name: token, in: query }]
      requestBody: { content: { application/json: { schema: { type: object } } } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: array
                items: { type: object, properties: { user_id: { type: integer }, password: { type: string } } }
  /order/{orderId}:
    delete: { responses: { '201': { description: odd } } }
  /Users:
    post: { responses: { '200': { description: ok, content: { application/json: { schema: { type: object, properties: { userId: { type: string }, user_id: { type: string } } } } } }, '400': { description: x } } }
`);

const rules = (r: ReturnType<typeof lintSpec>) => [...new Set(r.issues.map((i) => i.rule))].sort();

describe('lintSpec', () => {
  it('finds nothing wrong with a clean spec, and scores it 100', () => {
    const r = lintSpec(GOOD);
    expect(r.issues).toEqual([]);
    expect(r.score).toBe(100);
  });

  it('catches what is wrong with a sloppy spec, with pointers and fixes', () => {
    const r = lintSpec(BAD);
    expect(rules(r)).toEqual(
      expect.arrayContaining([
        'apikey-in-query',
        'sensitive-in-url',
        'password-write-only',
        'get-no-body',
        'op-summary',
        'op-operation-id',
        'op-error-response',
        'delete-status',
        'create-returns-201',
        'list-paginated',
        'path-no-verbs',
        'no-trailing-slash',
        'path-kebab-case',
        'path-plural',
        'field-case',
        'field-type',
        'version-present',
      ]),
    );
    const verb = r.issues.find((i) => i.rule === 'path-no-verbs')!;
    expect(verb).toMatchObject({ operation: 'GET /getOrders/', pointer: '#/paths/~1getOrders~1' });
    expect(r.issues.find((i) => i.rule === 'field-type')!.message).toContain('user_id');
    expect(r.score).toBeLessThan(40);
    expect(r.counts.error).toBe(2);
  });

  it('flags a spec with no security at all', () => {
    const none = parseSpecText(`openapi: 3.0.0\ninfo: { title: x, version: '1' }\npaths: { /a: { get: { summary: a, operationId: a, responses: { '200': { description: ok } } } } }`);
    expect(rules(lintSpec(none))).toContain('security-defined');
  });

  it('skips rules the project switched off', () => {
    const r = lintSpec(BAD, new Set(['path-plural', 'version-present']));
    expect(rules(r)).not.toContain('path-plural');
    expect(r.rulesRun).toBe(RULES.length - 2);
  });

  it('has a reason and a category for every rule', () => {
    for (const rule of RULES) expect(rule.why.length, rule.id).toBeGreaterThan(10);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });
});
