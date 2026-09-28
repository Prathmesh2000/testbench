import { describe, expect, it } from 'vitest';
import { parseDelimited, parseTable, tableFromRecords, toCsv } from './parse';

describe('parseDelimited', () => {
  it('handles quotes, doubled quotes and newlines inside quotes', () => {
    expect(parseDelimited('a,b\n"x, y","he said ""hi"""\n"multi\nline",2\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['multi\nline', '2'],
    ]);
  });

  it('reads spreadsheet paste (tabs) and semicolon CSV', () => {
    expect(parseDelimited('amount\tvpa\r\n100\ta@upi')).toEqual([['amount', 'vpa'], ['100', 'a@upi']]);
    expect(parseDelimited('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('tables', () => {
  it('names blank and repeated headers uniquely', () => {
    expect(tableFromRecords([['amount', '', 'amount'], ['1', '2', '3']]).columns).toEqual(['amount', 'column 2', 'amount 2']);
  });

  it('reads a JSON array of objects', () => {
    const t = parseTable('data.json', '[{"amount": 100, "meta": {"x": 1}}, {"vpa": "a@upi"}]');
    expect(t.columns).toEqual(['amount', 'meta', 'vpa']);
    expect(t.rows[0]).toEqual({ amount: '100', meta: '{"x":1}', vpa: '' });
  });

  it('round-trips through CSV', () => {
    const t = { columns: ['a', 'b'], rows: [{ a: 'x, y', b: 'q"q' }] };
    expect(tableFromRecords(parseDelimited(toCsv(t)))).toEqual(t);
  });
});
