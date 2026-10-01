// UI review as it runs inside the Test Browser. Two scripts, both source text rather than functions
// for the same reason as the picker (esbuild's keepNames helpers do not exist in the page):
//
// - UI_PERF_INIT starts with every page, because layout shifts and long tasks are only reported to an
//   observer that was already listening; asked for later, most browsers have dropped them.
// - UI_SCAN_SOURCE is evaluated on demand, when the tester scans or hovers. It defines window.__tbUi
//   once per document and keeps element ids in a WeakMap, so a rescan of the same page keeps them and
//   the tester's selection survives it.
//
// Everything these return comes from a page nobody vetted and is parsed again in Node (see ui.ts).

/** Most elements one scan keeps; a long feed page has tens of thousands. */
export const UI_MAX_NODES = 2_500;

export const UI_PERF_INIT = String.raw`
(function () {
  if (window.__tbPerfLog || window.top !== window) return;
  var log = window.__tbPerfLog = { lcp: null, cls: 0, long: [] };
  var win = { value: 0, first: 0, last: 0 };
  function observe(type, fn) {
    try {
      new PerformanceObserver(function (list) { list.getEntries().forEach(fn); }).observe({ type: type, buffered: true });
      return true;
    } catch (e) { return false; }
  }
  observe('largest-contentful-paint', function (e) { log.lcp = e.startTime; });
  // Session windows as Core Web Vitals counts them: shifts under 1 s apart, at most 5 s long.
  observe('layout-shift', function (e) {
    if (e.hadRecentInput) return;
    if (win.value && e.startTime - win.last < 1000 && e.startTime - win.first < 5000) win.value += e.value;
    else { win.value = e.value; win.first = e.startTime; }
    win.last = e.startTime;
    if (win.value > log.cls) log.cls = win.value;
  });
  if (!observe('longtask', function (e) { if (log.long.length < 500) log.long.push([e.startTime, e.duration]); })) log.long = null;
})();
`;

export const UI_SCAN_SOURCE = String.raw`
(function () {
  'use strict';
  if (window.__tbUi) return;

  var HOST = 'data-tb-ui';
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1, HEAD: 1, TITLE: 1, BASE: 1 };
  var FIELD = { INPUT: 1, SELECT: 1, TEXTAREA: 1 };
  var LANDMARK_TAGS = { HEADER: 1, NAV: 1, MAIN: 1, FOOTER: 1, ASIDE: 1 };
  var LANDMARK_ROLES = { banner: 1, navigation: 1, main: 1, contentinfo: 1, complementary: 1, region: 1, search: 1 };
  // Roles whose name is their content, so a button's text is its name.
  var NAME_FROM_CONTENT = { button: 1, link: 1, heading: 1, tab: 1, menuitem: 1, option: 1, checkbox: 1, radio: 1, switch: 1, cell: 1, columnheader: 1, rowheader: 1, tooltip: 1, treeitem: 1 };

  var ids = new WeakMap();
  var byId = new Map();
  var nextId = 0;
  function idOf(el) {
    var id = ids.get(el);
    if (id === undefined) { id = nextId++; ids.set(el, id); }
    // Hovering adds elements between scans; past this the oldest are simply forgotten.
    if (byId.size > 10000) byId.clear();
    byId.set(id, el);
    return id;
  }

  function clean(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > (max || 200) ? s.slice(0, (max || 200) - 1) + '…' : s;
  }

  // ---------- colour ----------

  var ctx = null;
  var parsed = {};
  /** Any CSS colour (rgb, hsl, oklch, named…) as [r, g, b, a], via a 1 × 1 canvas. */
  function rgba(c) {
    if (parsed[c]) return parsed[c];
    if (!ctx) {
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    var out = [0, 0, 0, 0];
    if (ctx && c && c !== 'transparent') {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      var d = ctx.getImageData(0, 0, 1, 1).data;
      out = [d[0], d[1], d[2], d[3] / 255];
    }
    parsed[c] = out;
    return out;
  }
  function over(top, under) {
    var a = top[3] + under[3] * (1 - top[3]);
    if (!a) return [0, 0, 0, 0];
    function ch(i) { return (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a; }
    return [ch(0), ch(1), ch(2), a];
  }
  function hex(c) {
    function h(n) { return ('0' + Math.round(n).toString(16)).slice(-2); }
    return '#' + h(c[0]) + h(c[1]) + h(c[2]) + (c[3] < 0.995 ? h(c[3] * 255) : '');
  }
  function luminance(c) {
    function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  }
  function ratio(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  // Reset on every scan and hover: the page may have changed since.
  var styles = new WeakMap();
  function css(el) {
    var s = styles.get(el);
    if (!s) { s = getComputedStyle(el); styles.set(el, s); }
    return s;
  }
  function parentOf(el) {
    return el.parentElement || (el.parentNode && el.parentNode.host) || null;
  }
  var backs = new WeakMap();
  function fresh() { styles = new WeakMap(); backs = new WeakMap(); }
  /** The colour painted behind an element, its own over its ancestors', ending on the page's white. */
  function backdrop(el) {
    var known = backs.get(el);
    if (known) return known;
    var up = parentOf(el);
    var under = up ? backdrop(up) : { colour: [255, 255, 255, 1], image: false };
    var s = css(el);
    var own = rgba(s.backgroundColor);
    var image = !!s.backgroundImage && s.backgroundImage !== 'none';
    // An opaque colour covers any image further up; a translucent one does not.
    var res = { colour: own[3] ? over(own, under.colour) : under.colour, image: image || (under.image && own[3] < 1) };
    backs.set(el, res);
    return res;
  }

  // ---------- naming ----------

  function roleOf(el, tag) {
    var r = el.getAttribute('role');
    if (r) return r.split(' ')[0];
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'NAV') return 'navigation';
    if (tag === 'MAIN') return 'main';
    if (tag === 'IMG') return el.getAttribute('alt') === '' ? 'presentation' : 'img';
    if (tag === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (/^(button|submit|reset|image)$/.test(t)) return 'button';
      return 'textbox';
    }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    return null;
  }
  function ownText(el) {
    var t = '';
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) t += n.nodeValue;
    return clean(t);
  }
  function nameOf(el, tag, role) {
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var parts = by.split(/\s+/).map(function (i) { var e = document.getElementById(i); return e ? e.textContent : ''; });
      var joined = clean(parts.join(' '));
      if (joined) return joined;
    }
    var label = clean(el.getAttribute('aria-label'));
    if (label) return label;
    if (FIELD[tag] && el.labels && el.labels.length) {
      var l = clean(Array.prototype.map.call(el.labels, function (x) { return x.textContent; }).join(' '));
      if (l) return l;
    }
    if (tag === 'IMG' || tag === 'AREA' || (tag === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'image')) {
      var alt = clean(el.getAttribute('alt'));
      if (alt) return alt;
    }
    if (tag === 'INPUT' && /^(button|submit|reset)$/i.test(el.getAttribute('type') || '')) {
      var v = clean(el.value || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : ''));
      if (v) return v;
    }
    if (tag === 'SVG') {
      var title = el.querySelector('title');
      if (title && clean(title.textContent)) return clean(title.textContent);
    }
    if (role && NAME_FROM_CONTENT[role]) {
      var text = clean(el.innerText || el.textContent);
      if (text) return text;
      var imgs = el.querySelectorAll('img[alt], svg title, [aria-label]');
      for (var i = 0; i < imgs.length; i++) {
        var n = clean(imgs[i].getAttribute('alt') || imgs[i].getAttribute('aria-label') || imgs[i].textContent);
        if (n) return n;
      }
    }
    return clean(el.getAttribute('title') || el.getAttribute('placeholder') || '');
  }

  function kindOf(el, tag, role, text) {
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (role === 'heading') return 'heading';
    if (role === 'link') return 'link';
    if (role === 'button') return 'button';
    if (role === 'checkbox' || role === 'radio' || role === 'switch') return 'checkbox';
    if (tag === 'SELECT' || role === 'combobox' || role === 'listbox') return 'select';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || role === 'textbox' || role === 'searchbox' || el.isContentEditable && el.hasAttribute('contenteditable')) return 'input';
    if (tag === 'IMG' || tag === 'PICTURE' || (role === 'img' && tag !== 'SVG')) return 'image';
    if (tag === 'SVG' || ((tag === 'I' || tag === 'SPAN') && !text && !el.children.length && css(el).backgroundImage === 'none' && /icon|awesome|glyph|symbol/i.test(css(el).fontFamily))) return 'icon';
    if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'CANVAS' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') return 'media';
    if (tag === 'UL' || tag === 'OL' || tag === 'DL' || role === 'list' || role === 'menu') return 'list';
    if (tag === 'TABLE' || role === 'table' || role === 'grid') return 'table';
    if (tag === 'FORM' || role === 'form') return 'form';
    if (LANDMARK_TAGS[tag] || (role && LANDMARK_ROLES[role])) return 'landmark';
    if (type === 'hidden') return 'container';
    return text ? 'text' : 'container';
  }

  function selectorOf(el) {
    var parts = [];
    for (var e = el, i = 0; e && e.nodeType === 1 && i < 4; e = e.parentElement, i++) {
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) { parts.unshift('#' + e.id); break; }
      var part = e.tagName.toLowerCase();
      var cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/)[0] : '';
      if (cls && /^[A-Za-z_-][\w-]*$/.test(cls)) part += '.' + cls;
      else if (e.parentElement) {
        var same = Array.prototype.filter.call(e.parentElement.children, function (c) { return c.tagName === e.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ').slice(0, 500);
  }

  var ATTRS = ['id', 'class', 'href', 'src', 'alt', 'type', 'name', 'placeholder', 'title', 'role', 'aria-label', 'data-testid', 'tabindex', 'aria-expanded', 'aria-hidden', 'disabled'];
  function attrsOf(el) {
    var out = [];
    for (var i = 0; i < ATTRS.length && out.length < 12; i++) {
      var a = ATTRS[i];
      if (el.hasAttribute(a)) out.push([a, String(el.getAttribute(a)).slice(0, 300)]);
    }
    return out;
  }

  function focusable(el, tag) {
    if (el.disabled) return false;
    if (el.hasAttribute('tabindex')) return el.tabIndex >= 0;
    return (tag === 'A' && el.hasAttribute('href')) || tag === 'BUTTON' || (FIELD[tag] && el.type !== 'hidden') || el.isContentEditable || tag === 'SUMMARY';
  }

  function sides(s, prop) {
    var t = s[prop + 'Top'], r = s[prop + 'Right'], b = s[prop + 'Bottom'], l = s[prop + 'Left'];
    if (t === r && r === b && b === l) return t;
    if (t === b && r === l) return t + ' ' + r;
    return t + ' ' + r + ' ' + b + ' ' + l;
  }

  /** One element as the tree and the tooltip show it. */
  function describe(el, parent, depth) {
    var tag = el.tagName.toUpperCase();
    var s = css(el);
    var role = roleOf(el, tag);
    var text = ownText(el);
    var kind = kindOf(el, tag, role, text);
    var r = el.getBoundingClientRect();
    var back = backdrop(el);
    var fg = over(rgba(s.color), back.colour);
    var size = parseFloat(s.fontSize) || 0;
    return {
      id: idOf(el),
      parent: parent,
      depth: depth,
      tag: tag.toLowerCase().slice(0, 40),
      kind: kind,
      role: role ? role.slice(0, 60) : null,
      name: nameOf(el, tag, role),
      text: text,
      selector: selectorOf(el),
      attrs: attrsOf(el),
      box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      style: {
        fontFamily: clean(s.fontFamily, 200),
        fontSize: size,
        fontWeight: String(s.fontWeight).slice(0, 10),
        lineHeight: String(s.lineHeight).slice(0, 20),
        letterSpacing: String(s.letterSpacing).slice(0, 20),
        textTransform: String(s.textTransform).slice(0, 20),
        textAlign: String(s.textAlign).slice(0, 20),
        color: hex(rgba(s.color)),
        background: hex(back.colour),
        backgroundImage: !!back.image,
        border: clean(s.borderTopWidth + ' ' + s.borderTopStyle + ' ' + hex(rgba(s.borderTopColor)), 120),
        borderRadius: String(s.borderRadius).slice(0, 60),
        padding: sides(s, 'padding').slice(0, 60),
        margin: sides(s, 'margin').slice(0, 60),
        display: String(s.display).slice(0, 30),
        position: String(s.position).slice(0, 20),
        zIndex: String(s.zIndex).slice(0, 12),
        opacity: parseFloat(s.opacity) || 0,
      },
      contrast: text && !back.image ? Math.round(ratio(fg, back.colour) * 100) / 100 : null,
      focusable: focusable(el, tag),
      childCount: el.children.length,
    };
  }

  function childrenOf(el) {
    var kids = [];
    if (el.shadowRoot) kids = kids.concat(Array.prototype.slice.call(el.shadowRoot.children));
    return kids.concat(Array.prototype.slice.call(el.children));
  }

  // ---------- accessibility and timing ----------

  function large(node) {
    var w = parseInt(node.style.fontWeight, 10) || 400;
    return node.style.fontSize >= 24 || (node.style.fontSize >= 18.66 && w >= 700);
  }

  function pageIssues(issues, headings) {
    if (!clean(document.title)) issues.push({ rule: 'doc-title', node: null, message: 'The document has no <title>, so tabs and screen readers cannot name the page.' });
    if (!clean(document.documentElement.getAttribute('lang'))) issues.push({ rule: 'html-lang', node: null, message: '<html> has no lang attribute; screen readers guess the language.' });
    if (!headings.some(function (h) { return h.level === 1; })) issues.push({ rule: 'no-h1', node: null, message: 'No <h1>: the page has no main heading.' });
    if (!document.querySelector('main, [role="main"]')) issues.push({ rule: 'no-main', node: null, message: 'No <main> landmark, so keyboard and screen-reader users cannot skip to the content.' });
    var vp = document.querySelector('meta[name="viewport"]');
    var content = vp ? (vp.getAttribute('content') || '').toLowerCase() : '';
    var max = /maximum-scale\s*=\s*([\d.]+)/.exec(content);
    if (/user-scalable\s*=\s*(no|0)/.test(content) || (max && parseFloat(max[1]) < 2))
      issues.push({ rule: 'zoom-disabled', node: null, message: 'The viewport meta tag stops people zooming in: ' + content.slice(0, 200) });
    var prev = 0;
    headings.forEach(function (h) {
      if (prev && h.level > prev + 1) issues.push({ rule: 'heading-order', node: h.id, message: 'h' + h.level + ' follows h' + prev + ': level ' + (prev + 1) + ' is skipped.' });
      prev = h.level;
    });
  }

  function nodeIssues(issues, el, node, hidden) {
    if (hidden) return;
    var tag = el.tagName.toUpperCase();
    var what = node.tag + (node.text ? ' "' + node.text.slice(0, 60) + '"' : '');
    if (tag === 'IMG' && !el.hasAttribute('alt') && node.role !== 'presentation' && node.role !== 'none')
      issues.push({ rule: 'img-alt', node: node.id, message: 'Image with no alt attribute: ' + clean(el.getAttribute('src'), 120) });
    if ((node.kind === 'button' || node.kind === 'link') && !node.name)
      issues.push({ rule: 'control-name', node: node.id, message: 'A ' + node.kind + ' with no text, label or title: a screen reader announces only "' + node.kind + '".' });
    if (FIELD[tag] && el.type !== 'hidden' && !/^(button|submit|reset|image)$/i.test(el.type || '') && !node.name)
      issues.push({ rule: 'input-label', node: node.id, message: 'A ' + (el.type || tag.toLowerCase()) + ' field with no label, aria-label or title.' });
    if (node.contrast !== null && !el.disabled) {
      var need = large(node) ? 3 : 4.5;
      if (node.contrast < need)
        issues.push({ rule: 'contrast', node: node.id, message: what + ': ' + node.contrast + ':1 (needs ' + need + ':1), ' + node.style.color + ' on ' + node.style.background + '.' });
    }
    if (node.text && node.style.fontSize > 0 && node.style.fontSize < 12)
      issues.push({ rule: 'small-text', node: node.id, message: what + ' is ' + node.style.fontSize + ' px.' });
    var interactive = node.kind === 'button' || node.kind === 'checkbox' || node.kind === 'select' || (node.kind === 'link' && node.style.display !== 'inline');
    if (interactive && node.box.w > 0 && node.box.h > 0 && (node.box.w < 24 || node.box.h < 24))
      issues.push({ rule: 'target-size', node: node.id, message: what + ' is ' + node.box.w + ' × ' + node.box.h + ' px.' });
    if (el.hasAttribute('tabindex') && parseInt(el.getAttribute('tabindex'), 10) > 0)
      issues.push({ rule: 'positive-tabindex', node: node.id, message: 'tabindex="' + el.getAttribute('tabindex') + '" on ' + what + '.' });
  }

  function perf(depth) {
    var nav = performance.getEntriesByType('navigation')[0];
    var paint = performance.getEntriesByName('first-contentful-paint')[0];
    var log = window.__tbPerfLog || null;
    var fcp = paint ? paint.startTime : null;
    var tbt = null;
    if (log && log.long && fcp !== null)
      tbt = log.long.reduce(function (sum, t) { return t[0] >= fcp ? sum + Math.max(0, t[1] - 50) : sum; }, 0);
    var res = performance.getEntriesByType('resource');
    var types = {};
    var total = 0;
    var list = res.map(function (r) {
      var bytes = r.transferSize || r.encodedBodySize || 0;
      total += bytes;
      var t = types[r.initiatorType] || (types[r.initiatorType] = { type: String(r.initiatorType || 'other').slice(0, 40), count: 0, bytes: 0 });
      t.count++;
      t.bytes += bytes;
      return { url: String(r.name).slice(0, 2000), type: String(r.initiatorType || 'other').slice(0, 40), bytes: bytes, durationMs: Math.round(r.duration) };
    });
    function top(key) { return list.slice().sort(function (a, b) { return b[key] - a[key]; }).slice(0, 8); }
    function ms(v) { return typeof v === 'number' && v > 0 ? Math.round(v) : null; }
    var mem = performance.memory;
    return {
      ttfb: nav ? ms(nav.responseStart - nav.startTime) : null,
      fcp: ms(fcp),
      lcp: log ? ms(log.lcp) : null,
      cls: log ? Math.round(log.cls * 1000) / 1000 : null,
      tbt: tbt === null ? null : Math.round(tbt),
      domContentLoaded: nav ? ms(nav.domContentLoadedEventEnd) : null,
      load: nav ? ms(nav.loadEventEnd) : null,
      domNodes: document.getElementsByTagName('*').length,
      domDepth: depth,
      requests: res.length + (nav ? 1 : 0),
      bytes: total + (nav ? nav.transferSize || 0 : 0),
      byType: Object.keys(types).map(function (k) { return types[k]; }).sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 20),
      largest: top('bytes'),
      slowest: top('durationMs'),
      jsHeapMb: mem && mem.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 104857.6) / 10 : null,
    };
  }

  function scan(max) {
    fresh();
    byId.clear();
    var nodes = [];
    var issues = [];
    var headings = [];
    var maxDepth = 0;
    var truncated = false;
    var seenIds = {};
    var root = document.body || document.documentElement;
    // Each entry: element, nearest kept ancestor's id, depth in the kept tree, inside aria-hidden.
    var stack = [[root, null, 0, false]];
    while (stack.length) {
      var item = stack.pop();
      var el = item[0];
      var tag = el.tagName.toUpperCase();
      if (SKIP[tag] || el.hasAttribute(HOST)) continue;
      var s = css(el);
      if (s.display === 'none') continue;
      var hidden = item[3] || el.getAttribute('aria-hidden') === 'true';
      var shown = s.visibility !== 'hidden' && s.visibility !== 'collapse';
      var parent = item[1];
      var depth = item[2];
      if (shown) {
        if (nodes.length >= max) { truncated = true; break; }
        var node = describe(el, parent, depth);
        nodes.push(node);
        if (depth > maxDepth) maxDepth = depth;
        nodeIssues(issues, el, node, hidden);
        if (node.role === 'heading') {
          var level = /^H([1-6])$/.exec(tag);
          headings.push({ id: node.id, level: level ? +level[1] : parseInt(el.getAttribute('aria-level'), 10) || 2 });
        }
        if (el.id) {
          if (seenIds[el.id]) issues.push({ rule: 'duplicate-id', node: node.id, message: 'id="' + el.id.slice(0, 80) + '" is used more than once.' });
          seenIds[el.id] = true;
        }
        parent = node.id;
        depth++;
      }
      // An svg is one icon; its paths are not what a reviewer checks.
      if (tag === 'SVG') continue;
      var kids = childrenOf(el);
      for (var i = kids.length - 1; i >= 0; i--) stack.push([kids[i], parent, depth, hidden]);
    }
    pageIssues(issues, headings);
    return {
      url: location.href,
      title: clean(document.title, 300),
      lang: clean(document.documentElement.getAttribute('lang'), 40),
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      nodes: nodes,
      truncated: truncated,
      issues: issues.slice(0, 1000),
      perf: perf(maxDepth),
    };
  }

  // ---------- outline ----------

  var host = null, box = null, badge = null, current = null;
  function overlay() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute(HOST, '');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    var root = host.attachShadow({ mode: 'closed' });
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #3a6cf4;background:rgba(58,108,244,.14);display:none;';
    badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;font:600 11px/1.5 system-ui,sans-serif;background:#1b1d22;color:#fff;padding:1px 6px;border-radius:4px;white-space:nowrap;display:none;';
    root.appendChild(box);
    root.appendChild(badge);
    document.documentElement.appendChild(host);
  }
  function draw() {
    if (!current || !current.isConnected) {
      if (box) { box.style.display = 'none'; badge.style.display = 'none'; }
      return;
    }
    overlay();
    var r = current.getBoundingClientRect();
    box.style.display = badge.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    badge.textContent = current.tagName.toLowerCase() + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height);
    badge.style.left = Math.max(0, r.left) + 'px';
    badge.style.top = (r.top > 20 ? r.top - 20 : r.bottom + 2) + 'px';
  }
  window.addEventListener('scroll', draw, true);
  window.addEventListener('resize', draw);
  function outline(el, scroll) {
    current = el;
    if (el && scroll) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    draw();
  }

  function deepAt(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      var inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    // The svg, not the path inside it.
    if (el && el instanceof SVGElement && el.ownerSVGElement) {
      while (el.ownerSVGElement) el = el.ownerSVGElement;
    }
    return el;
  }

  window.__tbUi = {
    scan: scan,
    at: function (x, y) {
      fresh();
      var el = deepAt(x, y);
      if (!el || el === document.documentElement) { outline(null); return null; }
      outline(el, false);
      var up = parentOf(el);
      return describe(el, up && ids.has(up) ? ids.get(up) : null, 0);
    },
    highlight: function (id, scroll) { outline(id === null ? null : byId.get(id) || null, scroll); },
  };
})();
`;
