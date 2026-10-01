import { ApiContainerConfig, ApiRequestDef, ApiWorkflowDef, type ApiAuth, type ApiBody, type ApiSpecDetail, type ApiSpecSummary, type ApiSpecVersion, type ImpactItem, type ImpactView, type SpecDiff, type SpecImportBody, type SpecOperation, type SpecUploadResult } from '@tb/contracts';
import { sql } from 'kysely';
import { badRequest, conflict, notFound, type ObjectStorage, type Tx } from '@tb/platform';
import { loadSpecDoc } from './effective';
import { collectionAuthFor, requestsFromOperations } from './spec-import';
import { generateForOperation } from './testgen';
import { diffSpecs, hashOf, normalise, operationKey, parseSpecText, readSpec, schemeAuth, SpecError } from './spec';
import type { Caller } from './workspaces';
import { references } from './workflows';
import { createNode, reviewNotes, type SecretBox } from './workspaces';

// The spec library (plan §8): many specs per project, each with immutable versions and a diff to the
// version before. The document goes to S3; the operation list stays in Postgres for the catalog.

type SpecRow = { id: string; name: string; source_url: string | null; current_version: number; updated_at: Date };
type VersionRow = {
  version: number;
  format: string;
  title: string;
  api_version: string;
  size_bytes: number;
  operations: unknown[];
  servers: string[];
  diff: Record<string, unknown> | null;
  created_by: string;
  created_at: Date;
};

const summary = (s: SpecRow, v: VersionRow): ApiSpecSummary => ({
  id: s.id,
  name: s.name,
  sourceUrl: s.source_url,
  version: v.version,
  title: v.title,
  apiVersion: v.api_version,
  format: v.format as ApiSpecSummary['format'],
  operationCount: v.operations.length,
  breakingInLatest: (v.diff as SpecDiff | null)?.breaking ?? 0,
  updatedAt: s.updated_at.toISOString(),
});

const versionView = (v: VersionRow): ApiSpecVersion => ({
  version: v.version,
  title: v.title,
  apiVersion: v.api_version,
  format: v.format as ApiSpecVersion['format'],
  sizeBytes: v.size_bytes,
  operationCount: v.operations.length,
  diff: v.diff as SpecDiff | null,
  createdBy: v.created_by,
  createdAt: v.created_at.toISOString(),
});

const VERSION_COLUMNS = ['version', 'format', 'title', 'api_version', 'size_bytes', 'operations', 'servers', 'diff', 'created_by', 'created_at'] as const;

export async function listSpecs(trx: Tx, projectId: string): Promise<ApiSpecSummary[]> {
  const rows = await trx
    .selectFrom('apitest.spec as s')
    .innerJoin('apitest.spec_version as v', (j) => j.onRef('v.spec_id', '=', 's.id').onRef('v.version', '=', 's.current_version'))
    .select(['s.id', 's.name', 's.source_url', 's.current_version', 's.updated_at'])
    .select(VERSION_COLUMNS.map((c) => `v.${c}` as const))
    .where('s.project_id', '=', projectId)
    .orderBy('s.name')
    .execute();
  return rows.map((r) => summary(r, r));
}

async function specIn(trx: Tx, projectId: string, specId: string): Promise<SpecRow> {
  const s = await trx
    .selectFrom('apitest.spec')
    .select(['id', 'name', 'source_url', 'current_version', 'updated_at'])
    .where('id', '=', specId)
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!s) throw notFound('Spec');
  return s;
}

async function versionOf(trx: Tx, specId: string, version: number): Promise<VersionRow> {
  const v = await trx.selectFrom('apitest.spec_version').select(VERSION_COLUMNS).where('spec_id', '=', specId).where('version', '=', version).executeTakeFirst();
  if (!v) throw notFound('Spec version');
  return v;
}

export async function getSpec(trx: Tx, projectId: string, specId: string, version?: number): Promise<ApiSpecDetail> {
  const s = await specIn(trx, projectId, specId);
  const versions = await trx.selectFrom('apitest.spec_version').select(VERSION_COLUMNS).where('spec_id', '=', s.id).orderBy('version', 'desc').execute();
  const current = versions.find((v) => v.version === (version ?? s.current_version));
  if (!current) throw notFound('Spec version');
  return {
    ...summary(s, versions[0]!),
    versions: versions.map(versionView),
    operations: current.operations as SpecOperation[],
    servers: current.servers,
  };
}

/** Parses and checks a document before anything is written, so a bad upload leaves no trace. */
export function parseUpload(content: string) {
  try {
    const doc = parseSpecText(content);
    const read = readSpec(doc);
    const text = normalise(doc);
    return { read, text, hash: hashOf(text) };
  } catch (err) {
    if (err instanceof SpecError) throw badRequest(err.message);
    throw err;
  }
}

type Parsed = ReturnType<typeof parseUpload>;

async function writeVersion(trx: Tx, storage: ObjectStorage, caller: Caller, specId: string, version: number, parsed: Parsed, previous: VersionRow | null) {
  const key = `apitest/${caller.orgId}/${specId}/${version}.json`;
  // ponytail: written before the row, so a failed insert leaves an orphan object. Harmless and rare;
  // a sweep of apitest/ keys without a row would clean them if it ever matters.
  await storage.write(key, Buffer.from(parsed.text), 'application/json');
  await trx
    .insertInto('apitest.spec_version')
    .values({
      spec_id: specId,
      version,
      org_id: caller.orgId,
      format: parsed.read.format,
      title: parsed.read.title,
      api_version: parsed.read.apiVersion,
      hash: parsed.hash,
      storage_key: key,
      size_bytes: Buffer.byteLength(parsed.text),
      operations: JSON.stringify(parsed.read.operations),
      servers: parsed.read.servers,
      diff: previous ? JSON.stringify(diffSpecs(previous.operations as SpecOperation[], parsed.read.operations, previous.version)) : null,
      created_by: caller.userId,
    })
    .execute();
  await trx.updateTable('apitest.spec').set({ current_version: version, updated_at: new Date() }).where('id', '=', specId).execute();
}

/** A new spec, or a new version of the spec with this name. Unchanged content makes no new version. */
export async function uploadSpec(
  trx: Tx,
  storage: ObjectStorage,
  caller: Caller,
  projectId: string,
  body: { name: string; sourceUrl: string | null; parsed: Parsed },
): Promise<SpecUploadResult> {
  const existing = await trx.selectFrom('apitest.spec').select('id').where('project_id', '=', projectId).where('name', '=', body.name).executeTakeFirst();
  if (existing) return addVersion(trx, storage, caller, projectId, existing.id, body.parsed);
  const spec = await trx
    .insertInto('apitest.spec')
    .values({ org_id: caller.orgId, project_id: projectId, name: body.name, source_url: body.sourceUrl, created_by: caller.userId, updated_at: new Date() })
    .returning('id')
    .executeTakeFirstOrThrow();
  await writeVersion(trx, storage, caller, spec.id, 1, body.parsed, null);
  return { spec: (await getSpec(trx, projectId, spec.id)) satisfies ApiSpecSummary, created: true };
}

export async function addVersion(trx: Tx, storage: ObjectStorage, caller: Caller, projectId: string, specId: string, parsed: Parsed): Promise<SpecUploadResult> {
  // Locked so two uploads at once cannot both claim the next version number.
  const s = await trx
    .selectFrom('apitest.spec')
    .select(['id', 'current_version'])
    .where('id', '=', specId)
    .where('project_id', '=', projectId)
    .forUpdate()
    .executeTakeFirst();
  if (!s) throw notFound('Spec');
  const latest = await trx
    .selectFrom('apitest.spec_version')
    .select([...VERSION_COLUMNS, 'hash'])
    .where('spec_id', '=', s.id)
    .where('version', '=', s.current_version)
    .executeTakeFirst();
  if (latest?.hash === parsed.hash) return { spec: await getSpec(trx, projectId, s.id), created: false };
  await writeVersion(trx, storage, caller, s.id, s.current_version + 1, parsed, latest ?? null);
  return { spec: await getSpec(trx, projectId, s.id), created: true };
}

export async function sourceOf(trx: Tx, projectId: string, specId: string): Promise<string | null> {
  return (await specIn(trx, projectId, specId)).source_url;
}

export async function deleteSpec(trx: Tx, projectId: string, specId: string): Promise<void> {
  const s = await specIn(trx, projectId, specId);
  await trx.deleteFrom('apitest.spec').where('id', '=', s.id).execute();
}

/**
 * Makes requests from spec operations: a new or existing collection, one folder per tag (reusing a
 * folder of that name), and {{baseUrl}} set on a new collection from the spec's first server.
 */
export async function importToCollection(
  trx: Tx,
  box: SecretBox,
  caller: Caller,
  projectId: string,
  specId: string,
  body: SpecImportBody,
  storage: ObjectStorage,
): Promise<{ collectionId: string; created: number }> {
  const s = await specIn(trx, projectId, specId);
  const v = await versionOf(trx, s.id, body.version ?? s.current_version);
  const all = v.operations as SpecOperation[];
  const wanted = body.operations.length ? all.filter((o) => body.operations.includes(operationKey(o))) : all;
  if (!wanted.length) throw badRequest('None of those operations are in this version of the spec.');
  if (wanted.length > 2000) throw conflict('Import at most 2,000 operations at a time; pick a subset.');

  const doc = (await loadSpecDoc(trx, storage, projectId, specId, v.version)).doc;
  const schemes = schemeAuth(doc);
  const bodies = new Map<string, ApiBody>();
  for (const o of wanted) {
    try {
      const body = generateForOperation(doc, s.id, o).find((g) => g.kind === 'happy')?.overrides.body;
      if (body) bodies.set(operationKey(o), body);
    } catch {
      // A body that cannot be worked out from the schema stays empty for the tester to fill in.
    }
  }
  let collectionId = body.collectionId;
  let collectionAuth: ApiAuth = collectionAuthFor(wanted, schemes);
  if (collectionId) {
    const c = await trx.selectFrom('apitest.node').select(['kind', 'config']).where('id', '=', collectionId).where('workspace_id', '=', body.workspaceId).executeTakeFirst();
    if (!c || c.kind !== 'collection') throw notFound('Collection');
    collectionAuth = ApiContainerConfig.safeParse(c.config).data?.auth ?? { type: 'none' };
  } else {
    const created = await createNode(trx, box, caller, body.workspaceId, {
      kind: 'collection',
      name: body.collectionName ?? `${v.title} ${v.api_version}`.slice(0, 200),
      config: { auth: collectionAuth, scripts: { pre: '', post: '' }, variables: v.servers[0] ? [{ key: 'baseUrl', value: v.servers[0], secret: false, enabled: true }] : [] },
    });
    collectionId = created.id;
  }

  const folders = new Map(
    (await trx.selectFrom('apitest.node').select(['id', 'name']).where('parent_id', '=', collectionId).where('kind', '=', 'folder').execute()).map((f) => [f.name, f.id]),
  );
  const items = requestsFromOperations(s.id, wanted, v.version, { schemes, bodies, collection: collectionAuth.type === 'inherit' ? { type: 'none' } : collectionAuth });
  for (const item of items) {
    let folderId = folders.get(item.folder);
    if (!folderId) {
      folderId = (await createNode(trx, box, caller, body.workspaceId, { kind: 'folder', name: item.folder, parentId: collectionId })).id;
      folders.set(item.folder, folderId);
    }
    await createNode(trx, box, caller, body.workspaceId, { kind: 'request', name: item.name, parentId: folderId, request: item.request });
  }
  return { collectionId, created: items.length };
}

/** Requests and workflows in the project that a change in this spec touches (plan §8). */
export async function specImpact(trx: Tx, projectId: string, specId: string): Promise<ImpactView> {
  const s = await specIn(trx, projectId, specId);
  const rows = await trx
    .selectFrom('apitest.node as n')
    .innerJoin('apitest.workspace as w', 'w.id', 'n.workspace_id')
    .select(['n.id', 'n.kind', 'n.name', 'n.config', 'n.workspace_id', 'w.name as wsName'])
    .where('w.project_id', '=', projectId)
    .where('n.kind', '=', 'request')
    .where(sql<boolean>`n.config->'operation'->>'specId' = ${specId}`)
    .execute();
  const notes = await reviewNotes(trx, rows);
  const items: ImpactItem[] = rows
    .filter((r) => notes.has(r.id))
    .map((r) => {
      const op = ApiRequestDef.parse(r.config).operation!;
      return { kind: 'request', id: r.id, name: r.name, workspaceId: r.workspace_id, workspaceName: r.wsName, operation: `${op.method} ${op.path}`, changes: notes.get(r.id)!.changes };
    });
  const flagged = new Set(items.map((i) => i.id));
  if (flagged.size) {
    const wfs = await trx
      .selectFrom('apitest.workflow as w')
      .innerJoin('apitest.workflow_version as v', (j) => j.onRef('v.workflow_id', '=', 'w.id').onRef('v.version', '=', 'w.current_version'))
      .innerJoin('apitest.workspace as ws', 'ws.id', 'w.workspace_id')
      .select(['w.id', 'w.name', 'w.workspace_id', 'ws.name as wsName', 'v.def'])
      .where('ws.project_id', '=', projectId)
      .execute();
    for (const w of wfs) {
      const def = ApiWorkflowDef.safeParse(w.def).data;
      const touched = def ? [...references([...def.steps, ...def.teardown]).requests].filter((id) => flagged.has(id)) : [];
      if (touched.length)
        items.push({ kind: 'workflow', id: w.id, name: w.name, workspaceId: w.workspace_id, workspaceName: w.wsName, operation: null, changes: touched.flatMap((id) => notes.get(id)!.changes) });
    }
  }
  return { specId, version: s.current_version, items };
}
