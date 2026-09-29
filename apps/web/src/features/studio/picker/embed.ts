import { LOCATOR_CORE } from './core';

// The embedded picker: one line the team adds to their own staging site so it can be opened in the
// pane beside the editor. Hovering an element there shows its locators in Testbench.
//
// It is inert by default and does three things only: answer a handshake from a Testbench frame,
// highlight what the tester hovers, and post that element's locators to the parent frame. It sends
// nothing anywhere else, stores nothing, and does nothing at all unless the page is framed by the
// Testbench origin it was served from.

export const EMBED_SOURCE = String.raw`
(function () {
  'use strict';
  var PARENT_ORIGIN = '__PARENT_ORIGIN__';
  if (window.parent === window) return; // Not framed: nothing to talk to, so stay out of the way.
  if (window.__tbPickerEmbed) return;
  window.__tbPickerEmbed = true;

__CORE__

  var active = false;
  var last = null;
  var box = null;

  function overlay() {
    if (box) return box;
    box = document.createElement('div');
    box.setAttribute('data-tb-embed', '');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4c8dff;' +
      'background:rgba(76,141,255,.12);border-radius:2px;display:none;transition:all .04s linear';
    document.documentElement.appendChild(box);
    return box;
  }

  function describe(el) {
    var list = candidates(el).map(function (c) {
      return {
        strategy: c.strategy,
        value: c.value,
        name: c.name,
        within: c.within ? { strategy: c.within.strategy, value: c.within.value, name: c.within.name, hasText: c.within.hasText } : undefined,
        nth: c.nth,
        code: 'page.' + playwrightCode(c),
        // A scoped locator is counted inside its container, which is the point of scoping it.
        matches: c.within ? 1 : countMatches(c, null)
      };
    });
    return {
      tag: el.tagName.toLowerCase(),
      role: roleOf(el) || null,
      text: squash(el.textContent).slice(0, 80),
      xpath: xpathOf(el),
      suggestedName: suggestName(el, candidates(el)),
      page: squash(document.title).slice(0, 60) || location.pathname,
      url: location.href,
      locators: list
    };
  }

  /** The first name worth offering: what the element is called, not what it looks like. */
  function suggestName(el, list) {
    var best = list[0];
    var base = (best && (best.name || (best.strategy !== 'css' ? best.value : ''))) || squash(el.textContent) || el.tagName.toLowerCase();
    base = base.slice(0, 40).trim();
    var kind = roleOf(el);
    return kind && base.toLowerCase().indexOf(kind) === -1 ? base + ' ' + kind : base;
  }

  function send(type, payload) {
    try {
      window.parent.postMessage({ tb: type, payload: payload }, PARENT_ORIGIN);
    } catch (err) { /* the parent went away */ }
  }

  function show(el) {
    var r = el.getBoundingClientRect();
    var b = overlay();
    b.style.display = 'block';
    b.style.left = r.left + 'px';
    b.style.top = r.top + 'px';
    b.style.width = r.width + 'px';
    b.style.height = r.height + 'px';
  }

  document.addEventListener('mousemove', function (e) {
    if (!active) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el.hasAttribute('data-tb-embed') || el === last) return;
    last = el;
    show(el);
    send('hover', describe(el));
  }, true);

  document.addEventListener('click', function (e) {
    if (!active) return;
    // While picking, a click means "this one", not "use the site".
    e.preventDefault();
    e.stopPropagation();
    send('picked', describe(e.target));
  }, true);

  document.addEventListener('mouseleave', function () {
    if (active && box) box.style.display = 'none';
  }, true);

  window.addEventListener('message', function (e) {
    if (e.origin !== PARENT_ORIGIN || !e.data || e.data.tb !== 'picking') return;
    active = !!e.data.on;
    last = null;
    if (!active && box) box.style.display = 'none';
    send('state', { picking: active, url: location.href, title: document.title });
  });

  // Tell the pane the page is ready, and again whenever a single-page app changes route.
  send('ready', { url: location.href, title: document.title });
  ['pushState', 'replaceState'].forEach(function (m) {
    var original = history[m];
    history[m] = function () {
      var out = original.apply(this, arguments);
      send('navigated', { url: location.href, title: document.title });
      return out;
    };
  });
  window.addEventListener('popstate', function () { send('navigated', { url: location.href, title: document.title }); });
})();
`.replace('__CORE__', LOCATOR_CORE);
