import { describe, expect, it } from 'vitest';
import { groupProjects, landingAfterSwitch, matchesProject, UNGROUPED } from './projects';

describe('groupProjects', () => {
  it('sorts groups and puts ungrouped projects last', () => {
    const groups = groupProjects([
      { key: 'X', group: null },
      { key: 'PAY', group: 'Payments' },
      { key: 'KYC', group: 'Onboarding' },
      { key: 'MOB', group: 'Payments' },
    ]);
    expect(groups.map((g) => [g.group, g.projects.map((p) => p.key)])).toEqual([
      ['Onboarding', ['KYC']],
      ['Payments', ['PAY', 'MOB']],
      [UNGROUPED, ['X']],
    ]);
  });
});

describe('landingAfterSwitch', () => {
  it.each([
    ['/cases/TC-10231', '/cases'],
    ['/runs/abc/items', '/runs'],
    ['/analytics', '/analytics'],
    ['/', '/'],
  ])('%s → %s', (from, to) => expect(landingAfterSwitch(from)).toBe(to));
});

describe('matchesProject', () => {
  it('matches key, name or group', () => {
    const p = { key: 'KYC', name: 'Video KYC', group: 'Onboarding' };
    expect(matchesProject(p, 'onboard')).toBe(true);
    expect(matchesProject(p, 'video')).toBe(true);
    expect(matchesProject(p, 'pay')).toBe(false);
  });
});
