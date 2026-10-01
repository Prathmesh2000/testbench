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
/**
 * One step of a locator. Its text may hold {data.x} or {vars.x} ("the project named {data.name}"),
 * turned into run-time lookups like step values; a CSS selector and a role name stay literal.
 */
function oneLocator(l: { strategy: Locator['strategy']; value: string; name?: string }, root: string, dataVar: string): string {
  const v = valueExpr(l.value, dataVar);
  switch (l.strategy) {
    case 'testid':
      return `${root}.getByTestId(${v})`;
    case 'role':
      return `${root}.getByRole(role(${j(l.value)})${l.name ? `, { name: ${valueExpr(l.name, dataVar)}, exact: true }` : ''})`;
    case 'label':
      return `${root}.getByLabel(${v}, { exact: true })`;
    case 'placeholder':
      return `${root}.getByPlaceholder(${v}, { exact: true })`;
    case 'text':
      return `${root}.getByText(${v})`;
    case 'css':
      return `${root}.locator(${j(l.value)})`;
  }
}

/**
 * The full expression, scoping through `within` first so "the Add button in the Dell XPS row" comes
 * out as Playwright would write it by hand.
 */
export function locatorExpr(l: Locator, dataVar = 'data'): string {
  let root = 'page';
  if (l.within) {
    root = oneLocator(l.within, 'page', dataVar);
    if (l.within.hasText) root += `.filter({ hasText: ${valueExpr(l.within.hasText, dataVar)} })`;
  }
  const expr = oneLocator(l, root, dataVar);
  return l.nth === undefined ? expr : `${expr}.nth(${l.nth})`;
}

function targetExpr(t: Target, lib: GenerationLibrary, dataVar = 'data'): string {
  if ('locator' in t) return locatorExpr(t.locator, dataVar);
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
  // Browser checks poll: a cookie or a stored value is often written just after the page updates.
  const poll = a.soft ? 'expect.soft.poll' : 'expect.poll';
  const key = valueExpr(a.key ?? '', dataVar);
  const settles = a.expected === undefined || a.expected === '' ? 'not.toBeNull()' : `toBe(${exp})`;
  if (a.kind === 'cookie') return [`await ${poll}(async () => (await page.context().cookies()).find((c) => c.name === ${key})?.value ?? null).${settles};`];
  if (a.kind === 'local_storage' || a.kind === 'session_storage') {
    const area = a.kind === 'local_storage' ? 'localStorage' : 'sessionStorage';
    return [`await ${poll}(() => page.evaluate((k) => ${area}.getItem(k), ${key})).${settles};`];
  }
  if (a.kind === 'api_called') {
    const status = a.expected ? ` && String(c.status) === String(${exp})` : '';
    return [`await ${poll}(() => apiCalls.some((c) => calledAs(c, ${key})${status})).toBe(true);`];
  }
  const target = a.target ?? step.target;
  if (!target) throw new Error(`Check "${a.kind}" has no element`);
  const loc = targetExpr(target, lib, dataVar);
  if (a.kind === 'validation_message') {
    // The browser's message is not on the page, so it is polled from the field until it settles.
    const read = `() => ${loc}.evaluate((e) => (e as HTMLInputElement).validationMessage)`;
    return [a.expected ? `await expect.poll(${read}).toContain(${exp});` : `await expect.poll(${read}).not.toBe('');`];
  }
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
  const loc = step.target ? targetExpr(step.target, lib, dataVar) : '';
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
    case 'store':
      return [`vars[${j(step.value!)}] = await readText(${loc});`];
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
    // `index` already ends in a dot ("2."), so a component's steps read 2.1, 2.2 in reports.
    comp.steps.forEach((s, n) => body.push(...stepBlock(s, `${index}${n + 1}`, lib, 'input', '')));
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
    "import { expect, test, type Locator, type Page } from '@playwright/test';",
    '',
    '// {unique} in a value is new on every run, for apps that refuse a value already used (a name, an email).',
    "const unique = (Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 4)).padEnd(8, '0');",
    'const data: Record<string, string> = Object.fromEntries(',
    "  Object.entries(JSON.parse(process.env.TB_DATA ?? '{}') as Record<string, string>).map(([k, v]) => [k, String(v).split('{unique}').join(unique)]),",
    ');',
    "const env: Record<string, string> = JSON.parse(process.env.TB_ENV ?? '{}');",
    "const secret = (name: string) => process.env[`TB_SECRET_${name}`] ?? '';",
    "const role = (r: string) => r as Parameters<Page['getByRole']>[0];",
    '// A field shows its value, anything else its text; read at run time, so a generated id is this run\'s.',
    'const readText = async (l: Locator) =>',
    "  (await l.evaluate((e) => (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) ? (e as HTMLInputElement).value : (e.textContent ?? '')))).trim();",
    "const contains = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'));",
    '// "POST /api/projects/:id" matches that method and path, ":id" any one segment.',
    'const calledAs = (c: { method: string; path: string }, want: string) => {',
    "  const [method, path = ''] = want.trim().split(/\\s+/, 2);",
    "  const re = new RegExp(`^${path.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&').replace(/:id\\b/g, '[^/]+')}/?$`);",
    '  return c.method.toUpperCase() === method!.toUpperCase() && re.test(c.path);',
    '};',
    'const pick = (value: unknown, path: string): unknown =>',
    "  path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), value);",
    '',
    `test(${j(`${test.key} ${test.title}`)}, async ({ page }) => {`,
    '  const vars: Record<string, unknown> = {};',
    '  // Every API the page calls, for api_called checks: a check comes after the call it looks for.',
    "  const apiCalls: Array<{ method: string; path: string; status: number }> = [];",
    "  page.on('response', (r) => { if (['xhr', 'fetch'].includes(r.request().resourceType())) apiCalls.push({ method: r.request().method(), path: new URL(r.url()).pathname, status: r.status() }); });",
    ...steps,
    '  void vars;',
    '});',
    '',
  ].join('\n');
  return { code, runnable };
}
