import {
  CASE_CONTENT_FIELDS,
  caseKey,
  runKey,
  type CaseDetail,
  type CaseFilter,
  type CaseGroup,
  type CaseGroupQuery,
  type CaseListQuery,
  type CaseRow,
  type CaseVersion,
  type CreateCaseBody,
  type Page,
  type Result,
  type UpdateCaseBody,
} from '@tb/contracts';
import { badRequest, conflict, notFound, recordEvent, type Tx } from '@tb/platform';
import { sql } from 'kysely';
import { afterCursor, caseFilter, cursorAfter, sortColumn } from './case-query';
import { findCycle } from './dependency-graph';
import { loadModules, modulePaths } from './modules';

interface Actor {
  orgId: string;
  userId: string;
}

/** Base query every case read shares: case + its module + owner. */
function caseRows(trx: Tx) {
  return trx
    .selectFrom('repo.test_case as c')
    .innerJoin('repo.module as m', 'm.id', 'c.module_id')
    .leftJoin('iam.app_user as o', 'o.id', 'c.owner_id')
    .select([
      'c.id',
      'c.key_no',
      'c.title',
      'c.module_id',
      'c.priority',
      'c.type',
      'c.status',
      'c.last_result',
      'c.labels',
      'c.estimate_min',
      'c.automation',
      'c.updated_at',
      'c.created_at',
      'c.current_version',
      'c.custom',
      'm.path as module_path',
      'o.id as owner_id',
      'o.name as owner_name',
      'o.email as owner_email',
    ]);
}
type CaseRecord = Awaited<ReturnType<ReturnType<typeof caseRows>['executeTakeFirstOrThrow']>>;

function toCaseRow(r: CaseRecord, paths: Map<string, string>): CaseRow {
  return {
    id: r.id,
    key: caseKey(r.key_no),
    title: r.title,
    moduleId: r.module_id,
    modulePath: paths.get(r.module_id) ?? '',
    priority: r.priority as CaseRow['priority'],
    type: r.type,
    status: r.status as CaseRow['status'],
    lastResult: r.last_result as Result,
    labels: r.labels,
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name!, email: r.owner_email! } : null,
    estimateMin: r.estimate_min,
    automation: r.automation as CaseRow['automation'],
    updatedAt: r.updated_at.toISOString(),
  };
}

const filterOf = (q: CaseListQuery | CaseGroupQuery): CaseFilter => ({
  moduleId: q.moduleId,
  priority: q.priority,
  status: q.status,
  labels: q.labels,
  ownerId: q.ownerId,
  lastResult: q.lastResult,
  q: q.q,
});

/** One page of cases, keyset-paginated (see case-query.ts for why not OFFSET). */
export async function listCases(trx: Tx, projectId: string, query: CaseListQuery): Promise<Page<CaseRow>> {
  const column = sortColumn(query.sort);
  let q = caseRows(trx)
    .where(caseFilter(projectId, filterOf(query)))
    .orderBy(sql.ref(column), query.dir)
    .orderBy('c.id', query.dir)
    .limit(query.limit + 1);
  if (query.cursor) q = q.where(afterCursor(query, query.cursor));

  const [rows, modules] = await Promise.all([q.execute(), loadModules(trx, projectId)]);
  const paths = modulePaths(modules);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return {
    items: page.map((r) => toCaseRow(r, paths)),
    nextCursor: hasMore ? cursorAfter(query.sort, page[page.length - 1]!) : null,
  };
}

const COUNT_CAP = 10_000;

/** Exact below 10,000; above that the UI shows "10,000+" rather than scanning millions of rows per keystroke. */
export async function countCases(
  trx: Tx,
  projectId: string,
  filter: CaseFilter,
): Promise<{ count: number; capped: boolean }> {
  const { count } = await trx
    .selectFrom((eb) =>
      eb
        .selectFrom('repo.test_case as c')
        .innerJoin('repo.module as m', 'm.id', 'c.module_id')
        .select('c.id')
        .where(caseFilter(projectId, filter))
        .limit(COUNT_CAP + 1)
        .as('capped'),
    )
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();
  return count > COUNT_CAP ? { count: COUNT_CAP, capped: true } : { count, capped: false };
}

/** Group headers for the grid's group-by, with a count per group. */
export async function groupCases(trx: Tx, projectId: string, query: CaseGroupQuery): Promise<CaseGroup[]> {
  const column = {
    priority: 'c.priority',
    status: 'c.status',
    lastResult: 'c.last_result',
    module: 'c.module_id',
  }[query.by];
  const rows = await trx
    .selectFrom('repo.test_case as c')
    .innerJoin('repo.module as m', 'm.id', 'c.module_id')
    .select([sql.ref<string>(column).as('value'), (eb) => eb.fn.countAll<number>().as('count')])
    .where(caseFilter(projectId, filterOf(query)))
    .groupBy(sql.ref(column))
    .orderBy(sql.ref(column))
    .execute();
  const paths = query.by === 'module' ? modulePaths(await loadModules(trx, projectId)) : null;
  return rows.map((r) => ({ value: r.value, label: paths?.get(r.value) ?? r.value, count: r.count }));
}

async function findCase(trx: Tx, projectId: string, keyNo: number, forUpdate = false): Promise<CaseRecord> {
  let q = caseRows(trx).where('c.project_id', '=', projectId).where('c.key_no', '=', keyNo);
  if (forUpdate) q = q.forUpdate('c');
  const row = await q.executeTakeFirst();
  if (!row) throw notFound(`Test case ${caseKey(keyNo)}`);
  return row;
}

function versionRows(trx: Tx, projectId: string, caseId: string) {
  return trx
    .selectFrom('repo.case_version as v')
    .leftJoin('iam.app_user as a', 'a.id', 'v.author_id')
    .select([
      'v.version',
      'v.title',
      'v.preconditions',
      'v.format',
      'v.steps',
      'v.gherkin',
      'v.note',
      'v.created_at',
      'a.id as author_id',
      'a.name as author_name',
      'a.email as author_email',
    ])
    .where('v.project_id', '=', projectId)
    .where('v.case_id', '=', caseId);
}

function toVersion(
  v: Awaited<ReturnType<ReturnType<typeof versionRows>['executeTakeFirstOrThrow']>>,
): CaseVersion {
  return {
    version: v.version,
    title: v.title,
    preconditions: v.preconditions,
    format: v.format as CaseVersion['format'],
    steps: v.steps,
    gherkin: v.gherkin,
    note: v.note,
    author: v.author_id ? { id: v.author_id, name: v.author_name!, email: v.author_email! } : null,
    createdAt: v.created_at.toISOString(),
  };
}

async function readVersion(
  trx: Tx,
  projectId: string,
  caseId: string,
  version: number,
): Promise<CaseVersion> {
  const v = await versionRows(trx, projectId, caseId).where('v.version', '=', version).executeTakeFirst();
  if (!v) throw notFound(`Version ${version}`);
  return toVersion(v);
}

export async function getCase(trx: Tx, projectId: string, keyNo: number): Promise<CaseDetail> {
  const row = await findCase(trx, projectId, keyNo);
  const [modules, version, dependsOn, usedBy, recent] = await Promise.all([
    loadModules(trx, projectId),
    readVersion(trx, projectId, row.id, row.current_version),
    trx
      .selectFrom('repo.case_dependency as d')
      .innerJoin('repo.test_case as p', (j) =>
        j.onRef('p.id', '=', 'd.depends_on_id').onRef('p.project_id', '=', 'd.project_id'),
      )
      .select(['p.key_no', 'p.title', 'p.last_result'])
      .where('d.project_id', '=', projectId)
      .where('d.case_id', '=', row.id)
      .orderBy('p.key_no')
      .execute(),
    trx
      .selectFrom('repo.case_dependency as d')
      .innerJoin('repo.test_case as u', (j) =>
        j.onRef('u.id', '=', 'd.case_id').onRef('u.project_id', '=', 'd.project_id'),
      )
      .select(['u.key_no', 'u.title'])
      .where('d.project_id', '=', projectId)
      .where('d.depends_on_id', '=', row.id)
      .orderBy('u.key_no')
      .limit(50)
      .execute(),
    // ponytail: reads execution tables directly because both modules ship in core-api (HLD §1.1).
    // Replace with an execution API call if execution is ever split into its own deployment.
    trx
      .selectFrom('exec.run_item as i')
      .innerJoin('exec.run as r', 'r.id', 'i.run_id')
      .select(['r.key_no', 'r.name', 'r.build', 'i.config', 'i.status', 'i.updated_at'])
      .where('i.case_id', '=', row.id)
      .where('i.status', '!=', 'untested')
      .orderBy('i.updated_at', 'desc')
      .limit(10)
      .execute(),
  ]);
  return {
    ...toCaseRow(row, modulePaths(modules)),
    preconditions: version.preconditions,
    custom: row.custom,
    currentVersion: row.current_version,
    version,
    dependsOn: dependsOn.map((d) => ({
      key: caseKey(d.key_no),
      title: d.title,
      lastResult: d.last_result as Result,
    })),
    usedBy: usedBy.map((u) => ({ key: caseKey(u.key_no), title: u.title })),
    recentResults: recent.map((r) => ({
      runKey: runKey(r.key_no),
      runName: r.name,
      build: r.build,
      config: r.config,
      status: r.status as Result,
      at: r.updated_at.toISOString(),
    })),
    createdAt: row.created_at.toISOString(),
  };
}

async function assertModuleInProject(trx: Tx, projectId: string, moduleId: string): Promise<void> {
  const found = await trx
    .selectFrom('repo.module')
    .select('id')
    .where('id', '=', moduleId)
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!found) throw badRequest('That module does not belong to this project.');
}

export async function createCase(
  trx: Tx,
  actor: Actor,
  projectId: string,
  body: CreateCaseBody,
): Promise<CaseDetail> {
  await assertModuleInProject(trx, projectId, body.moduleId);
  // Row lock on the project serialises key allocation; two concurrent creates get consecutive keys.
  const { key_no: keyNo } = await trx
    .updateTable('repo.project')
    .set((eb) => ({ next_case_no: eb('next_case_no', '+', 1) }))
    .where('id', '=', projectId)
    .returning(sql<number>`next_case_no - 1`.as('key_no'))
    .executeTakeFirstOrThrow();

  const { id } = await trx
    .insertInto('repo.test_case')
    .values({
      org_id: actor.orgId,
      project_id: projectId,
      key_no: keyNo,
      module_id: body.moduleId,
      title: body.title,
      priority: body.priority,
      type: body.type,
      status: body.status,
      owner_id: body.ownerId,
      labels: body.labels,
      custom: JSON.stringify(body.custom),
      estimate_min: body.estimateMin,
      automation: body.automation,
      current_version: 1,
      created_by: actor.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await trx
    .insertInto('repo.case_version')
    .values({
      project_id: projectId,
      case_id: id,
      version: 1,
      org_id: actor.orgId,
      title: body.title,
      preconditions: body.preconditions,
      format: body.format,
      steps: JSON.stringify(body.steps),
      gherkin: body.gherkin,
      note: 'Created',
      author_id: actor.userId,
    })
    .execute();

  await recordEvent(trx, {
    type: 'testcase.created',
    orgId: actor.orgId,
    projectId,
    actor: actor.userId,
    data: { case_id: id, key: caseKey(keyNo) },
  });
  return getCase(trx, projectId, keyNo);
}

/**
 * Applies an edit. Content changes (title, steps, …) append a new immutable version; metadata changes
 * (status, owner, labels, …) update the case in place. Both land in one transaction with one event.
 */
export async function updateCase(
  trx: Tx,
  actor: Actor,
  projectId: string,
  keyNo: number,
  body: UpdateCaseBody,
): Promise<CaseDetail> {
  const current = await findCase(trx, projectId, keyNo, true);
  const contentChanged = CASE_CONTENT_FIELDS.some((f) => body[f] !== undefined);

  let version = current.current_version;
  if (contentChanged) {
    if (body.baseVersion !== undefined && body.baseVersion !== current.current_version) {
      throw conflict(
        `Someone saved version ${current.current_version} while you were editing version ${body.baseVersion}. Reload to see their changes.`,
      );
    }
    const prev = await readVersion(trx, projectId, current.id, current.current_version);
    version += 1;
    await trx
      .insertInto('repo.case_version')
      .values({
        project_id: projectId,
        case_id: current.id,
        version,
        org_id: actor.orgId,
        title: body.title ?? prev.title,
        preconditions: body.preconditions ?? prev.preconditions,
        format: body.format ?? prev.format,
        steps: JSON.stringify(body.steps ?? prev.steps),
        gherkin: body.gherkin !== undefined ? body.gherkin : prev.gherkin,
        note: body.note ?? '',
        author_id: actor.userId,
      })
      .execute();
  }
  if (body.moduleId) await assertModuleInProject(trx, projectId, body.moduleId);

  await trx
    .updateTable('repo.test_case')
    .set({
      ...(body.title !== undefined && { title: body.title }),
      ...(body.moduleId !== undefined && { module_id: body.moduleId }),
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(body.type !== undefined && { type: body.type }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.ownerId !== undefined && { owner_id: body.ownerId }),
      ...(body.labels !== undefined && { labels: body.labels }),
      ...(body.estimateMin !== undefined && { estimate_min: body.estimateMin }),
      ...(body.automation !== undefined && { automation: body.automation }),
      ...(body.custom !== undefined && { custom: JSON.stringify(body.custom) }),
      current_version: version,
      updated_at: new Date(),
    })
    .where('project_id', '=', projectId)
    .where('id', '=', current.id)
    .execute();

  const { baseVersion: _base, note: _note, ...changed } = body;
  await recordEvent(trx, {
    type: 'testcase.updated',
    orgId: actor.orgId,
    projectId,
    actor: actor.userId,
    data: { case_id: current.id, key: caseKey(keyNo), fields: Object.keys(changed), version },
  });
  return getCase(trx, projectId, keyNo);
}

export async function listVersions(trx: Tx, projectId: string, keyNo: number): Promise<CaseVersion[]> {
  const row = await findCase(trx, projectId, keyNo);
  const rows = await versionRows(trx, projectId, row.id).orderBy('v.version', 'desc').execute();
  return rows.map(toVersion);
}

export async function getVersion(
  trx: Tx,
  projectId: string,
  keyNo: number,
  version: number,
): Promise<CaseVersion> {
  const row = await findCase(trx, projectId, keyNo);
  return readVersion(trx, projectId, row.id, version);
}

/** Replaces a case's prerequisites, refusing any change that would create a dependency cycle. */
export async function setDependencies(
  trx: Tx,
  actor: Actor,
  projectId: string,
  keyNo: number,
  dependsOnKeys: number[],
): Promise<CaseDetail> {
  const row = await findCase(trx, projectId, keyNo, true);
  const targets = dependsOnKeys.length
    ? await trx
        .selectFrom('repo.test_case')
        .select(['id', 'key_no'])
        .where('project_id', '=', projectId)
        .where('key_no', 'in', dependsOnKeys)
        .execute()
    : [];
  const missing = dependsOnKeys.filter((k) => !targets.some((t) => t.key_no === k));
  if (missing.length)
    throw badRequest(`These cases do not exist in this project: ${missing.map(caseKey).join(', ')}`);

  // ponytail: loads the project's whole dependency graph. Fine at thousands of edges; switch to a
  // recursive CTE from the new prerequisites when projects carry hundreds of thousands.
  const edges = new Map<string, string[]>();
  const all = await trx
    .selectFrom('repo.case_dependency')
    .select(['case_id', 'depends_on_id'])
    .where('project_id', '=', projectId)
    .where('case_id', '!=', row.id)
    .execute();
  for (const e of all) edges.set(e.case_id, [...(edges.get(e.case_id) ?? []), e.depends_on_id]);
  const cycle = findCycle(
    edges,
    row.id,
    targets.map((t) => t.id),
  );
  if (cycle) {
    const keyById = new Map(targets.map((t) => [t.id, caseKey(t.key_no)]));
    keyById.set(row.id, caseKey(keyNo));
    throw conflict(
      `That would create a dependency loop (${cycle.map((id) => keyById.get(id) ?? '…').join(' → ')}).`,
    );
  }

  await trx
    .deleteFrom('repo.case_dependency')
    .where('project_id', '=', projectId)
    .where('case_id', '=', row.id)
    .execute();
  if (targets.length) {
    await trx
      .insertInto('repo.case_dependency')
      .values(
        targets.map((t) => ({
          org_id: actor.orgId,
          project_id: projectId,
          case_id: row.id,
          depends_on_id: t.id,
        })),
      )
      .execute();
  }
  return getCase(trx, projectId, keyNo);
}
