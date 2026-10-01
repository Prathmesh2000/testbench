import {
  ApiContainerConfig,
  ApiRequestDef,
  ApiVariationOverrides,
  type ApiEnvironment,
  type ApiNode,
  type ApiNodeDetail,
  type ApiVariable,
  type ApiVariation,
  type ApiWorkspace,
  type CreateNodeBody,
  type EnvironmentBody,
  type UpdateNodeBody,
  type VariationBody,
} from '@tb/contracts';
import { AppError, badRequest, conflict, notFound, type Tx } from '@tb/platform';
import { sql } from 'kysely';
import { changesSince, reviewNote } from './impact';
import { NoSecretKeyError, toStored, toView, type StoredVariable } from './vars';

// Workspaces, the collection/folder/request tree, variations and environments (plan §3, §5).

export type Caller = { orgId: string; userId: string };

/** Encrypts and decrypts secret values; null when API_STUDIO_SECRET is not configured. */
export type SecretBox = { encrypt(plain: string): string; decrypt(cipher: string): string } | null;

const noKey = () =>
  new AppError(503, 'secrets_unavailable', 'Secret variables are not enabled on this server: API_STUDIO_SECRET is not set.');

export function storeVariables(box: SecretBox, incoming: ApiVariable[], existing: StoredVariable[]): StoredVariable[] {
  try {
    return toStored(incoming, existing, box ? (s) => box.encrypt(s) : null);
  } catch (err) {
    if (err instanceof NoSecretKeyError) throw noKey();
    throw err;
  }
}

const isUnique = (err: unknown) => (err as { code?: string }).code === '23505';

// ---------- workspaces ----------

type WorkspaceRow = { id: string; name: string; kind: string; owner_id: string; variables: unknown[]; updated_at: Date };
const workspaceView = (w: WorkspaceRow): ApiWorkspace => ({
  id: w.id,
  name: w.name,
  kind: w.kind as ApiWorkspace['kind'],
  ownerId: w.owner_id,
  variables: toView(w.variables as StoredVariable[]),
  updatedAt: w.updated_at.toISOString(),
});

/** A workspace the caller can see: any team workspace in the project, or their own personal one. */
export async function workspaceFor(trx: Tx, projectId: string, workspaceId: string, userId: string): Promise<WorkspaceRow> {
  const w = await trx
    .selectFrom('apitest.workspace')
    .select(['id', 'name', 'kind', 'owner_id', 'variables', 'updated_at'])
    .where('id', '=', workspaceId)
    .where('project_id', '=', projectId)
    .where((eb) => eb.or([eb('kind', '=', 'team'), eb('owner_id', '=', userId)]))
    .executeTakeFirst();
  if (!w) throw notFound('Workspace');
  return w;
}

export async function listWorkspaces(trx: Tx, projectId: string, userId: string): Promise<ApiWorkspace[]> {
  const rows = await trx
    .selectFrom('apitest.workspace')
    .select(['id', 'name', 'kind', 'owner_id', 'variables', 'updated_at'])
    .where('project_id', '=', projectId)
    .where((eb) => eb.or([eb('kind', '=', 'team'), eb('owner_id', '=', userId)]))
    .orderBy('kind', 'desc')
    .orderBy('name')
    .execute();
  return rows.map(workspaceView);
}

export async function createWorkspace(trx: Tx, caller: Caller, projectId: string, body: { name: string; kind: 'team' | 'personal' }) {
  try {
    const row = await trx
      .insertInto('apitest.workspace')
      .values({ org_id: caller.orgId, project_id: projectId, name: body.name, kind: body.kind, owner_id: caller.userId, updated_at: new Date() })
      .returning(['id', 'name', 'kind', 'owner_id', 'variables', 'updated_at'])
      .executeTakeFirstOrThrow();
    return workspaceView(row);
  } catch (err) {
    if (isUnique(err)) throw conflict(`A workspace called "${body.name}" already exists.`);
    throw err;
  }
}

export async function updateWorkspace(
  trx: Tx,
  box: SecretBox,
  caller: Caller,
  projectId: string,
  workspaceId: string,
  body: { name?: string | undefined; variables?: ApiVariable[] | undefined },
): Promise<ApiWorkspace> {
  const w = await workspaceFor(trx, projectId, workspaceId, caller.userId);
  try {
    const row = await trx
      .updateTable('apitest.workspace')
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.variables ? { variables: JSON.stringify(storeVariables(box, body.variables, w.variables as StoredVariable[])) } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', w.id)
      .returning(['id', 'name', 'kind', 'owner_id', 'variables', 'updated_at'])
      .executeTakeFirstOrThrow();
    return workspaceView(row);
  } catch (err) {
    if (isUnique(err)) throw conflict(`A workspace called "${body.name}" already exists.`);
    throw err;
  }
}

/** Deletes a workspace and everything in it. A personal one only by its owner (enforced by workspaceFor). */
export async function deleteWorkspace(trx: Tx, projectId: string, workspaceId: string, userId: string): Promise<void> {
  const w = await workspaceFor(trx, projectId, workspaceId, userId);
  await trx.deleteFrom('apitest.workspace').where('id', '=', w.id).execute();
}

// ---------- the tree ----------

type NodeRow = {
  id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  position: number;
  config: Record<string, unknown>;
  updated_at: Date;
};

const nodeView = (n: NodeRow, variationCount: number, needsReview: string | null = null): ApiNode => ({
  id: n.id,
  parentId: n.parent_id,
  kind: n.kind as ApiNode['kind'],
  name: n.name,
  position: n.position,
  method: n.kind === 'request' ? ((n.config.method as ApiNode['method']) ?? 'GET') : null,
  variationCount,
  needsReview,
  updatedAt: n.updated_at.toISOString(),
});

/** Container config as the browser sees it: secret values replaced by hasValue. */
function containerView(config: Record<string, unknown>): ApiContainerConfig {
  const parsed = ApiContainerConfig.parse({ auth: config.auth, scripts: config.scripts, variables: [] });
  return { ...parsed, variables: toView((config.variables as StoredVariable[] | undefined) ?? []) };
}

function containerStored(box: SecretBox, incoming: ApiContainerConfig, existing: Record<string, unknown>) {
  return {
    auth: incoming.auth,
    scripts: incoming.scripts,
    variables: storeVariables(box, incoming.variables, (existing.variables as StoredVariable[] | undefined) ?? []),
  };
}

/**
 * Requests whose spec operation changed after the version they were made from or last reviewed
 * against, with one sentence on what changed (plan §8).
 */
export async function reviewNotes(trx: Tx, rows: { id: string; kind: string; config: Record<string, unknown> }[]): Promise<Map<string, { note: string; changes: ReturnType<typeof changesSince> }>> {
  const linked = rows.flatMap((r) => {
    const op = r.kind === 'request' ? ApiRequestDef.safeParse(r.config).data?.operation : null;
    return op ? [{ id: r.id, op }] : [];
  });
  const out = new Map<string, { note: string; changes: ReturnType<typeof changesSince> }>();
  if (!linked.length) return out;
  const versions = await trx.selectFrom('apitest.spec_version').select(['spec_id', 'version', 'diff']).where('spec_id', 'in', [...new Set(linked.map((l) => l.op.specId))]).execute();
  for (const l of linked) {
    const diffs = versions.filter((v) => v.spec_id === l.op.specId).map((v) => ({ version: v.version, diff: v.diff as never }));
    const changes = changesSince(diffs, `${l.op.method} ${l.op.path}`, l.op.version);
    const note = reviewNote(changes);
    if (note) out.set(l.id, { note, changes });
  }
  return out;
}

/** Moves a request onto its spec's current version: the tester has looked at what changed. */
export async function markReviewed(trx: Tx, caller: Caller, workspaceId: string, nodeId: string): Promise<ApiNodeDetail> {
  const n = await nodeIn(trx, workspaceId, nodeId);
  const def = n.kind === 'request' ? ApiRequestDef.parse(n.config) : null;
  if (!def?.operation) throw badRequest('This request was not made from a spec.');
  const spec = await trx.selectFrom('apitest.spec').select('current_version').where('id', '=', def.operation.specId).executeTakeFirst();
  if (!spec) throw badRequest('The spec this request was made from was deleted.');
  await trx
    .updateTable('apitest.node')
    .set({ config: JSON.stringify({ ...def, operation: { ...def.operation, version: spec.current_version } }), updated_by: caller.userId, updated_at: new Date() })
    .where('id', '=', n.id)
    .execute();
  return getNode(trx, workspaceId, n.id);
}

export async function listTree(trx: Tx, workspaceId: string): Promise<ApiNode[]> {
  const rows = await trx
    .selectFrom('apitest.node as n')
    .leftJoin('apitest.variation as v', 'v.request_id', 'n.id')
    .select(['n.id', 'n.parent_id', 'n.kind', 'n.name', 'n.position', 'n.config', 'n.updated_at'])
    .select((eb) => eb.fn.count<string>('v.id').as('variations'))
    .where('n.workspace_id', '=', workspaceId)
    .groupBy('n.id')
    .orderBy('n.position')
    .orderBy('n.name')
    .execute();
  const notes = await reviewNotes(trx, rows);
  return rows.map((r) => nodeView(r, Number(r.variations), notes.get(r.id)?.note ?? null));
}

async function nodeIn(trx: Tx, workspaceId: string, nodeId: string): Promise<NodeRow> {
  const n = await trx
    .selectFrom('apitest.node')
    .select(['id', 'parent_id', 'kind', 'name', 'position', 'config', 'updated_at'])
    .where('id', '=', nodeId)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!n) throw notFound('Item');
  return n;
}

async function variationsOf(trx: Tx, requestId: string): Promise<ApiVariation[]> {
  const rows = await trx
    .selectFrom('apitest.variation')
    .selectAll()
    .where('request_id', '=', requestId)
    .orderBy('position')
    .orderBy('name')
    .execute();
  return rows.map((v) => ({
    id: v.id,
    requestId: v.request_id,
    name: v.name,
    position: v.position,
    overrides: ApiVariationOverrides.parse(v.overrides),
    updatedAt: v.updated_at.toISOString(),
  }));
}

export async function getNode(trx: Tx, workspaceId: string, nodeId: string): Promise<ApiNodeDetail> {
  const n = await nodeIn(trx, workspaceId, nodeId);
  const variations = n.kind === 'request' ? await variationsOf(trx, n.id) : [];
  const note = (await reviewNotes(trx, [n])).get(n.id)?.note ?? null;
  return {
    ...nodeView(n, variations.length, note),
    config: n.kind === 'request' ? null : containerView(n.config),
    request: n.kind === 'request' ? ApiRequestDef.parse(n.config) : null,
    variations,
  };
}

async function nextPosition(trx: Tx, workspaceId: string, parentId: string | null): Promise<number> {
  const row = await trx
    .selectFrom('apitest.node')
    .select((eb) => eb.fn.max('position').as('max'))
    .where('workspace_id', '=', workspaceId)
    .where((eb) => (parentId ? eb('parent_id', '=', parentId) : eb('parent_id', 'is', null)))
    .executeTakeFirst();
  return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
}

async function containerIn(trx: Tx, workspaceId: string, id: string): Promise<NodeRow> {
  const parent = await nodeIn(trx, workspaceId, id);
  if (parent.kind === 'request') throw badRequest('Items go inside a collection or a folder, not inside a request.');
  return parent;
}

export async function createNode(trx: Tx, box: SecretBox, caller: Caller, workspaceId: string, body: CreateNodeBody): Promise<ApiNodeDetail> {
  const parentId = body.kind === 'collection' ? null : body.parentId;
  if (parentId) await containerIn(trx, workspaceId, parentId);
  const config =
    body.kind === 'request'
      ? (body.request ?? ApiRequestDef.parse({ method: 'GET', url: '' }))
      : containerStored(box, body.config ?? ApiContainerConfig.parse({}), {});
  const row = await trx
    .insertInto('apitest.node')
    .values({
      org_id: caller.orgId,
      workspace_id: workspaceId,
      parent_id: parentId,
      kind: body.kind,
      name: body.name,
      position: await nextPosition(trx, workspaceId, parentId),
      config: JSON.stringify(config),
      updated_by: caller.userId,
      updated_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return getNode(trx, workspaceId, row.id);
}

/** Refuses a move that would put a folder inside itself or one of its own subfolders. */
async function assertNotDescendant(trx: Tx, nodeId: string, newParentId: string): Promise<void> {
  const hit = await sql<{ id: string }>`
    WITH RECURSIVE up AS (
      SELECT id, parent_id FROM apitest.node WHERE id = ${newParentId}
      UNION ALL
      SELECT n.id, n.parent_id FROM apitest.node n JOIN up ON n.id = up.parent_id
    )
    SELECT id FROM up WHERE id = ${nodeId} LIMIT 1`.execute(trx);
  if (hit.rows.length) throw badRequest('A folder cannot be moved inside itself.');
}

export async function updateNode(
  trx: Tx,
  box: SecretBox,
  caller: Caller,
  workspaceId: string,
  nodeId: string,
  body: UpdateNodeBody,
): Promise<ApiNodeDetail> {
  const n = await nodeIn(trx, workspaceId, nodeId);
  if (body.request && n.kind !== 'request') throw badRequest('Only a request has request settings.');
  if (body.config && n.kind === 'request') throw badRequest('A request has no folder settings; use its own auth and variables.');
  let parentId = n.parent_id;
  if (body.parentId !== undefined && body.parentId !== n.parent_id) {
    if (n.kind === 'collection') throw badRequest('A collection sits at the top of the workspace and cannot be moved into another.');
    await containerIn(trx, workspaceId, body.parentId);
    await assertNotDescendant(trx, n.id, body.parentId);
    parentId = body.parentId;
  }
  const config = body.request ?? (body.config ? containerStored(box, body.config, n.config) : undefined);
  await trx
    .updateTable('apitest.node')
    .set({
      ...(body.name ? { name: body.name } : {}),
      parent_id: parentId,
      ...(body.position !== undefined ? { position: body.position } : parentId !== n.parent_id ? { position: await nextPosition(trx, workspaceId, parentId) } : {}),
      ...(config ? { config: JSON.stringify(config) } : {}),
      updated_by: caller.userId,
      updated_at: new Date(),
    })
    .where('id', '=', n.id)
    .execute();
  return getNode(trx, workspaceId, n.id);
}

export async function deleteNode(trx: Tx, workspaceId: string, nodeId: string): Promise<void> {
  const n = await nodeIn(trx, workspaceId, nodeId);
  await trx.deleteFrom('apitest.node').where('id', '=', n.id).execute();
}

/** Stored configs from the node up to its collection, for resolving a send. */
export async function ancestry(trx: Tx, workspaceId: string, startId: string): Promise<{ id: string; kind: string; name: string; config: Record<string, unknown> }[]> {
  const rows = await sql<{ id: string; kind: string; name: string; config: Record<string, unknown>; depth: number }>`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, kind, name, config, 0 AS depth FROM apitest.node WHERE id = ${startId} AND workspace_id = ${workspaceId}
      UNION ALL
      SELECT n.id, n.parent_id, n.kind, n.name, n.config, up.depth + 1 FROM apitest.node n JOIN up ON n.id = up.parent_id
    )
    SELECT id, kind, name, config, depth FROM up ORDER BY depth`.execute(trx);
  return rows.rows;
}

// ---------- variations ----------

async function requestIn(trx: Tx, workspaceId: string, requestId: string): Promise<NodeRow> {
  const n = await nodeIn(trx, workspaceId, requestId);
  if (n.kind !== 'request') throw badRequest('Variations belong to a request.');
  return n;
}

export async function createVariation(trx: Tx, caller: Caller, workspaceId: string, requestId: string, body: VariationBody): Promise<ApiVariation[]> {
  await requestIn(trx, workspaceId, requestId);
  const last = await trx
    .selectFrom('apitest.variation')
    .select((eb) => eb.fn.max('position').as('max'))
    .where('request_id', '=', requestId)
    .executeTakeFirst();
  await trx
    .insertInto('apitest.variation')
    .values({
      org_id: caller.orgId,
      request_id: requestId,
      name: body.name,
      position: last?.max === null || last?.max === undefined ? 0 : Number(last.max) + 1,
      overrides: JSON.stringify(body.overrides),
      updated_by: caller.userId,
      updated_at: new Date(),
    })
    .execute();
  return variationsOf(trx, requestId);
}

export async function updateVariation(
  trx: Tx,
  caller: Caller,
  workspaceId: string,
  requestId: string,
  variationId: string,
  body: VariationBody,
): Promise<ApiVariation[]> {
  await requestIn(trx, workspaceId, requestId);
  const done = await trx
    .updateTable('apitest.variation')
    .set({ name: body.name, overrides: JSON.stringify(body.overrides), updated_by: caller.userId, updated_at: new Date() })
    .where('id', '=', variationId)
    .where('request_id', '=', requestId)
    .executeTakeFirst();
  if (!done.numUpdatedRows) throw notFound('Variation');
  return variationsOf(trx, requestId);
}

export async function deleteVariation(trx: Tx, workspaceId: string, requestId: string, variationId: string): Promise<void> {
  await requestIn(trx, workspaceId, requestId);
  await trx.deleteFrom('apitest.variation').where('id', '=', variationId).where('request_id', '=', requestId).execute();
}

export async function variationOverrides(trx: Tx, requestId: string, variationId: string): Promise<ApiVariationOverrides> {
  const v = await trx
    .selectFrom('apitest.variation')
    .select('overrides')
    .where('id', '=', variationId)
    .where('request_id', '=', requestId)
    .executeTakeFirst();
  if (!v) throw notFound('Variation');
  return ApiVariationOverrides.parse(v.overrides);
}

// ---------- environments ----------

type EnvRow = { id: string; name: string; position: number; variables: unknown[]; production: boolean; updated_at: Date };
const envView = (e: EnvRow): ApiEnvironment => ({
  id: e.id,
  name: e.name,
  position: e.position,
  variables: toView(e.variables as StoredVariable[]),
  production: e.production,
  updatedAt: e.updated_at.toISOString(),
});

export async function listEnvironments(trx: Tx, workspaceId: string): Promise<ApiEnvironment[]> {
  const rows = await trx
    .selectFrom('apitest.environment')
    .select(['id', 'name', 'position', 'variables', 'production', 'updated_at'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('position')
    .orderBy('name')
    .execute();
  return rows.map(envView);
}

export async function environmentIn(trx: Tx, workspaceId: string, environmentId: string): Promise<EnvRow> {
  const e = await trx
    .selectFrom('apitest.environment')
    .select(['id', 'name', 'position', 'variables', 'production', 'updated_at'])
    .where('id', '=', environmentId)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!e) throw notFound('Environment');
  return e;
}

export async function createEnvironment(trx: Tx, box: SecretBox, caller: Caller, workspaceId: string, body: EnvironmentBody): Promise<ApiEnvironment> {
  const count = await trx
    .selectFrom('apitest.environment')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  try {
    const row = await trx
      .insertInto('apitest.environment')
      .values({
        org_id: caller.orgId,
        workspace_id: workspaceId,
        name: body.name,
        position: Number(count?.n ?? 0),
        variables: JSON.stringify(storeVariables(box, body.variables, [])),
        production: body.production,
        updated_at: new Date(),
      })
      .returning(['id', 'name', 'position', 'variables', 'production', 'updated_at'])
      .executeTakeFirstOrThrow();
    return envView(row);
  } catch (err) {
    if (isUnique(err)) throw conflict(`An environment called "${body.name}" already exists.`);
    throw err;
  }
}

export async function updateEnvironment(
  trx: Tx,
  box: SecretBox,
  workspaceId: string,
  environmentId: string,
  body: EnvironmentBody,
): Promise<ApiEnvironment> {
  const e = await environmentIn(trx, workspaceId, environmentId);
  try {
    const row = await trx
      .updateTable('apitest.environment')
      .set({ name: body.name, variables: JSON.stringify(storeVariables(box, body.variables, e.variables as StoredVariable[])), production: body.production, updated_at: new Date() })
      .where('id', '=', e.id)
      .returning(['id', 'name', 'position', 'variables', 'production', 'updated_at'])
      .executeTakeFirstOrThrow();
    return envView(row);
  } catch (err) {
    if (isUnique(err)) throw conflict(`An environment called "${body.name}" already exists.`);
    throw err;
  }
}

export async function deleteEnvironment(trx: Tx, workspaceId: string, environmentId: string): Promise<void> {
  const e = await environmentIn(trx, workspaceId, environmentId);
  await trx.deleteFrom('apitest.environment').where('id', '=', e.id).execute();
}
