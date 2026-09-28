import { describe, expect, it } from 'vitest';
import { expandItems, fillPlaceholders } from './data-rows';

describe('expandItems', () => {
  it('runs a data-driven case once per row and configuration, others once per configuration', () => {
    const rows = new Map([['ds', [{ amount: '100' }, { amount: '15000' }]]]);
    const items = expandItems(
      [
        { id: 'a', version: 1, dataSetId: 'ds' },
        { id: 'b', version: 2, dataSetId: null },
      ],
      ['Chrome', 'Safari'],
      rows,
    );
    expect(items.map((i) => `${i.caseId}:${i.config}:${i.dataRow}`)).toEqual([
      'a:Chrome:0',
      'a:Chrome:1',
      'a:Safari:0',
      'a:Safari:1',
      'b:Chrome:null',
      'b:Safari:null',
    ]);
    expect(items[1]!.data).toEqual({ amount: '15000' });
  });

  it('treats an empty data set like no data set', () => {
    expect(
      expandItems([{ id: 'a', version: 1, dataSetId: 'ds' }], ['x'], new Map([['ds', []]])),
    ).toHaveLength(1);
  });
});

describe('fillPlaceholders', () => {
  it('fills known columns case-insensitively and leaves unknown ones visible', () => {
    expect(
      fillPlaceholders('Pay {{ Amount }} to {{vpa}} via {{bank}}', { amount: '₹500', VPA: 'shop@upi' }),
    ).toBe('Pay ₹500 to shop@upi via {{bank}}');
    expect(fillPlaceholders('Pay {{amount}}', null)).toBe('Pay {{amount}}');
  });
});
