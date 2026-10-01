import type { Scenario, Seen, Workflow } from '@tb/contracts';
import { FieldRules } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { validateSteps } from '../validate';
import { applyChat, checkMisses, differences, expectationFromSeen, planTests } from './scenarios';

const rules = (r: Partial<FieldRules>) => FieldRules.parse(r);
const nameBox = { strategy: 'placeholder' as const, value: 'Enter your full project name' };
const workflow: Workflow = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Create a project',
  version: 2,
  intent: 'Create a new project',
  purpose: '',
  prerequisite: { id: '22222222-2222-4222-8222-222222222222', name: 'Sign in', version: 1, inputs: ['email', 'password'], inputKinds: { email: 'email', password: 'password' } },
  continuation: { id: '33333333-3333-4333-8333-333333333333', version: 1, inputs: ['name'] },
  inputs: ['name', 'priority'],
  fields: [
    { key: 'name', label: 'Enter your full project name', kind: 'text', rules: rules({ required: true, maxLength: 60 }), recorded: 'Alpha', secret: false },
    { key: 'priority', label: 'Priority', kind: 'select', rules: rules({ type: 'select', options: ['Select', 'High', 'Low'] }), recorded: 'High', secret: false },
  ],
  pages: [
    {
      path: '/home/projects', title: 'Projects', headings: ['Projects'], fields: [],
      actions: [{ label: 'Add', locator: { strategy: 'role', value: 'button', name: 'Add' } }],
      messages: [{ kind: 'dialog', text: 'New project', after: 'Add New Project' }],
    },
  ],
  steps: [
    { id: 'a', label: 'type “Enter your full project name”', action: 'type' },
    { id: 'b', label: 'click “Add”', action: 'click' },
  ],
  baseUrl: 'http://shop.test',
  apis: [],
  submitLabel: 'Add',
  updatedAt: '',
};
const partSteps = [
  { id: 'a', action: 'type' as const, target: { locator: nameBox }, value: '{data.name}', assertions: [], noCheck: false, intent: '' },
  { id: 'b', action: 'click' as const, target: { locator: { strategy: 'role' as const, value: 'button', name: 'Add' } }, assertions: [], noCheck: true, intent: '' },
];
const seen = (s: Partial<Seen>): Seen => ({ url: 'http://shop.test/home/projects', title: 'Projects', dialogs: [], messages: [], fieldErrors: [], failed: null, stoppedAt: null, storage: [], apis: [], ...s });

describe('what discovery saw', () => {
  it('reads refusal, its inline errors and the dialog from the page', () => {
    const e = expectationFromSeen(workflow, seen({ dialogs: ['New project'], fieldErrors: [{ field: 'Enter your full project name', message: 'Project name is required', source: 'page' }] }));
    expect(e).toEqual({ outcome: 'rejected', message: '', fieldErrors: [{ field: 'name', message: 'Project name is required', source: 'page' }], page: 'stays', dialog: 'stays_open', stop: null, checks: [] });
    expect(expectationFromSeen(workflow, seen({ messages: ['Project Alpha created successfully'] }))).toMatchObject({ outcome: 'success', message: 'Project Alpha created successfully', dialog: 'closes' });
  });

  it('says where the expectation and the app disagree', () => {
    const expectOk = { outcome: 'success' as const, message: 'Created', fieldErrors: [], page: 'any' as const, dialog: 'closes' as const, stop: null, checks: [] };
    expect(differences(workflow, expectOk, seen({ dialogs: ['New project'], fieldErrors: [{ field: 'Priority', message: 'Pick one', source: 'page' }] }))).toEqual([
      'Expected it to be accepted, but it was refused.',
      'Expected the message "Created", saw no message.',
      'Expected the dialog to close; it stayed open.',
    ]);
  });

  it('reads a server’s refusal from its message, with the dialog still open', () => {
    expect(expectationFromSeen(workflow, seen({ dialogs: ['New project'], messages: ['A project with this name already exists'] }))).toMatchObject({
      outcome: 'rejected',
      message: 'A project with this name already exists',
      dialog: 'stays_open',
    });
  });

  it('sees a submit kept disabled as a refusal that stops the workflow there', () => {
    const s = seen({ failed: '"Add": the element is disabled.', stoppedAt: { stepId: 'b', kind: 'disabled' }, fieldErrors: [{ field: 'Enter your full project name', message: 'Too short', source: 'page' }] });
    expect(expectationFromSeen(workflow, s)).toMatchObject({ outcome: 'rejected', stop: { stepId: 'b', kind: 'disabled' }, fieldErrors: [{ field: 'name', message: 'Too short' }] });
    const refusedAtSubmit = { outcome: 'rejected' as const, message: '', fieldErrors: [{ field: 'name', message: 'Too short', source: 'page' as const }], page: 'any' as const, dialog: 'any' as const, stop: null, checks: [] };
    expect(differences(workflow, refusedAtSubmit, s)).toEqual(['It stopped before the end: “click “Add”” was disabled.']);
  });
});

describe('applyChat', () => {
  it('keeps what fits the workflow and drops the rest', () => {
    const { scenarios, dropped } = applyChat(workflow, [], {
      reply: 'ok',
      scenarios: [
        { title: 'Low priority', kind: 'positive', values: { priority: 'Low' }, expect: { outcome: 'success', message: '', fieldErrors: [], page: 'any', dialog: 'any' } },
        { title: 'Wrong password', kind: 'negative', values: { password: 'x' }, expect: { outcome: 'rejected', message: '', fieldErrors: [], page: 'any', dialog: 'any' } },
        { title: 'Name over 60', kind: 'negative', values: { name: 'A'.repeat(61) }, expect: { outcome: 'rejected', message: '', fieldErrors: [], page: 'any', dialog: 'any' } },
      ],
    });
    expect(scenarios.map((s) => [s.title, s.values])).toEqual([['Low priority', { name: 'Alpha', priority: 'Low' }]]);
    expect(dropped).toBe(2);
  });
});

describe('planTests', () => {
  const sc = (id: string, values: Record<string, string>, expectation: Partial<Scenario['expect']>): Scenario => ({
    id, title: id, kind: 'positive', values: { name: 'Alpha', priority: 'High', ...values }, seen: null, status: 'confirmed', source: 'tester',
    expect: { outcome: 'success', message: '', fieldErrors: [], page: 'any', dialog: 'any', stop: null, checks: [], ...expectation },
  });
  const scenarios = [
    sc('ok1', {}, { message: 'Project Alpha created successfully', dialog: 'closes' }),
    sc('ok2', { name: 'Beta' }, { message: 'Project Beta created successfully', dialog: 'closes' }),
    sc('empty', { name: '' }, { outcome: 'rejected', page: 'stays', dialog: 'stays_open', fieldErrors: [{ field: 'name', message: 'Please fill out this field.', source: 'native' }] }),
    sc('spaces', { name: '   ' }, { outcome: 'rejected', page: 'stays', dialog: 'stays_open', fieldErrors: [{ field: 'name', message: 'Project name is required', source: 'native' }] }),
    sc('nopri', { priority: 'Select' }, { outcome: 'rejected', page: 'stays', fieldErrors: [{ field: 'priority', message: 'Pick a priority', source: 'page' }] }),
  ];
  const plans = planTests({ workflow, partSteps, prerequisiteDefaults: { email: 'qa@x.test' }, prerequisiteSecrets: ['password'], scenarios, title: 'Create a project' });

  it('makes one data-driven test per thing expected, a row per scenario', () => {
    expect(plans.map((p) => [p.title, p.scenarios])).toEqual([
      ['Create a project', ['ok1', 'ok2']],
      ['Create a project refuses invalid Enter your full project name (browser message)', ['empty', 'spaces']],
      ['Create a project refuses invalid Priority', ['nopri']],
    ]);
    expect(plans[0]!.rows[1]).toEqual({ email: 'qa@x.test', name: 'Beta', priority: 'High', expectedMessage: 'Project Beta created successfully', case: 'ok2' });
    expect(plans[1]!.rows.map((r) => r.expected_name_browser)).toEqual(['Please fill out this field.', 'Project name is required']);
  });

  it('asserts each inline error its own way: the browser message on the field, page text as text', () => {
    const refusedName = plans[1]!.steps.at(-1)!.assertions;
    expect(refusedName).toEqual([
      { kind: 'validation_message', target: { locator: nameBox }, expected: '{data.expected_name_browser}', soft: false },
      { kind: 'hidden', target: { locator: { strategy: 'text', value: 'Project {data.name} created successfully' } }, soft: false },
      { kind: 'url_contains', expected: '/home/projects', soft: false },
      { kind: 'visible', target: { locator: { strategy: 'role', value: 'dialog' } }, soft: false },
    ]);
    expect(plans[2]!.steps.at(-1)!.assertions[0]).toEqual({ kind: 'visible', target: { locator: { strategy: 'text', value: '{data.expected_priority}' } }, soft: false });
  });

  it('runs the continuation only after success, and every test passes the save rules', () => {
    expect(plans[0]!.steps.map((s) => s.id)).toEqual(['u-pre', 'u-wf', 'check-ok', 'u-after']);
    expect(plans[1]!.steps.map((s) => s.id)).toEqual(['u-pre', 'u-wf', 'check-refused']);
    const components = new Map([
      [`${workflow.prerequisite!.id}@1`, { inputs: ['email', 'password'] }],
      [`${workflow.id}@2`, { inputs: ['name', 'priority'] }],
      [`${workflow.continuation!.id}@1`, { inputs: ['name'] }],
    ]);
    for (const p of plans)
      expect(validateSteps(p.steps, { dataColumns: p.columns, secrets: p.secrets, elementIds: new Set(), components }).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('keeps the browser message and the page text as two checks when a field shows both', () => {
    const both = planTests({
      workflow, partSteps, prerequisiteDefaults: {}, prerequisiteSecrets: ['password'], title: 'Create a project',
      scenarios: [sc('empty', { name: '' }, { outcome: 'rejected', fieldErrors: [
        { field: 'name', message: 'Please fill out this field.', source: 'native' },
        { field: 'name', message: 'Project name is required', source: 'page' },
      ] })],
    });
    expect(both[0]!.columns).toEqual(['email', 'name', 'priority', 'expected_name_browser', 'expected_name', 'case']);
    expect(both[0]!.rows[0]).toMatchObject({ expected_name_browser: 'Please fill out this field.', expected_name: 'Project name is required' });
  });

  it('runs a refusal that stops early only up to its stop, and checks the stop and the app’s message', () => {
    const plans2 = planTests({
      workflow, partSteps, prerequisiteDefaults: {}, prerequisiteSecrets: ['password'], title: 'Create a project',
      scenarios: [
        sc('short', { name: 'A' }, { outcome: 'rejected', stop: { stepId: 'b', kind: 'disabled' }, fieldErrors: [{ field: 'name', message: 'Too short', source: 'page' }] }),
        sc('dup', { name: 'Alpha' }, { outcome: 'rejected', message: 'Project name already exists' }),
      ],
    });
    const early = plans2.find((p) => p.scenarios.includes('short'))!;
    expect(early.steps.map((s) => s.id)).toEqual(['u-pre', 'wf-a', 'check-refused']);
    expect(early.steps.at(-1)!.assertions[0]).toEqual({ kind: 'disabled', target: { locator: { strategy: 'role', value: 'button', name: 'Add' } }, soft: false });
    const dup = plans2.find((p) => p.scenarios.includes('dup'))!;
    expect(dup.rows[0]).toMatchObject({ expectedMessage: 'Project name already exists' });
    expect(dup.steps.at(-1)!.assertions[0]).toEqual({ kind: 'visible', target: { locator: { strategy: 'text', value: '{data.expectedMessage}' } }, soft: false });
    for (const p of plans2)
      expect(validateSteps(p.steps, { dataColumns: p.columns, secrets: p.secrets, elementIds: new Set(), components: new Map([[`${workflow.prerequisite!.id}@1`, { inputs: ['email', 'password'] }], [`${workflow.id}@2`, { inputs: ['name', 'priority'] }]]) }).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('checkMisses', () => {
  const s = seen({
    storage: [{ area: 'local', key: 'lastProject', value: 'Alpha' }, { area: 'cookie', key: 'session', value: '••••' }],
    apis: [{ method: 'POST', path: '/api/projects', status: 201 }, { method: 'GET', path: '/api/projects/42', status: 200 }],
  });
  it('holds when the key is there with its value, or the API was called with its status', () => {
    expect(checkMisses({ kind: 'local_storage', key: 'lastProject', expected: 'Alpha', soft: false }, s)).toBeNull();
    expect(checkMisses({ kind: 'cookie', key: 'session', expected: 'abc', soft: false }, s)).toBeNull();
    expect(checkMisses({ kind: 'api_called', key: 'GET /api/projects/:id', expected: '200', soft: false }, s)).toBeNull();
  });
  it('says what was missing or different', () => {
    expect(checkMisses({ kind: 'session_storage', key: 'draft', soft: false }, s)).toBe('Expected session storage “draft” to be set; it was not.');
    expect(checkMisses({ kind: 'local_storage', key: 'lastProject', expected: 'Beta', soft: false }, s)).toBe('Expected local storage “lastProject” to be “Beta”; it was “Alpha”.');
    expect(checkMisses({ kind: 'api_called', key: 'POST /api/projects', expected: '200', soft: false }, s)).toBe('Expected POST /api/projects to answer 200; it answered 201.');
    expect(checkMisses({ kind: 'api_called', key: 'DELETE /api/projects/:id', soft: false }, s)).toBe('Expected a call to DELETE /api/projects/:id; the page made none.');
  });
});

