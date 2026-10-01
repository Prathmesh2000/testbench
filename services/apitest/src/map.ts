import type { LinkDecisionBody, ProjectMap } from '@tb/contracts';
import type { ObjectStorage, Tx } from '@tb/platform';
import { applyDecisions, callOrder, inferLinks, operationsIO, orphansOf, suggestWorkflows, toMapOperation, type OperationIO } from './deps';
import type { Caller } from './workspaces';

// The project map (plan §12): every operation in the project's specs, the links between them and the
// tester's decisions about those links. Links are computed on read from the current spec versions.

/**
 * Inputs and outputs of every operation in the project's current spec versions. Read from the stored
 * documents, so specs uploaded before this existed work too.
 * ponytail: reads every spec document from S3 on each call; cache by spec hash if maps get slow.
 */
export async function projectOperations(trx: Tx, storage: ObjectStorage, projectId: string): Promise<OperationIO[]> {
  const specs = await trx
    .selectFrom('apitest.spec as s')
    .innerJoin('apitest.spec_version as v', (j) => j.onRef('v.spec_id', '=', 's.id').onRef('v.version', '=', 's.current_version'))
    .select(['s.id', 's.name', 'v.storage_key'])
    .where('s.project_id', '=', projectId)
    .orderBy('s.name')
    .execute();
  const seen = new Set<string>();
  const out: OperationIO[] = [];
  for (const sp of specs) {
    const doc = JSON.parse(Buffer.from(await storage.read(sp.storage_key)).toString('utf8'));
    // Two specs with the same method and path: the first by name keeps the key.
    for (const op of operationsIO(doc, sp.id, sp.name)) if (!seen.has(op.key)) {
      seen.add(op.key);
      out.push(op);
    }
  }
  return out;
}

async function decisions(trx: Tx, projectId: string) {
  const rows = await trx.selectFrom('apitest.dependency_link').selectAll().where('project_id', '=', projectId).execute();
  return rows.map((r) => ({ from: r.from_key, to: r.to_key, param: { in: r.param_in as LinkDecisionBody['param']['in'], name: r.param_name }, field: r.field, status: r.status as 'confirmed' | 'rejected' }));
}

export async function projectMap(trx: Tx, storage: ObjectStorage, projectId: string): Promise<ProjectMap & { io: OperationIO[] }> {
  const io = await projectOperations(trx, storage, projectId);
  const links = applyDecisions(inferLinks(io), await decisions(trx, projectId));
  const orphans = orphansOf(io, links);
  return {
    operations: io.map((o) => toMapOperation(o, orphans.get(o.key) ?? [])),
    links,
    order: callOrder(io.map((o) => o.key), links),
    suggestions: suggestWorkflows(io, links),
    io,
  };
}

/** Records a tester's decision about a link; deciding again replaces the earlier decision. */
export async function decideLink(trx: Tx, caller: Caller, projectId: string, body: LinkDecisionBody): Promise<void> {
  await trx
    .insertInto('apitest.dependency_link')
    .values({
      org_id: caller.orgId,
      project_id: projectId,
      from_key: body.from,
      to_key: body.to,
      param_in: body.param.in,
      param_name: body.param.name,
      field: body.field,
      status: body.status,
      decided_by: caller.userId,
    })
    .onConflict((oc) =>
      oc.columns(['project_id', 'from_key', 'to_key', 'param_in', 'param_name']).doUpdateSet({ field: body.field, status: body.status, decided_by: caller.userId, decided_at: new Date() }),
    )
    .execute();
}

/** Forgets a decision, so the link is inferred afresh. */
export async function forgetDecision(trx: Tx, projectId: string, body: Omit<LinkDecisionBody, 'status' | 'field'>): Promise<void> {
  await trx
    .deleteFrom('apitest.dependency_link')
    .where('project_id', '=', projectId)
    .where('from_key', '=', body.from)
    .where('to_key', '=', body.to)
    .where('param_in', '=', body.param.in)
    .where('param_name', '=', body.param.name)
    .execute();
}
