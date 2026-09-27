import type { CaseFilter } from '@tb/contracts';
import type { Consumer, Db, Tx } from '@tb/platform';
import { caseFilter } from '@tb/repository';
import type { CaseIndex } from './case-index';
import { documentChunk, documentsFor } from './documents';

const CHUNK = 1_000;

/**
 * Keeps OpenSearch in step with Postgres by re-reading the cases an event touched and indexing their
 * current state. Re-reading (rather than applying the event's payload) makes out-of-order and repeated
 * delivery harmless: the last write always reflects the database.
 */
export function caseIndexer(index: CaseIndex): Consumer {
  return {
    name: 'search-indexer',
    types: ['testcase.created', 'testcase.updated', 'testcase.bulk_updated', 'result.recorded'],
    async handle(trx, event) {
      const projectId = event.projectId!;
      if (event.type === 'testcase.bulk_updated') {
        await reindexFilter(trx, index, projectId, String(event.data.job_id));
        return;
      }
      const caseId =
        event.type === 'result.recorded'
          ? await caseOfItem(trx, String(event.data.item_id))
          : String(event.data.case_id);
      if (caseId) await index.upsert(await documentsFor(trx, projectId, [caseId]));
    },
  };
}

async function caseOfItem(trx: Tx, itemId: string): Promise<string | null> {
  const row = await trx
    .selectFrom('exec.run_item')
    .select('case_id')
    .where('id', '=', itemId)
    .executeTakeFirst();
  return row?.case_id ?? null;
}

/** Re-indexes every case a finished bulk job matched, in chunks, using the job's own filter. */
async function reindexFilter(trx: Tx, index: CaseIndex, projectId: string, jobId: string): Promise<void> {
  const job = await trx
    .selectFrom('repo.bulk_job')
    .select('filter')
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (!job) return;
  let after: string | null = null;
  for (;;) {
    let q = trx
      .selectFrom('repo.test_case as c')
      .innerJoin('repo.module as m', 'm.id', 'c.module_id')
      .select('c.id')
      .where(caseFilter(projectId, job.filter as CaseFilter))
      .orderBy('c.id')
      .limit(CHUNK);
    if (after) q = q.where('c.id', '>', after);
    const ids = (await q.execute()).map((r) => r.id);
    if (!ids.length) return;
    await index.upsert(await documentsFor(trx, projectId, ids));
    if (ids.length < CHUNK) return;
    after = ids.at(-1)!;
  }
}

/**
 * Rebuilds the whole index into a new physical index and swaps the alias when it is complete, so
 * searches keep working throughout (HLD §3.1). Runs with the owner connection: it reads every tenant.
 */
export async function reindexAll(
  ownerDb: Db,
  index: CaseIndex,
  log: (msg: string) => void = console.log,
): Promise<number> {
  const target = await index.createPhysical();
  const projects = await ownerDb.selectFrom('repo.project').select(['id', 'key']).execute();
  let total = 0;
  for (const project of projects) {
    let after: string | null = null;
    for (;;) {
      const docs = await ownerDb.transaction().execute((trx) => documentChunk(trx, project.id, after, CHUNK));
      if (!docs.length) break;
      await index.upsert(docs, target);
      total += docs.length;
      after = docs.at(-1)!.case_id;
      if (total % 20_000 < CHUNK) log(`indexed ${total.toLocaleString('en-IN')} cases…`);
      if (docs.length < CHUNK) break;
    }
  }
  await index.client.indices.refresh({ index: target });
  await index.swapAlias(target);
  return total;
}
