import type { Locator, PickedElement, RecordedStep } from '@tb/contracts';

// Playwright code for what the Site pane picks and records. Built here from the validated locator
// fields, never from the `code` string a page reports: in Live mode the page is any site on the
// internet, and its scripts can send whatever they like. Every value goes through JSON.stringify, so
// nothing from a page can become code in the tester's file.
//
// A recorded script has to replay on another day, with other data, on a slower environment:
// - No fixed waits. Playwright waits for each element to be actionable; a page change is checked with
//   toHaveURL against a pattern, so it holds however long the transition takes.
// - Typed values become `data.x` parameters (overridable with TB_DATA), and a value the tester stored
//   with "Store value" is read at run time into `vars.x`. Wherever either value shows up again, in
//   another field or inside a locator, the script uses the parameter, so it follows the data.
// - Locators that lean on the page's data (prices, counts, positions) are used only when nothing
//   stable finds the element (see isStable in locator-core.ts).

export type { RecordedStep };

const q = (v: string) => JSON.stringify(v);

/** Known values and the expression that produces them at run time, longest first. */
type Refs = Array<{ value: string; expr: string }>;

/** A string as an expression: literal pieces joined with the parameters found inside it. */
function lit(v: string, refs: Refs): string {
  for (const r of refs) {
    const at = v.indexOf(r.value);
    if (at === -1) continue;
    const parts = [
      ...(at > 0 ? [lit(v.slice(0, at), refs)] : []),
      r.expr,
      ...(at + r.value.length < v.length ? [lit(v.slice(at + r.value.length), refs)] : []),
    ];
    return parts.join(' + ');
  }
  return q(v);
}

function oneCall(l: { strategy: Locator['strategy']; value: string; name?: string }, refs: Refs): string {
  const v = lit(l.value, refs);
  switch (l.strategy) {
    case 'testid':
      return `getByTestId(${v})`;
    case 'role':
      return `getByRole(${q(l.value)}${l.name ? `, { name: ${lit(l.name, refs)}, exact: true }` : ''})`;
    case 'label':
      return `getByLabel(${v}, { exact: true })`;
    case 'placeholder':
      return `getByPlaceholder(${v}, { exact: true })`;
    case 'text':
      return `getByText(${v}, { exact: true })`;
    case 'css':
      return `locator(${q(l.value)})`;
  }
}

/** The locator as it would be written by hand, scope and position included; same shape as the picker's. */
export function locatorCode(l: Locator, root = 'page', refs: Refs = []): string {
  let prefix = '';
  if (l.within) {
    prefix = oneCall(l.within, refs);
    if (l.within.hasText) prefix += `.filter({ hasText: ${lit(l.within.hasText, refs)} })`;
    prefix += '.';
  }
  return `${root}.${prefix}${oneCall(l, refs)}${l.nth === undefined ? '' : `.nth(${Math.trunc(l.nth)})`}`;
}

/**
 * The locator a recorded step uses: unique and stable first, then unique, as the picker preselects.
 * `avoid` is data the locator must not contain, such as the very text a Store step is reading.
 */
export function bestLocator(el: PickedElement, avoid?: string): Locator | null {
  const usable = el.locators.filter(
    (l) => !avoid || ![l.value, l.name, l.within?.hasText].some((s) => s && s.includes(avoid)),
  );
  const pool = usable.length ? usable : el.locators;
  return pool.find((l) => l.matches === 1 && l.stable) ?? pool.find((l) => l.matches === 1) ?? pool[0] ?? null;
}

/** A camelCase name for a parameter, from what the element is called. */
export function identifier(label: string, taken: Set<string>, fallback: string): string {
  const words = label.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, 4);
  let base = words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  if (!/^[a-zA-Z_]\w*$/.test(base)) base = fallback;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

const DYNAMIC_SEGMENT = /\d{2,}|^[0-9a-f]{8,}$|^[0-9a-f-]{32,36}$|^(?=.*\d)(?=.*[a-z]).{16,}$/i;
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a page address must look like, as a RegExp source: the path only (the host differs between
 * environments), with ids and numbers wildcarded, and any query or fragment allowed.
 */
export function urlPattern(url: string): string {
  let path = '/';
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a URL: check nothing more specific than "some page".
  }
  const segments = path.split('/').map((s) => (DYNAMIC_SEGMENT.test(decodeURIComponent(s)) ? '[^/]+' : reEscape(s)));
  return `^https?://[^/]+${segments.join('/')}(?:[?#]|$)`;
}

/** The element's root: its tab, then each iframe it sits in, reached with contentFrame(). */
function rootOf(page: string, frames: PickedElement[], refs: Refs): string {
  return frames.reduce((root, f) => {
    const loc = bestLocator(f);
    return loc ? `${locatorCode(loc, root, refs)}.contentFrame()` : root;
  }, page);
}

/** Password fields are never captured; the script reads them from a Testbench secret instead. */
const secretExpr = (name: string) => `(process.env[${q(`TB_SECRET_${name}`)}] ?? '')`;

/**
 * The recording as a test block, ready to paste into a spec. Steps with nothing to act on are
 * skipped; consecutive address changes on a tab collapse to the last one (redirects).
 */
export function scriptCode(steps: RecordedStep[], title = 'recorded test'): string {
  const pages = new Map<string, string>();
  const pageOf = (tab: string) => pages.get(tab) ?? (pages.size ? 'page' : (pages.set(tab, 'page'), 'page'));
  const firstTab = steps[0]?.tab;
  if (firstTab) pages.set(firstTab, 'page');

  const refs: Refs = [];
  const data: Array<[string, string]> = [];
  const names = new Set<string>(['page', 'context', 'data', 'vars']);
  const blocks: string[][] = [];
  const lastAction = new Map<string, number>(); // tab → index of its latest click or key press
  let usesVars = false;

  const refFor = (value: string, expr: string) => {
    if (value.trim().length >= 3 && !refs.some((r) => r.value === value)) {
      refs.push({ value, expr });
      refs.sort((a, b) => b.value.length - a.value.length);
    }
  };

  steps.forEach((step, i) => {
    const out: string[] = [];
    blocks.push(out);
    const p = pageOf(step.tab);

    if (step.action === 'open') {
      out.push(`await ${p}.goto(${q(step.url)});`);
      return;
    }
    if (step.action === 'navigated') {
      const next = steps.slice(i + 1).find((s) => s.tab === step.tab);
      const prev = steps.slice(0, i).reverse().find((s) => s.tab === step.tab);
      if (next?.action === 'navigated') return;
      if (prev && (prev.action === 'open' || prev.action === 'navigated') && urlPattern(prev.url) === urlPattern(step.url)) return;
      out.push(`await expect(${p}).toHaveURL(new RegExp(${q(urlPattern(step.url))}));`);
      return;
    }
    if (step.action === 'popup') {
      const name = identifier(`page ${pages.size}`, names, `page${pages.size}`);
      pages.set(step.tab, name);
      // The wait has to start before the click that opens the tab, or the event can be missed.
      const trigger = lastAction.get(step.opener) ?? [...lastAction.values()].pop();
      if (trigger !== undefined) {
        blocks[trigger]!.unshift(`const ${name}Promise = ${pageOf(step.opener)}.waitForEvent('popup');`);
        out.push(`const ${name} = await ${name}Promise;`);
      } else {
        out.push(`const ${name} = await context.waitForEvent('page');`);
      }
      out.push(`await ${name}.waitForLoadState();`);
      return;
    }
    if (step.action === 'newtab') {
      const name = identifier(`page ${pages.size}`, names, `page${pages.size}`);
      pages.set(step.tab, name);
      out.push(`const ${name} = await context.newPage();`);
      return;
    }
    if (step.action === 'close') {
      out.push(`await ${p}.close();`);
      return;
    }
    if (step.action === 'history') {
      out.push(`await ${p}.${step.go === 'back' ? 'goBack' : step.go === 'forward' ? 'goForward' : 'reload'}();`);
      return;
    }

    // Observations and the page's own API calls are for building checks from; they are not actions to replay.
    if (step.action === 'observed' || step.action === 'facts' || step.action === 'api') return;
    const el = step.element;
    const root = rootOf(p, step.frames, refs);
    if (step.action === 'store') {
      const loc = el && bestLocator(el, step.value);
      if (!loc) return;
      const name = identifier(el.suggestedName || 'value', names, `value${i}`);
      const read = /^(input|textarea|select)$/.test(el.tag) ? 'inputValue()' : 'innerText()';
      out.push(`vars.${name} = (await ${locatorCode(loc, root, refs)}.${read}).trim();`);
      usesVars = true;
      if (step.value) refFor(step.value.trim(), `vars.${name}`);
      return;
    }
    if (step.action === 'press') {
      const loc = el && bestLocator(el);
      out.push(loc ? `await ${locatorCode(loc, root, refs)}.press(${q(step.value ?? 'Enter')});` : `await ${p}.keyboard.press(${q(step.value ?? 'Enter')});`);
      lastAction.set(step.tab, i);
      return;
    }
    const loc = el && bestLocator(el);
    if (!loc) return;
    const target = locatorCode(loc, root, refs);
    switch (step.action) {
      case 'click':
        out.push(`await ${target}.click();`);
        lastAction.set(step.tab, i);
        return;
      case 'dblclick': {
        // The browser reports a double click as two clicks and then the double click: keep only that.
        for (let back = i - 1, n = 0; back >= 0 && n < 2; back--) {
          if (blocks[back]!.length !== 1) break;
          if (blocks[back]![0] !== `await ${target}.click();`) break;
          blocks[back]!.length = 0;
          n++;
        }
        out.push(`await ${target}.dblclick();`);
        lastAction.set(step.tab, i);
        return;
      }
      case 'check':
      case 'uncheck':
        out.push(`await ${target}.${step.action}();`);
        return;
      case 'type':
      case 'select': {
        const key = identifier(el.suggestedName || 'value', names, `value${i}`);
        let expr: string;
        if (step.secret) expr = secretExpr(key);
        else {
          const value = step.value ?? '';
          const existing = lit(value, refs);
          if (existing !== q(value) || value.trim().length < 1) expr = existing;
          else {
            data.push([key, value]);
            expr = `data.${key}`;
            refFor(value, expr);
          }
        }
        // Options are chosen by their visible label: option values are often generated ids.
        out.push(step.action === 'type' ? `await ${target}.fill(${expr});` : `await ${target}.selectOption({ label: ${expr} });`);
        return;
      }
    }
  });

  const head = [
    // Ceilings for a slow environment, not waits: every step still goes as soon as the page is ready.
    'context.setDefaultTimeout(15_000);',
    'context.setDefaultNavigationTimeout(45_000);',
  ];
  if (data.length)
    head.push(`const data: Record<string, string> = { ${data.map(([k, v]) => `${k}: ${q(v)}`).join(', ')}, ...JSON.parse(process.env.TB_DATA ?? '{}') };`);
  if (usesVars) head.push('const vars: Record<string, string> = {};');
  const lines = [...head, ...blocks.flat()];
  return [`test(${q(title)}, async ({ page, context }) => {`, ...lines.map((l) => `  ${l}`), '});', ''].join('\n');
}
