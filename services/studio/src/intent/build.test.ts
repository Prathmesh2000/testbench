import type { ObservedItem, PickedElement, RecordedStep } from '@tb/contracts';
import { FieldRules } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { validateSteps } from '../validate';
import { assemble } from './assemble';
import { buildDraft, stablePath } from './build';

type C = PickedElement['locators'][number];
const loc = (l: Partial<C> & Pick<C, 'strategy' | 'value'>): C => ({ code: '', matches: 1, stable: true, ...l });
const el = (tag: string, role: string | null, locators: C[], suggestedName = ''): PickedElement => ({ tag, role, text: '', xpath: '', suggestedName, page: '', url: '', locators });
const item = (kind: ObservedItem['kind'], text: string, element: PickedElement): ObservedItem => ({ kind, text, element });
const act = (s: Record<string, unknown>) => ({ tab: "A", frames: [], secret: false, element: null, ...s }) as unknown as RecordedStep;

const mobile = el('input', 'textbox', [loc({ strategy: 'label', value: 'Mobile number' })]);
const password = el('input', 'textbox', [loc({ strategy: 'label', value: 'Password' })]);
const signIn = el('button', 'button', [loc({ strategy: 'role', value: 'button', name: 'Sign in' })]);
const welcome = el('h1', 'heading', [loc({ strategy: 'role', value: 'heading', name: 'Welcome back' })]);
const search = el('input', 'searchbox', [loc({ strategy: 'placeholder', value: 'Search city' })]);
const results = el('h1', 'heading', [loc({ strategy: 'role', value: 'heading', name: 'Results' })]);
const firstResult = el('a', 'link', [
  loc({ strategy: 'role', value: 'link', name: 'Hotel Sunrise' }),
  loc({ strategy: 'role', value: 'link', within: { strategy: 'testid', value: 'results' }, nth: 0, stable: false }),
]);
const hotelName = el('h1', 'heading', [loc({ strategy: 'testid', value: 'hotel-name' })]);

const prerequisite: RecordedStep[] = [
  { action: 'open', tab: 'A', url: 'https://shop.test/login' },
  act({ action: 'type', element: mobile, value: '9123456789', field: FieldRules.parse({ type: 'tel', required: true, maxLength: 10 }) }),
  act({ action: 'type', element: password, secret: true, field: FieldRules.parse({ type: 'password', required: true }) }),
  act({ action: 'click', element: signIn }),
  { action: 'navigated', tab: 'A', url: 'https://shop.test/home' },
  { action: 'observed', tab: 'A', items: [item('heading', 'Welcome back', welcome)] },
];
const recording: RecordedStep[] = [
  act({ action: 'type', element: search, value: 'Pune', field: FieldRules.parse({ type: 'search', required: true }) }),
  act({ action: 'press', element: search, value: 'Enter' }),
  { action: 'navigated', tab: 'A', url: 'https://shop.test/results?q=Pune' },
  { action: 'observed', tab: 'A', items: [item('heading', 'Results', results)] },
  act({ action: 'click', element: firstResult }),
  { action: 'navigated', tab: 'A', url: 'https://shop.test/hotel/48213' },
  { action: 'facts', tab: 'A', url: 'https://shop.test/hotel/48213', title: 'Hotel Sunrise, Pune', items: [item('heading', 'Hotel Sunrise, Pune', hotelName)] },
];

let n = 0;
const { draft, context } = buildDraft({
  title: 'Search opens a hotel',
  intent: { prerequisites: 'Signed in as a buyer', intent: 'Search for a city and open the first result', goal: 'The hotel page shows the hotel name' },
  prerequisite,
  prerequisiteComponent: null,
  recording,
  existing: [],
  newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
});

describe('stablePath', () => {
  it('keeps the part of an address that is the same every run', () => {
    expect(stablePath('https://x/hotel/48213')).toBe('/hotel/');
    expect(stablePath('https://x/results?q=Pune')).toBe('/results');
    expect(stablePath('https://x/')).toBe('/');
  });
});

describe('buildDraft', () => {
  it('makes the prerequisite its own segment and splits the journey at page changes', () => {
    expect(draft.segments.map((s) => [s.key, s.role, s.component.name])).toEqual([
      ['prereq', 'prerequisite', 'Signed in as a buyer'],
      ['s1', 'segment', 'Enter Search city'],
      ['s2', 'segment', 'Go through on Results'],
    ]);
    expect(draft.segments[0]!.component.meta).toMatchObject({ origin: 'prerequisite', leaves: 'Signed in as a buyer', inputKinds: { mobileNumber: 'phone', password: 'password' } });
  });

  it('reads the site from the run, and the password from a secret passed into the segment', () => {
    expect(draft.segments[0]!.component.steps[0]).toMatchObject({ action: 'open', value: '{env.baseUrl}/login' });
    expect(draft.test.secrets).toEqual(['password']);
    expect(draft.test.steps[0]!.component!.inputs).toEqual({ mobileNumber: '{data.mobileNumber}', password: '{secret.password}' });
  });

  it('finds the first result by position only because the intent says "first"', () => {
    expect(draft.segments[2]!.component.steps[0]!.target).toEqual({
      locator: { strategy: 'role', value: 'link', within: { strategy: 'testid', value: 'results' }, nth: 0 },
    });
  });

  it('checks each page change and the goal from what the recording saw', () => {
    expect(draft.checks.map((c) => `${c.where}: ${c.label}`)).toEqual([
      'prereq: Address contains "/home"',
      'prereq: "Welcome back" is visible',
      's1: Address contains "/results"',
      's1: "Results" is visible',
      's2: Address contains "/hotel/"',
      // The hotel's name is content: which hotel comes first changes, so only that a name is shown.
      'test: "hotel-name" is visible',
      'test: Address contains "/hotel/"',
      'negative: Address contains "/home"',
    ]);
  });

  it('adds data variations, and a negative test that must not reach the results', () => {
    expect(draft.valid[0]!.values).toEqual({ mobileNumber: '9123456789', searchCity: 'Pune' });
    expect(draft.invalid.map((r) => r.case)).toContain('Search city left empty');
    // Only the searched form is broken; the prerequisite's login stays as recorded in every row.
    expect(draft.invalid.every((r) => r.values.mobileNumber === '9123456789')).toBe(true);
    expect(draft.valid[1]?.values.mobileNumber ?? '9123456789').toBe('9123456789');
    expect(draft.negative!.steps.map((s) => s.action)).toEqual(['use_component', 'type', 'press']);
    expect(draft.negative!.steps[0]!.component!.id).toBe(draft.segments[0]!.placeholderId);
  });

  it('assembles into components and tests that pass the save rules', () => {
    const out = assemble(draft, { rejectedChecks: [], rejectedRows: [], renamed: {} });
    const components = new Map(out.components.map((c) => [`${c.placeholderId}@1`, { inputs: c.body.inputs }]));
    for (const c of out.components) {
      const issues = validateSteps(c.body.steps, { dataColumns: c.body.inputs, secrets: [], elementIds: new Set(), components: new Map(), insideComponent: true });
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
    const issues = validateSteps(out.test.steps, { dataColumns: out.columns, secrets: out.test.secrets, elementIds: new Set(), components });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('gives the model every observed item by reference, and the page elements behind them', () => {
    expect(context.steps.map((st) => `${st.where}#${st.index} ${st.action}`)).toEqual(['prereq#0 open', 'prereq#1 type', 'prereq#2 type', 'prereq#3 click', 's1#4 type', 's1#5 press', 's2#6 click']);
    expect(context.steps[2]!.value).toBe('(secret)');
    expect(context.refs.get('3:0')).toBe(welcome);
    expect(context.end!.items[0]!.ref).toBe('end:0');
  });

  it('checks words only when they cannot change: a message, or a phrase the tester quoted', () => {
    const toast = el('div', 'status', [loc({ strategy: 'testid', value: 'toast' })]);
    const { draft: d } = buildDraft({
      title: 'Save profile',
      intent: { prerequisites: '', intent: 'Save the profile for Pune', goal: 'The page says "Profile saved"' },
      prerequisite: [],
      prerequisiteComponent: null,
      recording: [
        { action: 'open', tab: 'A', url: 'https://shop.test/profile' },
        act({ action: 'type', element: search, value: 'Pune', field: FieldRules.parse({}) }),
        act({ action: 'click', element: signIn }),
        { action: 'observed', tab: 'A', items: [item('status', 'Saved Pune as your city', toast), item('heading', 'Profile saved for Pune', welcome)] },
        { action: 'facts', tab: 'A', url: 'https://shop.test/profile', title: 'Profile', items: [item('heading', 'Profile saved for Pune', welcome)] },
      ],
      existing: [],
      newId: () => 'x',
    });
    expect(d.checks.map((c) => `${c.where}: ${c.label}`)).toEqual([
      's1: "toast" shows "Saved {data.searchCity} as your city"',
      'test: "Welcome back" shows "Profile saved"',
      // With invalid data, the success message must not appear.
      'negative: "toast" is not shown',
    ]);
  });

  it('never keeps a password or typed value that a GET form left in the address', () => {
    const { draft: d } = buildDraft({
      title: 'Opens with a query',
      intent: { prerequisites: '', intent: 'Open the dashboard', goal: 'Dashboard shows' },
      prerequisite: [],
      prerequisiteComponent: null,
      recording: [
        act({ action: 'type', element: search, value: 'Pune', field: FieldRules.parse({}) }),
        { action: 'open', tab: 'A', url: 'https://shop.test/home?q=Pune&password=hunter22&token=abc&tab=2' },
      ],
      existing: [],
      newId: () => 'x',
    });
    const open = d.segments.flatMap((sg) => sg.component.steps).find((st) => st.action === 'open')!;
    expect(open.value).toBe('{env.baseUrl}/home?tab=2');
    expect(JSON.stringify(d)).not.toContain('hunter22');
  });

  it('reuses a saved segment doing the same steps, even with its keys in another order', () => {
    const login = draft.segments[0]!;
    // As it comes back from jsonb: same values, keys reordered.
    const reorder = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v;
    const saved = { id: '11111111-1111-4111-8111-111111111111', name: 'Log in as buyer', description: '', inputs: ['mobile', 'pass'], version: 3, updatedAt: '',
      meta: login.component.meta,
      steps: login.component.steps.map((st) => reorder({ ...st, value: st.value?.replace('mobileNumber', 'mobile').replace('password', 'pass') })) as typeof login.component.steps };
    const { draft: again } = buildDraft({ title: 'Again', intent: draft.intent, prerequisite, prerequisiteComponent: null, recording, existing: [saved], newId: () => 'y' });
    expect(again.segments[0]!.reuse).toMatchObject({ id: saved.id, version: 3 });
    // Its inputs are filled from this recording's data, and the password still from the secret.
    expect(again.test.steps[0]!.component).toEqual({ id: saved.id, version: 3, inputs: { mobile: '{data.mobileNumber}', pass: '{secret.password}' } });
  });

  it('never keeps a one-time code: it comes from a secret, and the tester is told why', () => {
    const otp = el('input', 'textbox', [loc({ strategy: 'placeholder', value: 'Enter 6 digit code' })]);
    const { draft: d } = buildDraft({
      title: 'Sign in with OTP',
      intent: { prerequisites: '', intent: 'Sign in', goal: 'Dashboard' },
      prerequisite: [],
      prerequisiteComponent: null,
      recording: [
        { action: 'open', tab: 'A', url: 'https://shop.test/otp' },
        act({ action: 'type', element: otp, value: '482913', field: FieldRules.parse({ type: 'number' }) }),
        act({ action: 'click', element: signIn }),
      ],
      existing: [],
      newId: () => 'z',
    });
    expect(d.test.secrets).toEqual(['enter6DigitCode']);
    expect(JSON.stringify([d.valid, d.invalid])).not.toContain('482913');
    expect(d.notes.join(' ')).toContain('one-time code');
  });

  describe('a project form where only the name was filled and no success message was seen', () => {
    const field = (tag: string, locators: C[], label: string, rules: Partial<FieldRules>, value = '') => ({
      element: el(tag, 'textbox', locators, label), label, rules: FieldRules.parse(rules), value, secret: false,
    });
    const nameBox = el('input', 'textbox', [loc({ strategy: 'placeholder', value: 'Enter your full project name' })]);
    const form = [
      field('input', [loc({ strategy: 'placeholder', value: 'Enter your full project name' })], 'Enter your full project name', { required: true, maxLength: 60 }, 'Alpha Plan'),
      field('textarea', [loc({ strategy: 'label', value: 'Description' })], 'Description', { type: 'textarea' }),
      field('input', [loc({ strategy: 'label', value: 'Due date' })], 'Due date', { type: 'date', required: true }),
      field('select', [loc({ strategy: 'label', value: 'Priority' })], 'Priority', { type: 'select', options: ['Select', 'High', 'Low'] }),
    ];
    const add = el('button', 'button', [loc({ strategy: 'role', value: 'button', name: 'Add' })]);
    // The new project's link: found twice on the page by its name, and otherwise only by layout.
    const projectLink = { ...el('a', 'link', [loc({ strategy: 'role', value: 'link', name: 'Alpha Plan', matches: 2 }), loc({ strategy: 'css', value: 'div > div:nth-of-type(6) > a' })], 'Alpha Plan link'), text: 'Alpha Plan' };
    const recordingP: RecordedStep[] = [
      { action: 'open', tab: 'A', url: 'https://qa.test/home/projects' },
      act({ action: 'click', element: el('button', 'button', [loc({ strategy: 'role', value: 'button', name: 'Add New Project' })]) }),
      act({ action: 'type', element: nameBox, value: 'Alpha Plan', field: FieldRules.parse({ required: true, maxLength: 60 }) }),
      act({ action: 'click', element: add, form }),
      act({ action: 'click', element: projectLink }),
      { action: 'navigated', tab: 'A', url: 'https://qa.test/home/projects/77812' },
      { action: 'facts', tab: 'A', url: 'https://qa.test/home/projects/77812', title: 'Project', items: [item('heading', 'Start by creating a module', welcome)] },
    ];
    const intentP = { prerequisites: '', intent: 'Create a project and open it', goal: 'The project is created and opens' };
    const run = (answers: Record<string, string>) =>
      buildDraft({ title: 'Create a project', intent: intentP, prerequisite: [], prerequisiteComponent: null, recording: recordingP, existing: [], newId: () => `id-${Math.random()}`, answers }).draft;

    it('asks, instead of guessing, about the fields left empty and what shows success', () => {
      const d = run({});
      expect(d.questions.map((q) => [q.id, q.required, q.answer])).toEqual([['fields', true, null], ['signal', true, null]]);
      expect(d.questions[0]!.text).toContain('Description, Due date (required), Priority');
    });

    it('opens the created project through its data, not the page layout', () => {
      const steps = run({}).segments.flatMap((sg) => sg.component.steps);
      expect(steps.at(-1)!.target).toEqual({ locator: { strategy: 'role', value: 'link', name: '{data.enterYourFullProject}', nth: 0 } });
    });

    it('with the answers: every field in the data, the message checked, and a test for invalid input', () => {
      const d = run({ fields: 'all', signal: 'Project Alpha Plan created successfully' });
      expect(d.questions.every((q) => q.answer)).toBe(true);
      const form = d.segments.find((sg) => sg.component.inputs.length)!;
      expect(form.component.steps.map((st) => `${st.action} ${st.value ?? ''}`.trim())).toEqual([
        'open {env.baseUrl}/home/projects', 'click', 'type {data.enterYourFullProject}', 'type {data.description}', 'type {data.dueDate}', 'select {data.priority}', 'click', 'click',
      ]);
      expect(d.checks.map((c) => `${c.where}: ${c.label}`)).toContain('s1: "Project {data.enterYourFullProject} created successfully" is visible');
      expect(d.checks.filter((c) => c.where === 'negative').map((c) => c.label)).toEqual(['"Project {data.enterYourFullProject} created successfully" is not shown']);
      expect(d.valid.map((r) => r.case)).toEqual(['As recorded', 'Other valid values, every field filled in']);
      // As recorded: what was left empty stays empty, except the required due date; row 2 fills everything.
      expect(d.valid[0]!.values).toMatchObject({ description: '', dueDate: '2030-01-31', priority: 'High' });
      expect(d.valid[1]!.values).toMatchObject({ description: 'Test Description', dueDate: '2030-01-31', priority: 'Low' });
      expect(d.invalid.map((r) => r.case)).toEqual(expect.arrayContaining(['Enter your full project name left empty', 'Due date left empty']));
      // A native date field cannot even hold 30 February, so that is not offered as a test.
      expect(d.invalid.map((r) => r.case)).not.toContain('Due date that does not exist (30 February)');

      const out = assemble(d, { rejectedChecks: [], rejectedRows: [], renamed: {} });
      for (const c of out.components)
        expect(validateSteps(c.body.steps, { dataColumns: c.body.inputs, secrets: [], elementIds: new Set(), components: new Map(), insideComponent: true }).filter((i) => i.severity === 'error')).toEqual([]);
      const components = new Map(out.components.map((c) => [`${c.placeholderId}@1`, { inputs: c.body.inputs }]));
      for (const t of [out.test, out.negative!])
        expect(validateSteps(t.steps, { dataColumns: out.columns, secrets: t.secrets, elementIds: new Set(), components }).filter((i) => i.severity === 'error')).toEqual([]);
    });
  });
});
