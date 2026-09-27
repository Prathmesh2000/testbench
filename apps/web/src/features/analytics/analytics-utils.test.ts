import { describe, expect, it } from 'vitest';
import { hoursLabel, linePath, niceTicks, passRateTicks, toCsv } from './analytics-utils';

describe('analytics utils', () => {
  it('picks round axis steps', () => {
    expect(niceTicks(0, 37)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(0, 9)).toEqual([0, 5, 10]);
    expect(niceTicks(0, 3)).toEqual([0, 1, 2, 3]);
  });

  it('still draws an axis when every value is zero', () => {
    expect(niceTicks(0, 0)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps the pass-rate axis ending at 100 and showing the target', () => {
    expect(passRateTicks([91.4, 88, null], 95)).toEqual([80, 85, 90, 95, 100]);
    expect(passRateTicks([null, null], 95)).toEqual([90, 95, 100]);
    expect(passRateTicks([12], 95)).toEqual([0, 50, 100]);
  });

  it('breaks the line where a day has no data', () => {
    expect(linePath([10, 20, null, 30], (i) => i * 10, (v) => 100 - v)).toBe('M0,90L10,80M30,70');
    expect(linePath([null, null], (i) => i, (v) => v)).toBe('');
  });

  it('escapes CSV cells that need quoting', () => {
    expect(toCsv(['Key', 'Title'], [['TC-1', 'Say "hi", then leave'], ['TC-2', null]])).toBe(
      'Key,Title\r\nTC-1,"Say ""hi"", then leave"\r\nTC-2,',
    );
  });

  it('labels hours as days and hours', () => {
    expect(hoursLabel(0.75)).toBe('45m');
    expect(hoursLabel(5.2)).toBe('5h');
    expect(hoursLabel(30)).toBe('1d 6h');
    expect(hoursLabel(48)).toBe('2d');
  });
});
