import type { Assertion, GeneratedCode, Locator, AutoStep, Target } from '@tb/contracts';
import { REF } from './validate';

export interface GenerationLibrary {
  /** Page library: element id → ranked locators (the first is used). */
  elements: Map<string, Locator[]>;
  /** Components by `${id}@${version}`. */
  components: Map<string, { name: string; steps: AutoStep[] }>;
}

const j = (s: string) => JSON.stringify(s);

/**
 * A step value as a TypeScript expression. Placeholders become lookups at run time; everything else
 * stays a string literal, so no text from a step can ever become code.
 */
export function valueExpr(text: string, dataVar = 'data'): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(REF)) {
    if (m.index! > last) parts.push(j(text.slice(last, m.index)));
    const [, ns, name] = m;
    parts.push(
      ns === 'data'
        ? `(${dataVar}[${j(name!)}] ?? '')`
        : ns === 'secret'
          ? `secret(${j(name!)})`
          : ns === 'env'
            ? `(env[${j(name!)}] ?? '')`
            : `String(vars[${j(name!)}] ?? '')`,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(j(text.slice(last)));
  return parts.length ? parts.join(' + ') : "''";
}

/** One step of a locator: the call itself, without any scoping. */
function oneLocator(l: { strategy: Locator['strategy']; value: string; name?: string }, root: string): string {
  switch (l.strategy) {
    case 'testid':
      return `${root}.getByTestId(${j(l.value)})`;
    case 'role':
      return `${root}.getByRole(role(${j(l.value)})${l.name ? `, { name: ${j(l.name)}, exact: true }` : ''})`;
    case 'label':
      return `${root}.getByLabel(${j(l.value)}, { exact: true })`;
    case 'placeholder':
      return `${root}.getByPlaceholder(${j(l.value)}, { exact: true })`;
    case 'text':
      return `${root}.getByText(${j(l.value)})`;
    case 'css':
      return `${root}.locator(${j(l.value)})`;
  }
}

/**
 * The full expression, scoping through `within` first so "the Add button in the Dell XPS row" comes
 * out as Playwright would write it by hand.
 */
export function locatorExpr(l: Locator): string {
  let root = 'page';
  if (l.within) {
    root = oneLocator(l.within, 'page');
    if (l.within.hasText) root += `.filter({ hasText: ${j(l.within.hasText)} })`;
  }
  const expr = oneLocator(l, root);
  return l.nth === undefined ? expr : `${expr}.nth(${l.nth})`;
}

function targetExpr(t: Target, lib: GenerationLibrary): string {
  if ('locator' in t) return locatorExpr(t.locator);
  const best = lib.elements.get(t.elementId)?.[0];
  if (!best) throw new Error(`Element ${t.elementId} is not in the page library`);
  return locatorExpr(best);
}

/** Web-first assertions only: each one retries until it holds or times out (§5.1). */
function assertionLines(a: Assertion, step: AutoStep, lib: GenerationLibrary, dataVar: string): string[] {
  const ex = a.soft ? 'expect.soft' : 'expect';
  const exp = a.expected === undefined ? "''" : valueExpr(a.expected, dataVar);
  if (a.kind === 'url_contains') return [`await ${ex}(page).toHaveURL(contains(${exp}));`];
  if (a.kind === 'title_contains') return [`await ${ex}(page).toHaveTitle(contains(${exp}));`];
  if (a.kind === 'status_equals') return [`${ex}(response.status()).toBe(Number(${exp}));`];
  const target = a.target ?? step.target;
  if (!target) throw new Error(`Check "${a.kind}" has no element`);
  const loc = targetExpr(target, lib);
  const matcher = {
    visible: 'toBeVisible()',
    hidden: 'toBeHidden()',
    enabled: 'toBeEnabled()',
    disabled: 'toBeDisabled()',
    checked: 'toBeChecked()',
    text_equals: `toHaveText(${exp})`,
    text_contains: `toContainText(${exp})`,
    value_equals: `toHaveValue(${exp})`,
    count_equals: `toHaveCount(Number(${exp}))`,
  }[a.kind];
  return [`await ${ex}(${loc}).${matcher};`];
}

function actionLines(step: AutoStep, lib: GenerationLibrary, dataVar: string): string[] {
  const loc = step.target ? targetExpr(step.target, lib) : '';
  const val = step.value === undefined ? "''" : valueExpr(step.value, dataVar);
  switch (step.action) {
    case 'open':
      return [`await page.goto(${val});`];
    case 'click':
      return [`await ${loc}.click();`];
    case 'type':
      return [`await ${loc}.fill(${val});`];
    case 'select':
      return [`await ${loc}.selectOption(${val});`];
    case 'check':
      return [`await ${loc}.check();`];
    case 'uncheck':
      return [`await ${loc}.uncheck();`];
    case 'hover':
      return [`await ${loc}.hover();`];
    case 'press':
      return [step.target ? `await ${loc}.press(${val});` : `await page.keyboard.press(${val});`];
    case 'verify':
      return [];
    case 'manual':
      // Headless runs skip the test; Assist mode (TB_ASSIST=1) pauses here for the tester instead.
      return [`test.skip(process.env.TB_ASSIST !== '1', ${j(`Needs a person: ${step.intent || step.value || 'manual step'}`)});`];
    case 'api_request': {
      const r = step.request!;
      const headers = Object.entries(r.headers).map(([k, v]) => `${j(k)}: ${valueExpr(v, dataVar)}`);
      const lines = [
        `const response = await page.request.fetch(${valueExpr(r.url, dataVar)}, {`,
        `  method: ${j(r.method)},`,
        `  headers: { ${headers.join(', ')} },`,
        ...(r.body ? [`  data: ${valueExpr(r.body, dataVar)},`] : []),
        '});',
      ];
      if (r.extract.length) {
        lines.push('const json: unknown = await response.json().catch(() => null);');
        for (const e of r.extract) lines.push(`vars[${j(e.name)}] = pick(json, ${j(e.path)});`);
      }
      return lines;
    }
    case 'use_component':
      return [];
  }
}

function stepBlock(step: AutoStep, index: string, lib: GenerationLibrary, dataVar: string, indent: string): string[] {
  const label = `${index} ${step.intent || step.action}`;
  const body: string[] = [];
  if (step.action === 'use_component') {
    const comp = lib.components.get(`${step.component!.id}@${step.component!.version}`);
    if (!comp) throw new Error(`Component ${step.component!.id} v${step.component!.version} is missing`);
    const inputs = Object.entries(step.component!.inputs).map(([k, v]) => `${j(k)}: ${valueExpr(v, dataVar)}`);
    body.push(`const input: Record<string, string> = { ${inputs.join(', ')} };`);
    // Inside a component, {data.x} means the component's input x.
    comp.steps.forEach((s, n) => body.push(...stepBlock(s, `${index}.${n + 1}`, lib, 'input', '')));
  } else {
    body.push(...actionLines(step, lib, dataVar));
  }
  for (const a of step.assertions) body.push(...assertionLines(a, step, lib, dataVar));
  const inner = body.map((l) => `  ${l}`);
  return [`await test.step(${j(label)}, async () => {`, ...inner, '});'].map((l) => indent + l);
}

/**
 * Playwright code for one pinned test version. The generator is the only place code comes from, so
 * the reliability rules hold for every test: no sleeps, web-first assertions, one step per
 * `test.step` (which names each step in traces and reports), and step text only ever as string data.
 */
export function generateCode(
  test: { title: string; key: string; version: number; steps: AutoStep[] },
  lib: GenerationLibrary,
): GeneratedCode {
  const runnable = !test.steps.some(
    (s) =>
      s.action === 'manual' ||
      (s.action === 'use_component' &&
        lib.components.get(`${s.component!.id}@${s.component!.version}`)?.steps.some((c) => c.action === 'manual')),
  );
  const steps = test.steps.flatMap((s, i) => stepBlock(s, `${i + 1}.`, lib, 'data', '  '));
  const code = [
    `// Generated by Testbench from ${test.key} v${test.version}. Edit the steps in Testbench, not this file.`,
    "import { expect, test, type Page } from '@playwright/test';",
    '',
    "const data: Record<string, string> = JSON.parse(process.env.TB_DATA ?? '{}');",
    "const env: Record<string, string> = JSON.parse(process.env.TB_ENV ?? '{}');",
    "const secret = (name: string) => process.env[`TB_SECRET_${name}`] ?? '';",
    "const role = (r: string) => r as Parameters<Page['getByRole']>[0];",
    "const contains = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'));",
    'const pick = (value: unknown, path: string): unknown =>',
    "  path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), value);",
    '',
    `test(${j(`${test.key} ${test.title}`)}, async ({ page }) => {`,
    '  const vars: Record<string, unknown> = {};',
    ...steps,
    '  void vars;',
    '});',
    '',
  ].join('\n');
  return { code, runnable };
}
