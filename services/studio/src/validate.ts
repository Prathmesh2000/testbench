import {
  API_ASSERTIONS,
  BROWSER_ASSERTIONS,
  CHANGING_ACTIONS,
  PAGE_ASSERTIONS,
  type AssertionKind,
  type AutoStep,
  type StepIssue,
} from '@tb/contracts';

/** {data.x} {secret.x} {env.x} {vars.x}: the only placeholders steps may use. */
export const REF = /\{(data|secret|env|vars)\.([a-zA-Z_]\w*)\}/g;

const NEEDS_TARGET: AutoStep['action'][] = ['click', 'type', 'select', 'check', 'uncheck', 'hover', 'store'];
const NEEDS_VALUE: AutoStep['action'][] = ['open', 'type', 'select', 'press'];
const NEEDS_EXPECTED: AssertionKind[] = [
  'text_equals',
  'text_contains',
  'value_equals',
  'count_equals',
  'url_contains',
  'title_contains',
  'status_equals',
];

export interface ValidationContext {
  /** Columns of the bound data set, or null when the test has none (then {data.x} is an error). */
  dataColumns: string[] | null;
  secrets: string[];
  elementIds: Set<string>;
  /** Components by `${id}@${version}`, with the inputs they declare. */
  components: Map<string, { inputs: string[] }>;
  /** Validating a component's own steps: {data.x} then means one of its inputs. */
  insideComponent?: boolean;
}

/** The text of a locator that may hold placeholders: its value, name and container's. */
function locatorTexts(t: AutoStep['target']): (string | undefined)[] {
  if (!t || !('locator' in t)) return [];
  const l = t.locator;
  return [l.strategy === 'css' ? undefined : l.value, l.name, l.within?.value, l.within?.name, l.within?.hasText];
}

/** Every placeholder a step uses, wherever it appears. */
function refsOf(step: AutoStep): { ns: string; name: string }[] {
  const texts = [
    ...locatorTexts(step.target),
    ...step.assertions.flatMap((a) => locatorTexts(a.target)),
    step.value,
    ...step.assertions.map((a) => a.expected),
    ...step.assertions.map((a) => a.key),
    step.request?.url,
    step.request?.body,
    ...Object.values(step.request?.headers ?? {}),
    ...Object.values(step.component?.inputs ?? {}),
  ].filter((t): t is string => !!t);
  return texts.flatMap((t) => [...t.matchAll(REF)].map((m) => ({ ns: m[1]!, name: m[2]! })));
}

/**
 * The reliability rules (testing-studio-plan §5), checked when a test or component is saved. Errors
 * block the save; warnings are stored with the version and shown to the tester and reviewer.
 */
export function validateSteps(steps: AutoStep[], ctx: ValidationContext): StepIssue[] {
  const issues: StepIssue[] = [];
  const add = (stepIndex: number | null, severity: StepIssue['severity'], code: string, message: string) =>
    issues.push({ stepIndex, severity, code, message });
  const extracted = new Set<string>();
  const ids = new Set<string>();

  steps.forEach((step, i) => {
    if (ids.has(step.id)) add(i, 'error', 'duplicate_step_id', 'Two steps share the same id.');
    ids.add(step.id);

    if (NEEDS_TARGET.includes(step.action) && !step.target)
      add(i, 'error', 'missing_target', `A "${step.action}" step needs an element to act on.`);
    if (NEEDS_VALUE.includes(step.action) && !step.value)
      add(i, 'error', 'missing_value', step.action === 'open' ? 'Say which address to open.' : `A "${step.action}" step needs a value.`);
    if (step.action === 'api_request' && !step.request) add(i, 'error', 'missing_request', 'Describe the API request to send.');
    if (step.action === 'store') {
      if (!step.value || !/^[a-zA-Z_]\w{0,40}$/.test(step.value))
        add(i, 'error', 'store_name', 'Name the variable to store into: letters, digits and _, starting with a letter.');
      else extracted.add(step.value);
    }
    if (step.action === 'use_component') {
      if (ctx.insideComponent) add(i, 'error', 'nested_component', 'A component cannot use another component.');
      else if (!step.component) add(i, 'error', 'missing_component', 'Pick the component to use.');
      else {
        const comp = ctx.components.get(`${step.component.id}@${step.component.version}`);
        if (!comp) add(i, 'error', 'unknown_component', 'That component version does not exist.');
        else
          for (const input of comp.inputs)
            if (!(input in step.component.inputs)) add(i, 'error', 'missing_input', `Fill in the component's "${input}" input.`);
      }
    }
    if (step.action === 'manual')
      add(i, 'warning', 'manual_step', 'This step needs a person, so unattended runs skip the whole test.');

    // Where the step acts, and whether that element is known.
    const targets = [step.target, ...step.assertions.map((a) => a.target)].filter((t) => !!t);
    for (const t of targets) {
      if ('elementId' in t && !ctx.elementIds.has(t.elementId))
        add(i, 'error', 'unknown_element', 'That element is not in the page library any more.');
      if ('locator' in t && t.locator.strategy === 'css')
        add(i, 'warning', 'fragile_locator', 'CSS selectors break when the layout changes; prefer a test id, role or label.');
      if ('locator' in t && t.locator.strategy === 'role' && !t.locator.name)
        add(i, 'warning', 'unnamed_role', 'A role without a name often matches several elements; add its accessible name.');
    }

    for (const a of step.assertions) {
      const needsElement = !PAGE_ASSERTIONS.includes(a.kind) && !API_ASSERTIONS.includes(a.kind) && !BROWSER_ASSERTIONS.includes(a.kind);
      if (BROWSER_ASSERTIONS.includes(a.kind) && !a.key?.trim())
        add(i, 'error', 'assertion_key', a.kind === 'api_called' ? 'Say which API: "POST /api/projects".' : `Say which ${a.kind === 'cookie' ? 'cookie' : 'storage key'} to check.`);
      if (a.kind === 'api_called' && a.key?.trim() && !/^[A-Za-z]+\s+\/\S*$/.test(a.key.trim()))
        add(i, 'error', 'assertion_key', 'Write the API as a method and a path: "POST /api/projects".');
      if (needsElement && !a.target && !step.target)
        add(i, 'error', 'assertion_target', `The "${a.kind}" check needs an element.`);
      if (API_ASSERTIONS.includes(a.kind) && step.action !== 'api_request')
        add(i, 'error', 'assertion_kind', 'A status check only applies to an API request step.');
      if (NEEDS_EXPECTED.includes(a.kind) && !a.expected)
        add(i, 'error', 'assertion_expected', `Say what the "${a.kind}" check expects.`);
      if (a.expected && /\{secret\./.test(a.expected))
        add(i, 'warning', 'secret_in_check', 'Checks appear in reports and logs; comparing against a secret exposes it.');
    }

    // Web-first assertions only prove something if there is one after each change (§5.2).
    if (CHANGING_ACTIONS.includes(step.action) && step.assertions.length === 0 && !step.noCheck)
      add(i, 'error', 'needs_assertion', 'Add a check for what should happen next, or mark "no check needed".');

    for (const ref of refsOf(step)) {
      if (ref.ns === 'data') {
        if (ctx.dataColumns === null)
          add(i, 'error', 'unknown_data', `{data.${ref.name}} needs a data set${ctx.insideComponent ? ' input' : ''} with that column.`);
        else if (!ctx.dataColumns.includes(ref.name))
          add(i, 'error', 'unknown_data', `There is no "${ref.name}" ${ctx.insideComponent ? 'input' : 'column in the data set'}.`);
      } else if (ref.ns === 'secret' && !ctx.secrets.includes(ref.name)) {
        add(i, 'error', 'unknown_secret', `Declare the secret "${ref.name}" on the test before using it.`);
      } else if (ref.ns === 'vars' && !extracted.has(ref.name)) {
        add(i, 'error', 'unknown_var', `{vars.${ref.name}} is not saved by an earlier step (an API request or a stored value).`);
      }
    }
    for (const e of step.request?.extract ?? []) extracted.add(e.name);
  });

  const all = steps.flatMap((s) => s.assertions);
  if (!ctx.insideComponent && all.length === 0)
    add(null, 'warning', 'no_assertions', 'This test checks nothing; it can only fail if the page breaks outright.');
  else if (!ctx.insideComponent && all.every((a) => a.kind === 'visible'))
    add(null, 'warning', 'weak_assertions', 'Every check only looks for visible elements; check text or values too.');
  return issues;
}
