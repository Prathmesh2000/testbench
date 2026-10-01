import type { PageContext, PageSnapshot } from '@tb/contracts';
import type { BrowserContext, Page } from 'playwright';
import { storageSnapshot } from './inspect';

// The site map's view of a page (see PageContext): read in the page when the Test Browser reaches it,
// with the APIs the page called since. Source text, not a function, for the same reason as the picker.

/** A request's address as the site map keeps it: path only (no query, no host), ids made ":id". */
export function apiPath(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname
      .split('/')
      .map((seg) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{16,}$|^[A-Za-z0-9_-]{20,}$/i.test(seg) ? ':id' : seg))
      .join('/');
    return path.slice(0, 500) || '/';
  } catch {
    return '/';
  }
}

/** Only calls the page makes itself are APIs; scripts, styles and images are not. */
export const isApi = (resourceType: string) => resourceType === 'xhr' || resourceType === 'fetch';

export const PAGE_CONTEXT_SOURCE = String.raw`(function () {
  function squash(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function shown(el) { var r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'; }
  function nameOf(el) {
    return squash(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('alt') || '').slice(0, 200);
  }
  function labelOf(f) {
    if (f.id) { var l = document.querySelector('label[for="' + CSS.escape(f.id) + '"]'); if (l) return squash(l.textContent); }
    var w = f.closest('label');
    if (w) { var c = w.cloneNode(true); c.querySelectorAll('input,select,textarea,option').forEach(function (x) { x.remove(); }); return squash(c.textContent); }
    return squash(f.getAttribute('aria-label') || f.getAttribute('placeholder') || f.getAttribute('name') || '');
  }
  var headings = [].slice.call(document.querySelectorAll('h1,h2,h3,[role=heading]')).filter(shown)
    .map(function (h) { return squash(h.textContent).slice(0, 300); }).filter(Boolean).slice(0, 30);
  var seen = {};
  var actions = [].slice.call(document.querySelectorAll('button,a[href],[role=button],[role=link],[role=tab],[role=menuitem],input[type=submit],input[type=button]'))
    .filter(shown).map(function (el) {
      var role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : 'button');
      if (['button', 'link', 'tab', 'menuitem'].indexOf(role) === -1) role = 'button';
      var href = el.tagName === 'A' && el.href && /^https?:/.test(el.href) ? el.href : null;
      return { label: nameOf(el), role: role, href: href };
    }).filter(function (a) {
      var k = a.role + '|' + a.label;
      if (!a.label || seen[k]) return false;
      seen[k] = 1; return true;
    }).slice(0, 120);
  var fields = [].slice.call(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select')).filter(shown).map(function (f) {
    var num = function (v) { return typeof v === 'number' && v >= 0 ? v : -1; };
    return { label: labelOf(f).slice(0, 200), rules: {
      type: f.tagName === 'SELECT' ? 'select' : f.tagName === 'TEXTAREA' ? 'textarea' : (f.getAttribute('type') || 'text').toLowerCase(),
      name: (f.getAttribute('name') || '').slice(0, 100),
      autocomplete: (f.getAttribute('autocomplete') || '').slice(0, 60),
      inputMode: (f.getAttribute('inputmode') || '').slice(0, 20),
      required: f.required || f.getAttribute('aria-required') === 'true',
      minLength: num(f.minLength), maxLength: num(f.maxLength),
      pattern: (f.getAttribute('pattern') || '').slice(0, 300),
      min: (f.getAttribute('min') || '').slice(0, 40), max: (f.getAttribute('max') || '').slice(0, 40),
      options: f.tagName === 'SELECT' ? [].slice.call(f.options).map(function (o) { return squash(o.textContent).slice(0, 200); }).slice(0, 50) : []
    } };
  }).filter(function (f) { return f.label; }).slice(0, 60);
  return { url: location.href, title: squash(document.title).slice(0, 300), headings: headings, actions: actions, fields: fields };
})()`;

export async function pageContext(page: Page, apis: PageContext['apis']): Promise<PageContext | null> {
  const raw = (await page.evaluate(PAGE_CONTEXT_SOURCE).catch(() => null)) as Omit<PageContext, 'apis'> | null;
  if (!raw || typeof raw.url !== 'string' || !/^https?:/.test(raw.url)) return null;
  return { ...raw, apis: apis.slice(-80) };
}

/** Cookies and storage as a run left them, masked, for a scenario's storage checks. */
export async function storageOf(context: BrowserContext, page: Page): Promise<NonNullable<PageSnapshot['storage']>> {
  const snap = await storageSnapshot(context, page, false).catch(() => null);
  if (!snap) return [];
  return [
    ...snap.cookies.map((c) => ({ area: 'cookie' as const, key: c.name, value: c.value })),
    ...snap.local.map(([key, value]) => ({ area: 'local' as const, key, value })),
    ...snap.session.map(([key, value]) => ({ area: 'session' as const, key, value })),
  ]
    .slice(0, 100)
    .map((e) => ({ ...e, key: e.key.slice(0, 300), value: e.value.slice(0, 500) }));
}
