import { ApiRequestDef, ApiWorkflowDef, type ApiSuggestedWorkflow, type ApiWorkflow, type ApiWorkflowBody, type ApiWorkflowRunStatus, type ApiWorkflowStep, type ApiWorkflowSummary } from '@tb/contracts';
import { badRequest, conflict, notFound, type ObjectStorage, type Tx } from '@tb/platform';
import { projectMap } from './map';
import { importToCollection } from './specs';
import { createVariation, reviewNotes, type Caller, type SecretBox } from './workspaces';

// Workflows (plan §12): requests called in order with values passed between them, stored as immutable
// versions so a run can always say exactly what it ran.

const isUnique = (err: unknown) => (err as { code?: string }).code === '23505';

/** Every request and sub-workflow a definition points at, anywhere in its tree. */
export function references(steps: ApiWorkflowStep[], out = { requests: new Set<string>(), workflows: new Set<string>() }) {
  for (const s of steps) {
    if (s.kind === 'request' || s.kind === 'poll') out.requests.add(s.requestId);
    else if (s.kind === 'workflow') out.workflows.add(s.workflowId);
    else if (s.kind === 'if') references([...s.then, ...s.else], out);
    else if (s.kind === 'loop') references(s.steps, out);
    else if (s.kind === 'parallel') for (const b of s.branches) references(b, out);
  }
  return out;
}

/** Refuses a definition that points at requests or workflows outside this workspace. */
async function checkReferences(trx: Tx, workspaceId: string, def: ApiWorkflowDef, selfId?: string): Promise<void> {
  const refs = references([...def.steps, ...def.teardown]);
  if (refs.requests.size) {
    const found = await trx.selectFrom('apitest.node').select(['id', 'kind']).where('workspace_id', '=', workspaceId).where('id', 'in', [...refs.requests]).execute();
    const requests = new Set(found.filter((n) => n.kind === 'request').map((n) => n.id));
    if ([...refs.requests].some((id) => !requests.has(id))) throw badRequest('A step points at a request that is not in this workspace any more. Pick it again.');
  }
  if (refs.workflows.size) {
    if (selfId && refs.workflows.has(selfId)) throw badRequest('A workflow cannot run itself as a step.');
    const found = await trx.selectFrom('apitest.workflow').select('id').where('workspace_id', '=', workspaceId).where('id', 'in', [...refs.workflows]).execute();
    if (found.length !== refs.workflows.size) throw badRequest('A step runs a workflow that is not in this workspace.');
  }
}

const countSteps = (steps: ApiWorkflowStep[]): number =>
  steps.reduce((n, s) => n + 1 + (s.kind === 'if' ? countSteps(s.then) + countSteps(s.else) : s.kind === 'loop' ? countSteps(s.steps) : s.kind === 'parallel' ? s.branches.reduce((m, b) => m + countSteps(b), 0) : 0), 0);

export async function listWorkflows(trx: Tx, workspaceId: string): Promise<ApiWorkflowSummary[]> {
  const rows = await trx
    .selectFrom('apitest.workflow as w')
    .innerJoin('apitest.workflow_version as v', (j) => j.onRef('v.workflow_id', '=', 'w.id').onRef('v.version', '=', 'w.current_version'))
    .select(['w.id', 'w.name', 'w.description', 'w.current_version', 'w.updated_at', 'v.def'])
    .where('w.workspace_id', '=', workspaceId)
    .orderBy('w.name')
    .execute();
  const runs = rows.length
    ? await trx
        .selectFrom('apitest.workflow_run')
        .select(['id', 'workflow_id', 'status', 'finished_at', 'started_at'])
        .where('workflow_id', 'in', rows.map((r) => r.id))
        .orderBy('started_at', 'desc')
        .execute()
    : [];
  const defs = new Map(rows.map((r) => [r.id, ApiWorkflowDef.parse(r.def)]));
  const used = [...new Set([...defs.values()].flatMap((d) => [...references([...d.steps, ...d.teardown]).requests]))];
  const nodes = used.length ? await trx.selectFrom('apitest.node').select(['id', 'kind', 'config']).where('id', 'in', used).execute() : [];
  const notes = await reviewNotes(trx, nodes);
  return rows.map((r) => {
    const last = runs.find((x) => x.workflow_id === r.id);
    const def = defs.get(r.id)!;
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      version: r.current_version,
      stepCount: countSteps(def.steps),
      needsReview: [...references([...def.steps, ...def.teardown]).requests].filter((id) => notes.has(id)).length,
      lastRun: last ? { id: last.id, status: last.status as ApiWorkflowRunStatus, finishedAt: last.finished_at?.toISOString() ?? null } : null,
      updatedAt: r.updated_at.toISOString(),
    };
  });
}

export async function getWorkflow(trx: Tx, workspaceId: string, id: string, version?: number): Promise<ApiWorkflow> {
  const w = await trx.selectFrom('apitest.workflow').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (!w) throw notFound('Workflow');
  const v = await trx.selectFrom('apitest.workflow_version').select(['def']).where('workflow_id', '=', id).where('version', '=', version ?? w.current_version).executeTakeFirst();
  if (!v) throw notFound('Workflow version');
  const summary = (await listWorkflows(trx, workspaceId)).find((s) => s.id === id)!;
  return { ...summary, def: ApiWorkflowDef.parse(v.def) };
}

export async function saveWorkflow(trx: Tx, caller: Caller, workspaceId: string, body: ApiWorkflowBody, id?: string): Promise<ApiWorkflow> {
  await checkReferences(trx, workspaceId, body.def, id);
  try {
    if (!id) {
      const w = await trx
        .insertInto('apitest.workflow')
        .values({ org_id: caller.orgId, workspace_id: workspaceId, name: body.name, description: body.description, updated_by: caller.userId, updated_at: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('apitest.workflow_version').values({ workflow_id: w.id, version: 1, org_id: caller.orgId, def: JSON.stringify(body.def), created_by: caller.userId }).execute();
      return getWorkflow(trx, workspaceId, w.id);
    }
    const w = await trx.selectFrom('apitest.workflow').select(['current_version']).where('id', '=', id).where('workspace_id', '=', workspaceId).forUpdate().executeTakeFirst();
    if (!w) throw notFound('Workflow');
    const version = w.current_version + 1;
    await trx.insertInto('apitest.workflow_version').values({ workflow_id: id, version, org_id: caller.orgId, def: JSON.stringify(body.def), created_by: caller.userId }).execute();
    await trx.updateTable('apitest.workflow').set({ name: body.name, description: body.description, current_version: version, updated_by: caller.userId, updated_at: new Date() }).where('id', '=', id).execute();
    return getWorkflow(trx, workspaceId, id);
  } catch (err) {
    if (isUnique(err)) throw conflict(`A workflow called "${body.name}" already exists.`);
    throw err;
  }
}

export async function deleteWorkflow(trx: Tx, workspaceId: string, id: string): Promise<void> {
  // Any other workflow that runs this one as a step, at any depth, would break.
  const others = await trx
    .selectFrom('apitest.workflow as w')
    .innerJoin('apitest.workflow_version as v', (j) => j.onRef('v.workflow_id', '=', 'w.id').onRef('v.version', '=', 'w.current_version'))
    .select(['w.name', 'v.def'])
    .where('w.workspace_id', '=', workspaceId)
    .where('w.id', '!=', id)
    .execute();
  const user = others.find((o) => {
    const def = ApiWorkflowDef.safeParse(o.def).data;
    return def && references([...def.steps, ...def.teardown]).workflows.has(id);
  });
  if (user) throw conflict(`"${user.name}" runs this workflow as a step; take it out there first.`);
  const done = await trx.deleteFrom('apitest.workflow').where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (!done.numDeletedRows) throw notFound('Workflow');
}

/**
 * A workflow from a suggestion on the project map. Operations with no request in the workspace yet get
 * one (imported from their spec), each producer step assigns the values later steps need, and a step
 * that expects a status other than the request's own gets a variation that checks it.
 */
export async function workflowFromSuggestion(
  trx: Tx,
  storage: ObjectStorage,
  box: SecretBox,
  caller: Caller,
  projectId: string,
  workspaceId: string,
  suggestionId: string,
  name?: string,
): Promise<ApiWorkflow> {
  const map = await projectMap(trx, storage, projectId);
  const sug = map.suggestions.find((s) => s.id === suggestionId);
  if (!sug) throw notFound('Suggestion');
  return workflowFromSteps(trx, storage, box, caller, projectId, workspaceId, name ?? sug.name, sug.steps, map);
}

/**
 * A workflow from a list of operations in calling order (a map suggestion, or a chain the assistant
 * planned). Shared by both so they make workflows the same way.
 */
export async function workflowFromSteps(
  trx: Tx,
  storage: ObjectStorage,
  box: SecretBox,
  caller: Caller,
  projectId: string,
  workspaceId: string,
  baseName: string,
  stepList: ApiSuggestedWorkflow['steps'],
  known?: Awaited<ReturnType<typeof projectMap>>,
): Promise<ApiWorkflow> {
  const map = known ?? (await projectMap(trx, storage, projectId));
  const sug = { name: baseName, steps: stepList };
  const io = new Map(map.io.map((o) => [o.key, o]));
  const unknown = stepList.map((x) => x.key).filter((k) => !io.has(k));
  if (unknown.length) throw badRequest(`These are not operations in the project's specs: ${unknown.join(', ')}.`);

  const findRequests = async () => {
    const rows = await trx.selectFrom('apitest.node').select(['id', 'config']).where('workspace_id', '=', workspaceId).where('kind', '=', 'request').execute();
    const byKey = new Map<string, string>();
    for (const r of rows) {
      const op = ApiRequestDef.safeParse(r.config).data?.operation;
      if (op && !byKey.has(`${op.method} ${op.path}`)) byKey.set(`${op.method} ${op.path}`, r.id);
    }
    return byKey;
  };
  let requests = await findRequests();
  const missing = [...new Set(sug.steps.map((s) => s.key))].filter((k) => !requests.has(k));
  for (const specId of new Set(missing.map((k) => io.get(k)!.specId))) {
    const ops = missing.filter((k) => io.get(k)!.specId === specId);
    const specName = io.get(ops[0]!)!.specName;
    const existing = await trx.selectFrom('apitest.node').select('id').where('workspace_id', '=', workspaceId).where('kind', '=', 'collection').where('name', '=', specName).executeTakeFirst();
    await importToCollection(trx, box, caller, projectId, specId, { workspaceId, collectionId: existing?.id ?? null, collectionName: specName, operations: ops }, storage);
  }
  if (missing.length) requests = await findRequests();

  const steps: ApiWorkflowStep[] = [];
  for (const [i, s] of sug.steps.entries()) {
    const requestId = requests.get(s.key)!;
    let variationId: string | null = null;
    if (s.expectStatus) {
      const list = await trx.selectFrom('apitest.variation').select(['id', 'name']).where('request_id', '=', requestId).execute();
      const label = `Expects ${s.expectStatus}`;
      variationId =
        list.find((v) => v.name === label)?.id ??
        (await createVariation(trx, caller, workspaceId, requestId, { name: label, overrides: { assertions: [{ id: 'status', source: 'status', path: '', op: 'eq', value: s.expectStatus, enabled: true }] } })).find((v) => v.name === label)!.id;
    }
    const later = new Set(sug.steps.slice(i + 1).map((x) => x.key));
    const assign = map.links
      .filter((l) => l.from === s.key && later.has(l.to) && l.field)
      .map((l) => ({ variable: l.param.name, source: 'body' as const, path: l.field! }))
      .filter((a, j, all) => all.findIndex((b) => b.variable === a.variable) === j);
    // A login step hands its token on as {{token}}: point the collection's auth at it, or use a profile.
    if (map.links.some((l) => l.from === s.key && l.param.in === 'auth')) {
      const token = io.get(s.key)?.outputs.find((f) => /token/i.test(f) && !f.includes('[*]'));
      if (token) assign.push({ variable: 'token', source: 'body', path: token });
    }
    steps.push({ id: `s${i + 1}`, name: s.note, kind: 'request', requestId, variationId, assign, continueOnFail: false });
  }

  // A delete in the chain is also the cleanup: if the run stops before it, the thing that was created is
  // removed anyway. After a normal delete it answers 404, which the cleanup variation accepts.
  const teardown: ApiWorkflowStep[] = [];
  for (const [i, s] of sug.steps.entries()) {
    if (!s.key.startsWith('DELETE ')) continue;
    const link = map.links.find((l) => l.to === s.key && l.param.in === 'path' && sug.steps.slice(0, i).some((p) => p.key === l.from));
    if (!link) continue;
    const requestId = requests.get(s.key)!;
    const label = 'Cleanup (200, 204 or 404)';
    const list = await trx.selectFrom('apitest.variation').select(['id', 'name']).where('request_id', '=', requestId).execute();
    const variationId =
      list.find((v) => v.name === label)?.id ??
      (await createVariation(trx, caller, workspaceId, requestId, { name: label, overrides: { assertions: [{ id: 'status', source: 'status', path: '', op: 'in', value: '200,204,404', enabled: true }] } })).find((v) => v.name === label)!.id;
    const n = teardown.length + 1;
    teardown.push({
      id: `t${n}`,
      name: 'Clean up what the run created',
      kind: 'if',
      condition: { variable: link.param.name, op: 'exists', value: '' },
      then: [{ id: `t${n}d`, name: s.note, kind: 'request', requestId, variationId, assign: [], continueOnFail: true }],
      else: [],
    });
  }

  let finalName = sug.name;
  for (let n = 2; await trx.selectFrom('apitest.workflow').select('id').where('workspace_id', '=', workspaceId).where('name', '=', finalName).executeTakeFirst(); n++) finalName = `${sug.name} ${n}`;
  return saveWorkflow(trx, caller, workspaceId, { name: finalName, description: `Made from the project map: ${sug.steps.map((s) => s.key).join(' → ')}`, def: ApiWorkflowDef.parse({ steps, teardown }) });
}
