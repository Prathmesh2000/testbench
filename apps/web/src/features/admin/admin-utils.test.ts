import type { AuditRow, RoleView } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { auditCsv, changedRoles, copyRoleBody, customRoleId, dateRangeIso, samePermissions, togglePermission } from './admin-utils';

const role = (over: Partial<RoleView>): RoleView => ({
  ref: 'tester', name: 'Tester', builtIn: true, basedOn: null, permissions: ['case.read'], version: 1, holders: 0, ...over,
});

describe('admin-utils', () => {
  it('builds a quoted CSV that neutralises formulas', () => {
    const row: AuditRow = {
      id: '1', at: '2026-09-28T09:00:00Z', actor: null, source: 'web', action: 'Role edited',
      entity: 'Release "RM"', details: '=HYPERLINK("x"), then more', project: null,
    };
    const [header, line] = auditCsv([row]).split('\r\n');
    expect(header).toBe('"Time","Actor","Source","Action","Entity","Details","Project"');
    expect(line).toBe('"2026-09-28T09:00:00Z","System","web","Role edited","Release ""RM""","\'=HYPERLINK(""x""), then more",""');
  });

  it('turns a date range into whole IST days', () => {
    expect(dateRangeIso('2026-09-01', '2026-09-01')).toEqual({ from: '2026-09-01T00:00:00+05:30', to: '2026-09-01T23:59:59+05:30' });
    expect(dateRangeIso('', '')).toEqual({ from: undefined, to: undefined });
  });

  it('toggles permissions in canonical order and compares as sets', () => {
    expect(togglePermission(['run.read'], 'case.read')).toEqual(['case.read', 'run.read']);
    expect(togglePermission(['case.read', 'run.read'], 'case.read')).toEqual(['run.read']);
    expect(samePermissions(['run.read', 'case.read'], ['case.read', 'run.read'])).toBe(true);
    expect(samePermissions(['case.read'], ['case.read', 'run.read'])).toBe(false);
  });

  it('finds custom roles with unsaved changes', () => {
    const custom = role({ ref: 'custom:a', builtIn: false, basedOn: 'tester' });
    const roles = [role({}), custom];
    expect(changedRoles(roles, { 'custom:a': ['case.read'] })).toEqual([]);
    expect(changedRoles(roles, { 'custom:a': ['case.read', 'run.read'], tester: [] })).toEqual([custom]);
  });

  it('copies a custom role onto its own built-in base', () => {
    expect(copyRoleBody(role({ ref: 'test_lead' }), ' QA ').basedOn).toBe('test_lead');
    expect(copyRoleBody(role({ ref: 'custom:a', builtIn: false, basedOn: 'tester' }), 'X')).toEqual({ name: 'X', basedOn: 'tester', permissions: ['case.read'] });
    expect(customRoleId('custom:0f0e')).toBe('0f0e');
  });
});
