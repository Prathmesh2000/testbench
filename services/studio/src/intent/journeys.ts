import type { Assertion, AutoStep, JourneyBody, JourneyResult, Scenario, StudioComponent, Workflow, WorkflowPlan } from '@tb/contracts';
import { caseKey, CreateCaseBody } from '@tb/contracts';
import { badRequest, notFound, type Tx } from '@tb/platform';
import { createCase } from '@tb/repository';
import { getPlan } from '../site';
import { listComponents } from '../tests';
import { planTests, type PlannedTest } from './scenarios';
import { generateTests, getWorkflow, prerequisiteValues, savePlans } from './workflow-service';

// A journey is workflows in the order a user goes through them (sign in → create a project → add a
// module), and it is what a test case automates. Every workflow but the last runs one positive
// scenario and must succeed; the last runs as many scenarios as asked, a data row each, and is
// grouped into tests the way a single workflow's scenarios are (planTests).

export interface JourneyPart {
  workflow: Workflow;
  component: StudioComponent;
  plan: WorkflowPlan;
  scenarios: Scenario[];
}

const step = (id: string, action: AutoStep['action'], rest: Partial<AutoStep>): AutoStep => ({ id, action, assertions: [], noCheck: false, intent: '', ...rest });

/** The steps, columns and values that bring the app to where the last workflow starts. */
export function journeyLead(
  parts: JourneyPart[],
  prerequisite: { component: StudioComponent; values: Record<string, string> } | null,
): { steps: AutoStep[]; columns: string[]; row: Record<string, string>; secrets: string[] } {
  const last = parts.at(-1)!;
  const earlier = parts.slice(0, -1);
  const secrets = new Set<string>(prerequisite?.component.meta.secretInputs ?? []);
  for (const p of parts) for (const f of p.workflow.fields) if (f.secret) secrets.add(f.key);
  // A column keeps its plain name unless two workflows read one of that name: then it says whose it is.
  const owners = new Map<string, number>();
  for (const p of parts) for (const k of new Set([...p.workflow.inputs, ...(p.workflow.continuation?.inputs ?? [])])) owners.set(k, (owners.get(k) ?? 0) + 1);
  const lastKeys = new Set([...last.workflow.inputs, ...(last.workflow.continuation?.inputs ?? [])]);
  const colOf = (i: number, k: string) => (secrets.has(k) || (owners.get(k) ?? 0) < 2 || (i === parts.length - 1 && lastKeys.has(k)) ? k : `s${i + 1}_${k}`.slice(0, 60));
  const inputsOf = (i: number, keys: string[]) => Object.fromEntries(keys.map((k) => [k, secrets.has(k) ? `{secret.${k}}` : `{data.${colOf(i, k)}}`]));

  const steps: AutoStep[] = [];
  const row: Record<string, string> = {};
  const columns: string[] = [];
  const col = (name: string, value: string) => {
    if (!columns.includes(name)) columns.push(name);
    row[name] = value;
  };
  if (prerequisite) {
    const c = prerequisite.component;
    steps.push(step('u-pre', 'use_component', { component: { id: c.id, version: c.version, inputs: inputsOf(-1, c.inputs) }, intent: `Prerequisite: ${c.name}`, noCheck: true }));
    for (const k of c.inputs) if (!secrets.has(k)) col(k, prerequisite.values[k] ?? '');
  }
  earlier.forEach((p, i) => {
    const s = p.scenarios[0]!;
    const w = p.workflow;
    steps.push(step(`j${i + 1}-wf`, 'use_component', { component: { id: w.id, version: w.version, inputs: inputsOf(i, w.inputs) }, intent: `${i + 1}. ${w.name}`, noCheck: true }));
    for (const k of w.inputs) if (!secrets.has(k)) col(colOf(i, k), s.values[k] ?? w.fields.find((f) => f.key === k)?.recorded ?? '');
    // Each workflow on the way must have worked before the next one starts from where it left.
    const checks: Assertion[] = [];
    if (s.expect.message) {
      col(`s${i + 1}_expectedMessage`, s.expect.message);
      checks.push({ kind: 'visible', target: { locator: { strategy: 'text', value: `{data.s${i + 1}_expectedMessage}` } }, soft: false });
    }
    if (s.expect.dialog === 'closes') checks.push({ kind: 'hidden', target: { locator: { strategy: 'role', value: 'dialog' } }, soft: false });
    checks.push(...s.expect.checks, ...p.plan.checks);
    steps.push(step(`j${i + 1}-ok`, 'verify', { intent: `${w.name} worked`, assertions: checks, noCheck: checks.length === 0 }));
    if (w.continuation) {
      const cont = w.continuation;
      steps.push(step(`j${i + 1}-after`, 'use_component', { component: { id: cont.id, version: cont.version, inputs: inputsOf(i, cont.inputs) }, intent: `After ${w.submitLabel || w.name}`, noCheck: true }));
      for (const k of cont.inputs) if (!secrets.has(k)) col(colOf(i, k), s.values[k] ?? '');
    }
  });
  return { steps, columns, row, secrets: [...secrets] };
}

export function planJourney(title: string, parts: JourneyPart[], prerequisite: { component: StudioComponent; values: Record<string, string> } | null): PlannedTest[] {
  const last = parts.at(-1)!;
  if (parts.length === 1)
    return planTests({ workflow: last.workflow, partSteps: last.component.steps, prerequisiteDefaults: prerequisite?.values ?? {}, prerequisiteSecrets: prerequisite?.component.meta.secretInputs ?? [], scenarios: last.scenarios, title, extraChecks: last.plan.checks });
  const lead = journeyLead(parts, prerequisite);
  return planTests({
    workflow: last.workflow,
    partSteps: last.component.steps,
    prerequisiteDefaults: {},
    prerequisiteSecrets: lead.secrets,
    scenarios: last.scenarios,
    title,
    extraChecks: last.plan.checks,
    before: { steps: lead.steps, columns: lead.columns, row: lead.row },
  });
}

/** A journey's tests saved, each with its data set, and linked to its test case (an existing one or a new one). */
export async function generateJourney(trx: Tx, caller: { orgId: string; userId: string }, projectId: string, body: JourneyBody): Promise<JourneyResult> {
  const all = await listComponents(trx, projectId);
  const parts: JourneyPart[] = [];
  for (const [i, p] of body.parts.entries()) {
    const { workflow, component } = await getWorkflow(trx, projectId, p.workflowId);
    const plan = await getPlan(trx, projectId, p.workflowId);
    const scenarios = p.scenarioIds.map((id) => plan.scenarios.find((s) => s.id === id)).filter((s): s is Scenario => !!s);
    if (!scenarios.length) throw badRequest(`Pick a scenario of “${workflow.name}”: it has none saved with those ids.`);
    const isLast = i === body.parts.length - 1;
    if (!isLast && (scenarios.length !== 1 || scenarios[0]!.expect.outcome !== 'success'))
      throw badRequest(`“${workflow.name}” comes before another workflow, so it runs one scenario that succeeds.`);
    parts.push({ workflow, component, plan, scenarios });
  }
  const first = parts[0]!;
  const preComponent = first.workflow.prerequisite ? all.find((c) => c.id === first.workflow.prerequisite!.id) : undefined;
  const prerequisite = preComponent ? { component: preComponent, values: prerequisiteValues(first.component, preComponent) } : null;
  const plans = planJourney(body.title, parts, prerequisite);

  let caseId = body.caseId;
  let key: string | null = null;
  if (caseId) {
    const found = await trx.selectFrom('repo.test_case').select(['id', 'key_no']).where('id', '=', caseId).where('project_id', '=', projectId).executeTakeFirst();
    if (!found) throw notFound('Test case');
    key = caseKey(found.key_no);
  } else if (body.createCase) {
    const created = await createCase(
      trx,
      caller,
      projectId,
      CreateCaseBody.parse({
        moduleId: body.createCase.moduleId,
        title: body.title,
        preconditions: first.workflow.prerequisite ? `${first.workflow.prerequisite.name}.` : '',
        steps: parts.map((p, i) => ({
          action: `${p.workflow.name}: ${p.workflow.intent || 'run the workflow'}`.slice(0, 2000),
          expected: (i < parts.length - 1 ? p.scenarios[0]!.expect.message || 'It succeeds.' : `${p.scenarios.length} scenario${p.scenarios.length === 1 ? '' : 's'} as agreed for this workflow.`).slice(0, 2000),
        })),
        automation: 'automated',
      }),
    );
    caseId = created.id;
    key = created.key;
  }
  const saved = await savePlans(trx, caller, projectId, plans, {
    intent: { prerequisites: first.workflow.prerequisite?.name ?? '', intent: parts.map((p) => p.workflow.name).join(' → '), goal: body.title },
    description: `Journey: ${parts.map((p) => p.workflow.name).join(' → ')}; a row per scenario of the last one.`,
    caseId,
  });
  return { tests: saved.tests.map((t) => ({ id: t.id, key: t.key, title: t.title, rows: t.rows })), caseId, caseKey: key };
}

/** The scenario a workflow runs on the way to another: its first confirmed success, or its recorded values. */
function passingScenario(w: Workflow, plan: WorkflowPlan): Scenario {
  const found = plan.scenarios.find((s) => s.status === 'confirmed' && s.expect.outcome === 'success') ?? plan.scenarios.find((s) => s.expect.outcome === 'success');
  if (found) return found;
  return {
    id: 'recorded',
    title: `${w.name} with the recorded values`,
    kind: 'positive',
    values: Object.fromEntries(w.fields.filter((f) => !f.secret).map((f) => [f.key, f.recorded])),
    expect: { outcome: 'success', message: '', fieldErrors: [], page: 'any', dialog: 'any', stop: null, checks: [] },
    seen: null,
    status: 'draft',
    source: 'rule',
  };
}

/**
 * Tests for one workflow's scenarios. When what it needs first is itself a workflow (adding a module
 * needs a project made just before), the tests run that chain as a journey, so each starts where it must.
 */
export async function generateForWorkflow(trx: Tx, caller: { orgId: string; userId: string }, projectId: string, workflowId: string, title: string, scenarios: Scenario[]) {
  const all = await listComponents(trx, projectId);
  const chain: JourneyPart[] = [];
  let current = await getWorkflow(trx, projectId, workflowId);
  const seen = new Set([workflowId]);
  for (;;) {
    const preId = current.workflow.prerequisite?.id;
    const pre = preId ? all.find((c) => c.id === preId) : undefined;
    if (!pre || pre.meta.origin !== 'workflow' || seen.has(pre.id) || chain.length >= 8) break;
    seen.add(pre.id);
    current = await getWorkflow(trx, projectId, pre.id);
    const plan = await getPlan(trx, projectId, pre.id);
    chain.unshift({ workflow: current.workflow, component: current.component, plan, scenarios: [passingScenario(current.workflow, plan)] });
  }
  if (!chain.length) return generateTests(trx, caller, projectId, workflowId, title, scenarios);
  const { workflow, component } = await getWorkflow(trx, projectId, workflowId);
  const parts = [...chain, { workflow, component, plan: await getPlan(trx, projectId, workflowId), scenarios }];
  const first = chain[0]!;
  const preComponent = first.workflow.prerequisite ? all.find((c) => c.id === first.workflow.prerequisite!.id) : undefined;
  const plans = planJourney(title, parts, preComponent ? { component: preComponent, values: prerequisiteValues(first.component, preComponent) } : null);
  return savePlans(trx, caller, projectId, plans, {
    intent: { prerequisites: chain.map((p) => p.workflow.name).join(' → '), intent: workflow.intent || workflow.name, goal: title },
    description: `Scenarios of the workflow "${workflow.name}", after ${chain.map((p) => p.workflow.name).join(' → ')}; a row each.`,
    caseId: null,
  });
}
