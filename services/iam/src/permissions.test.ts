import { describe, expect, it } from 'vitest';
import { permissionsFor, visibleProjectIds, type Grant } from './permissions';

const PAY = 'pay-project';
const MOB = 'mob-project';

describe('permissionsFor', () => {
  it('gives an org-wide role in every project', () => {
    const grants: Grant[] = [{ projectId: null, role: 'viewer' }];
    expect(permissionsFor(grants, PAY)).toEqual(['case.read', 'run.read']);
    expect(permissionsFor(grants, MOB)).toEqual(['case.read', 'run.read']);
  });

  it('limits a project role to that project', () => {
    const grants: Grant[] = [{ projectId: PAY, role: 'tester' }];
    expect(permissionsFor(grants, PAY)).toContain('run.execute');
    expect(permissionsFor(grants, MOB)).toEqual([]);
  });

  it('unions an org-wide role with a stronger project role', () => {
    const grants: Grant[] = [
      { projectId: null, role: 'viewer' },
      { projectId: PAY, role: 'test_lead' },
    ];
    expect(permissionsFor(grants, PAY)).toEqual(
      expect.arrayContaining(['run.create', 'run.signoff', 'case.review']),
    );
    expect(permissionsFor(grants, MOB)).not.toContain('run.create');
  });

  it('never grants member management below project admin', () => {
    for (const role of ['viewer', 'tester', 'test_lead'] as const) {
      expect(permissionsFor([{ projectId: null, role }], PAY)).not.toContain('member.manage');
    }
    expect(permissionsFor([{ projectId: PAY, role: 'project_admin' }], PAY)).toContain('member.manage');
  });

  it('returns permissions in a stable order regardless of grant order', () => {
    const a = permissionsFor(
      [
        { projectId: null, role: 'tester' },
        { projectId: PAY, role: 'viewer' },
      ],
      PAY,
    );
    const b = permissionsFor(
      [
        { projectId: PAY, role: 'viewer' },
        { projectId: null, role: 'tester' },
      ],
      PAY,
    );
    expect(a).toEqual(b);
  });
});

describe('visibleProjectIds', () => {
  it('is unrestricted when any grant is org-wide', () => {
    expect(
      visibleProjectIds([
        { projectId: PAY, role: 'tester' },
        { projectId: null, role: 'viewer' },
      ]),
    ).toBeNull();
  });

  it('lists each project once', () => {
    expect(
      visibleProjectIds([
        { projectId: PAY, role: 'tester' },
        { projectId: PAY, role: 'viewer' },
        { projectId: MOB, role: 'viewer' },
      ]),
    ).toEqual([PAY, MOB]);
  });
});
