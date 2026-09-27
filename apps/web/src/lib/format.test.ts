import { describe, expect, it } from 'vitest';
import { ago, clock, fmt, initials, minutesLabel } from './format';

describe('format', () => {
  it('groups digits the Indian way', () => {
    expect(fmt(10482113)).toBe('1,04,82,113');
    expect(fmt(100000)).toBe('1,00,000');
  });

  it('formats durations compactly', () => {
    expect(minutesLabel(45)).toBe('45m');
    expect(minutesLabel(320)).toBe('5h 20m');
    expect(minutesLabel(120)).toBe('2h');
    expect(clock(75)).toBe('01:15');
    expect(clock(3725)).toBe('1:02:05');
  });

  it('describes recent times relative to now', () => {
    const now = Date.parse('2026-09-27T10:00:00Z');
    expect(ago('2026-09-27T09:59:30Z', now)).toBe('just now');
    expect(ago('2026-09-27T09:48:00Z', now)).toBe('12m ago');
    expect(ago('2026-09-25T10:00:00Z', now)).toBe('2d ago');
  });

  it('takes up to two initials', () => {
    expect(initials('Sneha Iyer')).toBe('SI');
    expect(initials('anita')).toBe('A');
  });
});
