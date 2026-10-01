import type { ApiAssertion } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { evaluate, extract, queryPath, type ResponseFacts } from './assert';

const doc = { id: 'ord_1', total: 1998, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }], meta: { 'next page': null } };
const facts = (over: Partial<ResponseFacts> = {}): ResponseFacts => ({
  status: 201,
  timeMs: 120,
  sizeBytes: 300,
  headers: [['Content-Type', 'application/json; charset=utf-8']],
  bodyText: JSON.stringify(doc),
  json: doc,
  ...over,
});
let n = 0;
const a = (over: Partial<ApiAssertion>): ApiAssertion => ({ id: String(n++), source: 'body', path: '', op: 'eq', value: '', enabled: true, ...over });

describe('queryPath', () => {
  it('reads keys, indexes, quoted keys, wildcards and recursive names', () => {
    expect(queryPath(doc, '$.items[0].sku')).toEqual(['A']);
    expect(queryPath(doc, '$.items[-1].sku')).toEqual(['B']);
    expect(queryPath(doc, "$.meta['next page']")).toEqual([null]);
    expect(queryPath(doc, '$.items[*].qty')).toEqual([2, 1]);
    expect(queryPath(doc, '$..sku')).toEqual(['A', 'B']);
    expect(queryPath(doc, '$.missing.deeper')).toEqual([]);
  });

  it('rejects paths it cannot read, with the reason', () => {
    expect(() => queryPath(doc, 'items')).toThrow(/starts with \$/);
    expect(() => queryPath(doc, '$.items[?(@.qty>1)]')).toThrow(/not supported/);
  });
});

describe('evaluate', () => {
  it('passes and fails with a message in plain words', () => {
    const [ok, bad] = evaluate([a({ source: 'status', op: 'eq', value: '201' }), a({ path: '$.total', op: 'eq', value: '2000' })], facts());
    expect(ok).toMatchObject({ passed: true, message: 'status is 201' });
    expect(bad).toMatchObject({ passed: false, message: '$.total is 2000, but it is 1998', actual: '1998' });
  });

  it('checks every value a wildcard selects', () => {
    expect(evaluate([a({ path: '$.items[*].qty', op: 'gt', value: '0' })], facts())[0]!.passed).toBe(true);
    expect(evaluate([a({ path: '$.items[*].qty', op: 'gt', value: '1' })], facts())[0]).toMatchObject({ passed: false, actual: '1' });
  });

  it('matches header names without case, and handles existence and type', () => {
    const results = evaluate(
      [
        a({ source: 'header', path: 'content-type', op: 'contains', value: 'json' }),
        a({ path: '$.id', op: 'exists' }),
        a({ path: '$.nope', op: 'notExists' }),
        a({ path: '$.items', op: 'type', value: 'array' }),
        a({ source: 'time', op: 'lt', value: '800' }),
        a({ source: 'status', op: 'in', value: '200, 201' }),
      ],
      facts(),
    );
    expect(results.map((r) => r.passed)).toEqual([true, true, true, true, true, true]);
  });

  it('fails a JSONPath on a body that is not JSON instead of throwing', () => {
    const [r] = evaluate([a({ path: '$.id', op: 'exists' })], facts({ json: undefined, bodyText: '<html>' }));
    expect(r).toMatchObject({ passed: false });
    expect(r!.message).toMatch(/not JSON/);
  });

  it('stops a runaway regex', () => {
    const [r] = evaluate([a({ path: '$.id', op: 'matches', value: '^(a+)+$' })], facts({ json: { id: `${'a'.repeat(40)}!` } }));
    expect(r).toMatchObject({ passed: false });
    expect(r!.message).toMatch(/too long/);
  });

  it('skips disabled assertions', () => {
    expect(evaluate([a({ enabled: false })], facts())).toEqual([]);
  });
});

describe('extract', () => {
  it('pulls values into variables and reports what it could not find', () => {
    const out = extract(
      [
        { variable: 'orderId', source: 'body', path: '$.id', enabled: true },
        { variable: 'ct', source: 'header', path: 'Content-Type', enabled: true },
        { variable: 'gone', source: 'body', path: '$.nope', enabled: true },
      ],
      facts(),
    );
    expect(out.values).toEqual({ orderId: 'ord_1', ct: 'application/json; charset=utf-8' });
    expect(out.problems).toEqual(['gone: nothing at $.nope']);
  });
});
