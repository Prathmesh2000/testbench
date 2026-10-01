import { describe, expect, it } from 'vitest';
import { applyPatches } from './enrich';
import { parseSpecText, readSpec } from './spec';
import { expectedStatuses, generateForSpec, pairwise, sampleValue } from './testgen';

const SPEC = parseSpecText(`
openapi: 3.0.3
info: { title: Shop, version: '1' }
security: [{ bearer: [] }]
components:
  securitySchemes: { bearer: { type: http, scheme: bearer } }
paths:
  /orders:
    get:
      parameters:
        - { name: status, in: query, required: true, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer, maximum: 100 } }
      responses: { '200': { description: ok } }
    post:
      requestBody:
        content:
          application/json:
            example: { qty: 2, email: a@b.test }
            schema:
              type: object
              required: [qty]
              properties:
                qty: { type: integer, minimum: 1, maximum: 10 }
                email: { type: string, format: email }
                code: { type: string, maxLength: 4, pattern: '^[A-Z]+$' }
                channel: { type: string, enum: [web, app, pos] }
                gift: { type: boolean }
      responses: { '201': { description: ok }, '422': { description: bad } }
  /orders/{orderId}:
    get: { security: [], parameters: [{ name: orderId, in: path, required: true }], responses: { '200': { description: ok }, '404': { description: none } } }
`);

const all = generateForSpec(SPEC as Record<string, unknown>, '00000000-0000-4000-8000-0000000000aa');
const of = (op: string) => all.filter((g) => g.operation === op);

describe('generateForSpec', () => {
  it('makes a happy path from the example, and one failing case per rule', () => {
    const post = of('POST /orders');
    expect(JSON.parse((post.find((g) => g.kind === 'happy')!.overrides.body as { text: string }).text)).toEqual({ qty: 2, email: 'a@b.test' });
    const names = post.map((g) => g.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Without qty',
        'qty of the wrong type',
        'qty just below the minimum (0)',
        'qty at the minimum (1)',
        'qty at the maximum (10)',
        'qty just above the maximum (11)',
        'email not a valid email',
        'code one character too long',
        'code not matching its pattern',
        'channel = "web"',
        'channel not an allowed value',
        'Without a credential',
      ]),
    );
    // Documented error codes are what failing cases expect.
    expect(post.find((g) => g.name === 'Without qty')!.expect).toEqual(['422']);
    expect(post.find((g) => g.name === 'qty at the maximum (10)')!.expect).toEqual(['201']);
    expect(post.find((g) => g.kind === 'auth_missing')!.expect).toEqual(['401']);
  });

  it('combines the optional enums and booleans pairwise', () => {
    // With two factors every pair needs its own row (3 channels × 2 gift values); the saving shows from
    // three factors up, which the pairwise test below checks.
    const pw = of('POST /orders').filter((g) => g.kind === 'pairwise');
    expect(pw).toHaveLength(6);
    expect(new Set(pw.map((g) => g.id)).size).toBe(6);
  });

  it('checks query parameters and unknown ids, and skips auth where the operation is public', () => {
    const list = of('GET /orders');
    expect(list.map((g) => g.name)).toEqual(expect.arrayContaining(['Without the status parameter', 'limit above its maximum (101)']));
    const byId = of('GET /orders/{orderId}');
    expect(byId.find((g) => g.kind === 'not_found')).toMatchObject({ expect: ['404'], overrides: { url: '{{baseUrl}}/orders/does-not-exist-000' } });
    expect(byId.some((g) => g.kind === 'auth_missing')).toBe(false);
  });

  it('gives the same ids every time, and reflects answers once the spec is enriched', () => {
    expect(generateForSpec(structuredClone(SPEC) as Record<string, unknown>, '00000000-0000-4000-8000-0000000000aa').map((g) => g.id)).toEqual(all.map((g) => g.id));
    const enriched = applyPatches(SPEC, [{ pointer: '#/paths/~1orders~1{orderId}/get/parameters/0/schema', op: 'set', value: { type: 'string' }, question: 'q' }]).doc as Record<string, unknown>;
    expect(readSpec(enriched).operations).toHaveLength(3);
  });
});

describe('helpers', () => {
  it('samples values that fit their schema', () => {
    expect(sampleValue({}, { type: 'string', maxLength: 3 })).toBe('sam');
    expect(sampleValue({}, { type: 'string', minLength: 10 })).toHaveLength(10);
    expect(sampleValue({}, { type: 'integer', minimum: 5 })).toBe(5);
    expect(sampleValue({}, { type: 'string', format: 'email' })).toContain('@');
  });

  it('pairwise covers every pair', () => {
    const factors = [
      { name: 'a', values: [1, 2, 3] },
      { name: 'b', values: ['x', 'y'] },
      { name: 'c', values: [true, false] },
    ];
    const rows = pairwise(factors);
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const)
      for (const va of factors[i]!.values)
        for (const vb of factors[j]!.values) expect(rows.some((r) => r[factors[i]!.name] === va && r[factors[j]!.name] === vb)).toBe(true);
    expect(rows.length).toBeLessThan(3 * 2 * 2);
  });

  it('reads the statuses a request expects from its checks', () => {
    expect(expectedStatuses([
      { id: '1', source: 'status', path: '', op: 'eq', value: '201', enabled: true },
      { id: '2', source: 'status', path: '', op: 'in', value: '400, 422', enabled: true },
      { id: '3', source: 'status', path: '', op: 'eq', value: '500', enabled: false },
    ])).toEqual(['201', '400', '422']);
  });
});
