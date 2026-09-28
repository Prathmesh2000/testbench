import { randomUUID } from 'node:crypto';
import type { ProjectOverview } from '@tb/contracts';
import { conflict, notFound, type Tx } from '@tb/platform';
import { sql } from 'kysely';

// Projects and their module trees. An organisation runs many projects (one per product or app),
// optionally grouped by product line; everything else in Testbench is scoped to one project.

interface Actor {
  orgId: string;
  userId: string;
}

/** ltree labels allow only [A-Za-z0-9_], so a module's label is its id without hyphens. */
export const moduleLabel = (id: string) => id.replaceAll('-', '');

/**
 * One row per visible project with the numbers people scan a portfolio by. `visible` is null when the
 * caller's org-wide role covers every project.
 */
export async function projectOverview(trx: Tx, visible: string[] | null): Promise<ProjectOverview[]> {
  const { rows } = await sql<{
    id: string;
    key: string;
    name: string;
    group_name: string | null;
    description: string;
    archived: boolean;
    cases: number;
    failing: number;
    active_runs: number;
    passed: number;
    executed: number;
    open_defects: number;
    last_activity: Date | null;
    members: number;
  }>`
    SELECT p.id, p.key, p.name, p.group_name, p.description, p.archived,
           coalesce((SELECT sum(total) FROM repo.module_stats s WHERE s.project_id = p.id), 0)::int AS cases,
           coalesce((SELECT sum(failing) FROM repo.module_stats s WHERE s.project_id = p.id), 0)::int AS failing,
           (SELECT count(*) FROM exec.run r WHERE r.project_id = p.id AND r.status <> 'completed')::int AS active_runs,
           (SELECT count(*) FROM exec.run_item i WHERE i.project_id = p.id AND i.status = 'passed'
              AND i.updated_at > now() - interval '30 days')::int AS passed,
           (SELECT count(*) FROM exec.run_item i WHERE i.project_id = p.id AND i.status <> 'untested'
              AND i.updated_at > now() - interval '30 days')::int AS executed,
           (SELECT count(*) FROM defect.defect d WHERE d.project_id = p.id AND d.status_category <> 'done')::int AS open_defects,
           (SELECT max(i.updated_at) FROM exec.run_item i WHERE i.project_id = p.id) AS last_activity,
           (SELECT count(DISTINCT m.user_id) FROM iam.membership m WHERE m.project_id = p.id)::int AS members
      FROM repo.project p
     WHERE ${visible ? sql`p.id = ANY(${visible})` : sql`true`}
     ORDER BY p.archived, p.group_name NULLS LAST, p.key`.execute(trx);
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    group: r.group_name,
    description: r.description,
    archived: r.archived,
    cases: r.cases,
    failing: r.failing,
    activeRuns: r.active_runs,
    passRate: r.executed ? Math.round((r.passed / r.executed) * 1000) / 10 : null,
    openDefects: r.open_defects,
    lastActivity: r.last_activity?.toISOString() ?? null,
    members: r.members,
  }));
}

export async function createProject(
  trx: Tx,
  actor: Actor,
  body: { key: string; name: string; group: string | null; description: string; copyModulesFrom?: string },
): Promise<{ id: string; key: string }> {
  const project = await trx
    .insertInto('repo.project')
    .values({
      org_id: actor.orgId,
      key: body.key,
      name: body.name,
      group_name: body.group,
      description: body.description,
      created_by: actor.userId,
    })
    .onConflict((oc) => oc.columns(['org_id', 'key']).doNothing())
    .returning(['id', 'key'])
    .executeTakeFirst();
  if (!project) throw conflict(`A project with key ${body.key} already exists.`);
  if (body.copyModulesFrom) await copyModules(trx, actor, body.copyModulesFrom, project.id);
  return project;
}

/** Copies a module tree (structure only), keeping names, nesting and order. */
async function copyModules(trx: Tx, actor: Actor, fromProject: string, toProject: string): Promise<void> {
  const source = await trx
    .selectFrom('repo.module')
    .select(['id', 'parent_id', 'name', 'position'])
    .where('project_id', '=', fromProject)
    .orderBy('path') // parents before children, so each parent's new id exists when its children need it
    .execute();
  if (!source.length) throw notFound('Source project modules');
  const newId = new Map(source.map((m) => [m.id, randomUUID()]));
  const newPath = new Map<string, string>();
  const rows = source.map((m) => {
    const id = newId.get(m.id)!;
    const path = m.parent_id ? `${newPath.get(m.parent_id)}.${moduleLabel(id)}` : moduleLabel(id);
    newPath.set(m.id, path);
    return {
      id,
      org_id: actor.orgId,
      project_id: toProject,
      parent_id: m.parent_id ? newId.get(m.parent_id)! : null,
      name: m.name,
      path,
      position: m.position,
    };
  });
  for (let i = 0; i < rows.length; i += 500)
    await trx
      .insertInto('repo.module')
      .values(rows.slice(i, i + 500))
      .execute();
}

export async function createModule(
  trx: Tx,
  actor: Actor,
  projectId: string,
  name: string,
  parentId: string | null,
): Promise<{ id: string }> {
  const parent = parentId
    ? await trx
        .selectFrom('repo.module')
        .select('path')
        .where('id', '=', parentId)
        .where('project_id', '=', projectId)
        .executeTakeFirst()
    : null;
  if (parentId && !parent) throw notFound('Parent module');
  const id = randomUUID();
  const siblings = await trx
    .selectFrom('repo.module')
    .select((eb) => eb.fn.coalesce(eb.fn.max('position'), eb.lit(-1)).as('max'))
    .where('project_id', '=', projectId)
    .where('parent_id', parentId ? '=' : 'is', parentId)
    .executeTakeFirstOrThrow();
  const created = await trx
    .insertInto('repo.module')
    .values({
      id,
      org_id: actor.orgId,
      project_id: projectId,
      parent_id: parentId,
      name,
      path: parent ? `${parent.path}.${moduleLabel(id)}` : moduleLabel(id),
      position: Number(siblings.max) + 1,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!created) throw conflict(`There is already a module called ${name} here.`);
  return created;
}

export async function renameModule(
  trx: Tx,
  projectId: string,
  moduleId: string,
  name: string,
): Promise<void> {
  const res = await trx
    .updateTable('repo.module')
    .set({ name })
    .where('id', '=', moduleId)
    .where('project_id', '=', projectId)
    .returning('id')
    .executeTakeFirst()
    .catch((err: { code?: string }) => {
      if (err.code === '23505') throw conflict(`There is already a module called ${name} here.`);
      throw err;
    });
  if (!res) throw notFound('Module');
}
