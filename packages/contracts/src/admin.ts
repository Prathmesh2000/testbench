import { z } from 'zod';
import { PERMISSIONS, ROLES, type Permission } from './access';

// Admin console (HLD §5.11, §8): members, custom roles, personal access tokens and the audit log.

/** A built-in role key, or "custom:<id>". */
const RoleRef = z.union([z.enum(ROLES), z.string().regex(/^custom:[0-9a-f-]{36}$/)]);

export const InviteBody = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  name: z.string().trim().min(1).max(120),
  role: RoleRef,
});

export interface InviteResult {
  userId: string;
  /** Set when the account was created in the local identity provider: shown once, changed at first sign-in. */
  temporaryPassword: string | null;
}

export const MemberRoleBody = z.object({
  role: RoleRef,
  /** Null sets the organisation-wide role. */
  projectId: z.uuid().nullable(),
});

export interface AdminMember {
  user: { id: string; name: string; email: string };
  /** Signed in at least once (invited people have not yet). */
  active: boolean;
  orgRole: { ref: string; label: string } | null;
  projects: { projectId: string; projectKey: string; ref: string; label: string }[];
}

export const RoleBody = z.object({
  name: z.string().trim().min(1).max(60),
  basedOn: z.enum(ROLES),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
});

export interface RoleView {
  ref: string;
  name: string;
  builtIn: boolean;
  basedOn: string | null;
  permissions: Permission[];
  version: number;
  holders: number;
}

export const TokenBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(['read', 'write'])).min(1),
  days: z.number().int().min(1).max(365),
});

export interface TokenView {
  id: string;
  name: string;
  prefix: string;
  scopes: ('read' | 'write')[];
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  revoked: boolean;
}

export interface TokenCreated extends TokenView {
  /** The only time the full token is shown. */
  token: string;
}

export const AUDIT_SOURCES = ['web', 'api', 'mcp', 'slack'] as const;

export const AuditQuery = z.object({
  actorId: z.uuid().optional(),
  source: z.enum(AUDIT_SOURCES).optional(),
  q: z.string().trim().max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export interface AuditRow {
  id: string;
  at: string;
  actor: string | null;
  source: (typeof AUDIT_SOURCES)[number];
  action: string;
  entity: string;
  details: string;
  project: string | null;
}

export interface AuditPage {
  items: AuditRow[];
  next: string | null;
}

export type IntegrationState = 'connected' | 'not_configured' | 'error' | 'local';

export interface Integration {
  id: string;
  name: string;
  detail: string;
  state: IntegrationState;
  lastSync: string | null;
}
