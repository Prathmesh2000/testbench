import type { AiService } from '@tb/ai';
import {
  ApiRequestDef,
  EnrichmentAnswer,
  type CoverageView,
  type EnrichmentDraft,
  type EnrichmentQuestion,
  type EnrichmentView,
  type GeneratedTest,
  type GeneratedView,
  type SpecQuality,
} from '@tb/contracts';
import { badRequest, notFound, type ObjectStorage, type Tx } from '@tb/platform';
import { answerToPatches, AnswerError, detectGaps, getAt, readiness, type Gap } from './enrich';
import { loadSpecDoc } from './effective';
import { decideLink, projectMap } from './map';
import { lintSpec, RULES } from './lint';
import { readSpec } from './spec';
import { importToCollection } from './specs';
import { expectedStatuses, generateForSpec } from './testgen';
import { createVariation, type Caller, type SecretBox } from './workspaces';

// Phase A2 over the database (plan §9–§11): the quality report, enrichment questions and answers, and
// generated tests with their review queue and the coverage they add up to.

// ---------- quality ----------

export async function specQuality(trx: Tx, storage: ObjectStorage, projectId: string, specId: string, version?: number): Promise<SpecQuality> {
  const s = await loadSpecDoc(trx, storage, projectId, specId, version);
  const settings = await trx.selectFrom('apitest.lint_setting').select(['rule', 'enabled', 'reason']).where('project_id', '=', projectId).execute();
  const off = new Set(settings.filter((x) => !x.enabled).map((x) => x.rule));
  // The report is on the effective spec: an answered gap no longer counts against it.
  const report = lintSpec(s.doc, off);
  return {
    ...report,
    version: s.version,
    rules: RULES.map((r) => {
      const set = settings.find((x) => x.rule === r.id);
      return { ...r, enabled: set ? set.enabled : true, reason: set && !set.enabled ? set.reason : null };
    }),
  };
}

export async function setLintRule(trx: Tx, caller: Caller, projectId: string, body: { rule: string; enabled: boolean; reason: string }): Promise<void> {
  if (!RULES.some((r) => r.id === body.rule)) throw notFound('Rule');
  await trx
    .insertInto('apitest.lint_setting')
    .values({ org_id: caller.orgId, project_id: projectId, rule: body.rule, enabled: body.enabled, reason: body.reason, updated_by: caller.userId })
    .onConflict((oc) => oc.columns(['project_id', 'rule']).doUpdateSet({ enabled: body.enabled, reason: body.reason, updated_by: caller.userId, updated_at: new Date() }))
    .execute();
}

// ---------- enrichment ----------

async function gapsFor(trx: Tx, storage: ObjectStorage, projectId: string, specId: string) {
  const s = await loadSpecDoc(trx, storage, projectId, specId);
  // Questions come from the raw document so an answered one stays listed (as answered), and from the
  // map's uncertain links for this spec's operations.
  const ops = new Set(readSpec(s.raw).operations.map((o) => `${o.method} ${o.path}`));
  const map = await projectMap(trx, storage, projectId);
  const gaps = detectGaps(s.raw, map.links.filter((l) => ops.has(l.to)));
  return { s, gaps };
}

export async function enrichmentView(trx: Tx, storage: ObjectStorage, projectId: string, specId: string): Promise<EnrichmentView> {
  const { s, gaps } = await gapsFor(trx, storage, projectId, specId);
  const rows = await trx
    .selectFrom('apitest.enrichment_answer as a')
    .leftJoin('iam.app_user as u', 'u.id', 'a.assigned_to')
    .leftJoin('iam.app_user as b', 'b.id', 'a.answered_by')
    .select(['a.question_id', 'a.status', 'a.answer', 'a.source', 'a.assigned_to', 'u.name as assignee', 'b.name as answerer', 'a.answered_at'])
    .where('a.spec_id', '=', specId)
    .execute();
  const byId = new Map(rows.map((r) => [r.question_id, r]));
  const questions: EnrichmentQuestion[] = gaps.map((g) => {
    const r = byId.get(g.id);
    const status = r?.status === 'answered' && s.stale.has(g.id) ? 'stale' : ((r?.status as EnrichmentQuestion['status']) ?? 'open');
    return {
      id: g.id,
      kind: g.kind,
      operation: g.operation,
      pointer: g.pointer,
      field: g.field,
      prompt: g.prompt,
      impact: g.impact,
      status,
      answer: r?.answer ? EnrichmentAnswer.parse(r.answer) : null,
      source: (r?.source as EnrichmentQuestion['source']) ?? null,
      assignedTo: r?.assigned_to ? { id: r.assigned_to, name: r.assignee ?? 'A teammate' } : null,
      answeredBy: r?.answerer ?? null,
      answeredAt: r?.answered_at?.toISOString() ?? null,
    };
  });
  const answered = new Set(questions.filter((q) => q.status === 'answered').map((q) => q.id));
  const count = (st: EnrichmentQuestion['status']) => questions.filter((q) => q.status === st).length;
  return { specId, version: s.version, readiness: readiness(gaps, answered), counts: { open: count('open'), answered: count('answered'), skipped: count('skipped'), stale: count('stale') }, questions };
}

async function findGap(trx: Tx, storage: ObjectStorage, projectId: string, specId: string, questionId: string): Promise<{ gap: Gap; raw: Record<string, unknown> }> {
  const { s, gaps } = await gapsFor(trx, storage, projectId, specId);
  const gap = gaps.find((g) => g.id === questionId);
  if (!gap) throw notFound('Question');
  return { gap, raw: s.raw };
}

export async function answerQuestion(
  trx: Tx,
  storage: ObjectStorage,
  caller: Caller,
  projectId: string,
  specId: string,
  body: { questionId: string; answer: EnrichmentAnswer; source: 'user' | 'ai' },
): Promise<EnrichmentView> {
  const { gap, raw } = await findGap(trx, storage, projectId, specId, body.questionId);
  if (body.answer.kind !== gap.kind) throw badRequest(`This question needs a ${gap.kind.replace('_', ' ')} answer.`);
  let patches;
  try {
    patches = answerToPatches(gap, body.answer, raw);
  } catch (err) {
    if (err instanceof AnswerError) throw badRequest(err.message);
    throw err;
  }
  // A dependency answer is a decision on the project map, not a change to the spec.
  if (body.answer.kind === 'dependency' && gap.link)
    await decideLink(trx, caller, projectId, { ...gap.link, field: gap.link.field, status: body.answer.confirmed ? 'confirmed' : 'rejected' });
  const values = { status: 'answered', answer: JSON.stringify(body.answer), patches: JSON.stringify(patches), source: body.source, answered_by: caller.userId, answered_at: new Date(), updated_at: new Date() };
  await trx
    .insertInto('apitest.enrichment_answer')
    .values({ org_id: caller.orgId, spec_id: specId, question_id: gap.id, kind: gap.kind, ...values })
    .onConflict((oc) => oc.columns(['spec_id', 'question_id']).doUpdateSet(values))
    .execute();
  return enrichmentView(trx, storage, projectId, specId);
}

/** Skip, reopen or assign a question without answering it. */
export async function setQuestionStatus(
  trx: Tx,
  storage: ObjectStorage,
  caller: Caller,
  projectId: string,
  specId: string,
  body: { questionId: string; status: 'open' | 'skipped'; assignTo?: string | null | undefined },
): Promise<EnrichmentView> {
  const { gap } = await findGap(trx, storage, projectId, specId, body.questionId);
  if (body.assignTo) {
    const member = await trx.selectFrom('iam.membership').select('user_id').where('user_id', '=', body.assignTo).executeTakeFirst();
    if (!member) throw badRequest('That person is not a member of this organisation.');
  }
  const values = {
    status: body.status,
    // Reopening drops the answer and its patches: the spec goes back to saying nothing there.
    ...(body.status === 'open' ? { answer: null, patches: '[]', source: null, answered_by: null, answered_at: null } : {}),
    ...(body.assignTo !== undefined ? { assigned_to: body.assignTo } : {}),
    updated_at: new Date(),
  };
  await trx
    .insertInto('apitest.enrichment_answer')
    .values({ org_id: caller.orgId, spec_id: specId, question_id: gap.id, kind: gap.kind, status: body.status, assigned_to: body.assignTo ?? null, updated_at: new Date() })
    .onConflict((oc) => oc.columns(['spec_id', 'question_id']).doUpdateSet(values))
    .execute();
  return enrichmentView(trx, storage, projectId, specId);
}

/** Context the AI draft gets: the operation and the spec around the question, cut short. */
export async function draftContext(trx: Tx, storage: ObjectStorage, projectId: string, specId: string, questionId: string) {
  const { gap, raw } = await findGap(trx, storage, projectId, specId, questionId);
  const map = await projectMap(trx, storage, projectId);
  const io = map.io.find((o) => o.key === gap.operation);
  const opPtr = gap.pointer.split('/').slice(0, 4).join('/');
  const schema = getAt(raw, gap.pointer) as Record<string, unknown> | undefined;
  return {
    gap,
    input: {
      question: { kind: gap.kind, prompt: gap.prompt, field: gap.field },
      operation: {
        key: gap.operation,
        summary: io?.summary ?? '',
        inputs: io?.inputs.map((i) => i.name) ?? [],
        outputs: io?.outputs ?? [],
        security: io?.securitySchemes ?? [],
        dependsOn: map.links.filter((l) => l.to === gap.operation).map((l) => l.from),
        feeds: map.links.filter((l) => l.from === gap.operation).map((l) => l.to),
      },
      bodyFields: Object.keys((schema?.properties as Record<string, unknown> | undefined) ?? {}),
      context: JSON.stringify(getAt(raw, opPtr) ?? {}).slice(0, 6000),
    },
  };
}

export async function draftAnswer(ai: AiService, caller: Caller, input: Awaited<ReturnType<typeof draftContext>>['input'], kind: string): Promise<EnrichmentDraft> {
  try {
    const out = await ai.run(caller, 'api_enrich', input);
    if (out.result.answer.kind !== kind) return { answer: out.result.answer, why: out.result.why, ai: { status: 'unavailable', message: 'The model answered a different kind of question; answer it yourself.' } };
    const a = out.result.answer;
    // A draft that says nothing is not an answer: the model could not tell from the spec.
    const empty =
      (a.kind === 'constraints' && a.minimum === null && a.maximum === null && a.maxLength === null && !a.pattern && !a.enum.length) ||
      (a.kind === 'required' && !a.fields.length) ||
      (a.kind === 'business_rule' && !a.text.trim());
    if (empty) return { answer: out.result.answer, why: out.result.why, ai: { status: 'unavailable', message: `The model could not tell from the spec: ${out.result.why || 'answer it yourself.'}` } };
    return { answer: out.result.answer, why: out.result.why, ai: { status: 'used', message: `${out.provider} · ${out.model}` } };
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'The AI model could not be reached.');
  }
}

// ---------- generated tests ----------

const view = (r: { gen_id: string; operation: string; kind: string; name: string; payload: Record<string, unknown>; status: string; variation_id: string | null; request_id: string | null }): GeneratedTest => ({
  id: r.gen_id,
  operation: r.operation,
  kind: r.kind as GeneratedTest['kind'],
  name: r.name,
  expect: r.payload.expect as string[],
  why: r.payload.why as string,
  pointer: r.payload.pointer as string,
  overrides: r.payload.overrides as GeneratedTest['overrides'],
  status: r.status as GeneratedTest['status'],
  variationId: r.variation_id,
  requestId: r.request_id,
});

export async function generatedView(trx: Tx, specId: string, version: number): Promise<GeneratedView> {
  const rows = await trx.selectFrom('apitest.generated_test').selectAll().where('spec_id', '=', specId).orderBy('operation').orderBy('kind').orderBy('name').execute();
  const tests = rows.map(view);
  const count = (s: GeneratedTest['status']) => tests.filter((t) => t.status === s).length;
  return { specId, version, tests, counts: { pending: count('pending'), accepted: count('accepted'), rejected: count('rejected') } };
}

/**
 * (Re)generates tests from the effective spec. Decided tests keep their decision; pending ones are
 * refreshed; pending ones the spec no longer produces are dropped.
 */
export async function generateTests(trx: Tx, storage: ObjectStorage, caller: Caller, projectId: string, specId: string, operations: string[]): Promise<GeneratedView> {
  const s = await loadSpecDoc(trx, storage, projectId, specId);
  const only = operations.length ? new Set(operations) : undefined;
  const made = generateForSpec(s.doc, s.specId, only);
  const existing = await trx.selectFrom('apitest.generated_test').select(['gen_id', 'status', 'operation']).where('spec_id', '=', specId).execute();
  const decided = new Set(existing.filter((e) => e.status !== 'pending').map((e) => e.gen_id));
  const fresh = new Set(made.map((g) => g.id));
  const stalePending = existing.filter((e) => e.status === 'pending' && !fresh.has(e.gen_id) && (!only || only.has(e.operation))).map((e) => e.gen_id);
  if (stalePending.length) await trx.deleteFrom('apitest.generated_test').where('spec_id', '=', specId).where('gen_id', 'in', stalePending).execute();
  for (const g of made) {
    if (decided.has(g.id)) continue;
    const values = { version: s.version, operation: g.operation, kind: g.kind, name: g.name, payload: JSON.stringify({ overrides: g.overrides, expect: g.expect, why: g.why, pointer: g.pointer }), updated_at: new Date() };
    await trx
      .insertInto('apitest.generated_test')
      .values({ org_id: caller.orgId, spec_id: specId, gen_id: g.id, ...values })
      .onConflict((oc) => oc.columns(['spec_id', 'gen_id']).doUpdateSet(values))
      .execute();
  }
  return generatedView(trx, specId, s.version);
}

/** Accepting makes each test a variation of its operation's request, imported from the spec if missing. */
export async function reviewTests(
  trx: Tx,
  box: SecretBox,
  storage: ObjectStorage,
  caller: Caller,
  projectId: string,
  specId: string,
  body: { ids: string[]; decision: 'accept' | 'reject' | 'pending'; workspaceId?: string | undefined },
): Promise<GeneratedView> {
  const rows = await trx.selectFrom('apitest.generated_test').selectAll().where('spec_id', '=', specId).where('gen_id', 'in', body.ids).execute();
  if (rows.length !== new Set(body.ids).size) throw notFound('Generated test');
  const spec = await trx.selectFrom('apitest.spec').select(['name', 'current_version']).where('id', '=', specId).executeTakeFirstOrThrow();
  if (body.decision !== 'accept') {
    await trx.updateTable('apitest.generated_test').set({ status: body.decision === 'reject' ? 'rejected' : 'pending', decided_by: caller.userId, updated_at: new Date() }).where('spec_id', '=', specId).where('gen_id', 'in', body.ids).execute();
    return generatedView(trx, specId, spec.current_version);
  }
  if (!body.workspaceId) throw badRequest('Pick the workspace the accepted tests go into.');
  const workspaceId = body.workspaceId;

  const requestFor = async () => {
    const nodes = await trx.selectFrom('apitest.node').select(['id', 'config']).where('workspace_id', '=', workspaceId).where('kind', '=', 'request').execute();
    const byOp = new Map<string, string>();
    for (const n of nodes) {
      const op = ApiRequestDef.safeParse(n.config).data?.operation;
      if (op && op.specId === specId && !byOp.has(`${op.method} ${op.path}`)) byOp.set(`${op.method} ${op.path}`, n.id);
    }
    return byOp;
  };
  let byOp = await requestFor();
  const missing = [...new Set(rows.map((r) => r.operation))].filter((k) => !byOp.has(k));
  if (missing.length) {
    const col = await trx.selectFrom('apitest.node').select('id').where('workspace_id', '=', workspaceId).where('kind', '=', 'collection').where('name', '=', spec.name).executeTakeFirst();
    await importToCollection(trx, box, caller, projectId, specId, { workspaceId, collectionId: col?.id ?? null, collectionName: spec.name, operations: missing }, storage);
    byOp = await requestFor();
  }
  for (const r of rows) {
    if (r.status === 'accepted' && r.variation_id) continue;
    const requestId = byOp.get(r.operation)!;
    const payload = r.payload as { overrides: GeneratedTest['overrides'] };
    const list = await createVariation(trx, caller, workspaceId, requestId, { name: r.name, overrides: payload.overrides });
    const made = list.filter((v) => v.name === r.name).at(-1)!;
    await trx.updateTable('apitest.generated_test').set({ status: 'accepted', request_id: requestId, variation_id: made.id, decided_by: caller.userId, updated_at: new Date() }).where('id', '=', r.id).execute();
  }
  return generatedView(trx, specId, spec.current_version);
}

// ---------- coverage ----------

/**
 * Operations × documented status codes: covered when a request or accepted variation in the project
 * checks for that status, generated when a test for it waits for review, missing otherwise.
 */
export async function coverage(trx: Tx, storage: ObjectStorage, projectId: string, specId: string): Promise<CoverageView> {
  const s = await loadSpecDoc(trx, storage, projectId, specId);
  const ops = readSpec(s.doc).operations;
  const requests = await trx
    .selectFrom('apitest.node as n')
    .innerJoin('apitest.workspace as w', 'w.id', 'n.workspace_id')
    .select(['n.id', 'n.config'])
    .where('w.project_id', '=', projectId)
    .where('n.kind', '=', 'request')
    .execute();
  const variations = requests.length
    ? await trx.selectFrom('apitest.variation').select(['request_id', 'overrides']).where('request_id', 'in', requests.map((r) => r.id)).execute()
    : [];
  const covered = new Map<string, Set<string>>();
  for (const r of requests) {
    const def = ApiRequestDef.safeParse(r.config).data;
    if (!def?.operation || def.operation.specId !== specId) continue;
    const key = `${def.operation.method} ${def.operation.path}`;
    const set = covered.get(key) ?? new Set<string>();
    for (const st of expectedStatuses(def.assertions)) set.add(st);
    for (const v of variations.filter((x) => x.request_id === r.id)) {
      const a = (v.overrides as { assertions?: ApiRequestDef['assertions'] }).assertions;
      if (a) for (const st of expectedStatuses(a)) set.add(st);
    }
    covered.set(key, set);
  }
  const pending = await trx.selectFrom('apitest.generated_test').select(['operation', 'payload']).where('spec_id', '=', specId).where('status', '=', 'pending').execute();
  const generated = new Map<string, Set<string>>();
  for (const p of pending) generated.set(p.operation, new Set([...(generated.get(p.operation) ?? []), ...((p.payload as { expect: string[] }).expect ?? [])]));

  const rows = ops.map((o) => {
    const key = `${o.method} ${o.path}`;
    const has = covered.get(key) ?? new Set();
    const gen = generated.get(key) ?? new Set();
    const documented = o.responses.filter((x) => /^\d{3}$/.test(x));
    const cells: Record<string, CoverageView['rows'][number]['cells'][string]> = {};
    for (const c of documented) {
      const ok = has.has(c) || (/^2/.test(c) && has.has('2xx'));
      cells[c] = ok ? 'covered' : gen.has(c) || (/^2/.test(c) && gen.has('2xx')) ? 'generated' : 'missing';
    }
    for (const c of has) if (/^\d{3}$/.test(c) && !documented.includes(c)) cells[c] = 'undocumented';
    return { operation: key, tag: o.tags[0] ?? 'Other', cells };
  });
  const statuses = [...new Set(rows.flatMap((r) => Object.keys(r.cells)))].sort();
  const all = rows.flatMap((r) => Object.values(r.cells));
  const n = (c: string) => all.filter((x) => x === c).length;
  // Undocumented cells are a note for the spec, not part of what is to cover.
  const counted = all.length - n('undocumented');
  return {
    statuses,
    rows,
    totals: { cells: counted, covered: n('covered'), generated: n('generated'), missing: n('missing'), undocumented: n('undocumented'), percent: counted ? Math.round((100 * n('covered')) / counted) : 100 },
  };
}
