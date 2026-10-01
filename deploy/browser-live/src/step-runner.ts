import type { AutoStep, Locator, PageSnapshot } from '@tb/contracts';
import type { Locator as PwLocator, Page } from 'playwright';

// Running saved steps in the Test Browser: a prerequisite before recording, or a scenario to see what
// the app really does. It follows the step model, the same one the generated code comes from, and
// never runs code. Checks are not asserted here; what the page showed is snapshotted instead.

export interface StepValues {
  data: Record<string, string>;
  secrets: Record<string, string>;
  /** Where {env.baseUrl} points: the site the workflow was recorded on. */
  baseUrl: string;
}

/** A step that could not be done for a reason a test can expect: its element is disabled, or not there. */
export class StepBlocked extends Error {
  constructor(
    readonly kind: 'disabled' | 'missing',
    message: string,
  ) {
    super(message);
  }
}

const REF = /\{(data|secret|env|vars)\.([a-zA-Z_]\w*)\}/g;
const ACTION_TIMEOUT = 10_000;

export function fill(text: string, v: StepValues, vars: Record<string, string>): string {
  return text.replace(REF, (_m, ns: string, name: string) =>
    ns === 'data' ? (v.data[name] ?? '') : ns === 'secret' ? (v.secrets[name] ?? '') : ns === 'env' ? (name === 'baseUrl' ? v.baseUrl : '') : (vars[name] ?? ''),
  );
}

type Role = Parameters<Page['getByRole']>[0];

/** A step-model locator as Playwright's, as the generator writes it (generate.ts). */
export function locate(page: Page, l: Locator, t: (s: string) => string): PwLocator {
  const one = (x: { strategy: Locator['strategy']; value: string; name?: string }, root: Page | PwLocator): PwLocator => {
    switch (x.strategy) {
      case 'testid':
        return root.getByTestId(t(x.value));
      case 'role':
        return root.getByRole(x.value as Role, x.name ? { name: t(x.name), exact: true } : {});
      case 'label':
        return root.getByLabel(t(x.value), { exact: true });
      case 'placeholder':
        return root.getByPlaceholder(t(x.value), { exact: true });
      case 'text':
        return root.getByText(t(x.value));
      case 'css':
        return root.locator(x.value);
    }
  };
  let root: Page | PwLocator = page;
  if (l.within) {
    root = one(l.within, page);
    if (l.within.hasText) root = root.filter({ hasText: t(l.within.hasText) });
  }
  const found = one(l, root);
  return l.nth === undefined ? found : found.nth(l.nth);
}

/** One step. Throws, in words a tester can act on, when it cannot be done. */
export async function runStep(page: Page, step: AutoStep, v: StepValues, vars: Record<string, string>): Promise<void> {
  const t = (s: string) => fill(s, v, vars);
  const target = step.target && 'locator' in step.target ? locate(page, step.target.locator, t) : null;
  const opts = { timeout: ACTION_TIMEOUT };
  const what = step.intent || step.action;
  const needTarget = () => {
    if (!target) throw new Error(`Step "${what}" has no element to act on here.`);
    return target;
  };
  // A form that keeps its submit off while a field is invalid is refusing, not broken: say so rather
  // than wait out the timeout, so a negative scenario can expect it.
  const usable = async () => {
    const el = needTarget();
    await el.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT }).catch(() => {
      throw new StepBlocked('missing', `"${what}": the element is not on the page.`);
    });
    for (let waited = 0; await el.isDisabled().catch(() => false); waited += 250) {
      if (waited >= 3_000) throw new StepBlocked('disabled', `"${what}": the element is disabled.`);
      await page.waitForTimeout(250);
    }
    return el;
  };
  switch (step.action) {
    case 'open': {
      const url = t(step.value ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error(`Cannot open "${url}": only http:// and https:// addresses.`);
      await page.goto(url, { timeout: 45_000 });
      return;
    }
    case 'click':
      return (await usable()).click(opts);
    case 'type':
      return (await usable()).fill(t(step.value ?? ''), opts);
    case 'select':
      await (await usable()).selectOption({ label: t(step.value ?? '') }, opts);
      return;
    case 'check':
      return (await usable()).check(opts);
    case 'uncheck':
      return (await usable()).uncheck(opts);
    case 'hover':
      return needTarget().hover(opts);
    case 'press':
      return target ? target.press(step.value ?? 'Enter', opts) : page.keyboard.press(step.value ?? 'Enter');
    case 'store':
      vars[step.value ?? 'value'] = ((await needTarget().textContent(opts)) ?? '').trim();
      return;
    // Checks, manual steps and API calls are not run here: the snapshot shows what the page did.
    default:
      return;
  }
}

/**
 * What the page is showing now: where it is, open dialogs, messages, and each field's inline error,
 * whether the browser's own ("Please fill out this field.") or one the app writes on the page.
 * Sent as source text: the dev build wraps named functions in a helper the page does not have.
 */
export const SNAPSHOT_SOURCE = String.raw`(function () {
  function squash(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function shown(el) { var r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'; }
  var MESSAGE = /(^|[\s_-])(toast|toastify|snackbar|notistack|notification|notif|flash|sonner|alert|message)([\s_-]|$)/i;
  var ERROR = /(^|[\s_-])(error|invalid|invalid-feedback|help-block|field-error|form-error|validation)([\s_-]|$)/i;
  function names(el) { return (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || ''); }
  function labelOf(f) {
    if (f.id) { var l = document.querySelector('label[for="' + CSS.escape(f.id) + '"]'); if (l) return squash(l.textContent); }
    var w = f.closest('label');
    if (w) { var c = w.cloneNode(true); c.querySelectorAll('input,select,textarea,option').forEach(function (x) { x.remove(); }); return squash(c.textContent); }
    return squash(f.getAttribute('aria-label') || f.getAttribute('placeholder') || f.getAttribute('name') || '');
  }
  var dialogs = [].slice.call(document.querySelectorAll('[role=dialog],dialog[open],[aria-modal=true]')).filter(shown)
    .map(function (d) { return squash(d.getAttribute('aria-label') || (d.querySelector('h1,h2,h3') || {}).textContent || d.id || 'dialog').slice(0, 120); });
  var messages = [].slice.call(document.querySelectorAll('[role=alert],[role=status],[aria-live],*'))
    .filter(function (el) { return (el.getAttribute('role') === 'alert' || el.getAttribute('role') === 'status' || MESSAGE.test(names(el))) && shown(el); })
    .map(function (el) { return squash(el.innerText || el.textContent).slice(0, 300); })
    .filter(function (t, i, all) { return t && all.indexOf(t) === i && !all.some(function (o, j) { return j !== i && o !== t && o.indexOf(t) !== -1 && o.length < 300; }); })
    .slice(0, 10);
  var errors = [];
  var fields = [].slice.call(document.querySelectorAll('input:not([type=hidden]),textarea,select')).filter(shown);
  var claimed = [];
  fields.forEach(function (f) {
    var label = labelOf(f).slice(0, 200);
    if (f.willValidate && !f.checkValidity()) errors.push({ field: label, message: squash(f.validationMessage).slice(0, 300), source: 'native' });
    // Linked on purpose by the app: the most reliable way to tie an error to its field.
    var ids = ((f.getAttribute('aria-describedby') || '') + ' ' + (f.getAttribute('aria-errormessage') || '')).split(/\s+/).filter(Boolean);
    ids.forEach(function (id) {
      var e = document.getElementById(id);
      if (e && shown(e) && squash(e.textContent) && (ERROR.test(names(e)) || f.getAttribute('aria-invalid') === 'true')) {
        claimed.push(e);
        errors.push({ field: label, message: squash(e.textContent).slice(0, 300), source: 'page' });
      }
    });
  });
  // Otherwise an error message belongs to the field it sits closest below (or beside): one field each.
  [].slice.call(document.querySelectorAll('*')).filter(function (e) {
    return ERROR.test(names(e)) && shown(e) && squash(e.textContent) && claimed.indexOf(e) === -1 && !e.querySelector('input,textarea,select');
  }).forEach(function (e) {
    var r = e.getBoundingClientRect();
    var best = null, bestDist = Infinity;
    fields.forEach(function (f) {
      var q = f.getBoundingClientRect();
      var overlap = Math.min(r.right, q.right) - Math.max(r.left, q.left);
      if (overlap <= 0 || r.top < q.top - 4) return;
      var dist = r.top - q.bottom;
      if (dist < bestDist) { bestDist = dist; best = f; }
    });
    if (best && bestDist < 80) errors.push({ field: labelOf(best).slice(0, 200), message: squash(e.textContent).slice(0, 300), source: 'page' });
  });
  return { url: location.href, title: squash(document.title).slice(0, 300), dialogs: dialogs.slice(0, 5), messages: messages, fieldErrors: errors.slice(0, 30) };
})()`;

export async function snapshot(page: Page): Promise<PageSnapshot> {
  // A moment for the app to answer: a request to finish, a toast to appear.
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(800);
  return (await page.evaluate(SNAPSHOT_SOURCE)) as PageSnapshot;
}
