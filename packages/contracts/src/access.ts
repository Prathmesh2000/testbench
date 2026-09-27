// Roles and permissions (HLD §5.1, §5.11). Built-in roles are fixed; organisations add custom roles
// by copying one and changing its permissions.

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
  'role.manage',
  'audit.read',
  'ai.use',
  /** Org-wide AI policy, models and keys: only Org Admins hold it. */
  'ai.configure',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const viewer: Permission[] = ['case.read', 'run.read'];
const tester: Permission[] = [...viewer, 'case.write', 'run.execute', 'ai.use'];
const testLead: Permission[] = [
  ...tester,
  'case.delete',
  'case.review',
  'run.create',
  'run.signoff',
  'audit.read',
];
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

/** Grouped for the roles matrix in the admin console. */
export const PERMISSION_GROUPS: { group: string; items: { permission: Permission; label: string }[] }[] = [
  {
    group: 'Test cases',
    items: [
      { permission: 'case.read', label: 'View cases' },
      { permission: 'case.write', label: 'Create and edit' },
      { permission: 'case.review', label: 'Approve reviews' },
      { permission: 'case.delete', label: 'Delete' },
    ],
  },
  {
    group: 'Runs',
    items: [
      { permission: 'run.read', label: 'View runs and reports' },
      { permission: 'run.create', label: 'Create runs and assign testers' },
      { permission: 'run.execute', label: 'Record results and log bugs' },
      { permission: 'run.signoff', label: 'Release sign-off' },
    ],
  },
  {
    group: 'Admin',
    items: [
      { permission: 'member.manage', label: 'Manage members' },
      { permission: 'project.manage', label: 'Project settings, notifications, integrations' },
      { permission: 'role.manage', label: 'Manage roles' },
      { permission: 'audit.read', label: 'View audit log' },
    ],
  },
  {
    group: 'AI',
    items: [
      { permission: 'ai.use', label: 'Use AI generation' },
      { permission: 'ai.configure', label: 'Configure providers and keys' },
    ],
  },
];

/** Memberships refer to a custom role as "custom:<id>". */
export const CUSTOM_ROLE_PREFIX = 'custom:';
