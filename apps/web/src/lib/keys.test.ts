import { describe, expect, it } from 'vitest';
import { executeAction, globalAction, moveFocus } from './keys';

describe('globalAction', () => {
  it('opens the palette with Ctrl K even while typing', () => {
    expect(globalAction({ key: 'k', ctrlKey: true }, true, false)).toEqual({ type: 'palette' });
    expect(globalAction({ key: 'K', metaKey: true }, false, false)).toEqual({ type: 'palette' });
  });

  it('ignores single-letter shortcuts while typing', () => {
    expect(globalAction({ key: '?' }, true, false)).toBeNull();
    expect(globalAction({ key: 'g' }, true, false)).toBeNull();
  });

  it('navigates with g-chords', () => {
    expect(globalAction({ key: 'g' }, false, false)).toEqual({ type: 'pending-g' });
    expect(globalAction({ key: 'c' }, false, true)).toEqual({ type: 'go', to: '/cases' });
    expect(globalAction({ key: 'x' }, false, true)).toBeNull();
  });
});

describe('executeAction', () => {
  it('maps P F B S to results', () => {
    expect(executeAction({ key: 'p' }, false)).toEqual({ type: 'mark', status: 'passed' });
    expect(executeAction({ key: 'f' }, false)).toEqual({ type: 'mark', status: 'failed' });
    expect(executeAction({ key: 'b' }, false)).toEqual({ type: 'mark', status: 'blocked' });
    expect(executeAction({ key: 's' }, false)).toEqual({ type: 'mark', status: 'skipped' });
  });

  it('distinguishes Shift+P (pass all) from P', () => {
    expect(executeAction({ key: 'P', shiftKey: true }, false)).toEqual({ type: 'pass-all' });
  });

  it('logs a bug with Ctrl+Shift+B, even from the actual-result field', () => {
    expect(executeAction({ key: 'B', ctrlKey: true, shiftKey: true }, true)).toEqual({ type: 'log-bug' });
  });

  it('never marks a result while the tester is typing', () => {
    expect(executeAction({ key: 'f' }, true)).toBeNull();
    expect(executeAction({ key: 'j' }, true)).toBeNull();
  });

  it('moves between cases with J/K/N and between steps with arrows', () => {
    expect(executeAction({ key: 'j' }, false)).toEqual({ type: 'item', delta: 1 });
    expect(executeAction({ key: 'n' }, false)).toEqual({ type: 'item', delta: 1 });
    expect(executeAction({ key: 'k' }, false)).toEqual({ type: 'item', delta: -1 });
    expect(executeAction({ key: 'ArrowUp' }, false)).toEqual({ type: 'step', delta: -1 });
  });
});

describe('moveFocus', () => {
  // index: 0 header, 1 row, 2 row, 3 header, 4 row
  const selectable = (i: number) => i !== 0 && i !== 3;

  it('skips group headers', () => {
    expect(moveFocus(2, 1, selectable, 5)).toBe(4);
    expect(moveFocus(4, -1, selectable, 5)).toBe(2);
  });

  it('stays put at either end', () => {
    expect(moveFocus(1, -1, selectable, 5)).toBe(1);
    expect(moveFocus(4, 1, selectable, 5)).toBe(4);
  });
});
