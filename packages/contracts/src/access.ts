// Roles and permissions (HLD §5.1). Built-in roles only in M1; custom roles arrive with the admin console.

export const ROLES = ['org_admin', 'project_admin', 'test_lead', 'tester', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'case.read',
  'case.write',
  'case.delete',
  'case.review',
  'run.read',
  'run.create',
  'run.execute',
  'run.signoff',
  'member.manage',
  'project.manage',
  'ai.use',
  /** Org-wide AI policy, models and keys: only Org Admins hold it. */
  'ai.configure',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const viewer: Permission[] = ['case.read', 'run.read'];
const tester: Permission[] = [...viewer, 'case.write', 'run.execute', 'ai.use'];
const testLead: Permission[] = [...tester, 'case.delete', 'case.review', 'run.create', 'run.signoff'];
const projectAdmin: Permission[] = [...testLead, 'member.manage', 'project.manage'];

/** Each role is a strict superset of the one below it. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer,
  tester,
  test_lead: testLead,
  project_admin: projectAdmin,
  org_admin: PERMISSIONS,
};

export const ROLE_LABELS: Record<Role, string> = {
  org_admin: 'Org Admin',
  project_admin: 'Project Admin',
  test_lead: 'Test Lead',
  tester: 'Tester',
  viewer: 'Viewer',
};
