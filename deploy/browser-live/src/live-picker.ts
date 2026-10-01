import { LOCATOR_CORE } from '@tb/contracts';

/** The page-side function the picker and recorder report through; exposed by the session. */
export const PICK_BINDING = '__tbLivePick';

// The element picker and action recorder as they run inside the Test Browser. Injected into every
// page and frame the session opens, so they work on any site: no embed script, no framing, and the
// site's CSP does not apply. They only report to the Playwright binding; the session decides what
// counts (see LiveSession.fromPage).
//
// The recorder cleans as it goes (testing-studio-plan §3.3), because a raw event log does not replay:
// - Keystrokes become one fill when the field is left, another control is used, or Enter is pressed.
//   The field is described when typing starts, in case the app re-renders it before then.
// - A click is described at pointerdown, before the page reacts: menus that close, buttons that change
//   their label and suggestions that commit on mousedown and vanish are still recorded as clicked.
// - Enter in a field records the key press only, not the submit button's synthetic click.
// - Listeners sit on window in the capture phase and read composedPath(), so sites that stop
//   propagation, and fields inside shadow DOM, are still seen.
//
// Written as a string, not a module, because it is evaluated in the page, not in Node.
export const LIVE_PICKER_SOURCE = String.raw`
(function () {
  'use strict';
  if (window.__tbLivePicker) return;
  window.__tbLivePicker = true;

__CORE__

  window.__tbDescribe = describeElement; // the session describes an iframe's element with its parent's copy

  function call(kind, payload) {
    try { return window.__BINDING__(kind, payload); } catch (err) { return null; }
  }

  var active = false;    // picking
  // On until the session answers, so a heavy page's first actions are not lost; the session drops
  // whatever arrives while it is not recording.
  var recording = true;
  var storing = false;

  function setModes(m) {
    if (!m) return;
    active = !!m.picking;
    last = null;
    if (!active && box) box.style.display = 'none';
    if (recording && !m.recording) flush();
    recording = !!m.recording;
    storing = !!m.storing;
  }
  window.__tbSetModes = setModes;
  var asked = call('modes', null);
  if (asked && asked.then) asked.then(setModes, function () {});

  function on(type, fn) { window.addEventListener(type, fn, true); }

  function targetOf(e) {
    var path = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) if (path[i] && path[i].nodeType === 1) return path[i];
    return e.target && e.target.nodeType === 1 ? e.target : null;
  }

  function deepActive() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  // ---------- recorder ----------

  /** How a control takes input: typed text, a select, a checkbox; null for anything clicked instead. */
  function fieldKind(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === 'TEXTAREA') return el.readOnly ? null : 'text';
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return 'check';
      if (['button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'].indexOf(t) !== -1) return null;
      // A read-only field usually opens a date picker or a dropdown: clicking it is the action.
      return el.readOnly ? null : 'text';
    }
    return el.isContentEditable ? 'text' : null;
  }

  // A "show password" toggle turns the field into plain text; it stays a secret.
  var secretFields = new WeakSet();
  function isSecret(el) {
    if (el && el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password') secretFields.add(el);
    return !!el && secretFields.has(el);
  }

  // As Playwright sees it: a zero-size element is not visible, so check() on it would never go through.
  function rendered(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
  }

  /** A field's own validation rules (FieldRules in browser.ts), so data can be made to fit and to break them. */
  function fieldRules(el) {
    var num = function (v) { return typeof v === 'number' && v >= 0 ? Math.min(v, 1000000) : -1; };
    var attr = function (n, max) { return (el.getAttribute(n) || '').slice(0, max); };
    return {
      type: (el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : attr('type', 30) || 'text').toLowerCase(),
      name: attr('name', 100), autocomplete: attr('autocomplete', 60), inputMode: attr('inputmode', 20),
      required: !!el.required || el.getAttribute('aria-required') === 'true',
      minLength: num(el.minLength), maxLength: num(el.maxLength),
      pattern: attr('pattern', 300), min: attr('min', 40), max: attr('max', 40),
      options: el.tagName === 'SELECT' ? [].slice.call(el.options, 0, 50).map(function (o) { return squash(o.text).slice(0, 200); }) : []
    };
  }

  function record(action, element, value, secret, field, form) {
    call('record', { action: action, element: element, value: value === undefined ? undefined : String(value).slice(0, 4000), secret: !!secret, field: field, form: form });
    if (action !== 'type' && action !== 'store') watchAfterAction();
  }

  // ---------- what the page shows: the raw material for checks ----------

  var KEY_ELEMENTS = 'h1,h2,h3,[role=heading],[role=alert],[role=alertdialog],[role=status],[aria-live],dialog,[role=dialog]';

  // Many toast libraries set no role at all; their class names still say what they are.
  var MESSAGE_CLASS = /(^|[\s_-])(toast|toastify|snackbar|notistack|notification|notif|flash|sonner|alert|message)([\s_-]|$)/i;

  function itemKind(el) {
    if (!el || el.nodeType !== 1) return null;
    var role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'alert' || role === 'alertdialog') return 'alert';
    if (role === 'status' || (el.getAttribute('aria-live') && el.getAttribute('aria-live') !== 'off')) return 'status';
    if (role === 'dialog' || el.tagName === 'DIALOG') return 'dialog';
    if (/^H[1-3]$/.test(el.tagName) || role === 'heading') return 'heading';
    var names = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('data-testid') || '');
    return MESSAGE_CLASS.test(names) ? 'alert' : null;
  }

  /** The nearest element, from this one up, that is a message, dialog or heading. */
  function keyAncestor(el) {
    for (var n = el, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) if (itemKind(n)) return n;
    return null;
  }

  function asItem(el, kind) {
    if (!el || el.nodeType !== 1 || el.closest('[data-tb-live]') || !rendered(el)) return null;
    var text = squash(el.innerText || el.textContent).slice(0, 300);
    return text.length >= 2 ? { kind: kind, text: text, element: describeElement(el) } : null;
  }

  /** The key elements under a node, or the node itself when it is a short piece of new text. */
  function itemsIn(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return [];
    var key = keyAncestor(el);
    if (key) return [asItem(key, itemKind(key))];
    var inside = [].slice.call(el.querySelectorAll ? el.querySelectorAll(KEY_ELEMENTS) : [], 0, 4);
    if (inside.length) return inside.map(function (k) { return asItem(k, itemKind(k)); });
    var text = squash(el.innerText || el.textContent);
    // Short new text, even with an icon or two inside it.
    return text.length >= 2 && text.length <= 120 && el.querySelectorAll('*').length <= 25 ? [asItem(el, 'text')] : [];
  }

  function collect(nodes, max) {
    var out = [], seen = {};
    for (var i = 0; i < nodes.length && out.length < max; i++) {
      var found = itemsIn(nodes[i]);
      for (var j = 0; j < found.length && out.length < max; j++) {
        var it = found[j];
        if (it && !seen[it.text]) { seen[it.text] = true; out.push(it); }
      }
    }
    return out;
  }

  var added = [];
  var watching = 0;
  var observer = new MutationObserver(function (list) {
    if (!recording || Date.now() > watching) return;
    for (var i = 0; i < list.length && added.length < 200; i++) {
      var m = list[i];
      // Shown by a style or class change (a dialog opening) counts as appearing, as adding it would.
      if (m.type === 'characterData' || m.type === 'attributes') added.push(m.target);
      for (var k = 0; k < m.addedNodes.length && added.length < 200; k++) added.push(m.addedNodes[k]);
    }
  });
  // The document itself, not <html>: this script runs before <html> exists, and an observer set on
  // nothing would miss every change after every action.
  observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open', 'aria-hidden'] });

  /** What appears in the moment after an action: a toast, an error, a dialog, a new heading. */
  function watchAfterAction() {
    added = [];
    watching = Date.now() + 1500;
    setTimeout(function () {
      var items = collect(added, 8);
      added = [];
      if (recording && items.length) call('observe', items);
    }, 1600);
  }

  // A page reached by the last action introduces itself with its headings and messages.
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!recording) return;
      var items = collect([].slice.call(document.querySelectorAll(KEY_ELEMENTS)), 8);
      if (items.length) call('observe', items);
    }, 800);
  });

  window.__tbFacts = function () {
    return { url: location.href.slice(0, 4000), title: squash(document.title).slice(0, 300), items: collect([].slice.call(document.querySelectorAll(KEY_ELEMENTS)), 20) };
  };

  // ---------- the form a submit belongs to ----------

  var FORM_BOX = 'form,[role=dialog],dialog,[role=form],[aria-modal=true]';
  var FIELD_SEL = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),textarea,select';

  function isButtonish(el) {
    return el.tagName === 'BUTTON' || (el.getAttribute('role') || '') === 'button' ||
      (el.tagName === 'INPUT' && /^(submit|button|image)$/i.test(el.getAttribute('type') || ''));
  }

  /**
   * Every field of the form (or dialog) an element sits in, filled or not, so the test can cover the
   * fields the tester did not happen to type into. A form without a <form> tag is the nearest block
   * holding two or more fields.
   */
  function formOf(el) {
    var box = el.closest(FORM_BOX);
    if (!box || !box.querySelector(FIELD_SEL))
      for (var n = el.parentElement, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++)
        if (n.querySelectorAll(FIELD_SEL).length >= 2) { box = n; break; }
    if (!box) return undefined;
    var out = [];
    var fields = [].slice.call(box.querySelectorAll(FIELD_SEL), 0, 40);
    for (var k = 0; k < fields.length; k++) {
      var f = fields[k];
      if (!rendered(f)) continue;
      var secret = isSecret(f);
      var t = (f.getAttribute('type') || '').toLowerCase();
      var value = secret ? '' : t === 'checkbox' || t === 'radio' ? (f.checked ? 'on' : '') :
        f.tagName === 'SELECT' ? (f.options[f.selectedIndex] ? squash(f.options[f.selectedIndex].text) : '') : f.value;
      out.push({
        element: describeElement(f),
        label: (labelOf(f) || squash(f.getAttribute('placeholder')) || squash(f.getAttribute('aria-label')) || f.getAttribute('name') || '').slice(0, 200),
        rules: fieldRules(f),
        value: String(value || '').slice(0, 4000),
        secret: secret
      });
    }
    return out.length ? out : undefined;
  }

  var pending = null; // { el, desc, secret }: the field being typed into
  function read(el) { return el.isContentEditable ? el.textContent : el.value; }
  function flush() {
    if (!pending) return;
    var p = pending;
    pending = null;
    var secret = p.secret || isSecret(p.el);
    record('type', p.el.isConnected ? describeElement(p.el) : p.desc, secret ? undefined : read(p.el), secret, p.el.isConnected ? fieldRules(p.el) : p.field);
  }

  /** What the tester meant to click: the control around the exact node, climbing out of icons. */
  function clickTarget(el) {
    var svg = el.closest('svg');
    if (svg) el = svg.parentElement || el;
    var control = el.closest('a[href],button,summary,label,select,input[type=submit],input[type=button],[role=button],[role=link],' +
      '[role=menuitem],[role=tab],[role=option],[role=switch],[role=checkbox],[role=radio],[onclick],[tabindex]:not([tabindex="-1"])');
    if (control) return control;
    // A div wired up in JavaScript: the outermost of the nearby elements that show a pointer.
    var best = el;
    for (var node = el, i = 0; node && node !== document.body && i < 5; node = node.parentElement, i++)
      if (getComputedStyle(node).cursor === 'pointer') best = node;
    return best;
  }

  on('focusin', function (e) { isSecret(targetOf(e)); });

  on('input', function (e) {
    if (!recording) return;
    var el = targetOf(e);
    if (fieldKind(el) !== 'text') return;
    if (pending && pending.el !== el) flush();
    if (!pending) pending = { el: el, desc: describeElement(el), secret: isSecret(el), field: fieldRules(el) };
  });

  on('change', function (e) {
    if (!recording) return;
    var el = targetOf(e);
    var kind = fieldKind(el);
    if (kind === 'text') { if (pending && pending.el === el) flush(); return; }
    if (kind === 'select') {
      flush();
      var opt = el.options[el.selectedIndex];
      record('select', describeElement(el), opt ? opt.text.trim() : el.value, false, fieldRules(el));
    } else if (kind === 'check') {
      flush();
      // Custom checkboxes hide the real input; what a person (and Playwright) can click is its label.
      if (!rendered(el)) {
        var label = (el.labels && el.labels[0]) || el.closest('label');
        if (label) record('click', describeElement(label));
      } else record(el.checked ? 'check' : 'uncheck', describeElement(el));
    }
  });

  var down = null;    // { el, desc }: described at pointerdown, before the page reacts
  var enterAt = 0;    // the synthetic submit click that follows Enter is not the tester's
  on('pointerdown', function (e) {
    if (!recording || active || storing || e.button !== 0) { down = null; return; }
    var t = targetOf(e);
    if (!t || fieldKind(t)) { down = null; return; }
    var el = clickTarget(t);
    // Read now, while the form is still there: a submit often closes its dialog.
    down = { el: el, desc: describeElement(el), form: isButtonish(el) ? formOf(el) : undefined };
  });
  on('pointerup', function () {
    var d = down;
    if (!d) return;
    // No click follows when the target was removed on mousedown (a suggestion list that commits then).
    setTimeout(function () {
      if (down !== d) return;
      down = null;
      flush();
      record('click', d.desc, undefined, false, undefined, d.form);
    }, 150);
  });

  on('click', function (e) {
    if (!recording || active) return;
    var t = targetOf(e);
    if (storing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      storing = false;
      if (!t) return;
      record('store', describeElement(t), fieldKind(t) === 'text' || t.tagName === 'SELECT' ? read(t) : squash(t.innerText || t.textContent));
      return;
    }
    if (e.detail === 0 && Date.now() - enterAt < 100) return;
    var d = down;
    down = null;
    if (!t || fieldKind(t)) return; // focusing a field, or a checkbox its change event records
    var el = clickTarget(t);
    if (el.tagName === 'LABEL' && el.control && fieldKind(el.control)) return;
    flush();
    record('click', d ? d.desc : describeElement(el), undefined, false, undefined, d ? d.form : isButtonish(el) ? formOf(el) : undefined);
  });

  on('dblclick', function (e) {
    if (!recording || active) return;
    var t = targetOf(e);
    if (t && !fieldKind(t)) record('dblclick', describeElement(clickTarget(t)));
  });

  on('keydown', function (e) {
    if (!recording || active) return;
    var el = deepActive();
    var onField = fieldKind(el) === 'text';
    if (e.key === 'Enter') {
      // On a button or link, Enter clicks it, and that click is recorded instead.
      if (!onField && el && el !== document.body && clickTarget(el) === el) return;
      flush();
      record('press', onField ? describeElement(el) : null, 'Enter', false, undefined, onField ? formOf(el) : undefined);
      enterAt = Date.now();
    } else if (e.key === 'Escape' || (onField && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
      // Arrow keys in a field move through its suggestions; the fill before them must come first.
      flush();
      record('press', onField ? describeElement(el) : null, e.key);
    }
  });

  window.addEventListener('pagehide', flush, true);
  window.__tbFlush = flush;

  // ---------- picker ----------

  var last = null;
  var box = null;

  function overlay() {
    if (box && box.isConnected) return box;
    box = document.createElement('div');
    box.setAttribute('data-tb-live', '');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4c8dff;' +
      'background:rgba(76,141,255,.12);border-radius:2px;display:none';
    document.documentElement.appendChild(box);
    return box;
  }

  on('mousemove', function (e) {
    if (!active) return;
    var el = targetOf(e);
    if (!el || el.hasAttribute('data-tb-live') || el === last) return;
    last = el;
    var r = el.getBoundingClientRect();
    var b = overlay();
    b.style.display = 'block';
    b.style.left = r.left + 'px';
    b.style.top = r.top + 'px';
    b.style.width = r.width + 'px';
    b.style.height = r.height + 'px';
    call('hover', describeElement(el));
  });

  // While picking, a press means "this one", not "use the site": swallow the whole click sequence.
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(function (type) {
    on(type, function (e) {
      if (!active) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    });
  });
  on('click', function (e) {
    if (!active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var t = targetOf(e);
    if (t) call('picked', describeElement(t));
  });
})();
`
  .replace('__CORE__', LOCATOR_CORE)
  .replaceAll('__BINDING__', PICK_BINDING);
