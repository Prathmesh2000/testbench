import type { Assertion, AutoStep, Expectation, Locator, Scenario, ScenarioChatAnswer, Seen, Workflow } from '@tb/contracts';
// The recording's own path function: a workflow's pages were saved with it, so they compare equal.
import { stablePath } from './build';

// Scenarios for a saved workflow: built from what the tester wants tested (validations.ts), discussed in the chat, checked
// against what the app really does (a discovery run), and finally grouped into data-driven tests.
// No database here.


/** The path of the page the workflow submits on. */
export function submitPage(w: Workflow): string {
  return w.pages.find((p) => p.actions.some((a) => a.label === w.submitLabel || a.locator.name === w.submitLabel))?.path ?? w.pages[0]?.path ?? '/';
}

const ERROR_WORDS = /\b(already|exists?|invalid|error|failed|not allowed|cannot|can't|unable|denied|duplicate|required|must)\b/i;
const hadDialog = (w: Workflow) => w.pages.some((p) => p.messages.some((m) => m.kind === 'dialog'));

/**
 * The model's proposed list, made safe: only the workflow's own non-secret inputs, no value a native
 * date, number or maxlength field cannot hold, and what discovery already saw kept for scenarios left unchanged.
 */
export function applyChat(w: Workflow, current: Scenario[], answer: ScenarioChatAnswer): { scenarios: Scenario[]; dropped: number } {
  const inputs = new Set(w.fields.filter((f) => !f.secret).map((f) => f.key));
  const rules = new Map(w.fields.map((f) => [f.key, f.rules]));
  const base = Object.fromEntries(w.fields.filter((f) => !f.secret).map((f) => [f.key, f.recorded]));
  let dropped = 0;
  const out: Scenario[] = [];
  for (const s of answer.scenarios) {
    const keys = Object.keys(s.values);
    const untypeable = keys.some((k) => {
      const t = rules.get(k)?.type;
      const v = s.values[k] ?? '';
      const max = rules.get(k)?.maxLength ?? -1;
      // The browser cuts a typed value at the field's maxlength, so the app never receives the rest.
      return (t === 'number' && v !== '' && !/^-?\d+(\.\d+)?$/.test(v)) || (t === 'date' && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) || (max > 0 && v.length > max);
    });
    if (keys.some((k) => !inputs.has(k)) || untypeable || s.expect.fieldErrors.some((e) => !inputs.has(e.field))) {
      dropped++;
      continue;
    }
    const values = { ...base, ...s.values };
    const before = current.find((c) => c.id === s.id);
    const same = before && JSON.stringify(before.values) === JSON.stringify(values);
    out.push({
      id: s.id && !out.some((o) => o.id === s.id) ? s.id : `s${out.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
      title: s.title,
      kind: s.kind,
      values,
      expect: {
        ...s.expect,
        fieldErrors: s.expect.fieldErrors.map((e) => ({ ...e, source: before?.expect.fieldErrors.find((x) => x.field === e.field)?.source ?? 'page' })),
        // Where a refusal stops the workflow is seen by running it, not said by the model.
        stop: same ? before!.expect.stop : null,
        checks: before?.expect.checks ?? [],
      },
      seen: same ? before!.seen : null,
      status: same ? before!.status : 'draft',
      source: before && same ? before.source : 'ai',
    });
  }
  return { scenarios: out, dropped };
}

/** What discovery saw, as an expectation: what the tester is shown to confirm or correct. */
export function expectationFromSeen(w: Workflow, seen: Seen): Expectation {
  const byLabel = new Map(w.fields.map((f) => [f.label.toLowerCase(), f.key]));
  const fieldErrors = seen.fieldErrors
    .map((e) => ({ field: byLabel.get(e.field.toLowerCase()) ?? '', message: e.message, source: e.source }))
    .filter((e) => e.field);
  // Refused by the server comes as a message ("already exists"), with the form's dialog still open.
  const errorMessage = seen.messages.some((m) => ERROR_WORDS.test(m));
  const dialogOpen = seen.dialogs.length > 0 && hadDialog(w);
  const rejected = !!seen.failed || fieldErrors.length > 0 || errorMessage || (dialogOpen && seen.messages.length === 0);
  const moved = stablePath(seen.url) !== submitPage(w);
  const stopped = seen.stoppedAt && seen.stoppedAt.kind !== 'error' ? { stepId: seen.stoppedAt.stepId, kind: seen.stoppedAt.kind } : null;
  return {
    outcome: rejected ? 'rejected' : 'success',
    // A refusal can come as a message too (a duplicate, refused by the server): kept to be checked.
    message: seen.messages[0] ?? '',
    fieldErrors,
    page: moved ? 'moves_on' : 'stays',
    dialog: !hadDialog(w) ? 'any' : seen.dialogs.length ? 'stays_open' : 'closes',
    stop: stopped,
    // Storage and API checks are the tester's to choose; what the run saw is compared with them.
    checks: [],
  };
}

/** Where what was expected and what the app did disagree, in words; empty when they agree. */
export function differences(w: Workflow, e: Expectation, seen: Seen): string[] {
  const got = expectationFromSeen(w, seen);
  const label = (k: string) => w.fields.find((f) => f.key === k)?.label ?? k;
  const step = (id: string) => w.steps.find((x) => x.id === id)?.label ?? 'a step';
  const out: string[] = [];
  if (got.stop && !e.stop) out.push(`It stopped before the end: “${step(got.stop.stepId)}” was ${got.stop.kind === 'disabled' ? 'disabled' : 'not there'}.`);
  else if (e.stop && !got.stop) out.push(`Expected “${step(e.stop.stepId)}” to be ${e.stop.kind === 'disabled' ? 'disabled' : 'missing'}; it could be used.`);
  else if (e.stop && got.stop && (e.stop.stepId !== got.stop.stepId || e.stop.kind !== got.stop.kind))
    out.push(`Expected it to stop at “${step(e.stop.stepId)}”; it stopped at “${step(got.stop.stepId)}” (${got.stop.kind}).`);
  else if (seen.failed && !got.stop) out.push(`A step could not be done: ${seen.failed}`);
  if (e.outcome !== got.outcome) out.push(e.outcome === 'success' ? 'Expected it to be accepted, but it was refused.' : 'Expected it to be refused, but it was accepted.');
  if (e.message && !seen.messages.some((m) => m.includes(e.message))) out.push(`Expected the message "${e.message}", saw ${seen.messages.length ? `"${seen.messages[0]}"` : 'no message'}.`);
  for (const fe of e.fieldErrors) {
    const saw = got.fieldErrors.filter((x) => x.field === fe.field);
    if (!saw.length) out.push(`Expected an error on ${label(fe.field)}, saw none.`);
    else if (fe.message && !saw.some((x) => x.message.includes(fe.message))) out.push(`Expected "${fe.message}" on ${label(fe.field)}, saw "${saw[0]!.message}".`);
  }
  if (e.dialog !== 'any' && got.dialog !== 'any' && e.dialog !== got.dialog) out.push(e.dialog === 'closes' ? 'Expected the dialog to close; it stayed open.' : 'Expected the dialog to stay open; it closed.');
  if (e.page !== 'any' && e.page !== got.page) out.push(e.page === 'moves_on' ? 'Expected to move to another page; it stayed.' : 'Expected to stay on the page; it moved on.');
  for (const c of e.checks) {
    const miss = checkMisses(c, seen);
    if (miss) out.push(miss);
  }
  return out;
}

const AREA = { cookie: 'cookie', local_storage: 'local', session_storage: 'session' } as const;
const MASKED = /•/;

/** Where a storage or API check disagrees with what a run saw; null when it holds (or cannot be told). */
export function checkMisses(c: Assertion, seen: Seen): string | null {
  const key = (c.key ?? '').trim();
  if (c.kind === 'cookie' || c.kind === 'local_storage' || c.kind === 'session_storage') {
    const where = c.kind === 'cookie' ? 'cookie' : c.kind === 'local_storage' ? 'local storage' : 'session storage';
    const found = seen.storage.find((x) => x.area === AREA[c.kind as keyof typeof AREA] && x.key === key);
    if (!found) return `Expected ${where} “${key}” to be set; it was not.`;
    // A masked value (a token, say) cannot be compared here; the test compares it at run time.
    if (c.expected && !c.expected.includes('{') && !MASKED.test(found.value) && found.value !== c.expected) return `Expected ${where} “${key}” to be “${c.expected}”; it was “${found.value}”.`;
    return null;
  }
  if (c.kind === 'api_called') {
    const [method = '', path = ''] = key.split(/\s+/, 2);
    const re = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:id\b/g, '[^/]+')}/?$`);
    const calls = seen.apis.filter((a) => a.method.toUpperCase() === method.toUpperCase() && re.test(a.path));
    if (!calls.length) return `Expected a call to ${key}; the page made none.`;
    if (c.expected && !calls.some((a) => String(a.status) === c.expected)) return `Expected ${key} to answer ${c.expected}; it answered ${calls.map((a) => a.status ?? 'nothing').join(', ')}.`;
    return null;
  }
  return null;
}

/** A storage or API check in a few words, for a test's title. */
export function checkName(c: Assertion): string {
  const what = { cookie: 'cookie', local_storage: 'local storage', session_storage: 'session storage', api_called: '' }[c.kind as string] ?? c.kind;
  return `${what ? `${what} ` : ''}${c.key ?? ''}${c.expected ? ` = ${c.expected}` : ''}`.trim();
}

/** A step as a tester reads it: its own intent, or what it does to which element. */
export function stepLabel(s: AutoStep): string {
  if (s.intent) return s.intent.slice(0, 120);
  const l = s.target && 'locator' in s.target ? s.target.locator : null;
  const on = l ? (l.name ?? l.value) : '';
  return `${s.action}${on ? ` “${on}”` : ''}${s.action === 'open' && s.value ? ` ${s.value}` : ''}`.slice(0, 120);
}

export interface PlannedTest {
  title: string;
  scenarios: string[];
  columns: string[];
  rows: Record<string, string>[];
  steps: AutoStep[];
  secrets: string[];
}

interface PlanInput {
  workflow: Workflow;
  partSteps: AutoStep[];
  prerequisiteDefaults: Record<string, string>;
  prerequisiteSecrets: string[];
  scenarios: Scenario[];
  title: string;
  /** Checked on every success, whatever the scenario: the workflow's own checks (from the site map). */
  extraChecks?: Assertion[];
  /**
   * What runs before this workflow in a journey, instead of its own prerequisite: the earlier
   * workflows' steps, with the data columns they read and this journey's values for them.
   */
  before?: { steps: AutoStep[]; columns: string[]; row: Record<string, string> };
}

const step = (id: string, action: AutoStep['action'], rest: Partial<AutoStep>): AutoStep => ({ id, action, assertions: [], noCheck: false, intent: '', ...rest });
/** The column holding a field's expected error: the browser's own message and the page's are two checks. */
const col = (key: string, source: 'native' | 'page') => `expected_${key}${source === 'native' ? '_browser' : ''}`.slice(0, 60);

/**
 * Scenarios as tests, as few as the requirement allows: those that expect the same things run as one
 * data-driven test, a row each (their messages and errors as `expected…` columns); scenarios that
 * expect different things (success, or refusal by a different field) are separate tests.
 */
export function planTests(p: PlanInput): PlannedTest[] {
  const w = p.workflow;
  const secrets = [...new Set([...p.prerequisiteSecrets, ...w.fields.filter((f) => f.secret).map((f) => f.key)])];
  const fieldLocator = (key: string): Locator | null => {
    const s = p.partSteps.find((x) => (x.action === 'type' || x.action === 'select') && x.value === `{data.${key}}`);
    return s?.target && 'locator' in s.target ? s.target.locator : null;
  };
  const uses = (id: string, version: number, inputs: string[], n: string, purpose: string): AutoStep =>
    step(n, 'use_component', {
      component: { id, version, inputs: Object.fromEntries(inputs.map((k) => [k, secrets.includes(k) ? `{secret.${k}}` : `{data.${k}}`])) },
      intent: purpose,
      noCheck: true,
    });
  const lead: AutoStep[] = [];
  if (p.before) lead.push(...p.before.steps);
  else if (w.prerequisite) lead.push(uses(w.prerequisite.id, w.prerequisite.version, w.prerequisite.inputs, 'u-pre', `Prerequisite: ${w.prerequisite.name}`));
  lead.push(uses(w.id, w.version, w.inputs, 'u-wf', w.intent || w.name));
  const own = [...new Set([...(p.before ? [] : (w.prerequisite?.inputs ?? [])), ...w.inputs, ...(w.continuation?.inputs ?? [])])];
  const dataInputs = [...new Set([...(p.before?.columns ?? []), ...own])].filter((k) => !secrets.includes(k));
  const baseRow = { ...p.prerequisiteDefaults, ...p.before?.row, ...Object.fromEntries(w.fields.map((f) => [f.key, f.recorded])) };
  const rowOf = (s: Scenario, extra: Record<string, string>) =>
    Object.fromEntries([...dataInputs.map((k) => [k, (own.includes(k) ? s.values[k] : undefined) ?? baseRow[k] ?? '']), ...Object.entries(extra), ['case', s.title]]);
  const here = submitPage(w);
  const dialogLoc: Locator = { strategy: 'role', value: 'dialog' };
  const plans: PlannedTest[] = [];

  // Accepted: one test for every scenario that expects success, split only where their extra checks differ.
  const ok = p.scenarios.filter((s) => s.expect.outcome === 'success');
  const okGroups = new Map<string, Scenario[]>();
  for (const s of ok) okGroups.set(JSON.stringify(s.expect.checks), [...(okGroups.get(JSON.stringify(s.expect.checks)) ?? []), s]);
  for (const [n, ok] of [...okGroups.values()].entries()) {
    const checks: Assertion[] = [];
    const withMessage = ok.every((s) => s.expect.message);
    if (withMessage) checks.push({ kind: 'visible', target: { locator: { strategy: 'text', value: '{data.expectedMessage}' } }, soft: false });
    const moved = ok.every((s) => s.expect.page === 'moves_on');
    const target = ok.map((s) => s.seen && stablePath(s.seen.url)).find((x) => x && x !== here);
    if (moved && target) checks.push({ kind: 'url_contains', expected: target, soft: false });
    if (ok.every((s) => s.expect.page === 'stays')) checks.push({ kind: 'url_contains', expected: here, soft: false });
    if (ok.every((s) => s.expect.dialog === 'closes')) checks.push({ kind: 'hidden', target: { locator: dialogLoc }, soft: false });
    checks.push(...ok[0]!.expect.checks, ...(p.extraChecks ?? []));
    const steps = [...lead, step('check-ok', 'verify', { intent: 'It is accepted', assertions: checks })];
    if (w.continuation) steps.push(uses(w.continuation.id, w.continuation.version, w.continuation.inputs, 'u-after', `After ${w.submitLabel}`));
    plans.push({
      // The group checking nothing extra keeps the plain title; the others say what else they check.
      title: !ok[0]!.expect.checks.length || (n === 0 && okGroups.size === 1) ? p.title : `${p.title} (${ok[0]!.expect.checks.map(checkName).join(', ')})`.slice(0, 200),
      scenarios: ok.map((s) => s.id),
      columns: [...dataInputs, ...(withMessage ? ['expectedMessage'] : []), 'case'],
      rows: ok.map((s) => rowOf(s, withMessage ? { expectedMessage: s.expect.message } : {})),
      steps,
      secrets,
    });
  }

  // Refused: one test per set of fields that report the error, a row per scenario.
  const refused = p.scenarios.filter((s) => s.expect.outcome === 'rejected');
  const groups = new Map<string, Scenario[]>();
  for (const s of refused) {
    const stop = s.expect.stop ? `stop:${s.expect.stop.stepId}:${s.expect.stop.kind}` : '';
    const extra = s.expect.checks.length ? JSON.stringify(s.expect.checks) : '';
    const key = [stop, extra, s.expect.message ? 'message' : '', ...s.expect.fieldErrors.map((e) => `${e.field}:${e.source}`).sort()].filter(Boolean).join('|');
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  // The success message, with the scenario's own values as {data.x}: it must not show when refused.
  const okMessage = ok.find((s) => s.expect.message);
  const template = okMessage
    ? Object.entries(okMessage.values).reduce((m, [k, v]) => (v && v.length >= 3 ? m.split(v).join(`{data.${k}}`) : m), okMessage.expect.message)
    : '';
  for (const list of groups.values()) {
    const errs = list[0]!.expect.fieldErrors;
    const stop = list[0]!.expect.stop;
    const at = stop ? p.partSteps.findIndex((x) => x.id === stop.stepId) : -1;
    const stopStep = at === -1 ? null : p.partSteps[at]!;
    const checks: Assertion[] = [];
    const extra: string[] = [];
    // Refused before the submit: what comes before the stop is done and must work; the stop itself is checked.
    if (stopStep?.target && 'locator' in stopStep.target)
      checks.push({ kind: stop!.kind === 'disabled' ? 'disabled' : 'hidden', target: { locator: stopStep.target.locator }, soft: false });
    if (list.every((s) => s.expect.message)) {
      extra.push('expectedMessage');
      checks.push({ kind: 'visible', target: { locator: { strategy: 'text', value: '{data.expectedMessage}' } }, soft: false });
    }
    const errorOf = (s: Scenario, e: { field: string; source: 'native' | 'page' }) => s.expect.fieldErrors.find((x) => x.field === e.field && x.source === e.source);
    for (const e of errs) {
      const loc = fieldLocator(e.field);
      const c = col(e.field, e.source);
      const withText = list.every((s) => errorOf(s, e)?.message);
      if (withText) extra.push(c);
      if (e.source === 'native' && loc) checks.push({ kind: 'validation_message', target: { locator: loc }, ...(withText ? { expected: `{data.${c}}` } : {}), soft: false });
      else if (withText) checks.push({ kind: 'visible', target: { locator: { strategy: 'text', value: `{data.${c}}` } }, soft: false });
    }
    if (template) checks.push({ kind: 'hidden', target: { locator: { strategy: 'text', value: template } }, soft: false });
    if (list.every((s) => s.expect.page === 'stays')) checks.push({ kind: 'url_contains', expected: here, soft: false });
    if (list.every((s) => s.expect.dialog === 'stays_open')) checks.push({ kind: 'visible', target: { locator: dialogLoc }, soft: false });
    checks.push(...list[0]!.expect.checks);
    const labels = [...new Set(errs.map((e) => w.fields.find((f) => f.key === e.field)?.label ?? e.field))];
    const how = errs.some((e) => e.source === 'native') ? (errs.some((e) => e.source === 'page') ? ' (browser and page messages)' : ' (browser message)') : '';
    const valueOf = (s: Scenario, c: string) => (c === 'expectedMessage' ? s.expect.message : (s.expect.fieldErrors.find((x) => col(x.field, x.source) === c)?.message ?? ''));
    const what = labels.length ? `, with an error on ${labels.join(', ')}` : list[0]!.expect.message ? ', with the app’s message' : '';
    const refuses = labels.length ? `refuses invalid ${labels.join(' and ')}` : list[0]!.expect.message ? 'refuses, with the app’s message' : 'refuses invalid input';
    const body = stopStep
      ? [...lead.slice(0, -1), ...p.partSteps.slice(0, at).map((x) => ({ ...x, id: `wf-${x.id}`.slice(0, 60) }))]
      : lead;
    plans.push({
      title: `${p.title} ${refuses}${how}${stopStep ? ` (stops at ${stepLabel(stopStep)})` : ''}`.slice(0, 200),
      scenarios: list.map((s) => s.id),
      columns: [...dataInputs, ...extra, 'case'],
      rows: list.map((s) => rowOf(s, Object.fromEntries(extra.map((c) => [c, valueOf(s, c)])))),
      steps: [...body, step('check-refused', 'verify', { intent: `Refused${what}`, assertions: checks })],
      secrets,
    });
  }
  return plans;
}
