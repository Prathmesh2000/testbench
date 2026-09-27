import { EVENT_TYPES } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { summarise } from './summarise';

describe('summarise', () => {
  it('has wording for every event type', () => {
    for (const type of EVENT_TYPES) expect(summarise(type, {}).action).not.toBe(type);
  });

  it('describes a bulk update by its patch', () => {
    expect(
      summarise('testcase.bulk_updated', { processed: 12480, patch: { status: 'ready', labels: ['smoke'] } }),
    ).toEqual({
      action: 'Bulk update',
      entity: '12480 cases',
      details: 'status → ready · labels → smoke',
    });
  });

  it('shows role changes with readable names', () => {
    expect(summarise('user.role_changed', { role: 'test_lead', from: 'tester' }).details).toBe(
      'Tester → Test Lead',
    );
    expect(
      summarise('role.saved', { name: 'Release Manager', version: 2, added: ['run.create'], removed: [] }),
    ).toEqual({
      action: 'Role edited',
      entity: 'Release Manager',
      details: '+ run.create',
    });
  });

  it('keeps unknown events visible instead of dropping them', () => {
    expect(summarise('something.new', {})).toEqual({ action: 'something.new', entity: '', details: '' });
  });
});
