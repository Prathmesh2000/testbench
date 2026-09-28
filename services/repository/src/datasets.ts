import { randomUUID } from 'node:crypto';
import {
  caseKey,
  parseCaseKey,
  runKey,
  type DataFile,
  type DataResults,
  type DataSetBody,
  type DataSetDetail,
  type DataSetSummary,
  type Result,
} from '@tb/contracts';
import { badRequest, conflict, notFound, recordEvent, type ObjectStorage, type Tx } from '@tb/platform';
import { sql } from 'kysely';

// Test data sets (data-driven testing): the project's library of data tables and files, which cases
// link to. A linked case runs once per row; see execution's data-rows.ts.

interface Actor {
  orgId: string;
  userId: string;
}

/** Rows keep only the declared columns, so a renamed or removed column can't leave stray values behind. */
export function normaliseRows(
  columns: readonly string[],
  rows: readonly Record<string, string>[],
): Record<string, string>[] {
  return rows
    .map((r) => Object.fromEntries(columns.map((c) => [c, (r[c] ?? '').trim()])))
    .filter((r) => Object.values(r).some((v) => v !== ''));
}

const summaryQuery = (trx: Tx, projectId: string) =>
  trx
    .selectFrom('repo.data_set as d')
    .innerJoin('iam.app_user as u', 'u.id', 'd.updated_by')
    .select((eb) => [
      'd.id',
      'd.name',
      'd.description',
      'd.columns',
      'd.version',
      'd.updated_at',
      'u.name as updated_by',
      sql<number>`jsonb_array_length(d.rows)`.as('row_count'),
      eb
        .selectFrom('repo.test_case as c')
        .select(eb.fn.countAll<number>().as('n'))
        .where('c.project_id', '=', projectId)
        .whereRef('c.data_set_id', '=', 'd.id')
        .as('case_count'),
      eb
        .selectFrom('repo.data_file as f')
        .select(eb.fn.countAll<number>().as('n'))
        .whereRef('f.data_set_id', '=', 'd.id')
        .as('file_count'),
    ])
    .where('d.project_id', '=', projectId);

type SummaryRow = Awaited<ReturnType<ReturnType<typeof summaryQuery>['executeTakeFirstOrThrow']>>;
const toSummary = (d: SummaryRow): DataSetSummary => ({
  id: d.id,
  name: d.name,
  description: d.description,
  columns: d.columns,
  rowCount: d.row_count,
  caseCount: Number(d.case_count ?? 0),
  fileCount: Number(d.file_count ?? 0),
  version: d.version,
  updatedBy: d.updated_by,
  updatedAt: d.updated_at.toISOString(),
});

export async function listDataSets(trx: Tx, projectId: string): Promise<DataSetSummary[]> {
  return (await summaryQuery(trx, projectId).orderBy('d.name').execute()).map(toSummary);
}

export async function getDataSet(
  trx: Tx,
  storage: ObjectStorage,
  projectId: string,
  id: string,
): Promise<DataSetDetail> {
  const d = await summaryQuery(trx, projectId).where('d.id', '=', id).executeTakeFirst();
  if (!d) throw notFound('Data set');
  const [rows, files, cases] = await Promise.all([
    trx.selectFrom('repo.data_set').select('rows').where('id', '=', id).executeTakeFirstOrThrow(),
    trx
      .selectFrom('repo.data_file as f')
      .innerJoin('iam.app_user as u', 'u.id', 'f.uploaded_by')
      .select([
        'f.id',
        'f.object_key',
        'f.file_name',
        'f.content_type',
        'f.size_bytes',
        'f.created_at',
        'u.name',
      ])
      .where('f.data_set_id', '=', id)
      .orderBy('f.created_at')
      .execute(),
    trx
      .selectFrom('repo.test_case')
      .select(['key_no', 'title'])
      .where('project_id', '=', projectId)
      .where('data_set_id', '=', id)
      .orderBy('key_no')
      .limit(200)
      .execute(),
  ]);
  return {
    ...toSummary(d),
    rows: rows.rows,
    files: await Promise.all(
      files.map(async (f): Promise<DataFile> => ({
        id: f.id,
        fileName: f.file_name,
        contentType: f.content_type,
        sizeBytes: f.size_bytes,
        url: await storage.presignDownload(f.object_key),
        uploadedBy: f.name,
        createdAt: f.created_at.toISOString(),
      })),
    ),
    cases: cases.map((c) => ({ key: caseKey(c.key_no), title: c.title })),
  };
}

export async function saveDataSet(
  trx: Tx,
  actor: Actor,
  projectId: string,
  id: string | null,
  body: DataSetBody,
): Promise<{ id: string }> {
  const rows = JSON.stringify(normaliseRows(body.columns, body.rows));
  if (!id) {
    const created = await trx
      .insertInto('repo.data_set')
      .values({
        org_id: actor.orgId,
        project_id: projectId,
        name: body.name,
        description: body.description,
        columns: body.columns,
        rows,
        updated_by: actor.userId,
      })
      .onConflict((oc) => oc.columns(['project_id', 'name']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!created) throw conflict(`A data set called ${body.name} already exists.`);
    return created;
  }
  const updated = await trx
    .updateTable('repo.data_set')
    .set((eb) => ({
      name: body.name,
      description: body.description,
      columns: body.columns,
      rows,
      version: eb('version', '+', 1),
      updated_by: actor.userId,
      updated_at: new Date(),
    }))
    .where('id', '=', id)
    .where('project_id', '=', projectId)
    .returning('id')
    .executeTakeFirst()
    .catch((err: { code?: string }) => {
      if (err.code === '23505') throw conflict(`A data set called ${body.name} already exists.`);
      throw err;
    });
  if (!updated) throw notFound('Data set');
  return updated;
}

export async function deleteDataSet(trx: Tx, projectId: string, id: string): Promise<void> {
  const used = await trx
    .selectFrom('repo.test_case')
    .select('key_no')
    .where('project_id', '=', projectId)
    .where('data_set_id', '=', id)
    .limit(3)
    .execute();
  if (used.length)
    throw conflict(
      `Cases still use this data set (${used.map((c) => caseKey(c.key_no)).join(', ')}…). Unlink them first.`,
    );
  const gone = await trx
    .deleteFrom('repo.data_set')
    .where('id', '=', id)
    .where('project_id', '=', projectId)
    .returning('id')
    .executeTakeFirst();
  if (!gone) throw notFound('Data set');
}

export async function addDataFile(
  trx: Tx,
  storage: ObjectStorage,
  actor: Actor,
  projectId: string,
  dataSetId: string,
  body: { fileName: string; contentType: string; sizeBytes: number },
): Promise<{ file: DataFile; uploadUrl: string }> {
  const set = await trx
    .selectFrom('repo.data_set')
    .select('id')
    .where('id', '=', dataSetId)
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!set) throw notFound('Data set');
  const safeName = body.fileName.replace(/[^\w.-]+/g, '_').slice(-120);
  const objectKey = `${actor.orgId}/datasets/${dataSetId}/${randomUUID()}-${safeName}`;
  const row = await trx
    .insertInto('repo.data_file')
    .values({
      org_id: actor.orgId,
      data_set_id: dataSetId,
      object_key: objectKey,
      file_name: body.fileName,
      content_type: body.contentType,
      size_bytes: body.sizeBytes,
      uploaded_by: actor.userId,
    })
    .returning(['id', 'created_at'])
    .executeTakeFirstOrThrow();
  const [uploadUrl, url] = await Promise.all([
    storage.presignUpload(objectKey, body.contentType, body.sizeBytes),
    storage.presignDownload(objectKey),
  ]);
  return {
    uploadUrl,
    file: {
      id: row.id,
      fileName: body.fileName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      url,
      uploadedBy: '',
      createdAt: row.created_at.toISOString(),
    },
  };
}

export async function deleteDataFile(
  trx: Tx,
  projectId: string,
  dataSetId: string,
  fileId: string,
): Promise<void> {
  // ponytail: the S3 object stays until a lifecycle rule sweeps unreferenced keys under datasets/.
  const gone = await trx
    .deleteFrom('repo.data_file')
    .where('id', '=', fileId)
    .where('data_set_id', '=', dataSetId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('repo.data_set')
          .select('id')
          .where('id', '=', dataSetId)
          .where('project_id', '=', projectId),
      ),
    )
    .returning('id')
    .executeTakeFirst();
  if (!gone) throw notFound('File');
}

/** Links a case to a data set (or unlinks with null). Later runs expand it; past runs keep their rows. */
export async function setCaseDataSet(
  trx: Tx,
  actor: Actor,
  projectId: string,
  key: string,
  dataSetId: string | null,
): Promise<void> {
  if (dataSetId) {
    const set = await trx
      .selectFrom('repo.data_set')
      .select('id')
      .where('id', '=', dataSetId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!set) throw badRequest('That data set is not in this project.');
  }
  const c = await trx
    .updateTable('repo.test_case')
    .set({ data_set_id: dataSetId, updated_at: new Date() })
    .where('project_id', '=', projectId)
    .where('key_no', '=', parseCaseKey(key)!)
    .returning(['id', 'key_no'])
    .executeTakeFirst();
  if (!c) throw notFound('Case');
  await recordEvent(trx, {
    type: 'testcase.updated',
    orgId: actor.orgId,
    projectId,
    actor: actor.userId,
    data: { case_id: c.id, key: caseKey(c.key_no), fields: ['dataSet'] },
  });
}

/**
 * Latest result of each data row per configuration, across all runs of the case.
 * ponytail: rows are matched by position, so reordering a data set's rows misattributes older results;
 * key rows by a stable row id if people start reordering sets that already have history.
 */
export async function dataResults(trx: Tx, projectId: string, key: string): Promise<DataResults> {
  const c = await trx
    .selectFrom('repo.test_case as c')
    .leftJoin('repo.data_set as d', 'd.id', 'c.data_set_id')
    .select(['c.id', 'd.id as set_id', 'd.name', 'd.columns', 'd.rows'])
    .where('c.project_id', '=', projectId)
    .where('c.key_no', '=', parseCaseKey(key)!)
    .executeTakeFirst();
  if (!c) throw notFound('Case');
  if (!c.set_id) return { dataSet: null, rows: [] };
  const latest = await sql<{
    data_row: number;
    config: string;
    status: Result;
    key_no: number;
    updated_at: Date;
  }>`
    SELECT DISTINCT ON (i.data_row, i.config) i.data_row, i.config, i.status, r.key_no, i.updated_at
      FROM exec.run_item i JOIN exec.run r ON r.id = i.run_id
     WHERE i.project_id = ${projectId} AND i.case_id = ${c.id} AND i.data_row IS NOT NULL AND i.status <> 'untested'
     ORDER BY i.data_row, i.config, i.updated_at DESC`.execute(trx);
  return {
    dataSet: { id: c.set_id, name: c.name!, columns: c.columns! },
    rows: (c.rows ?? []).map((values, index) => ({
      index,
      values,
      results: latest.rows
        .filter((l) => l.data_row === index)
        .map((l) => ({
          config: l.config,
          status: l.status,
          runKey: runKey(l.key_no),
          at: l.updated_at.toISOString(),
        })),
    })),
  };
}
