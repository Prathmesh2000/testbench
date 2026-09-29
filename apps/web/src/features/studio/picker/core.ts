// The locator engine: reads a page's own DOM and ranks the ways Playwright can find an element,
// exactly as the generator and page library expect them. Shared by both pickers (the bookmarklet the
// tester runs on their site, and the embed script that reports locators to the pane beside the
// editor), so a locator never differs depending on how it was picked.
//
// Written as a string, not a module, because it is delivered to another origin as plain JavaScript.
// Plain ES2017 without template literals, so it needs no build step and no escaping here.

export const LOCATOR_CORE = String.raw`
  var TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

  // ---------- accessible name and role, as Playwright's getByRole sees them ----------

  var IMPLICIT_ROLE = {
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    NAV: 'navigation', MAIN: 'main', FORM: 'form', TABLE: 'table', UL: 'list', OL: 'list', LI: 'listitem'
  };
  var INPUT_ROLE = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox', password: 'textbox'
  };

  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    if (el.tagName === 'INPUT') return INPUT_ROLE[(el.getAttribute('type') || 'text').toLowerCase()] || null;
    if (el.tagName === 'A' && !el.hasAttribute('href')) return null;
    return IMPLICIT_ROLE[el.tagName] || null;
  }

  function squash(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

  function labelOf(el) {
    var aria = el.getAttribute('aria-label');
    if (squash(aria)) return squash(aria);
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var parts = by.split(/\s+/).map(function (id) {
        var node = document.getElementById(id);
        return node ? squash(node.textContent) : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    if (el.id) {
      var forLabel = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (forLabel) return squash(forLabel.textContent);
    }
    var wrapping = el.closest('label');
    if (wrapping) return squash(wrapping.textContent);
    return '';
  }

  function accessibleName(el) {
    var label = labelOf(el);
    if (label) return label;
    if (el.tagName === 'IMG') return squash(el.getAttribute('alt'));
    if (el.tagName === 'INPUT' && INPUT_ROLE[(el.getAttribute('type') || '').toLowerCase()] === 'button')
      return squash(el.getAttribute('value'));
    var title = squash(el.getAttribute('title'));
    var text = squash(el.textContent);
    // Only short, self-contained text counts as a name; a whole paragraph does not.
    if (text && text.length <= 80 && el.children.length <= 3) return text;
    return title;
  }

  function cssEscape(v) {
    return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
  }

  // ---------- candidate locators, best first ----------

  // Containers a tester would name out loud: "the row that says...", "the card for...", "the dialog".
  var CONTAINER_ROLES = { row: 1, listitem: 1, article: 1, dialog: 1, form: 1, region: 1, group: 1, cell: 1, table: 1, navigation: 1, main: 1 };

  /** The nearest ancestor a tester could point at, with a locator that finds only that ancestor. */
  function containerFor(el) {
    var node = el.parentElement;
    var depth = 0;
    while (node && node !== document.body && depth < 8) {
      depth++;
      var role = roleOf(node);
      var testid = null;
      for (var i = 0; i < TEST_ID_ATTRS.length; i++) {
        var v = node.getAttribute(TEST_ID_ATTRS[i]);
        if (v) { testid = { strategy: 'testid', value: v, attr: TEST_ID_ATTRS[i] }; break; }
      }
      // A row's accessible name is all of its text, which is long and breaks on any edit. Names are
      // only used for containers that really have one; rows and list items are identified by the
      // short piece of text inside them that a tester would actually say.
      var name = accessibleName(node);
      var namedRole = /^(dialog|region|form|navigation|main|article|group)$/.test(role || '');
      var useName = namedRole && name && name.length <= 40 ? name : undefined;
      var base = testid || (role && CONTAINER_ROLES[role] ? { strategy: 'role', value: role, name: useName } : null);
      if (base) {
        var found = matchesIn(base, document);
        if (found.length === 1) return { el: node, locator: base };
        if (found.indexOf(node) === -1) { node = node.parentElement; continue; }
        // Several identical containers: the text inside this one is what tells them apart, which is
        // how a tester says it, as in "the row that says Dell XPS".
        var own = distinguishingText(node, found);
        if (own) return { el: node, locator: { strategy: base.strategy, value: base.value, name: base.name, attr: base.attr, hasText: own } };
      }
      node = node.parentElement;
    }
    return null;
  }

  /** A short piece of this container's text that none of its lookalikes share. */
  function distinguishingText(node, siblings) {
    var mine = [];
    var cells = node.querySelectorAll('td, th, [role="cell"], h1, h2, h3, h4, strong, b, a');
    for (var i = 0; i < cells.length && mine.length < 6; i++) {
      var t = squash(cells[i].textContent);
      if (t && t.length <= 60) mine.push(t);
    }
    if (!mine.length) {
      var whole = squash(node.textContent);
      if (whole && whole.length <= 60) mine.push(whole);
    }
    for (var k = 0; k < mine.length; k++) {
      var text = mine[k];
      var sharing = siblings.filter(function (s) { return s !== node && squash(s.textContent).indexOf(text) !== -1; });
      if (!sharing.length) return text;
    }
    return null;
  }

  function candidates(el) {
    var out = [];
    for (var i = 0; i < TEST_ID_ATTRS.length; i++) {
      var v = el.getAttribute(TEST_ID_ATTRS[i]);
      if (v) { out.push({ strategy: 'testid', value: v, attr: TEST_ID_ATTRS[i] }); break; }
    }
    var role = roleOf(el);
    var name = accessibleName(el);
    if (role && name) out.push({ strategy: 'role', value: role, name: name });
    var lbl = labelOf(el);
    var isField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (isField && lbl) out.push({ strategy: 'label', value: lbl });
    var ph = el.getAttribute('placeholder');
    if (ph) out.push({ strategy: 'placeholder', value: squash(ph) });
    var text = squash(el.textContent);
    if (text && text.length <= 60 && el.children.length === 0) out.push({ strategy: 'text', value: text });
    if (el.id) out.push({ strategy: 'css', value: '#' + cssEscape(el.id) });

    // Anything ambiguous on its own gets a version scoped to the container the tester would name,
    // and, failing that, its position. Both come before the brittle full CSS path.
    var container;
    var base = out.slice();
    for (var n = 0; n < base.length; n++) {
      var c = base[n];
      if (countMatches(c, document) <= 1) continue;
      if (container === undefined) container = containerFor(el) || null;
      if (container && countMatches(c, container.el) === 1) {
        out.push({ strategy: c.strategy, value: c.value, name: c.name, attr: c.attr, within: container.locator });
      } else {
        var all = matchesIn(c, document);
        var at = all.indexOf(el);
        if (at !== -1) out.push({ strategy: c.strategy, value: c.value, name: c.name, attr: c.attr, nth: at });
      }
    }

    out.push({ strategy: 'css', value: cssPath(el) });
    // The id rule and the path can land on the same selector; offer each way only once.
    var seen = {};
    return out.filter(function (c) {
      var key = c.strategy + '|' + c.value + '|' + (c.name || '') + '|' +
        (c.within ? c.within.strategy + c.within.value + (c.within.hasText || '') : '') + '|' + (c.nth === undefined ? '' : c.nth);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  /** A short, readable CSS path: stops at the nearest id, and uses :nth-of-type only when needed. */
  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (node.id) { parts.unshift('#' + cssEscape(node.id)); break; }
      var sel = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) sel += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = parent;
    }
    return parts.join(' > ');
  }

  /** Every element a candidate matches, inside 'root' (the whole page by default). */
  function matchesIn(c, root) {
    var scope = root || document;
    try {
      if (c.strategy === 'testid') return [].slice.call(scope.querySelectorAll('[' + c.attr + '="' + cssEscape(c.value) + '"]'));
      if (c.strategy === 'placeholder') return [].slice.call(scope.querySelectorAll('[placeholder="' + cssEscape(c.value) + '"]'));
      if (c.strategy === 'css') return [].slice.call(scope.querySelectorAll(c.value));
      var all = scope.querySelectorAll('*');
      var out = [];
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (c.strategy === 'role' && roleOf(e) === c.value && (c.name === undefined || accessibleName(e) === c.name)) out.push(e);
        else if (c.strategy === 'label' && /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && labelOf(e) === c.value) out.push(e);
        else if (c.strategy === 'text' && e.children.length === 0 && squash(e.textContent) === c.value) out.push(e);
      }
      return out;
    } catch (err) { return []; }
  }

  /** How many elements a candidate matches: 1 means it identifies this element on its own. */
  function countMatches(c, root) { return matchesIn(c, root).length; }

  function oneCall(c) {
    var q = function (v) { return JSON.stringify(v); };
    if (c.strategy === 'testid') return 'getByTestId(' + q(c.value) + ')';
    if (c.strategy === 'role') return 'getByRole(' + q(c.value) + (c.name ? ', { name: ' + q(c.name) + ', exact: true }' : '') + ')';
    if (c.strategy === 'label') return 'getByLabel(' + q(c.value) + ', { exact: true })';
    if (c.strategy === 'placeholder') return 'getByPlaceholder(' + q(c.value) + ', { exact: true })';
    if (c.strategy === 'text') return 'getByText(' + q(c.value) + ')';
    return 'locator(' + q(c.value) + ')';
  }

  /** The whole expression as it would be written by hand, scope and position included. */
  function playwrightCode(c) {
    var q = function (v) { return JSON.stringify(v); };
    var prefix = '';
    if (c.within) {
      prefix = oneCall(c.within);
      if (c.within.hasText) prefix += '.filter({ hasText: ' + q(c.within.hasText) + ' })';
      prefix += '.';
    }
    return prefix + oneCall(c) + (c.nth === undefined ? '' : '.nth(' + c.nth + ')');
  }

  function suggestName(el, list) {
    var best = list[0];
    var base = (best && (best.name || (best.strategy !== 'css' ? best.value : ''))) || squash(el.textContent) || el.tagName.toLowerCase();
    base = base.slice(0, 40).trim();
    var kind = roleOf(el);
    return kind && base.toLowerCase().indexOf(kind) === -1 ? base + ' ' + kind : base;
  }


  /** An XPath for people who need one; Playwright locators above are preferred and far less brittle. */
  function xpathOf(el) {
    for (var i = 0; i < TEST_ID_ATTRS.length; i++) {
      var v = el.getAttribute(TEST_ID_ATTRS[i]);
      if (v) return '//*[@' + TEST_ID_ATTRS[i] + '=' + xpathLiteral(v) + ']';
    }
    if (el.id) return '//*[@id=' + xpathLiteral(el.id) + ']';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var parent = node.parentElement;
      var step = node.tagName.toLowerCase();
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) step += '[' + (same.indexOf(node) + 1) + ']';
      }
      parts.unshift(step);
      node = parent;
    }
    return '/html/' + parts.join('/');
  }

  /** XPath has no escape character: a value holding both quote kinds has to be built with concat(). */
  function xpathLiteral(v) {
    var SQ = String.fromCharCode(39);
    var DQ = String.fromCharCode(34);
    if (v.indexOf(SQ) === -1) return SQ + v + SQ;
    if (v.indexOf(DQ) === -1) return DQ + v + DQ;
    var parts = v.split(SQ).map(function (p) { return SQ + p + SQ; });
    // Rejoined around a quoted apostrophe: concat('it', "'", 's')
    return 'concat(' + parts.join(', ' + DQ + SQ + DQ + ', ') + ')';
  }
`;
