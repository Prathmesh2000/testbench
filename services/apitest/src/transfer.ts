import { ApiContainerConfig, ApiRequestDef, type ImportBody, type ImportResult } from '@tb/contracts';
import { badRequest, notFound, type Tx } from '@tb/platform';
import { fromCurl } from './curl';
import { fromPostmanCollection, fromPostmanEnvironment, ImportError, toPostmanCollection, type ExportNode, type ImportedItem } from './postman';
import { toView, type StoredVariable } from './vars';
import { createEnvironment, createNode, type Caller, type SecretBox } from './workspaces';

// Moving requests in and out of a workspace (plan §4): Postman and cURL imports, Postman export, and
// duplicating part of the tree.

const MAX_IMPORT_REQUESTS = 2000;

function parseJsonDoc(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw badRequest('That file is not valid JSON. Export it from Postman as JSON.');
  }
}

async function writeItems(trx: Tx, box: SecretBox, caller: Caller, workspaceId: string, parentId: string, items: ImportedItem[]): Promise<void> {
  for (const item of items) {
    if (item.kind === 'folder') {
      const folder = await createNode(trx, box, caller, workspaceId, { kind: 'folder', name: item.name, parentId, config: item.config });
      await writeItems(trx, box, caller, workspaceId, folder.id, item.children ?? []);
    } else await createNode(trx, box, caller, workspaceId, { kind: 'request', name: item.name, parentId, request: item.request });
  }
}

export async function importInto(trx: Tx, box: SecretBox, caller: Caller, workspaceId: string, body: ImportBody): Promise<ImportResult> {
  try {
    if (body.format === 'postman') {
      const c = fromPostmanCollection(parseJsonDoc(body.content));
      if (c.requestCount > MAX_IMPORT_REQUESTS) throw badRequest(`That collection has ${c.requestCount} requests; import up to ${MAX_IMPORT_REQUESTS} at a time.`);
      const root = await createNode(trx, box, caller, workspaceId, { kind: 'collection', name: c.name, config: c.config });
      await writeItems(trx, box, caller, workspaceId, root.id, c.items);
      return { kind: 'collection', id: root.id, name: c.name, requests: c.requestCount, warnings: c.warnings };
    }
    if (body.format === 'postman-environment') {
      const e = fromPostmanEnvironment(parseJsonDoc(body.content));
      const env = await createEnvironment(trx, box, caller, workspaceId, { ...e, production: false });
      return { kind: 'environment', id: env.id, name: env.name, requests: 0, warnings: [] };
    }
    const parent = await trx.selectFrom('apitest.node').select('kind').where('id', '=', body.parentId).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!parent) throw notFound('Folder');
    if (parent.kind === 'request') throw badRequest('Put the request in a collection or a folder.');
    const r = fromCurl(body.content);
    const node = await createNode(trx, box, caller, workspaceId, { kind: 'request', name: r.name, parentId: body.parentId, request: r.request });
    return { kind: 'request', id: node.id, name: r.name, requests: 1, warnings: r.warnings };
  } catch (err) {
    if (err instanceof ImportError) throw badRequest(err.message);
    throw err;
  }
}

type Row = { id: string; parent_id: string | null; kind: string; name: string; position: number; config: Record<string, unknown> };

async function subtree(trx: Tx, workspaceId: string, nodeId: string): Promise<{ root: Row; children: Map<string, Row[]> }> {
  const rows = await trx
    .selectFrom('apitest.node')
    .select(['id', 'parent_id', 'kind', 'name', 'position', 'config'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('position')
    .orderBy('name')
    .execute();
  const root = rows.find((r) => r.id === nodeId);
  if (!root) throw notFound('Item');
  const children = new Map<string, Row[]>();
  for (const r of rows) if (r.parent_id) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r]);
  return { root, children };
}

/** A collection, folder or request as a Postman v2.1 collection. Secret values are left empty. */
export async function exportPostman(trx: Tx, workspaceId: string, nodeId: string): Promise<Record<string, unknown>> {
  const { root, children } = await subtree(trx, workspaceId, nodeId);
  const toNode = (r: Row): ExportNode => ({
    kind: r.kind as ExportNode['kind'],
    name: r.name,
    request: r.kind === 'request' ? ApiRequestDef.parse(r.config) : null,
    config:
      r.kind === 'request'
        ? null
        : { ...ApiContainerConfig.parse({ auth: r.config.auth, scripts: r.config.scripts, variables: [] }), variables: toView((r.config.variables as StoredVariable[] | undefined) ?? []) },
    children: (children.get(r.id) ?? []).map(toNode),
  });
  return toPostmanCollection(toNode(root));
}

/**
 * A copy of a request, folder or collection next to the original, variations included. Stored configs
 * are copied as they are, so secret values stay encrypted and are never decrypted to be copied.
 */
export async function duplicateNode(trx: Tx, caller: Caller, workspaceId: string, nodeId: string): Promise<string> {
  const { root, children } = await subtree(trx, workspaceId, nodeId);
  const copy = async (r: Row, parentId: string | null, name: string, position: number): Promise<string> => {
    const row = await trx
      .insertInto('apitest.node')
      .values({
        org_id: caller.orgId,
        workspace_id: workspaceId,
        parent_id: parentId,
        kind: r.kind,
        name,
        position,
        config: JSON.stringify(r.config),
        updated_by: caller.userId,
        updated_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (r.kind === 'request') {
      const variations = await trx.selectFrom('apitest.variation').select(['name', 'position', 'overrides']).where('request_id', '=', r.id).execute();
      if (variations.length)
        await trx
          .insertInto('apitest.variation')
          .values(variations.map((v) => ({ org_id: caller.orgId, request_id: row.id, name: v.name, position: v.position, overrides: JSON.stringify(v.overrides), updated_by: caller.userId, updated_at: new Date() })))
          .execute();
    }
    for (const c of children.get(r.id) ?? []) await copy(c, row.id, c.name, c.position);
    return row.id;
  };
  return copy(root, root.parent_id, `${root.name} (copy)`.slice(0, 200), root.position + 1);
}
