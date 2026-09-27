import type { Permission } from '@tb/contracts';
import { forbidden, notFound, withTenant, type Db, type Tx } from '@tb/platform';
import type { FastifyRequest } from 'fastify';
import { orgPermissions, permissionsFor } from './permissions';

/**
 * Throws unless the caller's roles grant `permission` on the project.
 * A project the caller has no role on at all answers 404, not 403, so project ids from other teams
 * cannot be probed for existence.
 *
 * Roles alone cannot tell whether a project id belongs to the caller's organisation (an org-wide role
 * matches any id), so route handlers use projectTx, which also checks that.
 */
export function requirePermission(req: FastifyRequest, projectId: string, permission: Permission): void {
  const granted = permissionsFor(req.auth.grants, projectId);
  if (granted.length === 0) throw notFound('Project');
  if (!granted.includes(permission)) throw forbidden();
}

/** Opens the request's tenant transaction (RLS scoped to the caller's organisation). */
export function tenantTx<T>(db: Db, req: FastifyRequest, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return withTenant(db, { orgId: req.auth.orgId, userId: req.auth.userId, source: req.auth.source }, fn);
}

/**
 * The standard entry point for project-scoped routes: checks the permission, opens the tenant
 * transaction, and confirms the project is visible in it (RLS hides other organisations' projects),
 * answering 404 otherwise. Everything in `fn` then runs in that same transaction.
 */
export function projectTx<T>(
  db: Db,
  req: FastifyRequest,
  projectId: string,
  permission: Permission,
  fn: (trx: Tx) => Promise<T>,
): Promise<T> {
  requirePermission(req, projectId, permission);
  return tenantTx(db, req, async (trx) => {
    const project = await trx
      .selectFrom('repo.project')
      .select('id')
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (!project) throw notFound('Project');
    return fn(trx);
  });
}

/**
 * For organisation-level routes (the admin console): the permission must come from an org-wide role,
 * since a project role says nothing about the rest of the organisation.
 */
export function orgTx<T>(
  db: Db,
  req: FastifyRequest,
  permission: Permission,
  fn: (trx: Tx) => Promise<T>,
): Promise<T> {
  if (!orgPermissions(req.auth.grants).includes(permission)) throw forbidden();
  return tenantTx(db, req, fn);
}
