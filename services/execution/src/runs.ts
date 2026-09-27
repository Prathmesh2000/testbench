import { randomUUID } from 'node:crypto';
import {
  caseKey,
  runKey,
  type CreateRunBody,
  type Evidence,
  type EvidenceUpload,
  type HomeSummary,
  type RecordResultBody,
  type RecordResultResponse,
  type Result,
  type RunCounts,
  type RunItemDetail,
  type RunItemRow,
  type RunSummary,
  type UserRef,
} from '@tb/contracts';
import { badRequest, conflict, notFound, recordEvent, type ObjectStorage, type Tx } from '@tb/platform';
import { caseFilter, loadModules, modulePaths } from '@tb/repository';
import { sql } from 'kysely';
import { autoBlockChanges, type BlockableItem } from './auto-block';
import { counterDelta, deriveItemStatus, withStepStatus, type CounterField } from './item-status';
import { orderByPrerequisites } from './run-order';

interface Actor {
  orgId: string;
  userId: string;
}

/**
 * ponytail: runs are expanded synchronously inside the request, capped at 5,000 cases. The 800k-case
 * runs in HLD §3.1 need the background expander ("Preparing…" status), planned alongside M2's jobs.
 */
export const MAX_RUN_CASES = 5_000;

const COUNTER_FIELDS: CounterField[] = ['passed', 'failed', 'blocked', 'skipped'];

function countsOf(r: {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
}): RunCounts {
  return {
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    blocked: r.blocked,
    skipped: r.skipped,
    untested: r.total - r.passed - r.failed - r.blocked - r.skipped,
  };
}

function runRows(trx: Tx) {
  return trx
    .selectFrom('exec.run as r')
    .select([
      'r.id',
      'r.key_no',
      'r.name',
      'r.type',
      'r.environment',
      'r.build',
      'r.configs',
      'r.status',
      'r.due_at',
      'r.created_at',
      'r.total',
      'r.passed',
      'r.failed',
      'r.blocked',
      'r.skipped',
    ]);
}
type RunRecord = Awaited<ReturnType<ReturnType<typeof runRows>['executeTakeFirstOrThrow']>>;

async function toSummaries(trx: Tx, runs: RunRecord[]): Promise<RunSummary[]> {
  if (!runs.length) return [];
  const assignees = await trx
    .selectFrom('exec.run_item as i')
    .innerJoin('iam.app_user as u', 'u.id', 'i.assignee_id')
    .select(['i.run_id', 'u.id', 'u.name', 'u.email'])
    .distinct()
    .where('i.run_id', '=', (eb) => eb.fn.any(eb.val(runs.map((r) => r.id))))
    .execute();
  return runs.map((r) => ({
    id: r.id,
    key: runKey(r.key_no),
    name: r.name,
    type: r.type as RunSummary['type'],
    environment: r.environment,
    build: r.build,
    configs: r.configs,
    status: r.status as RunSummary['status'],
    dueAt: r.due_at?.toISOString() ?? null,
    counts: countsOf(r),
    createdAt: r.created_at.toISOString(),
    assignees: assignees.filter((a) => a.run_id === r.id).map(({ id, name, email }) => ({ id, name, email })),
  }));
}

export async function listRuns(
  trx: Tx,
  projectId: string,
  status?: RunSummary['status'],
): Promise<RunSummary[]> {
  let q = runRows(trx).where('r.project_id', '=', projectId).orderBy('r.created_at', 'desc').limit(200);
  if (status) q = q.where('r.status', '=', status);
  return toSummaries(trx, await q.execute());
}

async function findRun(trx: Tx, projectId: string, runId: string, forUpdate = false): Promise<RunRecord> {
  let q = runRows(trx).where('r.project_id', '=', projectId).where('r.id', '=', runId);
  if (forUpdate) q = q.forUpdate();
  const run = await q.executeTakeFirst();
  if (!run) throw notFound('Run');
  return run;
}

export async function getRun(trx: Tx, projectId: string, runId: string): Promise<RunSummary> {
  return (await toSummaries(trx, [await findRun(trx, projectId, runId)]))[0]!;
}

/**
 * Creates a static run: freezes the current version of every matching case, orders cases so
 * prerequisites come first, and creates one item per case per configuration. Assignees are handed
 * cases round-robin, keeping all configurations of one case with the same tester.
 */
export async function createRun(
  trx: Tx,
  actor: Actor,
  projectId: string,
  body: CreateRunBody,
): Promise<RunSummary> {
  const cases = await trx
    .selectFrom('repo.test_case as c')
    .innerJoin('repo.module as m', 'm.id', 'c.module_id')
    .select(['c.id', 'c.current_version'])
    .where(caseFilter(projectId, body.filter))
    .where('c.status', '!=', 'obsolete')
    .orderBy('m.path')
    .orderBy('c.key_no')
    .limit(MAX_RUN_CASES + 1)
    .execute();
  if (cases.length === 0)
    throw badRequest('No cases match this selection. Widen the filter or pick cases in the grid.');
  if (cases.length > MAX_RUN_CASES) {
    throw badRequest(
      `This selection has more than ${MAX_RUN_CASES.toLocaleString('en-IN')} cases. Narrow the filter or split it into several runs.`,
    );
  }
  if (body.assigneeIds.length) {
    const members = await trx
      .selectFrom('iam.membership')
      .select('user_id')
      .distinct()
      .where('user_id', '=', (eb) => eb.fn.any(eb.val(body.assigneeIds)))
      .execute();
    if (members.length !== new Set(body.assigneeIds).size)
      throw badRequest('Every assignee must be a member of this organisation.');
  }

  const deps = await trx
    .selectFrom('repo.case_dependency')
    .select(['case_id', 'depends_on_id'])
    .where('project_id', '=', projectId)
    .where('case_id', '=', (eb) => eb.fn.any(eb.val(cases.map((c) => c.id))))
    .execute();
  const dependsOn = new Map<string, string[]>();
  for (const d of deps) dependsOn.set(d.case_id, [...(dependsOn.get(d.case_id) ?? []), d.depends_on_id]);
  const versionOf = new Map(cases.map((c) => [c.id, c.current_version]));
  const ordered = orderByPrerequisites(
    cases.map((c) => c.id),
    dependsOn,
  );

  const { key_no: keyNo } = await trx
    .updateTable('repo.project')
    .set((eb) => ({ next_run_no: eb('next_run_no', '+', 1) }))
    .where('id', '=', projectId)
    .returning(sql<number>`next_run_no - 1`.as('key_no'))
    .executeTakeFirstOrThrow();
  const configs = [...new Set(body.configs)];
  const { id: runId } = await trx
    .insertInto('exec.run')
    .values({
      org_id: actor.orgId,
      project_id: projectId,
      key_no: keyNo,
      name: body.name,
      type: body.type,
      environment: body.environment,
      build: body.build,
      configs,
      due_at: body.dueAt,
      total: ordered.length * configs.length,
      created_by: actor.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const items = ordered.flatMap((caseId, i) =>
    configs.map((config, c) => ({
      org_id: actor.orgId,
      project_id: projectId,
      run_id: runId,
      case_id: caseId,
      case_version: versionOf.get(caseId)!,
      config,
      position: i * configs.length + c,
      assignee_id: body.assigneeIds.length ? body.assigneeIds[i % body.assigneeIds.length]! : null,
    })),
  );
  for (let i = 0; i < items.length; i += 1_000)
    await trx
      .insertInto('exec.run_item')
      .values(items.slice(i, i + 1_000))
      .execute();

  await recordEvent(trx, {
    type: 'run.created',
    orgId: actor.orgId,
    projectId,
    actor: actor.userId,
    data: { run_id: runId, key: runKey(keyNo), items: items.length },
  });
  return getRun(trx, projectId, runId);
}

function itemRows(trx: Tx) {
  return trx
    .selectFrom('exec.run_item as i')
    .innerJoin('repo.test_case as c', (j) =>
      j.onRef('c.id', '=', 'i.case_id').onRef('c.project_id', '=', 'i.project_id'),
    )
    .innerJoin('repo.case_version as v', (j) =>
      j
        .onRef('v.project_id', '=', 'i.project_id')
        .onRef('v.case_id', '=', 'i.case_id')
        .onRef('v.version', '=', 'i.case_version'),
    )
    .leftJoin('iam.app_user as a', 'a.id', 'i.assignee_id')
    .select([
      'i.id',
      'i.run_id',
      'i.case_id',
      'i.case_version',
      'i.config',
      'i.status',
      'i.position',
      'i.blocked_by',
      'i.blocked_reason',
      'i.step_status',
      'i.duration_s',
      'c.key_no',
      'c.module_id',
      'c.priority',
      'c.status as case_status',
      'c.estimate_min',
      'v.title',
      'v.preconditions',
      'v.steps',
      'a.id as assignee_id',
      'a.name as assignee_name',
      'a.email as assignee_email',
    ]);
}
type ItemRecord = Awaited<ReturnType<ReturnType<typeof itemRows>['executeTakeFirstOrThrow']>>;

const userRef = (id: string | null, name: string | null, email: string | null): UserRef | null =>
  id ? { id, name: name!, email: email! } : null;

function toItemRow(r: ItemRecord, paths: Map<string, string>): RunItemRow {
  return {
    id: r.id,
    caseKey: caseKey(r.key_no),
    title: r.title,
    priority: r.priority as RunItemRow['priority'],
    modulePath: paths.get(r.module_id) ?? '',
    config: r.config,
    status: r.status as Result,
    assignee: userRef(r.assignee_id, r.assignee_name, r.assignee_email),
    blockedReason: r.blocked_reason,
    position: r.position,
  };
}

export async function listItems(trx: Tx, projectId: string, runId: string): Promise<RunItemRow[]> {
  await findRun(trx, projectId, runId);
  const [rows, modules] = await Promise.all([
    itemRows(trx).where('i.run_id', '=', runId).orderBy('i.position').execute(),
    loadModules(trx, projectId),
  ]);
  const paths = modulePaths(modules);
  return rows.map((r) => toItemRow(r, paths));
}

async function findItem(trx: Tx, runId: string, itemId: string, forUpdate = false): Promise<ItemRecord> {
  let q = itemRows(trx).where('i.run_id', '=', runId).where('i.id', '=', itemId);
  if (forUpdate) q = q.forUpdate('i');
  const item = await q.executeTakeFirst();
  if (!item) throw notFound('Run item');
  return item;
}

export async function getItem(
  trx: Tx,
  storage: ObjectStorage,
  projectId: string,
  runId: string,
  itemId: string,
): Promise<RunItemDetail> {
  await findRun(trx, projectId, runId);
  const item = await findItem(trx, runId, itemId);
  const [modules, actuals, evidence, previous] = await Promise.all([
    loadModules(trx, projectId),
    // Latest non-empty "actual result" per step, from the append-only log.
    trx
      .selectFrom('exec.step_result')
      .select(['step_index', 'actual'])
      .distinctOn('step_index')
      .where('run_item_id', '=', itemId)
      .orderBy('step_index')
      .orderBy('recorded_at', 'desc')
      .execute(),
    trx
      .selectFrom('exec.evidence')
      .selectAll()
      .where('run_item_id', '=', itemId)
      .orderBy('created_at')
      .execute(),
    trx
      .selectFrom('exec.run_item as p')
      .innerJoin('exec.run as r', 'r.id', 'p.run_id')
      .select(['r.key_no', 'r.name', 'r.build', 'p.config', 'p.status', 'p.updated_at'])
      .where('p.case_id', '=', item.case_id)
      .where('p.id', '!=', itemId)
      .where('p.status', '!=', 'untested')
      .orderBy('p.updated_at', 'desc')
      .limit(5)
      .execute(),
  ]);
  const actualByStep = new Map(actuals.map((a) => [a.step_index, a.actual]));
  return {
    ...toItemRow(item, modulePaths(modules)),
    runId,
    caseId: item.case_id,
    caseVersion: item.case_version,
    preconditions: item.preconditions,
    steps: item.steps,
    stepStatus: item.steps.map((_, i) => (item.step_status[i] as Result | undefined) ?? 'untested'),
    actuals: item.steps.map((_, i) => actualByStep.get(i) ?? null),
    evidence: await Promise.all(
      evidence.map(async (e): Promise<Evidence> => ({
        id: e.id,
        stepIndex: e.step_index,
        fileName: e.file_name,
        contentType: e.content_type,
        sizeBytes: e.size_bytes,
        url: await storage.presignDownload(e.object_key),
      })),
    ),
    previous: previous.map((p) => ({
      runKey: runKey(p.key_no),
      runName: p.name,
      build: p.build,
      config: p.config,
      status: p.status as Result,
      at: p.updated_at.toISOString(),
    })),
    durationS: item.duration_s,
    needsReview: item.case_status === 'needs_review',
  };
}

async function applyCounters(
  trx: Tx,
  runId: string,
  deltas: Partial<Record<CounterField, number>>[],
): Promise<RunCounts> {
  const total: Partial<Record<CounterField, number>> = {};
  for (const d of deltas) for (const f of COUNTER_FIELDS) if (d[f]) total[f] = (total[f] ?? 0) + d[f];
  // Most step results do not change the item's status (step 1 of 5 passed), so there is often
  // nothing to add; read the counters instead of issuing an UPDATE with an empty SET.
  if (!COUNTER_FIELDS.some((f) => total[f])) {
    const run = await trx
      .selectFrom('exec.run')
      .select(['total', 'passed', 'failed', 'blocked', 'skipped'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    return countsOf(run);
  }
  const run = await trx
    .updateTable('exec.run')
    .set((eb) =>
      Object.fromEntries(COUNTER_FIELDS.filter((f) => total[f]).map((f) => [f, eb(f, '+', total[f]!)])),
    )
    .where('id', '=', runId)
    .returning(['total', 'passed', 'failed', 'blocked', 'skipped'])
    .executeTakeFirstOrThrow();
  return countsOf(run);
}

/**
 * Records one step result and everything that follows from it, atomically: the item's derived status,
 * the run's counters, the case's last result, and any dependents auto-blocked or released.
 */
export async function recordResult(
  trx: Tx,
  storage: ObjectStorage,
  actor: Actor,
  projectId: string,
  runId: string,
  itemId: string,
  body: RecordResultBody,
): Promise<RecordResultResponse> {
  const run = await findRun(trx, projectId, runId, true);
  if (run.status === 'completed') throw conflict('This run is completed. Results can no longer be changed.');
  const item = await findItem(trx, runId, itemId, true);
  if (body.stepIndex >= item.steps.length)
    throw badRequest(`This case has ${item.steps.length} steps; step ${body.stepIndex + 1} does not exist.`);

  await trx
    .insertInto('exec.step_result')
    .values({
      org_id: actor.orgId,
      run_item_id: itemId,
      step_index: body.stepIndex,
      status: body.status,
      actual: body.actual ?? null,
      recorded_by: actor.userId,
    })
    .execute();

  const before = item.status as Result;
  const stepStatus = withStepStatus(
    item.step_status as Result[],
    body.stepIndex,
    body.status,
    item.steps.length,
  );
  const after = deriveItemStatus(stepStatus, item.steps.length);
  // A tester's own result replaces an automatic block; a block recorded on a step keeps the tester's words as the reason.
  const blockedReason =
    after === 'blocked' ? (body.status === 'blocked' ? (body.actual ?? null) : item.blocked_reason) : null;
  await trx
    .updateTable('exec.run_item')
    .set({
      step_status: JSON.stringify(stepStatus),
      status: after,
      blocked_by: after === 'blocked' && body.status !== 'blocked' ? item.blocked_by : null,
      blocked_reason: blockedReason,
      duration_s: item.duration_s + body.elapsedS,
      updated_at: new Date(),
    })
    .where('id', '=', itemId)
    .execute();

  const deltas = [counterDelta(before, after)];
  const affected: RecordResultResponse['affected'] = [];
  if (before !== after) {
    if (after !== 'untested') {
      await trx
        .updateTable('repo.test_case')
        .set({ last_result: after, last_run_at: new Date() })
        .where('project_id', '=', projectId)
        .where('id', '=', item.case_id)
        .execute();
    }
    const wasBlocking = before === 'failed' || before === 'blocked';
    const isBlocking = after === 'failed' || after === 'blocked';
    if (wasBlocking !== isBlocking) {
      for (const change of await dependencyChanges(trx, projectId, runId, { ...item, status: after })) {
        const previous = change.previous;
        await trx
          .updateTable('exec.run_item')
          .set({
            status: change.status,
            blocked_by: change.blockedBy,
            blocked_reason: change.blockedReason,
            updated_at: new Date(),
          })
          .where('id', '=', change.id)
          .execute();
        deltas.push(counterDelta(previous, change.status));
        affected.push({ id: change.id, status: change.status, blockedReason: change.blockedReason });
      }
    }
  }
  const counts = await applyCounters(trx, runId, deltas);

  await recordEvent(trx, {
    type: 'result.recorded',
    orgId: actor.orgId,
    projectId,
    actor: actor.userId,
    data: {
      run_id: runId,
      item_id: itemId,
      step_index: body.stepIndex,
      status: body.status,
      item_status: after,
    },
  });
  return { item: await getItem(trx, storage, projectId, runId, itemId), counts, affected };
}

/** Loads the run's items in the changed item's configuration and works out which ones to block or release. */
async function dependencyChanges(
  trx: Tx,
  projectId: string,
  runId: string,
  changed: ItemRecord & { status: Result },
) {
  const items = await trx
    .selectFrom('exec.run_item as i')
    .innerJoin('repo.test_case as c', (j) =>
      j.onRef('c.id', '=', 'i.case_id').onRef('c.project_id', '=', 'i.project_id'),
    )
    .select(['i.id', 'i.case_id', 'i.config', 'i.status', 'i.blocked_by', 'c.key_no'])
    .where('i.run_id', '=', runId)
    .where('i.config', '=', changed.config)
    .forUpdate('i')
    .execute();
  const edges = await trx
    .selectFrom('repo.case_dependency')
    .select(['case_id', 'depends_on_id'])
    .where('project_id', '=', projectId)
    .where('depends_on_id', '=', (eb) => eb.fn.any(eb.val(items.map((i) => i.case_id))))
    .execute();
  const dependents = new Map<string, string[]>();
  for (const e of edges)
    dependents.set(e.depends_on_id, [...(dependents.get(e.depends_on_id) ?? []), e.case_id]);

  const toBlockable = (i: (typeof items)[number]): BlockableItem => ({
    id: i.id,
    caseId: i.case_id,
    caseKey: caseKey(i.key_no),
    config: i.config,
    status: i.status as Result,
    blockedBy: i.blocked_by,
  });
  const statusById = new Map(items.map((i) => [i.id, i.status as Result]));
  const root: BlockableItem = {
    id: changed.id,
    caseId: changed.case_id,
    caseKey: caseKey(changed.key_no),
    config: changed.config,
    status: changed.status,
    blockedBy: null,
  };
  return autoBlockChanges(root, items.map(toBlockable), dependents).map((c) => ({
    ...c,
    previous: statusById.get(c.id)!,
  }));
}

/** Only files a browser can show inline, with the name reduced to safe characters for the object key. */
export async function createEvidenceUpload(
  trx: Tx,
  storage: ObjectStorage,
  actor: Actor,
  projectId: string,
  runId: string,
  itemId: string,
  body: { stepIndex: number; fileName: string; contentType: string; sizeBytes: number },
): Promise<EvidenceUpload> {
  await findRun(trx, projectId, runId);
  const item = await findItem(trx, runId, itemId);
  if (body.stepIndex >= item.steps.length) throw badRequest('That step does not exist in this case.');
  const safeName = body.fileName.replace(/[^\w.-]+/g, '_').slice(-120);
  const objectKey = `${actor.orgId}/${runId}/${itemId}/${randomUUID()}-${safeName}`;
  const row = await trx
    .insertInto('exec.evidence')
    .values({
      org_id: actor.orgId,
      run_item_id: itemId,
      step_index: body.stepIndex,
      object_key: objectKey,
      file_name: body.fileName,
      content_type: body.contentType,
      size_bytes: body.sizeBytes,
      created_by: actor.userId,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  const [uploadUrl, url] = await Promise.all([
    storage.presignUpload(objectKey, body.contentType, body.sizeBytes),
    storage.presignDownload(objectKey),
  ]);
  return {
    uploadUrl,
    evidence: {
      id: row.id,
      stepIndex: body.stepIndex,
      fileName: body.fileName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      url,
    },
  };
}

/** Everything the Home screen shows for the signed-in tester in one project. */
export async function homeSummary(trx: Tx, userId: string, projectId: string): Promise<HomeSummary> {
  const mine = itemRows(trx)
    .innerJoin('exec.run as r', 'r.id', 'i.run_id')
    .where('i.project_id', '=', projectId)
    .where('i.assignee_id', '=', userId)
    .where('i.status', '=', 'untested')
    .where('r.status', '=', 'active');

  // "Today" is the tester's working day in India, not the UTC day.
  const todayStart = sql<Date>`date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;
  const [queue, totals, today, runs, modules] = await Promise.all([
    mine
      .select(['r.key_no as run_key_no', 'r.name as run_name'])
      .orderBy('r.created_at', 'desc')
      .orderBy('i.position')
      .limit(200)
      .execute(),
    trx
      .selectFrom('exec.run_item as i')
      .innerJoin('exec.run as r', 'r.id', 'i.run_id')
      .innerJoin('repo.test_case as c', (j) =>
        j.onRef('c.id', '=', 'i.case_id').onRef('c.project_id', '=', 'i.project_id'),
      )
      .select((eb) => [
        eb.fn.countAll<number>().as('assigned'),
        eb.fn.coalesce(eb.fn.sum<number>('c.estimate_min'), eb.lit(0)).as('minutes'),
      ])
      .where('i.project_id', '=', projectId)
      .where('i.assignee_id', '=', userId)
      .where('i.status', '=', 'untested')
      .where('r.status', '=', 'active')
      .executeTakeFirstOrThrow(),
    trx
      .selectFrom('exec.run_item as i')
      .select((eb) => [
        eb.fn.countAll<number>().as('executed'),
        eb.fn.countAll<number>().filterWhere('i.status', '=', 'passed').as('passed'),
      ])
      .where('i.project_id', '=', projectId)
      .where('i.status', '!=', 'untested')
      .where('i.id', 'in', (eb) =>
        eb
          .selectFrom('exec.step_result')
          .select('run_item_id')
          .where('recorded_by', '=', userId)
          .where('recorded_at', '>=', todayStart),
      )
      .executeTakeFirstOrThrow(),
    runRows(trx)
      .where('r.project_id', '=', projectId)
      .where('r.status', '=', 'active')
      .orderBy('r.created_at', 'desc')
      .limit(10)
      .execute(),
    loadModules(trx, projectId),
  ]);
  const paths = modulePaths(modules);
  return {
    assigned: totals.assigned,
    assignedMinutes: Number(totals.minutes),
    executedToday: today.executed,
    passedToday: today.passed,
    queue: queue.map((q) => ({
      ...toItemRow(q, paths),
      runId: q.run_id,
      runKey: runKey(q.run_key_no),
      runName: q.run_name,
      estimateMin: q.estimate_min,
    })),
    activeRuns: await toSummaries(trx, runs),
  };
}
