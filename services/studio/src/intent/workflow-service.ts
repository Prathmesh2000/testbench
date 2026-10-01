import type { FieldValidation, GeneratedTests, Scenario, StudioComponent, Workflow, WorkflowDraft, WorkflowDraftBody } from '@tb/contracts';
import { DataSetBody, SaveComponentBody, SaveTestBody } from '@tb/contracts';
import { badRequest, maskText, notFound, type Tx } from '@tb/platform';
import { saveDataSet } from '@tb/repository';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { listComponents, saveComponent, saveTest } from '../tests';
import { buildDraft } from './build';
import { planTests, stepLabel, submitPage, type PlannedTest } from './scenarios';
import { getPlan, pagePath } from '../site';
import { workflowDraft } from './workflow';

type Caller = { orgId: string; userId: string };

function parsed<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(`The ${what} is not valid: ${r.error.issues[0]?.message ?? 'unknown problem'}`);
  return r.data;
}

/** A recording as a workflow draft, with the questions it needs answered before saving. */
export async function draftWorkflowFromRecording(trx: Tx, projectId: string, body: WorkflowDraftBody): Promise<WorkflowDraft> {
  const existing = await listComponents(trx, projectId);
  const prerequisiteComponent = body.prerequisiteComponentId ? (existing.find((c) => c.id === body.prerequisiteComponentId) ?? null) : null;
  if (body.prerequisiteComponentId && !prerequisiteComponent) throw notFound('Prerequisite workflow');
  const { draft } = buildDraft({
    title: body.name,
    intent: { prerequisites: prerequisiteComponent?.name ?? '', intent: body.intent, goal: body.intent },
    prerequisite: prerequisiteComponent ? [] : body.prerequisite,
    prerequisiteComponent,
    recording: body.recording,
    existing,
    newId: randomUUID,
    answers: body.answers,
  });
  const start = body.recording.find((r): r is Extract<typeof r, { action: 'open' }> => r.action === 'open')?.url ?? null;
  const out = workflowDraft(draft, body, body.prerequisiteComponentId, start);
  out.part.meta = { ...out.part.meta, apis: apisOf(body.recording) };
  return out;
}

/** The APIs a recording's page called, each after the action that set it off, repeats once. */
export function apisOf(recording: WorkflowDraftBody['recording']): StudioComponent['meta']['apis'] {
  const out: StudioComponent['meta']['apis'] = [];
  let after = 'opening the page';
  for (const r of recording) {
    if (r.action === 'click' || r.action === 'type' || r.action === 'select' || r.action === 'press' || r.action === 'check' || r.action === 'uncheck')
      after = `${r.action} ${r.element?.suggestedName || r.element?.text || ''}`.trim().slice(0, 200);
    if (r.action !== 'api') continue;
    const call = { method: r.method.toUpperCase(), path: pagePath(r.url), status: r.status, after };
    if (!out.some((c) => c.method === call.method && c.path === call.path && c.status === call.status)) out.push(call);
  }
  return out.slice(0, 60);
}

/** A saved workflow, with what its prerequisite and continuation need. */
function workflowView(c: StudioComponent, all: StudioComponent[]): Workflow {
  const pre = c.meta.prerequisiteId ? all.find((x) => x.id === c.meta.prerequisiteId) : undefined;
  const cont = c.meta.continuationId ? all.find((x) => x.id === c.meta.continuationId) : undefined;
  const keys = [...new Set([...c.inputs, ...(cont?.inputs ?? [])])];
  const pageFields = c.meta.pages.flatMap((p) => p.fields);
  return {
    id: c.id,
    name: c.name,
    version: c.version,
    intent: c.meta.intent,
    purpose: c.meta.purpose,
    prerequisite: pre ? { id: pre.id, name: pre.name, version: pre.version, inputs: pre.inputs, inputKinds: pre.meta.inputKinds } : null,
    continuation: cont ? { id: cont.id, version: cont.version, inputs: cont.inputs } : null,
    inputs: c.inputs,
    fields: keys.flatMap((k) => {
      const f = pageFields.find((x) => x.key === k);
      const rules = c.meta.inputRules[k] ?? f?.rules;
      if (!rules) return [];
      return [{ key: k, label: f?.label ?? k, kind: f?.kind ?? c.meta.inputKinds[k] ?? 'text', rules, recorded: c.meta.defaults[k] ?? '', secret: c.meta.secretInputs.includes(k) }];
    }),
    pages: c.meta.pages,
    steps: c.steps.map((s) => ({ id: s.id, label: stepLabel(s), action: s.action })),
    apis: c.meta.apis,
    baseUrl: c.meta.baseUrl,
    submitLabel: c.meta.submitLabel,
    updatedAt: c.updatedAt,
  };
}

export async function listWorkflows(trx: Tx, projectId: string): Promise<Workflow[]> {
  const all = await listComponents(trx, projectId);
  return all.filter((c) => c.meta.origin === 'workflow' && !c.meta.archived).map((c) => workflowView(c, all));
}

/**
 * Takes a workflow out of the library (and the site map and suggestions). Its versions stay, so a
 * test that runs it still runs; recording one under the same name brings it back as a new version.
 */
export async function archiveWorkflow(trx: Tx, projectId: string, id: string): Promise<void> {
  const { component } = await getWorkflow(trx, projectId, id);
  await trx
    .updateTable('studio.component')
    .set({ meta: JSON.stringify({ ...component.meta, archived: true }), updated_at: new Date() })
    .where('id', '=', id)
    .where('project_id', '=', projectId)
    .execute();
}

export async function getWorkflow(trx: Tx, projectId: string, id: string): Promise<{ workflow: Workflow; component: StudioComponent; all: StudioComponent[] }> {
  const all = await listComponents(trx, projectId);
  const component = all.find((c) => c.id === id && c.meta.origin === 'workflow');
  if (!component) throw notFound('Workflow');
  return { workflow: workflowView(component, all), component, all };
}

/**
 * Saves a reviewed workflow draft in one transaction: its prerequisite (when recorded now) and its
 * continuation first, so the workflow can point at them. The draft came back from the browser, so
 * each piece is parsed with its real schema and passes the same save rules as one made by hand.
 */
export async function saveWorkflow(trx: Tx, caller: Caller, projectId: string, draft: WorkflowDraft): Promise<Workflow> {
  if (!draft?.part?.steps?.length) throw badRequest('That workflow has no steps.');
  const open = (draft.questions ?? []).filter((q) => q.required && !q.answer);
  if (open.length) throw badRequest(`Answer the build's question first: ${open[0]!.text}`);
  // Saving a workflow again under its name publishes a new version of it; tests keep the version they pinned.
  const existing = await listComponents(trx, projectId);
  const save = (body: z.infer<typeof SaveComponentBody>) =>
    saveComponent(trx, caller, projectId, body, existing.find((c) => c.name.toLowerCase() === body.name.toLowerCase())?.id);
  const prerequisiteId = draft.prerequisite ? (await save(parsed(SaveComponentBody, draft.prerequisite, 'prerequisite'))).id : draft.prerequisiteId;
  const continuationId = draft.continuation ? (await save(parsed(SaveComponentBody, draft.continuation, 'continuation'))).id : null;
  const part = parsed(SaveComponentBody, draft.part, 'workflow');
  const saved = await save({ ...part, meta: { ...part.meta, prerequisiteId, continuationId } });
  return (await getWorkflow(trx, projectId, saved.id)).workflow;
}

/** What the scenario chat is told about a workflow: its fields, pages and what they showed, masked. */
export function chatInput(
  w: Workflow,
  messages: Array<{ role: 'tester' | 'assistant'; text: string }>,
  scenarios: Scenario[],
  testIntent = '',
  validations: FieldValidation[] = [],
) {
  const m = (s: string) => maskText(s);
  const rules = (r: Workflow['fields'][number]['rules']) =>
    [r.type !== 'text' && r.type, r.required && 'required', r.minLength > 0 && `min ${r.minLength}`, r.maxLength > 0 && `max ${r.maxLength}`, r.pattern && `pattern ${r.pattern}`, r.options.length > 0 && `options ${r.options.join('/')}`]
      .filter(Boolean)
      .join(', ');
  return {
    workflow: {
      name: w.name,
      intent: m(w.intent),
      submit: w.submitLabel,
      pages: w.pages.map((p) => ({ path: p.path, headings: p.headings.map(m), messages: p.messages.map((x) => `${x.kind} after ${x.after}: ${m(x.text)}`) })),
      fields: w.fields.filter((f) => !f.secret).map((f) => ({ key: f.key, label: f.label, kind: f.kind, rules: rules(f.rules), recorded: m(f.recorded) })),
    },
    testIntent: m(testIntent),
    validations: validations.map((v) => ({
      field: v.key,
      required: v.required,
      unique: v.unique,
      checks: v.checks.map((c) => `${c.label} → ${c.outcome === 'success' ? 'accepted' : 'refused'}`),
      message: m(v.message),
      notes: m(v.notes),
    })),
    messages: messages.slice(-20).map((x) => ({ role: x.role, text: m(x.text) })),
    scenarios: scenarios.map((s) => ({
      id: s.id,
      title: m(s.title),
      kind: s.kind,
      values: Object.fromEntries(Object.entries(s.values).map(([k, v]) => [k, m(v)])),
      expect: s.expect,
      seen: s.seen ? m(`${s.seen.messages.join(' | ') || 'no message'}; errors: ${s.seen.fieldErrors.map((e) => `${e.field}: ${e.message}`).join('; ') || 'none'}; dialogs open: ${s.seen.dialogs.length}`) : null,
    })),
  };
}

/**
 * What the prerequisite is run with: its own saved values, and, where it has none, what this
 * workflow's recording typed into it.
 */
export function prerequisiteValues(workflow: StudioComponent, pre: StudioComponent | undefined): Record<string, string> {
  if (!pre) return {};
  return Object.fromEntries(pre.inputs.filter((k) => !pre.meta.secretInputs.includes(k)).map((k) => [k, pre.meta.defaults[k] || workflow.meta.defaults[k] || '']));
}

async function freeName(trx: Tx, projectId: string, wanted: string): Promise<string> {
  const taken = new Set((await trx.selectFrom('repo.data_set').select('name').where('project_id', '=', projectId).execute()).map((r) => r.name.toLowerCase()));
  let name = wanted.slice(0, 110);
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted.slice(0, 105)} (${n})`;
  return name;
}

/** Planned tests saved, each with its data set, in the caller's transaction. */
export async function savePlans(
  trx: Tx,
  caller: Caller,
  projectId: string,
  plans: PlannedTest[],
  about: { intent: { prerequisites: string; intent: string; goal: string }; description: string; caseId: string | null },
): Promise<GeneratedTests> {
  const tests: GeneratedTests['tests'] = [];
  const dataSetIds: string[] = [];
  for (const plan of plans) {
    const set = await saveDataSet(
      trx,
      caller,
      projectId,
      null,
      parsed(DataSetBody, { name: await freeName(trx, projectId, `${plan.title} · data`), description: about.description, columns: plan.columns, rows: plan.rows }, 'data set'),
    );
    dataSetIds.push(set.id);
    const t = await saveTest(
      trx,
      caller,
      projectId,
      parsed(
        SaveTestBody,
        { title: plan.title, kind: 'ui', caseId: about.caseId, dataSetId: set.id, secrets: plan.secrets, steps: plan.steps, intent: { ...about.intent, goal: plan.title } },
        `test "${plan.title}"`,
      ),
    );
    tests.push({ id: t.id, key: t.key, title: t.title, rows: plan.rows.length, scenarios: plan.scenarios });
  }
  return { tests, dataSetIds };
}

/** Scenarios as tests (planTests), each with its data set, saved in one transaction. */
export async function generateTests(trx: Tx, caller: Caller, projectId: string, workflowId: string, title: string, scenarios: Scenario[]): Promise<GeneratedTests> {
  const { workflow, component, all } = await getWorkflow(trx, projectId, workflowId);
  const pre = workflow.prerequisite ? all.find((c) => c.id === workflow.prerequisite!.id) : undefined;
  const plans = planTests({
    workflow,
    partSteps: component.steps,
    prerequisiteDefaults: prerequisiteValues(component, pre),
    prerequisiteSecrets: pre?.meta.secretInputs ?? [],
    scenarios,
    title,
    extraChecks: (await getPlan(trx, projectId, workflowId)).checks,
  });
  return savePlans(trx, caller, projectId, plans, {
    intent: { prerequisites: workflow.prerequisite?.name ?? '', intent: workflow.intent || workflow.name, goal: title },
    description: `Scenarios of the workflow "${workflow.name}", a row each; the case column names them.`,
    caseId: null,
  });
}

export { submitPage };
