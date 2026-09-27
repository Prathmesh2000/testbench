import { caseKey } from '@tb/contracts';
import type { StepJson, Tx } from '@tb/platform';
import type { CaseDocument } from './case-index';

interface ModuleInfo {
  path: string;
  ancestors: string[];
  sort: string;
}

/** Display path, ancestor ids and tree-order key for every module of a project. */
async function projectModules(trx: Tx, projectId: string): Promise<Map<string, ModuleInfo>> {
  const rows = await trx
    .selectFrom('repo.module')
    .select(['id', 'parent_id', 'name', 'path'])
    .where('project_id', '=', projectId)
    .orderBy('path')
    .execute();
  const out = new Map<string, ModuleInfo>();
  // path order puts parents before children, so each parent is resolved when its children arrive.
  for (const r of rows) {
    const parent = r.parent_id ? out.get(r.parent_id) : undefined;
    out.set(r.id, {
      path: parent ? `${parent.path} / ${r.name}` : r.name,
      ancestors: [...(parent?.ancestors ?? []), r.id],
      sort: r.path,
    });
  }
  return out;
}

function baseQuery(trx: Tx, projectId: string) {
  return trx
    .selectFrom('repo.test_case as c')
    .innerJoin('repo.case_version as v', (j) =>
      j
        .onRef('v.project_id', '=', 'c.project_id')
        .onRef('v.case_id', '=', 'c.id')
        .onRef('v.version', '=', 'c.current_version'),
    )
    .leftJoin('iam.app_user as o', 'o.id', 'c.owner_id')
    .select([
      'c.id',
      'c.org_id',
      'c.project_id',
      'c.key_no',
      'c.title',
      'c.module_id',
      'c.priority',
      'c.status',
      'c.last_result',
      'c.automation',
      'c.type',
      'c.labels',
      'c.estimate_min',
      'c.updated_at',
      'c.created_at',
      'c.last_run_at',
      'v.steps',
      'v.preconditions',
      'o.id as owner_id',
      'o.name as owner_name',
      'o.email as owner_email',
    ])
    .where('c.project_id', '=', projectId);
}

function toDocuments(
  rows: Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>,
  modules: Map<string, ModuleInfo>,
): CaseDocument[] {
  return rows.map((r) => {
    const m = modules.get(r.module_id);
    return {
      org_id: r.org_id,
      project_id: r.project_id,
      case_id: r.id,
      key_no: r.key_no,
      key: caseKey(r.key_no),
      title: r.title,
      // Preconditions and every step's text, so "text ~" finds a case by anything written in it.
      steps_text: [r.preconditions, ...(r.steps as StepJson[]).flatMap((s) => [s.action, s.expected, s.data])]
        .filter(Boolean)
        .join('\n'),
      module_id: r.module_id,
      module_ids: m?.ancestors ?? [r.module_id],
      module_path: m?.path ?? '',
      module_sort: m?.sort ?? '',
      priority: r.priority,
      priority_rank: Number(r.priority.slice(1)),
      status: r.status,
      last_result: r.last_result,
      automation: r.automation,
      type: r.type,
      labels: r.labels,
      owner_id: r.owner_id,
      owner_name: r.owner_name,
      owner_email: r.owner_email,
      estimate_min: r.estimate_min,
      updated_at: r.updated_at.toISOString(),
      created_at: r.created_at.toISOString(),
      last_run_at: r.last_run_at?.toISOString() ?? null,
    };
  });
}

/** Documents for specific cases, e.g. the one an event is about. */
export async function documentsFor(trx: Tx, projectId: string, caseIds: string[]): Promise<CaseDocument[]> {
  if (!caseIds.length) return [];
  const [rows, modules] = await Promise.all([
    baseQuery(trx, projectId)
      .where('c.id', '=', (eb) => eb.fn.any(eb.val(caseIds)))
      .execute(),
    projectModules(trx, projectId),
  ]);
  return toDocuments(rows, modules);
}

/** The next `limit` documents after `afterId`, in id order: used by reindexing to walk a whole project. */
export async function documentChunk(
  trx: Tx,
  projectId: string,
  afterId: string | null,
  limit: number,
): Promise<CaseDocument[]> {
  let q = baseQuery(trx, projectId).orderBy('c.id').limit(limit);
  if (afterId) q = q.where('c.id', '>', afterId);
  const [rows, modules] = await Promise.all([q.execute(), projectModules(trx, projectId)]);
  return toDocuments(rows, modules);
}
