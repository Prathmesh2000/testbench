import { describe, expect, it } from 'vitest';
import { answerToPatches, AnswerError, applyPatches, detectGaps, getAt, readiness, resolvePointer } from './enrich';
import { parseSpecText, readSpec } from './spec';

const THIN = parseSpecText(`
openapi: 3.0.3
info: { title: Thin, version: '1' }
components:
  schemas:
    NewOrder: { type: object, properties: { qty: { type: integer }, note: { type: string }, status: { type: string, enum: [open, shut] } } }
paths:
  /orders:
    post:
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/NewOrder' } } } }
      responses: { '201': { description: ok } }
  /orders/{id}:
    delete: { security: [], parameters: [{ name: id, in: path, required: true }], responses: { '204': { description: gone }, '404': { description: missing } } }
`);

const gaps = detectGaps(THIN);
const gap = (kind: string, field?: string) => gaps.find((g) => g.kind === kind && (field === undefined || g.field === field))!;

describe('detectGaps', () => {
  it('asks what testing needs, highest impact first', () => {
    expect(gaps[0]!.kind).toBe('security');
    expect(gaps.map((g) => `${g.kind}:${g.field ?? ''}`)).toEqual(
      expect.arrayContaining(['security:', 'error_response:', 'required:', 'constraints:qty', 'constraints:note', 'example:', 'side_effect:', 'business_rule:']),
    );
    // Bounded fields and operations that already say what is asked are left alone.
    expect(gaps.some((g) => g.field === 'status')).toBe(false);
    expect(gaps.some((g) => g.kind === 'security' && g.operation === 'DELETE /orders/{id}')).toBe(false);
    expect(gaps.some((g) => g.kind === 'error_response' && g.operation === 'DELETE /orders/{id}')).toBe(false);
  });

  it('points field questions at the shared schema, not the $ref', () => {
    expect(gap('constraints', 'qty').pointer).toBe('#/components/schemas/NewOrder/properties/qty');
    expect(gap('required').pointer).toBe('#/components/schemas/NewOrder');
    expect(resolvePointer(THIN, '#/paths/~1orders/post/requestBody/content/application~1json/schema')).toBe('#/components/schemas/NewOrder');
  });

  it('gives each question a stable id, so an answer survives a new version', () => {
    expect(detectGaps(structuredClone(THIN)).map((g) => g.id)).toEqual(gaps.map((g) => g.id));
  });

  it('asks about links it is unsure of', () => {
    const q = detectGaps(THIN, [{ id: 'x', from: 'GET /orders', to: 'DELETE /orders/{id}', param: { in: 'path', name: 'id' }, field: '$[*].id', confidence: 0.5, reason: '', source: 'inferred' }]);
    expect(q.find((g) => g.kind === 'dependency')!.prompt).toContain('GET /orders');
  });
});

describe('answers and the effective spec', () => {
  it('turns each answer into patches that fill the gap, leaving the original alone', () => {
    const patches = [
      ...answerToPatches(gap('security'), { kind: 'security', scheme: 'bearer', roles: ['customer'] }, THIN),
      ...answerToPatches(gap('error_response'), { kind: 'error_response', status: '422', description: 'Invalid', body: '{"error":"qty must be positive"}' }, THIN),
      ...answerToPatches(gap('required'), { kind: 'required', fields: ['qty'] }, THIN),
      ...answerToPatches(gap('constraints', 'qty'), { kind: 'constraints', minimum: 1, maximum: 10, maxLength: null, pattern: '', enum: [] }, THIN),
      ...answerToPatches(gap('example'), { kind: 'example', body: '{"qty": 2}' }, THIN),
      ...answerToPatches(gap('business_rule'), { kind: 'business_rule', text: 'total = qty × price' }, THIN),
    ];
    const { doc, skipped } = applyPatches(THIN, patches);
    expect(skipped).toEqual([]);
    expect(getAt(doc, '#/components/schemas/NewOrder/properties/qty')).toEqual({ type: 'integer', minimum: 1, maximum: 10 });
    expect(getAt(doc, '#/components/schemas/NewOrder/required')).toEqual(['qty']);
    expect(getAt(doc, '#/paths/~1orders/post/security')).toEqual([{ bearer: [] }]);
    const op = readSpec(doc).operations.find((o) => o.method === 'POST')!;
    expect(op.responses).toEqual(['201', '422']);
    expect(op.security).toEqual(['bearer']);
    // Once answered, the gaps are gone from the effective spec.
    const left = detectGaps(doc).filter((g) => g.operation === 'POST /orders').map((g) => `${g.kind}:${g.field ?? ''}`);
    expect(left).toEqual(expect.arrayContaining(['constraints:note', 'business_rule:']));
    expect(left).not.toContain('security:');
    expect(left).not.toContain('constraints:qty');
    // The upload itself is never changed.
    expect(getAt(THIN, '#/components/schemas/NewOrder/required')).toBeUndefined();
  });

  it('refuses answers that do not make sense', () => {
    expect(() => answerToPatches(gap('required'), { kind: 'required', fields: ['nope'] }, THIN)).toThrow(AnswerError);
    expect(() => answerToPatches(gap('constraints', 'qty'), { kind: 'constraints', minimum: 5, maximum: 1, maxLength: null, pattern: '', enum: [] }, THIN)).toThrow(/above/);
    expect(() => answerToPatches(gap('example'), { kind: 'example', body: '{bad' }, THIN)).toThrow(/JSON/);
  });

  it('skips a patch whose target is gone in a new version, instead of failing', () => {
    const { skipped } = applyPatches(THIN, [{ pointer: '#/paths/~1gone/post/security', op: 'set', value: [], question: 'q' }]);
    expect(skipped).toHaveLength(1);
  });

  it('weighs readiness by impact', () => {
    expect(readiness(gaps, new Set())).toBe(0);
    expect(readiness(gaps, new Set(gaps.map((g) => g.id)))).toBe(100);
    expect(readiness([], new Set())).toBe(100);
    const half = readiness(gaps, new Set([gap('security').id]));
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(50);
  });
});
