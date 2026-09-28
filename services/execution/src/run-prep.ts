import { runKey, type CaseFilter, type CreateRunBody } from '@tb/contracts';
import { badRequest, recordEvent, withTenant, type Db, type Tx } from '@tb/platform';
import { caseFilter } from '@tb/repository';
import { sql } from 'kysely';
import { expandItems, loadRows } from './data-rows';

// Background expansion for runs too big to create inside one request (HLD §3.1). The run is created
// straight away in "preparing" state; a worker then writes its items chunk by chunk, so testers can
// start on the first items while the rest are still being written.

export const PREP_CHUNK = 5_000;
/** Upper bound for one run. A million cases × configurations is already far beyond a sensible run. */
export const MAX_PREPARED_CASES = 1_000_000;

interface Actor {
  orgId: string;
  userId: string;
}

/** Creates the run shell and its preparation job; returns the run id. */
export async function createPreparedRun(
  trx: Tx,
  actor: Actor,
  projectId: string,
  body: CreateRunBody,
): Promise<string> {
  const { count } = await trx
    .selectFrom('repo.test_case as c')
    .innerJoin('repo.module as m', 'm.id', 'c.module_id')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where(caseFilter(projectId, body.filter))
    .where('c.status', '!=', 'obsolete')
    .executeTakeFirstOrThrow();
  if (count > MAX_PREPARED_CASES) {
    throw badRequest(
      `A run can hold up to ${MAX_PREPARED_CASES.toLocaleString('en-IN')} cases; this selection has ${count.toLocaleString('en-IN')}.`,
    );
  }
  const configs = [...new Set(body.configs)];
  const { key_no: keyNo } = await trx
    .updateTable('repo.project')
    .set((eb) => ({ next_run_no: eb('next_run_no', '+', 1) }))
    .where('id', '=', projectId)
    .returning(sql<number>`next_run_no - 1`.as('key_no'))
    .executeTakeFirstOrThrow();
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
      status: 'preparing',
      total: count * configs.length,
      created_by: actor.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('exec.run_prep')
    .values({
      run_id: runId,
      org_id: actor.orgId,
      project_id: projectId,
      filter: JSON.stringify(body.filter),
      assignees: body.assigneeIds,
      created_by: actor.userId,
    })
    .execute();
  await recordEvent(trx, {
    type: 'run.created',
    orgId: actor.orgId,
    projectId,
    actor: actor.userId,
    data: { run_id: runId, key: runKey(keyNo), items: count * configs.length, prepared: true },
  });
  return runId;
}

/**
 * Writes the next chunk of a run's items, walking cases in (module path, key) order from the job's
 * cursor. Items and cursor commit together, so a crash resumes at the next chunk and never duplicates
 * items (the unique (run, case, config) constraint would stop it anyway). Returns true when finished.
 *
 * ponytail: prerequisites are ordered within the synchronous path only; a prepared run keeps tree
 * order across chunks. Cross-chunk ordering needs a global topological pass over the dependency graph.
 */
export async function prepChunk(trx: Tx, runId: string): Promise<boolean> {
  const job = await trx
    .selectFrom('exec.run_prep')
    .selectAll()
    .where('run_id', '=', runId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const run = await trx
    .selectFrom('exec.run')
    .select(['configs', 'project_id', 'key_no'])
    .where('id', '=', runId)
    .executeTakeFirstOrThrow();

  let q = trx
    .selectFrom('repo.test_case as c')
    .innerJoin('repo.module as m', 'm.id', 'c.module_id')
    .select(['c.id', 'c.current_version', 'c.key_no', 'c.data_set_id', sql<string>`m.path::text`.as('path')])
    .where(caseFilter(job.project_id, job.filter as CaseFilter))
    .where('c.status', '!=', 'obsolete')
    .orderBy('m.path')
    .orderBy('c.key_no')
    .limit(PREP_CHUNK);
  if (job.cursor_path !== null && job.cursor_key !== null) {
    q = q.where(sql<boolean>`(m.path, c.key_no) > (CAST(${job.cursor_path} AS ltree), ${job.cursor_key})`);
  }
  const cases = await q.execute();

  const toRun = cases.map((c) => ({ id: c.id, version: c.current_version, dataSetId: c.data_set_id }));
  const items = expandItems(toRun, run.configs, await loadRows(trx, toRun)).map((e) => {
    const n = job.cases_done + e.caseIndex;
    return {
      org_id: job.org_id,
      project_id: job.project_id,
      run_id: runId,
      case_id: e.caseId,
      case_version: e.version,
      config: e.config,
      // Rows of one case share a position; lists order by (position, data_row).
      position: n * run.configs.length + e.configIndex,
      assignee_id: job.assignees.length ? job.assignees[n % job.assignees.length]! : null,
      data_row: e.dataRow,
      data: e.data ? JSON.stringify(e.data) : null,
    };
  });
  for (let i = 0; i < items.length; i += 1_000) {
    await trx
      .insertInto('exec.run_item')
      .values(items.slice(i, i + 1_000))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  const done = cases.length < PREP_CHUNK;
  const last = cases.at(-1);
  await trx
    .updateTable('exec.run_prep')
    .set({
      cases_done: job.cases_done + cases.length,
      cursor_path: last?.path ?? job.cursor_path,
      cursor_key: last?.key_no ?? job.cursor_key,
      updated_at: new Date(),
      ...(done && { status: 'done' }),
    })
    .where('run_id', '=', runId)
    .execute();

  if (done) {
    // Cases can be added or made obsolete while a big run prepares, so the total is recounted from
    // what was actually written rather than trusted from creation time.
    const { total } = await trx
      .selectFrom('exec.run_item')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
    await trx.updateTable('exec.run').set({ status: 'active', total }).where('id', '=', runId).execute();
    await recordEvent(trx, {
      type: 'run.prepared',
      orgId: job.org_id,
      projectId: job.project_id,
      actor: job.created_by,
      data: { run_id: runId, key: runKey(run.key_no), items: total },
    });
  }
  return done;
}

/** Worker loop, one per core-api process, same claim-and-resume pattern as bulk edits. */
export function startRunPrepWorker(
  db: Db,
  log: { error(o: object, m: string): void },
  idleMs = 1_000,
): () => Promise<void> {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const { rows } = await sql<{
          run_id: string;
          org_id: string;
          created_by: string;
        }>`SELECT * FROM exec.claim_run_prep()`.execute(db);
        const job = rows[0];
        if (!job) {
          await new Promise((r) => setTimeout(r, idleMs));
          continue;
        }
        const tenant = { orgId: job.org_id, userId: job.created_by };
        try {
          let done = false;
          while (!done && !stopped) done = await withTenant(db, tenant, (trx) => prepChunk(trx, job.run_id));
        } catch (err) {
          log.error({ err, runId: job.run_id }, 'run preparation failed');
          await withTenant(db, tenant, (trx) =>
            trx
              .updateTable('exec.run_prep')
              .set({
                status: 'failed',
                error: 'Preparing the run stopped part-way. The items created so far can be executed.',
                updated_at: new Date(),
              })
              .where('run_id', '=', job.run_id)
              .execute(),
          );
        }
      } catch (err) {
        log.error({ err }, 'could not claim a run to prepare');
        await new Promise((r) => setTimeout(r, idleMs * 5));
      }
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}
