import type { StudioComponent, Workflow, WorkflowPlan } from '@tb/contracts';
import { ComponentMeta, FieldRules } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { validateSteps } from '../validate';
import { journeyLead, planJourney, type JourneyPart } from './journeys';

const rules = FieldRules.parse({ required: true });
const comp = (id: string, name: string, inputs: string[], meta: Partial<ComponentMeta> = {}): StudioComponent => ({
  id, name, description: '', version: 1, inputs, updatedAt: '', meta: ComponentMeta.parse(meta),
  steps: [
    { id: 'a', action: 'type', target: { locator: { strategy: 'label', value: 'Name' } }, value: `{data.${inputs[0]}}`, assertions: [], noCheck: false, intent: '' },
    { id: 'b', action: 'click', target: { locator: { strategy: 'role', value: 'button', name: 'Save' } }, assertions: [], noCheck: true, intent: '' },
  ],
} as StudioComponent);
const wf = (c: StudioComponent, over: Partial<Workflow> = {}): Workflow => ({
  id: c.id, name: c.name, version: 1, intent: c.name, purpose: '', prerequisite: null, continuation: null, inputs: c.inputs,
  fields: c.inputs.map((k) => ({ key: k, label: k, kind: 'text', rules, recorded: `rec-${k}`, secret: false })),
  pages: [], steps: [], apis: [], baseUrl: '', submitLabel: 'Save', updatedAt: '', ...over,
});
const plan = (checks: WorkflowPlan['checks'] = []): WorkflowPlan => ({ intent: '', validations: [], messages: [], scenarios: [], checks });
const sc = (id: string, values: Record<string, string>, outcome: 'success' | 'rejected', message = '') => ({
  id, title: id, kind: 'positive' as const, values, seen: null, status: 'confirmed' as const, source: 'tester' as const,
  expect: { outcome, message, fieldErrors: outcome === 'rejected' ? [{ field: 'name', message: 'Name is required', source: 'page' as const }] : [], page: 'any' as const, dialog: 'any' as const, stop: null, checks: [] },
});

const signIn = comp('00000000-0000-4000-8000-000000000001', 'Sign in', ['email', 'password'], { secretInputs: ['password'] });
const project = comp('00000000-0000-4000-8000-000000000002', 'Create a project', ['name']);
const cont = comp('00000000-0000-4000-8000-000000000004', 'Open it', ['name']);
const moduleC = comp('00000000-0000-4000-8000-000000000003', 'Add a module', ['name']);
const parts: JourneyPart[] = [
  { workflow: wf(project, { prerequisite: { id: signIn.id, name: 'Sign in', version: 1, inputs: signIn.inputs, inputKinds: {} }, continuation: { id: cont.id, version: 1, inputs: ['name'] } }), component: project, plan: plan([{ kind: 'api_called', key: 'POST /api/projects', expected: '201', soft: false }]), scenarios: [sc('p-ok', { name: 'Alpha {unique}' }, 'success', 'Project Alpha {unique} created')] },
  { workflow: wf(moduleC), component: moduleC, plan: plan([{ kind: 'local_storage', key: 'lastModule', soft: false }]), scenarios: [sc('m-ok', { name: 'Login' }, 'success', 'Module created'), sc('m-empty', { name: '' }, 'rejected')] },
];

describe('journeyLead', () => {
  it('runs the prerequisite and every earlier workflow, checking each worked, with their own columns', () => {
    const lead = journeyLead(parts, { component: signIn, values: { email: 'qa@x.test' } });
    expect(lead.steps.map((s) => s.id)).toEqual(['u-pre', 'j1-wf', 'j1-ok', 'j1-after']);
    // Both workflows read "name": the earlier one's column says whose it is; the last keeps the plain name.
    expect(lead.steps[1]!.component!.inputs).toEqual({ name: '{data.s1_name}' });
    expect(lead.steps[0]!.component!.inputs).toEqual({ email: '{data.email}', password: '{secret.password}' });
    expect(lead.row).toEqual({ email: 'qa@x.test', s1_name: 'Alpha {unique}', s1_expectedMessage: 'Project Alpha {unique} created' });
    expect(lead.steps[2]!.assertions.map((a) => a.kind)).toEqual(['visible', 'api_called']);
  });
});

describe('planJourney', () => {
  it('makes the last workflow’s scenarios data rows after the lead, grouped by what they expect', () => {
    const plans = planJourney('Project to module', parts, { component: signIn, values: { email: 'qa@x.test' } });
    expect(plans.map((p) => [p.title, p.rows.map((r) => r.name)])).toEqual([
      ['Project to module', ['Login']],
      ['Project to module refuses invalid name', ['']],
    ]);
    expect(plans[0]!.steps.map((s) => s.id)).toEqual(['u-pre', 'j1-wf', 'j1-ok', 'j1-after', 'u-wf', 'check-ok']);
    expect(plans[0]!.steps.at(-1)!.assertions.at(-1)).toMatchObject({ kind: 'local_storage', key: 'lastModule' });
    expect(plans[0]!.secrets).toEqual(['password']);
    const components = new Map([signIn, project, cont, moduleC].map((c) => [`${c.id}@1`, { inputs: c.inputs }]));
    for (const p of plans)
      expect(validateSteps(p.steps, { dataColumns: p.columns, secrets: p.secrets, elementIds: new Set(), components }).filter((i) => i.severity === 'error')).toEqual([]);
  });
});
