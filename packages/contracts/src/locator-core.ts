// The locator engine: reads a page's own DOM and ranks the ways Playwright can find an element,
// exactly as the generator and page library expect them. Shared by every picker (the bookmarklet the
// tester runs on their site, the embed script in a framed staging site, and the Test Browser, which
// injects it into any page), so a locator never differs depending on how it was picked.
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
      var forLabel = document.querySelector('label[for="' + attrValue(el.id) + '"]');
      if (forLabel) return squash(forLabel.textContent);
    }
    // A label that wraps its field: its own words only, not a select's options or a textarea's text.
    var wrapping = el.closest('label');
    if (wrapping) return squash(textOutside(wrapping, el));
    return '';
  }

  /** The text of a node, leaving out one element inside it. */
  function textOutside(node, skip) {
    var out = '';
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c === skip) continue;
      out += c.nodeType === 3 ? c.nodeValue : c.nodeType === 1 ? textOutside(c, skip) : '';
    }
    return out;
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

  /** A value inside a quoted CSS attribute selector: only quotes and backslashes need escaping. */
  function attrValue(v) { return String(v).replace(/["\\]/g, '\\$&'); }

  function cssEscape(v) {
    return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
  }

  // ---------- stability: a locator must not depend on the data the page happens to show ----------

  // Counts, prices, dates and times change between runs; so does anything long enough to be content.
  var VOLATILE = /\d{2,}|[₹$€£¥]|\d\s?%|\b(today|yesterday|tomorrow|ago|am|pm)\b|\d{1,2}[\/.:-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i;
  function looksVolatile(s) { return !!s && (s.length > 50 || VOLATILE.test(s)); }

  // Framework-generated ids (React's :r1:, ember123, hashed suffixes) differ between builds or renders.
  var GENERATED_ID = /^[:_\d]|:|\d{3,}|[a-f0-9]{8,}|^(ember|react|mui|radix|headlessui|rc[-_]|ng-|mat-|cdk-|select2-)|[-_](?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,}$/i;
  function stableId(id) { return !!id && !GENERATED_ID.test(id); }

  /** Whether a candidate still finds the element when the page shows different data. */
  function isStable(c) {
    if (c.nth !== undefined) return false; // position in a list is the data's order
    if (c.within && looksVolatile(c.within.hasText)) return false;
    if (c.strategy === 'role') return !looksVolatile(c.name);
    if (c.strategy === 'text' || c.strategy === 'label' || c.strategy === 'placeholder') return !looksVolatile(c.value);
    return true;
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
    // Names and labels past the contract's limits would be cut, and a cut name no longer matches exactly.
    if (role && name && name.length <= 200) out.push({ strategy: 'role', value: role, name: name });
    var lbl = labelOf(el);
    var isField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    // Playwright reads a wrapping label's whole text, a select's options and a textarea's text with it;
    // then only the role and name (combobox "Priority") find the field reliably, so no label locator.
    var wrapped = !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && el.closest('label');
    var labelMatches = !wrapped || squash(wrapped.textContent) === lbl;
    if (isField && lbl && labelMatches && lbl.length <= 500) out.push({ strategy: 'label', value: lbl });
    var ph = squash(el.getAttribute('placeholder'));
    if (ph && ph.length <= 500) out.push({ strategy: 'placeholder', value: ph });
    var text = squash(el.textContent);
    // A label wrapping its checkbox is still found by what it says.
    if (text && text.length <= 60 && (el.children.length === 0 || el.tagName === 'LABEL')) out.push({ strategy: 'text', value: text });
    if (stableId(el.id)) out.push({ strategy: 'css', value: '#' + cssEscape(el.id) });
    // A form field's name is what the server reads, so it outlives label and layout changes.
    var fieldName = el.getAttribute('name');
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON|IFRAME)$/.test(el.tagName) && stableId(fieldName))
      out.push({ strategy: 'css', value: el.tagName.toLowerCase() + '[name="' + attrValue(fieldName) + '"]' });
    // An iframe has no role or text; its title, or where it loads from, is what identifies it.
    if (el.tagName === 'IFRAME') {
      var title = squash(el.getAttribute('title'));
      if (title) out.push({ strategy: 'css', value: 'iframe[title="' + attrValue(title) + '"]' });
      var src = (el.getAttribute('src') || '').split(/[?#]/)[0];
      if (src && src.length <= 200 && !looksVolatile(src)) out.push({ strategy: 'css', value: 'iframe[src^="' + attrValue(src) + '"]' });
    }

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
        if (at !== -1 && at <= 500) out.push({ strategy: c.strategy, value: c.value, name: c.name, attr: c.attr, nth: at });
      }
    }

    // Its place in a list ("the first result"): offered for every item in a list, always marked as
    // data-dependent, so it is only chosen when the tester's intent is about position.
    var inList = listPosition(el, role);
    if (inList) out.push(inList);

    out.push({ strategy: 'css', value: cssPath(el) });
    // The id rule and the path can land on the same selector; offer each way only once.
    var seen = {};
    var unique = out.filter(function (c) {
      var key = c.strategy + '|' + c.value + '|' + (c.name || '') + '|' +
        (c.within ? c.within.strategy + c.within.value + (c.within.hasText || '') : '') + '|' + (c.nth === undefined ? '' : c.nth);
      if (seen[key]) return false;
      seen[key] = true;
      c.stable = isStable(c);
      return true;
    });
    // Stable ways first, each group keeping its preference order ("Add to cart" before "₹499").
    return unique.filter(function (c) { return c.stable; }).concat(unique.filter(function (c) { return !c.stable; }));
  }

  var LIST_ITEM = 'li,[role=listitem],[role=row],tr,article,[role=article]';
  var LIST = 'ul,ol,[role=list],table,[role=table],[role=grid],[role=feed],[role=listbox]';

  /** This element's position among the same kind of element in its list, found through that list. */
  function listPosition(el, role) {
    var item = role && el.closest(LIST_ITEM);
    var list = item && item.parentElement && item.parentElement.closest(LIST);
    if (!list || list.querySelectorAll(LIST_ITEM).length < 2) return null;
    var listLoc = null;
    for (var i = 0; i < TEST_ID_ATTRS.length && !listLoc; i++) {
      var tid = list.getAttribute(TEST_ID_ATTRS[i]);
      if (tid) listLoc = { strategy: 'testid', value: tid, attr: TEST_ID_ATTRS[i] };
    }
    var listRole = roleOf(list) || (list.tagName === 'TABLE' ? 'table' : null);
    if (!listLoc && listRole) {
      var nm = accessibleName(list);
      listLoc = { strategy: 'role', value: listRole, name: nm && nm.length <= 40 && list.children.length > 0 && nm !== squash(list.textContent) ? nm : undefined };
    }
    if (!listLoc || matchesIn(listLoc, document).length !== 1) return null;
    var peers = matchesIn({ strategy: 'role', value: role }, list);
    var at = peers.indexOf(el);
    return at === -1 || at > 500 ? null : { strategy: 'role', value: role, within: listLoc, nth: at };
  }

  /** A short, readable CSS path: stops at the nearest id, and uses :nth-of-type only when needed. */
  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (stableId(node.id)) { parts.unshift('#' + cssEscape(node.id)); break; }
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

  /** getByRole leaves out what is hidden from people, so a hidden duplicate (a mobile menu) must not count. */
  function rendered(e) {
    if (e.closest('[aria-hidden="true"]') || !e.getClientRects().length) return false;
    return getComputedStyle(e).visibility !== 'hidden';
  }

  /** Every element a candidate matches, inside 'root' (the whole page by default). */
  function matchesIn(c, root) {
    var scope = root || document;
    try {
      if (c.strategy === 'testid') return [].slice.call(scope.querySelectorAll('[' + c.attr + '="' + attrValue(c.value) + '"]'));
      if (c.strategy === 'placeholder') return [].slice.call(scope.querySelectorAll('[placeholder="' + cssEscape(c.value) + '"]'));
      if (c.strategy === 'css') return [].slice.call(scope.querySelectorAll(c.value));
      var all = scope.querySelectorAll('*');
      var out = [];
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (c.strategy === 'role' && roleOf(e) === c.value && (c.name === undefined || accessibleName(e) === c.name) && rendered(e)) out.push(e);
        else if (c.strategy === 'label' && /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && labelOf(e) === c.value) out.push(e);
        else if (c.strategy === 'text' && (e.children.length === 0 || e.tagName === 'LABEL') && squash(e.textContent) === c.value) out.push(e);
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
    // Exact, as it is counted: getByText otherwise matches any element containing the text, any case.
    if (c.strategy === 'text') return 'getByText(' + q(c.value) + ', { exact: true })';
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

  /** Everything a picker pane shows about one element; the shape is PickedElement in browser.ts. */
  function describeElement(el) {
    var found = candidates(el);
    return {
      tag: el.tagName.toLowerCase(),
      role: roleOf(el) || null,
      text: squash(el.textContent).slice(0, 80),
      xpath: xpathOf(el).slice(0, 2000),
      suggestedName: suggestName(el, found).slice(0, 200),
      page: (squash(document.title).slice(0, 60) || location.pathname).slice(0, 200),
      url: location.href.slice(0, 2000),
      locators: found.map(function (c) {
        return {
          strategy: c.strategy,
          value: c.value,
          name: c.name,
          within: c.within ? { strategy: c.within.strategy, value: c.within.value, name: c.within.name, hasText: c.within.hasText } : undefined,
          nth: c.nth,
          code: 'page.' + playwrightCode(c),
          stable: c.stable,
          // A scoped locator is counted inside its container, and a positional one picks exactly one.
          matches: c.within || c.nth !== undefined ? 1 : countMatches(c, null)
        };
      })
    };
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
