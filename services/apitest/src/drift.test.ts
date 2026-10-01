import { describe, expect, it } from 'vitest';
import { checkDrift } from './drift';
import { deref, parseSpecText } from './spec';

const DOC = parseSpecText(`
openapi: 3.0.3
info: { title: T, version: '1' }
components:
  schemas:
    Order:
      type: object
      required: [id, status]
      properties:
        id: { type: string }
        total: { type: number }
        status: { type: string, enum: [open, paid] }
        items: { type: array, items: { type: object, properties: { qty: { type: integer } } } }
        note: { type: string, nullable: true }
paths:
  /orders/{id}:
    get:
      responses:
        '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } } }
        4XX: { description: client error }
`) as Record<string, unknown>;
const op = deref(DOC, (DOC.paths as Record<string, Record<string, unknown>>)['/orders/{id}']!.get) as Record<string, unknown>;

describe('checkDrift', () => {
  it('finds nothing when the response matches', () => {
    expect(checkDrift(DOC, op, 200, { id: 'o1', total: 12, status: 'paid', items: [{ qty: 2 }], note: null })).toEqual([]);
  });

  it('reports wrong types, missing required fields, enums and extra fields with their paths', () => {
    const issues = checkDrift(DOC, op, 200, { id: 42, total: '12', status: 'shipped', items: [{ qty: 1.5 }], extra: true });
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: '$.id', kind: 'type', expected: 'string', actual: 'integer' },
        { path: '$.total', kind: 'type', expected: 'number', actual: 'string' },
        { path: '$.status', kind: 'enum', expected: '"open", "paid"', actual: '"shipped"' },
        { path: '$.items[0].qty', kind: 'type', expected: 'integer', actual: 'number' },
        { path: '$.extra', kind: 'extra', expected: 'not in the spec', actual: 'boolean' },
      ]),
    );
    expect(checkDrift(DOC, op, 200, { total: 1 })).toEqual(expect.arrayContaining([{ path: '$.id', kind: 'missing', expected: 'present', actual: 'absent' }]));
  });

  it('matches a status class, and flags a status the spec never mentions', () => {
    expect(checkDrift(DOC, op, 404, { anything: 1 })).toEqual([]);
    expect(checkDrift(DOC, op, 503, {})).toEqual([{ path: '$', kind: 'status', expected: '200, 4XX', actual: '503' }]);
  });
});
