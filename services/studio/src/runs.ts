import type {
  AutoEvidence,
  AutoItemStatus,
  AutoRun,
  AutoRunDetail,
  AutoStepResult,
  StartAutoRunBody,
} from '@tb/contracts';
import { badRequest, notFound, type Database, type ObjectStorage, type Tx } from '@tb/platform';
import type { Insertable } from 'kysely';
import type { z } from 'zod';
import { snapshot } from './code';
import { testCode, testKey } from './tests';

type Caller = { orgId: string; userId: string };
export const runKey = (n: number) => `AR-${n}`;
const STATUSES: AutoItemStatus[] = ['queued', 'running', 'passed', 'failed', 'skipped', 'error', 'cancelled'];

/** Stored evidence entry; the view adds a download link. */
export interface StoredEvidence {
  kind: AutoEvidence['kind'];
  key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Queues an automated run: one item per test and data row, each with its code generated now from the
 * test's current version. Tests that need a person are recorded as skipped instead of silently left out.
 */
export async function startRun(
  trx: Tx,
  caller: Caller,
  projectId: string,
  body: z.infer<typeof StartAutoRunBody>,
): Promise<AutoRun> {
  const tests = body.testIds.length
    ? await trx
        .selectFrom('studio.test')
        .select(['id', 'data_set_id', 'status'])
        .where('project_id', '=', projectId)
        .where('id', 'in', body.testIds)
        .execute()
    : [];
  const missing = body.testIds.filter((id) => !tests.some((t) => t.id === id));
  if (missing.length) throw badRequest(`${missing.length} of the chosen tests are not in this project.`);
  if (tests.some((t) => t.status === 'archived')) throw badRequest('Archived tests cannot be run.');

  // Spec files run inside a frozen copy of the whole workspace, so their imports resolve.
  const workspace = body.specPaths.length ? await snapshot(trx, projectId) : null;
  const specs = [...new Set(body.specPaths)];
  const badSpec = specs.find((p) => !/^tests\/.+\.spec\.ts$/.test(p) || !(p in workspace!));
  if (badSpec) throw badRequest(`${badSpec} is not a spec file in the workspace (tests/name.spec.ts).`);

  await trx.selectFrom('repo.project').select('id').where('id', '=', projectId).forUpdate().executeTakeFirstOrThrow();
  const last = await trx
    .selectFrom('studio.auto_run')
    .select((eb) => eb.fn.max('key_no').as('n'))
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  const run = await trx
    .insertInto('studio.auto_run')
    .values({
      org_id: caller.orgId,
      project_id: projectId,
      key_no: Number(last?.n ?? 0) + 1,
      name: body.name,
      base_url: body.baseUrl.replace(/\/+$/, ''),
      variables: JSON.stringify(body.variables),
      max_parallel: body.maxParallel,
      trigger: body.trigger,
      workspace: workspace ? JSON.stringify(workspace) : null,
      created_by: caller.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const items: Insertable<Database['studio.auto_run_item']>[] = [];
  for (const t of tests) {
    const [{ code, runnable }, version, rows] = await Promise.all([
      testCode(trx, projectId, t.id),
      trx.selectFrom('studio.test').select('current_version').where('id', '=', t.id).executeTakeFirstOrThrow(),
      t.data_set_id
        ? trx.selectFrom('repo.data_set').select('rows').where('id', '=', t.data_set_id).executeTakeFirst()
        : Promise.resolve(null),
    ]);
    const dataRows = (rows?.rows as Record<string, string>[] | undefined) ?? [null];
    dataRows.forEach((data, n) =>
      items.push({
        org_id: caller.orgId,
        run_id: run.id,
        test_id: t.id,
        test_version: version.current_version,
        data_row: data ? n : null,
        data: JSON.stringify(data ?? {}),
        code,
        status: runnable ? 'queued' : 'skipped',
        error: runnable ? null : 'Needs a person for a manual step; run it in Assist mode instead.',
        steps: '[]',
        evidence: '[]',
      }),
    );
  }
  for (const path of specs)
    items.push({
      org_id: caller.orgId,
      run_id: run.id,
      spec_path: path,
      data: '{}',
      code: '',
      steps: '[]',
      evidence: '[]',
    });
  if (!items.length) throw badRequest('None of the chosen tests has anything to run.');
  await trx.insertInto('studio.auto_run_item').values(items).execute();
  return (await listRuns(trx, projectId, run.id))[0]!;
}

/** The newest runs; with `testId`, only the runs that ran that test. */
export async function listRuns(trx: Tx, projectId: string, runId?: string, testId?: string): Promise<AutoRun[]> {
  let q = trx
    .selectFrom('studio.auto_run')
    .selectAll()
    .where('project_id', '=', projectId)
    .orderBy('key_no', 'desc')
    .limit(100);
  if (runId) q = q.where('id', '=', runId);
  if (testId) q = q.where('id', 'in', trx.selectFrom('studio.auto_run_item').select('run_id').where('test_id', '=', testId));
  const runs = await q.execute();
  if (!runs.length) return [];
  const counts = await trx
    .selectFrom('studio.auto_run_item')
    .select(['run_id', 'status', 'flaky'])
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('run_id', 'in', runs.map((r) => r.id))
    .groupBy(['run_id', 'status', 'flaky'])
    .execute();
  return runs.map((r) => {
    const c = Object.fromEntries(STATUSES.map((s) => [s, 0])) as AutoRun['counts'];
    c.total = 0;
    c.flaky = 0;
    for (const row of counts.filter((x) => x.run_id === r.id)) {
      c[row.status as AutoItemStatus] += Number(row.n);
      c.total += Number(row.n);
      if (row.flaky) c.flaky += Number(row.n);
    }
    return {
      id: r.id,
      key: runKey(r.key_no),
      name: r.name,
      status: r.status as AutoRun['status'],
      baseUrl: r.base_url,
      maxParallel: r.max_parallel,
      trigger: r.trigger as AutoRun['trigger'],
      counts: c,
      createdAt: r.created_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
    };
  });
}

export async function getRun(trx: Tx, storage: ObjectStorage, projectId: string, runId: string): Promise<AutoRunDetail> {
  const [run] = await listRuns(trx, projectId, runId);
  if (!run) throw notFound('Run');
  const items = await trx
    .selectFrom('studio.auto_run_item as i')
    .leftJoin('studio.test as t', 't.id', 'i.test_id')
    .select([
      'i.id',
      'i.spec_path',
      'i.test_id',
      'i.test_version',
      'i.data_row',
      'i.status',
      'i.attempt',
      'i.flaky',
      'i.error',
      'i.duration_ms',
      'i.steps',
      'i.evidence',
      't.key_no',
      't.title',
    ])
    .where('i.run_id', '=', runId)
    .orderBy('i.spec_path')
    .orderBy('t.key_no')
    .orderBy('i.data_row')
    .execute();
  return {
    ...run,
    items: await Promise.all(
      items.map(async (i) => ({
        id: i.id,
        testId: i.test_id,
        testKey: i.key_no === null ? null : testKey(i.key_no),
        specPath: i.spec_path,
        title: i.title ?? i.spec_path ?? '',
        testVersion: i.test_version,
        dataRow: i.data_row,
        status: i.status as AutoItemStatus,
        attempt: i.attempt,
        flaky: i.flaky,
        error: i.error,
        durationMs: i.duration_ms,
        steps: i.steps as AutoStepResult[],
        evidence: await Promise.all(
          (i.evidence as StoredEvidence[]).map(async (e) => ({
            kind: e.kind,
            fileName: e.fileName,
            contentType: e.contentType,
            sizeBytes: e.sizeBytes,
            url: await storage.presignDownload(e.key),
          })),
        ),
      })),
    ),
  };
}

/** Stops handing out the run's remaining items; tests already running finish and keep their result. */
export async function cancelRun(trx: Tx, projectId: string, runId: string): Promise<void> {
  const run = await trx
    .updateTable('studio.auto_run')
    .set({ status: 'cancelled', finished_at: new Date() })
    .where('id', '=', runId)
    .where('project_id', '=', projectId)
    .where('status', 'in', ['queued', 'running'])
    .returning('id')
    .executeTakeFirst();
  if (!run) throw notFound('Active run');
  await trx
    .updateTable('studio.auto_run_item')
    .set({ status: 'cancelled', updated_at: new Date() })
    .where('run_id', '=', runId)
    .where('status', '=', 'queued')
    .execute();
}
