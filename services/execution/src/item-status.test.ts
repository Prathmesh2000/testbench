import { describe, expect, it } from 'vitest';
import { counterDelta, deriveItemStatus, withStepStatus } from './item-status';

describe('deriveItemStatus', () => {
  it('fails as soon as any step fails, even with steps left', () => {
    expect(deriveItemStatus(['passed', 'failed', 'untested'], 3)).toBe('failed');
  });

  it('prefers failed over blocked', () => {
    expect(deriveItemStatus(['blocked', 'failed'], 2)).toBe('failed');
  });

  it('blocks when a step is blocked and none failed', () => {
    expect(deriveItemStatus(['passed', 'blocked'], 3)).toBe('blocked');
  });

  it('stays untested until every step has a result', () => {
    expect(deriveItemStatus(['passed', 'passed'], 3)).toBe('untested');
    expect(deriveItemStatus([], 3)).toBe('untested');
  });

  it('passes when every step is done and at least one passed', () => {
    expect(deriveItemStatus(['passed', 'skipped', 'passed'], 3)).toBe('passed');
  });

  it('is skipped only when every step was skipped', () => {
    expect(deriveItemStatus(['skipped', 'skipped'], 2)).toBe('skipped');
  });

  it('treats a case with no steps as untested', () => {
    expect(deriveItemStatus([], 0)).toBe('untested');
  });
});

describe('withStepStatus', () => {
  it('pads earlier steps and sets the given one', () => {
    expect(withStepStatus([], 2, 'passed', 4)).toEqual(['untested', 'untested', 'passed', 'untested']);
  });

  it('overwrites a previous result for the same step', () => {
    expect(withStepStatus(['failed', 'passed'], 0, 'passed', 2)).toEqual(['passed', 'passed']);
  });
});

describe('counterDelta', () => {
  it('moves one count between buckets', () => {
    expect(counterDelta('failed', 'passed')).toEqual({ failed: -1, passed: 1 });
  });

  it('only increments when leaving untested and only decrements when returning to it', () => {
    expect(counterDelta('untested', 'blocked')).toEqual({ blocked: 1 });
    expect(counterDelta('skipped', 'untested')).toEqual({ skipped: -1 });
  });

  it('is empty when nothing changes', () => {
    expect(counterDelta('passed', 'passed')).toEqual({});
  });
});
