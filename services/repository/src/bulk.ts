import type { BulkPatch, CaseFilter, JobStatus } from '@tb/contracts';
import { notFound, recordEvent, withTenant, type Db, type Tx } from '@tb/platform';
import { sql } from 'kysely';
import { caseFilter } from './case-query';

/** Cases changed per transaction. Small enough to keep locks short, large enough to finish 10M in reasonable time. */
export const CHUNK_SIZE = 5_000;

export async function createBulkJob(
  trx: Tx,
  actor: { orgId: string; userId: string },
  projectId: string,
  filter: CaseFilter,
  patch: BulkPatch,
): Promise<JobStatus> {
  // Exact count, unlike the capped count the grid uses: the progress bar needs a real denominator.
  const { total } = await trx
    .selectFrom('repo.test_case as c')
    .innerJoin('repo.module as m', 'm.id', 'c.module_id')
    .select((eb) => eb.fn.countAll<number>().as('total'))
    .where(caseFilter(projectId, filter))
    .executeTakeFirstOrThrow();
  const job = await trx
    .insertInto('repo.bulk_job')
    .values({
      org_id: actor.orgId,
      project_id: projectId,
      filter: JSON.stringify(filter),
      patch: JSON.stringify(patch),
      total,
      created_by: actor.userId,
    })
    .returning(['id', 'status', 'total', 'processed', 'error'])
    .executeTakeFirstOrThrow();
  return job as JobStatus;
}

export async function getBulkJob(trx: Tx, projectId: string, jobId: string): Promise<JobStatus> {
  const job = await trx
    .selectFrom('repo.bulk_job')
    .select(['id', 'status', 'total', 'processed', 'error'])
    .where('id', '=', jobId)
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!job) throw notFound('Job');
  return job as JobStatus;
}

/**
 * Applies one chunk of a job: the next CHUNK_SIZE matching cases after the job's cursor, in id order.
 * The case updates and the cursor move commit together, so a crash between chunks loses nothing and
 * a retried chunk never applies twice. Walking by id (not by the filter's sort) also means a patch
 * that changes a filtered field (e.g. status draft → ready) cannot make the job skip or revisit rows.
 * Returns true when the job is finished.
 */
export async function runChunk(trx: Tx, jobId: string): Promise<boolean> {
  const job = await trx
    .selectFrom('repo.bulk_job')
    .selectAll()
    .where('id', '=', jobId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const filter = job.filter as CaseFilter;
  const patch = job.patch as BulkPatch;

  let ids = trx
    .selectFrom('repo.test_case as c')
    .innerJoin('repo.module as m', 'm.id', 'c.module_id')
    .select('c.id')
    .where(caseFilter(job.project_id, filter))
    .orderBy('c.id')
    .limit(CHUNK_SIZE);
  if (job.cursor) ids = ids.where('c.id', '>', job.cursor);
  const chunk = (await ids.execute()).map((r) => r.id);

  if (chunk.length) {
    await trx
      .updateTable('repo.test_case')
      .set((eb) => ({
        ...(patch.status && { status: patch.status }),
        ...(patch.priority && { priority: patch.priority }),
        ...(patch.ownerId !== undefined && { owner_id: patch.ownerId }),
        ...((patch.addLabels || patch.removeLabels) && {
          labels: sql<string[]>`ARRAY(
          SELECT l FROM (SELECT unnest(${eb.ref('labels')} || ${sql.val(patch.addLabels ?? [])}::text[]) AS l
                         EXCEPT SELECT unnest(${sql.val(patch.removeLabels ?? [])}::text[])) s
          ORDER BY l)`,
        }),
        updated_at: new Date(),
      }))
      .where('project_id', '=', job.project_id)
      .where('id', '=', (eb) => eb.fn.any(eb.val(chunk)))
      .execute();
  }

  const done = chunk.length < CHUNK_SIZE;
  await trx
    .updateTable('repo.bulk_job')
    .set({
      processed: job.processed + chunk.length,
      cursor: chunk.at(-1) ?? job.cursor,
      updated_at: new Date(),
      ...(done && { status: 'done', finished_at: new Date() }),
    })
    .where('id', '=', jobId)
    .execute();

  if (done) {
    await recordEvent(trx, {
      type: 'testcase.bulk_updated',
      orgId: job.org_id,
      projectId: job.project_id,
      actor: job.created_by,
      data: { job_id: jobId, processed: job.processed + chunk.length, patch },
    });
  }
  return done;
}

/**
 * Background loop, one per core-api process: claims the oldest pending job and runs it chunk by
 * chunk. Several processes can run it safely; the claim uses SKIP LOCKED.
 */
export function startBulkWorker(
  db: Db,
  log: { error: (obj: object, msg: string) => void },
  idleMs = 1_000,
): () => Promise<void> {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const { rows } = await sql<{
          id: string;
          org_id: string;
          created_by: string;
        }>`SELECT * FROM repo.claim_bulk_job()`.execute(db);
        const job = rows[0];
        if (!job) {
          await new Promise((r) => setTimeout(r, idleMs));
          continue;
        }
        const tenant = { orgId: job.org_id, userId: job.created_by };
        try {
          let done = false;
          while (!done && !stopped) done = await withTenant(db, tenant, (trx) => runChunk(trx, job.id));
        } catch (err) {
          // The failed chunk rolled back, so everything before it is applied and the cursor is accurate.
          // Marking the job failed (instead of retrying forever) surfaces the problem in the status bar.
          log.error({ err, jobId: job.id }, 'bulk job failed');
          await withTenant(db, tenant, (trx) =>
            trx
              .updateTable('repo.bulk_job')
              .set({
                status: 'failed',
                error: 'The update stopped part-way. Cases before the failure were updated.',
                updated_at: new Date(),
              })
              .where('id', '=', job.id)
              .execute(),
          );
        }
      } catch (err) {
        log.error({ err }, 'could not claim a bulk job');
        await new Promise((r) => setTimeout(r, idleMs * 5));
      }
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}
