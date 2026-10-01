import type {
  Assertion,
  AutoStep,
  DraftCheck,
  DraftQuestion,
  DraftSegment,
  FieldKind,
  IntentDraft,
  FormField,
  Locator,
  ObservedItem,
  PageInfo,
  PickedElement,
  RecordedStep,
  StudioComponent,
  TestIntent,
} from '@tb/contracts';
import { CHANGING_ACTIONS, ComponentMeta, FieldRules } from '@tb/contracts';
import { CHECK_POLICY, chooseLocator, policyFor, type LocatorPolicy } from './locators';
import { fieldKind, sampleValue, variations, type RecordedField } from './variations';

// The rules half of an intent build: a recording becomes steps, split into reusable segments, with
// the checks the page itself justifies and data variations from the fields' rules. No database and
// no model here; AI refinement (ai.ts) and saving (commit.ts) come after.

/** A recorded action as a step, with what the recording saw around it. */
interface Converted {
  step: AutoStep;
  element: PickedElement | null;
  field: RecordedField | null;
  /** The field is a password: its value comes from a secret. */
  secret: boolean;
  observed: ObservedItem[];
  /** The page address after this step, when the step moved to another page. */
  navigatedTo: string | null;
  /** Path of the page the step happened on. */
  page: string;
  /** On a submit: every field of its form, as it stood then. */
  form?: FormField[];
}

/**
 * The recording as the model sees it: numbered steps and what appeared after each, the final page
 * and the fields. `refs` maps "<step>:<item>" and "end:<item>" to the page element, so a check the
 * model proposes is always on an element the recorder actually saw.
 */
export interface AiContext {
  steps: Array<{ index: number; where: string; stepId: string; action: string; element: string; value: string; page: string; observed: Array<{ ref: string; kind: string; text: string }> }>;
  end: { url: string; title: string; items: Array<{ ref: string; kind: string; text: string }> } | null;
  fields: Array<{ key: string; label: string; kind: FieldKind; rules: string; value: string }>;
  segments: Array<{ key: string; name: string; purpose: string; steps: number[] }>;
  refs: Map<string, PickedElement>;
}

export interface BuildInput {
  title: string;
  intent: TestIntent;
  prerequisite: RecordedStep[];
  /** A saved component chosen for the prerequisites instead of a recording. */
  prerequisiteComponent: StudioComponent | null;
  recording: RecordedStep[];
  existing: StudioComponent[];
  /** Ids for placeholders and checks; injectable so tests are deterministic. */
  newId(): string;
  /** The tester's answers to earlier questions, by question id. */
  answers?: Record<string, string>;
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'should', 'must', 'will', 'can', 'are', 'was', 'has', 'have', 'from', 'into', 'then', 'user', 'page', 'shows', 'show', 'see', 'get', 'gets', 'able']);
const VOLATILE = /\d{2,}|[₹$€£¥]|\d\s?%|\b(today|yesterday|ago|am|pm)\b/i;
const SENSITIVE_PARAM = /pass(word|wd)?|pwd|token|otp|secret|auth|session|api.?key|pin\b/i;
const DYNAMIC_SEGMENT = /\d{2,}|^[0-9a-f]{8,}$|^[0-9a-f-]{32,36}$|^(?=.*\d)(?=.*[a-z]).{16,}$/i;

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
};

/** The part of a path that is the same on every run: up to the first id-like segment. */
export function stablePath(url: string): string {
  const parts = pathOf(url).split('/');
  const cut = parts.findIndex((p, i) => i > 0 && DYNAMIC_SEGMENT.test(decodeURIComponent(p)));
  const kept = cut === -1 ? parts : parts.slice(0, cut);
  const path = kept.join('/') || '/';
  return cut === -1 ? path : `${path}/`;
}

/** camelCase, unique among `taken`. */
export function identifier(label: string, taken: Set<string>, fallback: string): string {
  const words = label.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, 4);
  let base = words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  if (!/^[a-zA-Z_]\w{0,30}$/.test(base)) base = fallback;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

/** What a person calls a field: its label, placeholder or name, not "Search city textbox". */
function fieldLabel(el: PickedElement, rules: FieldRules): string {
  const by = (s: string) => el.locators.find((l) => l.strategy === s)?.value;
  return by('label') ?? by('placeholder') ?? el.locators.find((l) => l.strategy === 'role')?.name ?? (rules.name || el.suggestedName);
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP_WORDS.has(w)));

/** How much of the goal a piece of page text covers, 0 to 1. */
function overlap(goal: Set<string>, text: string): number {
  if (!goal.size) return 0;
  const t = words(text);
  let hit = 0;
  for (const w of goal) if (t.has(w)) hit++;
  return hit / goal.size;
}

// ---------- recording → steps ----------

function convert(
  recording: RecordedStep[],
  policy: LocatorPolicy,
  // Shared by the prerequisite and main recordings: the main one starts where the prerequisite ended.
  ctx: { baseOrigin: string | null; url: string; keys: Set<string>; fields: Map<string, RecordedField>; notes: string[]; stepNo: { n: number }; continuing: boolean },
): Converted[] {
  const out: Converted[] = [];
  let mainTab: string | null = null;
  const skipped = new Set<string>();
  const nextId = () => `s${++ctx.stepNo.n}`;
  const toTarget = (el: PickedElement | null): AutoStep['target'] => {
    if (!el) return undefined;
    const typed = typedValues(ctx.fields);
    // Something named after what the test typed ("the project called Alpha") is found through that
    // data, so it is the item this run created, whatever else the page lists.
    const bound = el.locators.find((l) => l.nth === undefined && l.strategy !== 'css' && typed.some(([v]) => [l.value, l.name].some((t) => t?.includes(v))));
    const loc = bound ? { strategy: bound.strategy, value: bound.value, ...(bound.name ? { name: bound.name } : {}), ...(bound.within ? { within: bound.within } : {}), ...(bound.matches > 1 ? { nth: 0 } : {}) } : chooseLocator(el, policy);
    return loc ? { locator: bindData(loc, typed) } : undefined;
  };
  const address = (u: string) => {
    try {
      const parsed = new URL(u);
      // A form sent by GET leaves what was typed in the address, a password included: never keep it.
      const typed = new Set([...ctx.fields.values()].map((f) => f.value).filter((v) => v.length >= 3));
      for (const [k, v] of [...parsed.searchParams]) if (SENSITIVE_PARAM.test(k) || typed.has(v)) parsed.searchParams.delete(k);
      if (!ctx.baseOrigin) ctx.baseOrigin = parsed.origin;
      // The environment under test is a run setting, so the recorded site's address is not baked in.
      return parsed.origin === ctx.baseOrigin ? `{env.baseUrl}${parsed.pathname}${parsed.search}` : u;
    } catch {
      return u;
    }
  };

  for (const r of recording) {
    mainTab ??= r.tab;
    if (r.tab !== mainTab) {
      if (!skipped.has('tab')) ctx.notes.push('Steps in other tabs were left out: no-code tests work in one tab. Use Insert (code) for those.');
      skipped.add('tab');
      continue;
    }
    const last = out.at(-1);
    switch (r.action) {
      case 'open':
        // The journey carries on from where the prerequisite left the app: no need to open it again.
        if (ctx.continuing && !out.length && ctx.url && pathOf(r.url) === pathOf(ctx.url)) {
          ctx.url = r.url;
          continue;
        }
        ctx.url = r.url;
        out.push({ step: base(nextId(), 'open', { value: address(r.url) }), element: null, field: null, secret: false, observed: [], navigatedTo: null, page: pathOf(r.url) });
        continue;
      case 'navigated':
        if (last && pathOf(r.url) !== pathOf(ctx.url)) last.navigatedTo = r.url;
        ctx.url = r.url;
        continue;
      case 'observed':
        if (last) last.observed.push(...r.items);
        continue;
      // The page's own API calls are kept with the workflow (workflow-service apisOf), not replayed.
      case 'facts':
      case 'api':
      case 'popup':
      case 'newtab':
      case 'close':
        continue;
      case 'history':
        ctx.notes.push(`A "${r.go}" was left out: no-code tests have no back or reload step yet.`);
        continue;
    }
    if (r.frames.length) {
      if (!skipped.has('frame')) ctx.notes.push('Steps inside iframes were left out: no-code tests do not reach into frames yet. Use Insert (code) for those.');
      skipped.add('frame');
      continue;
    }
    const target = toTarget(r.element);
    const page = pathOf(ctx.url);
    if (r.action === 'type' || r.action === 'select') {
      if (!r.element || !target) continue;
      const rules = r.field ?? FieldRules.parse({});
      const label = fieldLabel(r.element, rules);
      // One key per field: typing into the same field again reuses it.
      const sig = JSON.stringify(target);
      let field = [...ctx.fields.values()].find((f) => (f as RecordedField & { sig?: string }).sig === sig) ?? null;
      if (!field) {
        field = Object.assign({ key: identifier(label, ctx.keys, 'value'), label, rules, value: r.value ?? '' }, { sig });
        ctx.fields.set(field.key, field);
      } else field.value = r.value ?? field.value;
      const kind = fieldKind(field);
      const secret = r.secret || kind === 'password' || kind === 'otp';
      if (kind === 'otp' && !ctx.notes.some((n) => n.includes(field!.label)))
        ctx.notes.push(
          `"${field.label}" looks like a one-time code, which changes on every run, so the recorded one is not kept: the test reads it from the secret {secret.${field.key}}. ` +
            'Give the test environment a fixed test code (or a way to read the latest one), or the test cannot get past it.',
        );
      out.push({
        step: base(nextId(), r.action, { target, value: `{data.${field.key}}` }),
        element: r.element, field, secret, observed: [], navigatedTo: null, page,
      });
      continue;
    }
    if (r.action === 'store') {
      if (!target || !r.element) continue;
      const name = identifier(r.element.suggestedName || 'value', ctx.keys, 'value');
      out.push({ step: base(nextId(), 'store', { target, value: name }), element: r.element, field: null, secret: false, observed: [], navigatedTo: null, page });
      continue;
    }
    if (r.action === 'press') {
      out.push({ step: base(nextId(), 'press', { ...(target ? { target } : {}), value: r.value ?? 'Enter' }), element: r.element, field: null, secret: false, observed: [], navigatedTo: null, page, form: r.form });
      continue;
    }
    if (!target) continue;
    if (r.action === 'dblclick') ctx.notes.push('A double click was recorded as a click: no-code tests have no double click yet.');
    const action = r.action === 'dblclick' ? 'click' : r.action;
    out.push({ step: base(nextId(), action, { target }), element: r.element, field: null, secret: false, observed: [], navigatedTo: null, page, form: r.form });
  }
  return out;
}

/** Typed values worth following into locators and messages (long enough to be meaningful), longest first. */
function typedValues(fields: Map<string, RecordedField>): Array<[string, string]> {
  return [...fields.values()]
    .filter((f) => f.value.trim().length >= 3 && fieldKind(f) !== 'password' && fieldKind(f) !== 'otp')
    .map((f) => [f.value, f.key] as [string, string])
    .sort((a, b) => b[0].length - a[0].length);
}

/** A locator with each typed value in its text replaced by {data.x}, so it follows the data row. */
export function bindData(loc: Locator, typed: Array<[string, string]>): Locator {
  const bind = (t: string | undefined) => {
    if (!t) return t;
    let out = t;
    for (const [value, key] of typed) out = out.split(value).join(`{data.${key}}`);
    return out;
  };
  return {
    ...loc,
    ...(loc.strategy === 'css' ? {} : { value: bind(loc.value)! }),
    ...(loc.name ? { name: bind(loc.name) } : {}),
    ...(loc.within ? { within: { ...loc.within, ...(loc.within.strategy === 'css' ? {} : { value: bind(loc.within.value)! }), ...(loc.within.name ? { name: bind(loc.within.name) } : {}), ...(loc.within.hasText ? { hasText: bind(loc.within.hasText) } : {}) } } : {}),
  };
}

function base(id: string, action: AutoStep['action'], rest: Partial<AutoStep>): AutoStep {
  return { id, action, assertions: [], noCheck: false, intent: '', ...rest };
}

// ---------- checks the page justifies ----------

const KIND_ORDER: ObservedItem['kind'][] = ['alert', 'status', 'dialog', 'heading', 'text'];

/** The observed item worth checking after a step: a message before a heading before plain text. */
function bestObserved(items: ObservedItem[]): ObservedItem | null {
  return [...items].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))[0] ?? null;
}

/** How a check should read the page, given what the tester typed and said. */
interface CheckContext {
  policy: LocatorPolicy;
  /** Typed values to replace with their {data.x}, longest first, so a message check follows the data row. */
  data: Array<[string, string]>;
  /** Phrases the tester quoted in the intent or goal: text they expect word for word. */
  quoted: string[];
}

/** A message's first sentence, with typed values as {data.x}, so it reads the same in every data row. */
function messageText(item: ObservedItem, data: Array<[string, string]>): string {
  let text = item.text.split(/(?<=[.!?])\s/)[0]!.slice(0, 80).trim();
  for (const [value, key] of data) text = text.split(value).join(`{data.${key}}`);
  return text;
}

/** "…shows "Booking confirmed"": the words the tester put in quotes. */
function quotedPhrases(text: string): string[] {
  return [...text.matchAll(/"([^"]{2,80})"|“([^”]{2,80})”|'([^']{2,80})'/g)].map((m) => (m[1] ?? m[2] ?? m[3])!.trim());
}

/**
 * The check for something that appeared. Words are only checked when they are certain to stay the
 * same: a system message (alert, status, dialog, with typed values as {data.x}) or a phrase the tester
 * quoted. Anything else, a heading such as a hotel's name, is content that changes between runs, so
 * the check is that it is there, found by its stable locator.
 */
function textCheck(item: ObservedItem, cc: CheckContext): Assertion | null {
  const found = chooseLocator(item.element, { ...CHECK_POLICY, referential: cc.policy.referential });
  if (!found) return null;
  // Found through the data too: "Project Alpha created" is "Project {data.name} created" in every row.
  const loc = bindData(found, cc.data);
  const quote = cc.quoted.find((q) => item.text.toLowerCase().includes(q.toLowerCase()));
  if (quote) return { kind: 'text_contains', target: { locator: loc }, expected: quote, soft: false };
  // A dialog is checked as open; its contents are the form it holds, not a message.
  if (item.kind === 'alert' || item.kind === 'status') {
    const text = messageText(item, cc.data);
    if (text && !VOLATILE.test(text.replace(/\{data\.\w+\}/g, ''))) {
      // A toast rarely has a role or test id: found by page structure it would break, so the
      // message's own words (with {data.x}) are how it is found.
      if (loc.strategy === 'css') return { kind: 'visible', target: { locator: { strategy: 'text', value: text } }, soft: false };
      return { kind: 'text_contains', target: { locator: loc }, expected: text, soft: false };
    }
  }
  return { kind: 'visible', target: { locator: loc }, soft: false };
}

function describeCheck(a: Assertion): string {
  const what = a.target && 'locator' in a.target ? (a.target.locator.name ?? a.target.locator.value) : '';
  switch (a.kind) {
    case 'url_contains':
      return `Address contains "${a.expected}"`;
    case 'title_contains':
      return `Page title contains "${a.expected}"`;
    case 'text_contains':
      return `"${what}" shows "${a.expected}"`;
    case 'visible':
      return `"${what}" is visible`;
    case 'hidden':
      return `"${what}" is not shown`;
    default:
      return `${a.kind.replace('_', ' ')} ${a.expected ?? ''}`.trim();
  }
}

// ---------- the build ----------

export function buildDraft(input: BuildInput): { draft: IntentDraft; context: AiContext } {
  const policy = policyFor(`${input.intent.intent} ${input.intent.goal}`);
  const notes: string[] = [];
  const checks: DraftCheck[] = [];
  const keys = new Set<string>(['case']);
  const fields = new Map<string, RecordedField>();
  const ctx = { baseOrigin: null as string | null, url: '', keys, fields, notes, stepNo: { n: 0 }, continuing: false };
  const addCheck = (where: string, stepId: string, assertion: Assertion, why: string, source: DraftCheck['source'] = 'rule') =>
    checks.push({ id: `c${checks.length + 1}`, source, where, stepId, assertion, label: describeCheck(assertion), why });

  const pre = convert(input.prerequisite, policy, ctx);
  ctx.continuing = pre.length > 0 || !!input.prerequisiteComponent;
  const main = convert(input.recording, policy, ctx);
  const cc: CheckContext = {
    policy,
    data: [...fields.values()]
      .filter((f) => f.value.trim().length >= 3 && ![...pre, ...main].some((c) => c.field === f && c.secret))
      .map((f) => [f.value, f.key] as [string, string])
      .sort((a, b) => b[0].length - a[0].length),
    quoted: quotedPhrases(`${input.intent.intent} ${input.intent.goal}`),
  };
  if (!main.length) notes.push('Nothing in the recording could become a step.');

  /** Rule checks for a segment's changing steps; a step with no evidence is marked, not left silent. */
  const checkSteps = (where: string, steps: Converted[]) => {
    for (const c of steps) {
      if (!CHANGING_ACTIONS.includes(c.step.action)) continue;
      const before = c.page;
      if (c.navigatedTo && stablePath(c.navigatedTo) !== stablePath(`https://x${before}`) && stablePath(c.navigatedTo) !== '/')
        addCheck(where, c.step.id, { kind: 'url_contains', expected: stablePath(c.navigatedTo), soft: false }, 'The page changed to this address after this step while recording.');
      const item = bestObserved(c.observed);
      const check = item && textCheck(item, cc);
      if (check) addCheck(where, c.step.id, check, `"${item!.text.slice(0, 60)}" appeared after this step while recording.`);
    }
  };

  // Prerequisite: a saved component, or the recorded steps as one new component.
  const segments: DraftSegment[] = [];
  const nameTaken = new Set(input.existing.map((c) => c.name.toLowerCase()));
  const uniqueName = (n: string) => {
    let name = n.slice(0, 110);
    for (let i = 2; nameTaken.has(name.toLowerCase()); i++) name = `${n.slice(0, 105)} ${i}`;
    nameTaken.add(name.toLowerCase());
    return name;
  };
  const segmentFrom = (key: string, role: DraftSegment['role'], steps: Converted[], name: string, meta: Partial<ComponentMeta>): DraftSegment => {
    const inputs = [...new Set(steps.flatMap((c) => (c.field ? [c.field.key] : [])))];
    const inputKinds = Object.fromEntries(inputs.map((k) => [k, fieldKind(fields.get(k)!)])) as Record<string, FieldKind>;
    const reuse = findReuse(steps, input.existing);
    return {
      key,
      role,
      placeholderId: input.newId(),
      reuse: reuse && { id: reuse.id, name: reuse.name, version: reuse.version, why: reuse.why },
      bindings: reuse ? reuse.bindings : Object.fromEntries(inputs.map((k) => [k, k])),
      component: {
        name: reuse ? reuse.name : uniqueName(name),
        description: meta.purpose ?? '',
        inputs,
        steps: steps.map((c) => c.step),
        changelog: 'Built from a recording',
        meta: ComponentMeta.parse({ purpose: '', leaves: '', preconditions: '', tags: [], inputKinds, origin: role === 'prerequisite' ? 'prerequisite' : 'segment', ...meta }),
      },
    };
  };

  if (pre.length) {
    checkSteps('prereq', pre);
    const name = input.intent.prerequisites ? capital(input.intent.prerequisites.split(/[.\n]/)[0]!.slice(0, 80)) : 'Prerequisites';
    segments.push(segmentFrom('prereq', 'prerequisite', pre, name, { purpose: input.intent.prerequisites, leaves: input.intent.prerequisites, tags: ['prerequisite'] }));
  }

  // Main recording: a new segment wherever the journey reaches another page.
  const groups: Converted[][] = [];
  for (const c of main) {
    const cur = groups.at(-1);
    if (!cur || c.step.action === 'open' || cur.at(-1)!.navigatedTo || c.page !== cur[0]!.page) groups.push([c]);
    else cur.push(c);
  }
  // ---------- what the recording cannot tell: ask, and apply what was answered ----------
  const answers = input.answers ?? {};
  const questions: DraftQuestion[] = [];
  const ask = (q: Omit<DraftQuestion, 'answer'>): string | null => {
    const answer = answers[q.id]?.trim() || null;
    questions.push({ ...q, answer });
    return answer;
  };

  // A click found only by the page's structure breaks with the next layout change: ask what it is.
  for (const c of [...pre, ...main]) {
    const loc = c.step.target && 'locator' in c.step.target ? c.step.target.locator : null;
    if (!loc || loc.strategy !== 'css' || !/>|nth-of-type/.test(loc.value) || !c.element || c.step.action !== 'click') continue;
    const el = c.element;
    const created = typedValues(fields).find(([v]) => el.text.includes(v));
    const inList = el.locators.find((l) => l.within && l.nth !== undefined);
    const answer = ask({
      id: `loc:${c.step.id}`,
      text: `What does the step "click ${el.suggestedName || el.tag}" click? It was only found by the page's layout (${loc.value.slice(0, 60)}).`,
      why: 'A locator made of the page layout breaks as soon as the page changes; one based on what the element is does not.',
      options: [
        ...(created ? [{ value: `data:${created[1]}`, label: `The item named "${created[0]}": the one this test created` }] : []),
        ...(inList ? [{ value: 'position', label: `Its place in the list (item ${inList.nth! + 1})` }] : []),
        { value: 'keep', label: 'Keep the layout path' },
      ],
      allowText: true,
      textHint: 'Or type the text it shows, e.g. Open project',
      required: true,
    });
    if (!answer || answer === 'keep') continue;
    const role = el.role === 'link' || el.role === 'button' ? el.role : null;
    let next: Locator | null = null;
    if (answer.startsWith('data:')) next = role ? { strategy: 'role', value: role, name: `{${answer.replace(':', '.')}}`, nth: 0 } : { strategy: 'text', value: `{${answer.replace(':', '.')}}`, nth: 0 };
    else if (answer === 'position' && inList) next = { strategy: inList.strategy, value: inList.value, ...(inList.name ? { name: inList.name } : {}), within: inList.within!, nth: inList.nth! };
    else if (answer !== 'position') next = bindData(role ? { strategy: 'role', value: role, name: answer, nth: 0 } : { strategy: 'text', value: answer, nth: 0 }, typedValues(fields));
    if (next) c.step.target = { locator: next };
  }

  // The form the journey submits: fields the tester left out are covered too, if they say so.
  const formAt0 = groups.findLastIndex((g) => g.some((c) => c.field && !c.secret));
  const formGroup = formAt0 === -1 ? null : groups[formAt0]!;
  const lastField = formGroup ? formGroup.findLastIndex((c) => !!c.field) : -1;
  const submitAt = formGroup ? formGroup.findIndex((c, i) => i > lastField && CHANGING_ACTIONS.includes(c.step.action)) : -1;
  const submit = formGroup && submitAt !== -1 ? formGroup[submitAt]! : null;
  if (formGroup && submit?.form) {
    const have = new Set(formGroup.flatMap((c) => (c.field && c.step.target ? [canonical(c.step.target)] : [])));
    const missing = submit.form.filter((f) => {
      if (f.secret || /^(checkbox|radio|file|hidden)$/.test(f.rules.type)) return false;
      const loc = chooseLocator(f.element, policy);
      return !!loc && !have.has(canonical({ locator: loc }));
    });
    if (missing.length) {
      const names = missing.map((f) => `${f.label || f.element.suggestedName}${f.rules.required ? ' (required)' : ''}`);
      const anyRequired = missing.some((f) => f.rules.required);
      const answer = ask({
        id: 'fields',
        text: `The form also has ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}, which you did not fill in. What should the test do with them?`,
        why: 'A test of the form should cover all of it: each field gets its data column, and valid and invalid values.',
        options: [
          { value: 'all', label: 'Fill them all in, with data I can change' },
          ...(anyRequired ? [{ value: 'required', label: 'Only the required ones' }] : []),
          { value: 'none', label: 'Leave them out' },
        ],
        allowText: false,
        textHint: '',
        required: true,
      });
      if (answer === 'all' || answer === 'required') {
        const added: Converted[] = [];
        for (const f of missing.filter((m) => answer === 'all' || m.rules.required)) {
          const loc = chooseLocator(f.element, policy)!;
          const label = f.label || f.element.suggestedName;
          // "As recorded" stays as recorded (empty stays empty) unless the field is required, or is a
          // select, which always shows some option and cannot be chosen as ''. The "every field filled
          // in" row gives each one a value.
          const needsValue = f.rules.required || f.rules.type === 'select';
          const field: RecordedField = { key: identifier(label, keys, 'value'), label, rules: f.rules, value: f.value || (needsValue ? sampleValue(f) : '') };
          fields.set(field.key, field);
          const action = f.rules.type === 'select' ? 'select' : 'type';
          added.push({ step: base(`f${added.length + 1}-${submit.step.id}`, action, { target: { locator: loc }, value: `{data.${field.key}}` }), element: f.element, field, secret: false, observed: [], navigatedTo: null, page: submit.page });
        }
        formGroup.splice(submitAt, 0, ...added);
      }
    }
  }

  groups.forEach((g, i) => {
    const key = `s${i + 1}`;
    checkSteps(key, g);
    const page = pageName(g);
    const labels = g.flatMap((c) => (c.field ? [c.field.label] : []));
    // Labels often start "Enter your…" already; do not say it twice.
    const plain = labels.map((l) => l.replace(/^enter\s+(your\s+)?/i, ''));
    const name = labels.length ? `Enter ${plain.slice(0, 2).join(' and ')}${plain.length > 2 ? '…' : ''}` : `${capital(verbOf(g))} on ${page}`;
    const endsOn = g.at(-1)!.navigatedTo ? pageName([{ ...g.at(-1)!, page: pathOf(g.at(-1)!.navigatedTo!) }]) : page;
    segments.push(
      segmentFrom(key, 'segment', g, name, {
        purpose: `${capital(verbOf(g))} on ${page}${labels.length ? `: ${labels.join(', ')}` : ''}.`,
        leaves: `On ${endsOn}`,
        preconditions: i === 0 ? input.intent.prerequisites : `On ${page}`,
        tags: [page.toLowerCase()],
      }),
    );
  });

  // The test: prerequisite, segments in order, then the goal.
  const facts = [...input.recording].reverse().find((r): r is Extract<RecordedStep, { action: 'facts' }> => r.action === 'facts') ?? null;
  const goalStep = base('goal', 'verify', { intent: `Goal: ${input.intent.goal}` });
  const goal = words(input.intent.goal);
  if (facts) {
    const scored = facts.items.map((it) => ({ it, score: overlap(goal, it.text) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    for (const { it } of scored.slice(0, 2)) {
      const check = textCheck(it, cc);
      if (check) addCheck('test', goalStep.id, check, `The goal mentions what this shows on the final page.`);
    }
    const startPath = main[0]?.page ?? '/';
    const endPath = stablePath(facts.url);
    if (endPath !== '/' && endPath !== stablePath(`https://x${startPath}`))
      addCheck('test', goalStep.id, { kind: 'url_contains', expected: endPath, soft: false }, 'The journey ended on this page while recording.');
    const titleQuote = cc.quoted.find((q) => facts.title.toLowerCase().includes(q.toLowerCase()));
    if (titleQuote) addCheck('test', goalStep.id, { kind: 'title_contains', expected: titleQuote, soft: false }, 'The final page title has the words the goal quotes.');
    if (!scored.length) {
      const heading = facts.items.find((i) => i.kind === 'heading');
      const check = heading && textCheck(heading, cc);
      if (check) addCheck('test', goalStep.id, check, 'Nothing on the final page matched the goal’s words; this checks its main heading is there. Make it more specific if the goal needs it.');
    }
  } else notes.push('The recording has no final page facts (it was not stopped in the Site pane), so the goal has no checks yet.');

  // What shows the journey worked: a message seen after the submit, a phrase the tester quoted, or,
  // failing both, the tester's answer. Its opposite is what the invalid-input test checks.
  let signalHidden: Assertion | null = null;
  const actOn = submit ?? [...main].reverse().find((c) => CHANGING_ACTIONS.includes(c.step.action) && c.step.action !== 'open') ?? null;
  if (actOn) {
    const where = `s${groups.findIndex((g) => g.includes(actOn)) + 1}`;
    const typed = typedValues(fields);
    const bindText = (t: string) => typed.reduce((out, [v, k]) => out.split(v).join(`{data.${k}}`), t.split(/(?<=[.!?])\s/)[0]!.slice(0, 80).trim());
    const messages = actOn.observed.filter((o) => o.kind === 'alert' || o.kind === 'status' || o.kind === 'dialog');
    const quotedSeen = cc.quoted.some((q) => [...actOn.observed, ...(facts?.items ?? [])].some((o) => o.text.toLowerCase().includes(q.toLowerCase())));
    if (messages.length) {
      const best = bestObserved(messages)!;
      const found = chooseLocator(best.element, CHECK_POLICY);
      const text = messageText(best, typed);
      const loc = found && found.strategy !== 'css' ? bindData(found, typed) : text ? { strategy: 'text' as const, value: text } : found;
      if (loc) signalHidden = { kind: 'hidden', target: { locator: loc }, soft: false };
    } else if (!quotedSeen) {
      const what = actOn.element?.suggestedName || actOn.step.action;
      const answer = ask({
        id: 'signal',
        text: `What shows that it worked after "${what}"? Nothing like a success message was seen.`,
        why: 'Without it the test cannot tell success from failure, and the invalid-input test has nothing to check.',
        options: [
          ...actOn.observed.slice(0, 6).map((o, m) => ({ value: `after:${m}`, label: `"${o.text.slice(0, 80)}" appeared (${o.kind})` })),
          ...(facts?.items ?? []).slice(0, 6).map((o, m) => ({ value: `end:${m}`, label: `On the final page: "${o.text.slice(0, 80)}" (${o.kind})` })),
          { value: 'none', label: 'Nothing on the page confirms it' },
        ],
        allowText: true,
        textHint: 'Or type the message it shows, e.g. Project created successfully',
        required: true,
      });
      if (answer && answer !== 'none') {
        const picked = answer.startsWith('after:') ? actOn.observed[Number(answer.slice(6))] : answer.startsWith('end:') ? facts?.items[Number(answer.slice(4))] : undefined;
        const onEnd = answer.startsWith('end:');
        const pickedLoc = picked && chooseLocator(picked.element, CHECK_POLICY);
        const loc: Locator | null = pickedLoc ? bindData(pickedLoc, typed) : picked || answer.includes(':') ? null : { strategy: 'text', value: bindText(answer) };
        if (loc) {
          // The tester said this is the proof, so its words are checked, typed values as {data.x}.
          const check: Assertion = picked ? { kind: 'text_contains', target: { locator: loc }, expected: bindText(picked.text), soft: false } : { kind: 'visible', target: { locator: loc }, soft: false };
          addCheck(onEnd ? 'test' : where, onEnd ? goalStep.id : actOn.step.id, check, 'You said this shows it worked.');
          if (!onEnd) signalHidden = { kind: 'hidden', target: { locator: loc }, soft: false };
        }
      } else if (answer === 'none') notes.push('Nothing on the page confirms success, so the invalid-input test can only check that the page does not move on.');
    }
  }

  const secrets = [...new Set([...pre, ...main].flatMap((c) => (c.secret && c.field ? [c.field.key] : [])))];
  const useStep = (seg: DraftSegment, n: number): AutoStep =>
    base(`u${n}`, 'use_component', {
      component: {
        id: seg.reuse?.id ?? seg.placeholderId,
        version: seg.reuse?.version ?? 1,
        inputs: Object.fromEntries(Object.entries(seg.bindings).map(([input, k]) => [input, secrets.includes(k) ? `{secret.${k}}` : `{data.${k}}`])),
      },
      intent: seg.component.meta.purpose || seg.component.name,
      noCheck: true,
    });

  const testSteps: AutoStep[] = [];
  if (input.prerequisiteComponent) {
    const c = input.prerequisiteComponent;
    for (const k of c.inputs) if (!fields.has(k) && !keys.has(k)) keys.add(k);
    testSteps.push(
      base('u0', 'use_component', {
        component: { id: c.id, version: c.version, inputs: Object.fromEntries(c.inputs.map((k) => [k, c.meta.inputKinds[k] === 'password' ? `{secret.${k}}` : `{data.${k}}`])) },
        intent: `Prerequisite: ${c.name}`,
        noCheck: true,
      }),
    );
    const blank = c.inputs.filter((k) => c.meta.inputKinds[k] !== 'password');
    if (blank.length) notes.push(`Fill in ${blank.join(', ')} for "${c.name}" in the data sets before running.`);
    for (const k of c.inputs) if (c.meta.inputKinds[k] === 'password') secrets.push(k);
  }
  segments.forEach((seg, n) => testSteps.push(useStep(seg, n + 1)));
  testSteps.push(goalStep);

  // Negative test: the same journey up to the form, with its submit check turned round.
  const negative = negativeTest(input, segments, groups, pre, useStep, testSteps, signalHidden, (stepId, a, why) => addCheck('negative', stepId, a, why));

  // Vary what the journey is about (the main recording's fields); the prerequisite's stay as recorded.
  const formAt = groups.findLastIndex((g) => g.some((c) => c.field && !c.secret));
  const vary = new Set((formAt === -1 ? main : groups[formAt]!).flatMap((c) => (c.field ? [c.field.key] : [])));
  const { valid, invalid } = variations([...fields.values()].filter((f) => !secrets.includes(f.key)), vary);
  const prereqColumns = input.prerequisiteComponent?.inputs.filter((k) => !secrets.includes(k)) ?? [];
  for (const row of [...valid, ...invalid]) for (const k of prereqColumns) row.values[k] ??= '';

  if (!checks.some((c) => c.where === 'test')) notes.push('The goal has no checks yet: add one in review or in the Tests tab.');

  const refs = new Map<string, PickedElement>();
  const aiSteps: AiContext['steps'] = [];
  const aiSegments: AiContext['segments'] = [];
  const parts: Array<[string, Converted[]]> = [...(pre.length ? [['prereq', pre] as [string, Converted[]]] : []), ...groups.map((g, i) => [`s${i + 1}`, g] as [string, Converted[]])];
  for (const [where, list] of parts) {
    const seg = segments.find((x) => x.key === where)!;
    aiSegments.push({ key: where, name: seg.component.name, purpose: seg.component.meta.purpose, steps: [] });
    for (const c of list) {
      const index = aiSteps.length;
      aiSegments.at(-1)!.steps.push(index);
      aiSteps.push({
        index,
        where,
        stepId: c.step.id,
        action: c.step.action,
        element: c.field?.label ?? c.element?.suggestedName ?? '',
        value: c.secret ? '(secret)' : c.field ? c.field.value : c.step.action === 'open' ? pathOf(ctx.baseOrigin ?? '') : (c.step.value ?? ''),
        page: c.page,
        observed: c.observed.map((o, m) => {
          refs.set(`${index}:${m}`, o.element);
          return { ref: `${index}:${m}`, kind: o.kind, text: o.text };
        }),
      });
    }
  }
  const context: AiContext = {
    steps: aiSteps,
    end: facts && {
      url: stablePath(facts.url),
      title: facts.title,
      items: facts.items.map((o, m) => {
        refs.set(`end:${m}`, o.element);
        return { ref: `end:${m}`, kind: o.kind, text: o.text };
      }),
    },
    fields: [...fields.values()].filter((f) => !secrets.includes(f.key)).map((f) => ({ key: f.key, label: f.label, kind: fieldKind(f), rules: rulesText(f.rules), value: f.value })),
    segments: aiSegments,
    refs,
  };

  const draft: IntentDraft = {
    title: input.title,
    intent: input.intent,
    segments,
    test: { title: input.title, steps: testSteps, secrets },
    negative: negative && invalid.length ? { ...negative, secrets } : null,
    fields: [...fields.values()].map((f) => ({
      key: f.key, label: f.label, kind: fieldKind(f), rules: rulesText(f.rules), ruleSet: f.rules,
      recorded: secrets.includes(f.key) ? '' : f.value, secret: secrets.includes(f.key),
    })),
    valid,
    invalid: negative ? invalid : [],
    checks,
    questions,
    submitStepId: submit?.step.id ?? null,
    baseUrl: ctx.baseOrigin ?? '',
    // From the steps as built, so fields added from the form are on their page too.
    pages: pagesOf([...groups.flat()], facts),
    notes,
    ai: { status: 'off', message: null },
  };
  return { draft, context };
}

/**
 * The pages a journey went through, as the recording saw them: what each page is called, the fields
 * filled on it and their rules, what was pressed, and the messages, dialogs and headings that came up.
 * Saved with a workflow, it is what scenarios are proposed from.
 */
function pagesOf(steps: Converted[], facts: Extract<RecordedStep, { action: 'facts' }> | null): PageInfo[] {
  const pages = new Map<string, PageInfo>();
  const pageFor = (path: string): PageInfo => {
    let p = pages.get(path);
    if (!p) {
      p = { path, title: '', headings: [], fields: [], actions: [], messages: [] };
      pages.set(path, p);
    }
    return p;
  };
  for (const c of steps) {
    const here = pageFor(stablePath(`https://x${c.page}`));
    const what = c.field?.label ?? c.element?.suggestedName ?? c.step.action;
    if (c.field && !here.fields.some((f) => f.key === c.field!.key))
      here.fields.push({ key: c.field.key, label: c.field.label, kind: fieldKind(c.field), rules: c.field.rules });
    if ((c.step.action === 'click' || c.step.action === 'press') && c.step.target && 'locator' in c.step.target && here.actions.length < 40)
      here.actions.push({ label: what.slice(0, 200), locator: c.step.target.locator });
    // What appeared belongs to the page it appeared on: the next one, when the step moved there.
    const on = c.navigatedTo ? pageFor(stablePath(c.navigatedTo)) : here;
    for (const o of c.observed) {
      if (o.kind === 'heading') {
        if (!on.headings.includes(o.text) && on.headings.length < 20) on.headings.push(o.text.slice(0, 300));
      } else if (on.messages.length < 40) on.messages.push({ kind: o.kind, text: o.text.slice(0, 300), after: what.slice(0, 200) });
    }
  }
  if (facts) {
    const last = pageFor(stablePath(facts.url));
    last.title = facts.title;
    for (const i of facts.items) if (i.kind === 'heading' && !last.headings.includes(i.text) && last.headings.length < 20) last.headings.push(i.text.slice(0, 300));
  }
  return [...pages.values()].slice(0, 20);
}

function negativeTest(
  input: BuildInput,
  segments: DraftSegment[],
  groups: Converted[][],
  pre: Converted[],
  useStep: (seg: DraftSegment, n: number) => AutoStep,
  testSteps: AutoStep[],
  /** The success signal, turned round: it must not show when the input is invalid. */
  signalHidden: Assertion | null,
  addCheck: (stepId: string, a: Assertion, why: string) => void,
): { title: string; steps: AutoStep[] } | null {
  const formAt = groups.findLastIndex((g) => g.some((c) => c.field && !c.secret));
  if (formAt === -1) return null;
  const form = groups[formAt]!;
  const lastType = form.findLastIndex((c) => !!c.field);
  const submitAt = form.findIndex((c, i) => i > lastType && CHANGING_ACTIONS.includes(c.step.action));
  if (submitAt === -1) return null;
  const submit = form[submitAt]!;
  const negSteps = form.slice(0, submitAt + 1).map((c) => ({ ...c.step, id: `n-${c.step.id}`, assertions: [] }));
  const submitId = `n-${submit.step.id}`;
  let checked = false;
  if (submit.navigatedTo && stablePath(`https://x${submit.page}`) !== '/') {
    addCheck(submitId, { kind: 'url_contains', expected: stablePath(`https://x${submit.page}`), soft: false }, 'With invalid data the form must not move on: it stays on this page.');
    checked = true;
  }
  if (signalHidden) {
    addCheck(submitId, signalHidden, 'What shows success with valid data must not show with invalid data.');
    checked = true;
  }
  // A form in a dialog that refuses its input keeps the dialog open: the clearest sign of all.
  const dialog = form.slice(0, submitAt).flatMap((c) => c.observed).reverse().find((o) => o.kind === 'dialog');
  const dialogLoc = dialog && chooseLocator(dialog.element, CHECK_POLICY);
  if (dialogLoc) {
    addCheck(submitId, { kind: 'visible', target: { locator: dialogLoc }, soft: false }, 'With invalid data the form must not be accepted: its dialog stays open.');
    checked = true;
  }
  if (!checked) return null;
  const firstSegment = segments.findIndex((s) => s.role === 'segment');
  const before = testSteps.filter((s) => s.id === 'u0');
  if (pre.length) before.push(useStep(segments[0]!, 0));
  segments.slice(firstSegment, firstSegment + formAt).forEach((seg, i) => before.push(useStep(seg, firstSegment + i + 1)));
  return { title: `${input.title} rejects invalid input`, steps: [...before, ...negSteps] };
}

/** JSON with object keys sorted, so equal values compare equal whatever order they were built in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * An existing component doing the same steps on the same elements, with how its inputs line up with
 * this recording's fields (its "mobile" may be this recording's "enterMobileNumber").
 */
function findReuse(steps: Converted[], existing: StudioComponent[]): (NonNullable<DraftSegment['reuse']> & { bindings: Record<string, string> }) | null {
  // Keys sorted: a saved component comes back from jsonb with its keys in another order.
  const sig = (s: AutoStep) => `${s.action}|${canonical(s.target ?? null)}`;
  const mine = steps.map((c) => sig(c.step));
  if (mine.length < 2) return null;
  for (const c of existing) {
    const theirs = c.steps.map(sig);
    if (theirs.length !== mine.length || !theirs.every((t, i) => t === mine[i])) continue;
    const bindings: Record<string, string> = {};
    c.steps.forEach((s, i) => {
      const input = /^\{data\.(\w+)\}$/.exec(s.value ?? '')?.[1];
      const key = steps[i]!.field?.key;
      if (input && key) bindings[input] = key;
    });
    if (!c.inputs.every((k) => k in bindings)) continue;
    return { id: c.id, name: c.name, version: c.version, why: `Same ${mine.length} steps on the same elements as "${c.name}" v${c.version}.`, bindings };
  }
  return null;
}

/**
 * A page's name from its address ("/checkout/payment" is "Payment"). Not from a heading: what appears
 * after a step belongs to the page it leads to, and headings are often content (a product's name).
 */
function pageName(g: Converted[]): string {
  const last = g[0]!.page.split('/').filter(Boolean).filter((p) => !DYNAMIC_SEGMENT.test(p)).pop();
  return last ? capital(last.replace(/[-_]+/g, ' ')) : 'Home';
}

function verbOf(g: Converted[]): string {
  if (g.some((c) => c.field)) return 'fill in the form';
  if (g.some((c) => c.step.action === 'store')) return 'read values';
  return g.some((c) => c.step.action === 'click') ? 'go through' : 'open';
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function rulesText(r: FieldRules): string {
  return [
    r.type !== 'text' && r.type,
    r.required && 'required',
    r.minLength > 0 && `min ${r.minLength}`,
    r.maxLength > 0 && `max ${r.maxLength}`,
    r.pattern && `pattern ${r.pattern}`,
    r.min && `≥ ${r.min}`,
    r.max && `≤ ${r.max}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

