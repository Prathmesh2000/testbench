// The locator picker, as it runs on the tester's own site. Served by /api/picker/script with the
// ticket and endpoint substituted in. It reads the page's DOM to rank locators the same way the
// generator and the page library do, and sends back only the elements the tester chooses to keep:
// nothing about the page leaves the browser otherwise.
//
// Written as a string, not a module, because it is delivered to another origin as plain JavaScript.
// The locator ranking itself lives in core.ts and is shared with the embedded picker.

import { LOCATOR_CORE } from './core';

export const PICKER_SOURCE = String.raw`
(function () {
  'use strict';
  var ROOT_ID = 'tb-locator-picker';
  if (document.getElementById(ROOT_ID)) return;

  var CAPTURE_URL = '__CAPTURE_URL__';
  var TICKET = '__TICKET__';

__CORE__
  // ---------- overlay ----------

  var root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('data-tb-picker', '');
  root.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  var shadow = root.attachShadow ? root.attachShadow({ mode: 'open' }) : root;
  document.documentElement.appendChild(root);

  var style = document.createElement('style');
  style.textContent = [
    ':host,*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif}',
    '.box{position:fixed;border:2px solid #4c8dff;background:rgba(76,141,255,.12);pointer-events:none;border-radius:2px;transition:all .04s linear}',
    '.tag{position:fixed;background:#4c8dff;color:#fff;font-size:11px;padding:1px 5px;border-radius:3px;pointer-events:none;white-space:nowrap}',
    '.panel{position:fixed;right:16px;bottom:16px;width:420px;max-height:72vh;display:flex;flex-direction:column;background:#16181d;color:#e6e7ea;border:1px solid #2b2d33;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5);pointer-events:auto;font-size:12.5px;overflow:hidden}',
    '.hd{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2b2d33;background:#1b1e24}',
    '.hd b{font-size:12.5px}',
    '.bd{padding:10px;overflow:auto;display:flex;flex-direction:column;gap:8px}',
    '.row{display:flex;gap:6px;align-items:center}',
    'input{flex:1;min-width:0;background:#0f1114;color:#e6e7ea;border:1px solid #2b2d33;border-radius:4px;padding:5px 7px;font-size:12.5px}',
    'button{background:#23262d;color:#e6e7ea;border:1px solid #2b2d33;border-radius:4px;padding:4px 9px;font-size:12px;cursor:pointer}',
    'button.primary{background:#2f6fe4;border-color:#2f6fe4;color:#fff}',
    'button:disabled{opacity:.5;cursor:default}',
    '.cand{display:flex;gap:6px;align-items:baseline;padding:4px 6px;border:1px solid #2b2d33;border-radius:4px;cursor:pointer;background:#0f1114}',
    '.cand.on{border-color:#2f6fe4;background:#17233a}',
    '.cand code{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;flex:1}',
    '.uniq{font-size:10.5px;color:#7fd18e;white-space:nowrap}',
    '.dup{color:#e2a33d}',
    '.kept{display:flex;gap:6px;align-items:center;font-size:11.5px;border-top:1px solid #2b2d33;padding-top:6px}',
    '.muted{color:#9aa0aa;font-size:11.5px}'
  ].join('');
  shadow.appendChild(style);

  var box = document.createElement('div'); box.className = 'box'; box.style.display = 'none';
  var tag = document.createElement('div'); tag.className = 'tag'; tag.style.display = 'none';
  shadow.appendChild(box); shadow.appendChild(tag);

  var panel = document.createElement('div'); panel.className = 'panel';
  // A fixed literal with nothing interpolated. Everything from the page under test (locator values,
  // names, counts) is set with textContent below, so page content can never become markup here.
  panel.innerHTML = [
    '<div class="hd"><b>Testbench locator picker</b><span class="muted" id="tb-state">hovering</span>',
    '<span style="flex:1"></span><button id="tb-pause">Pause</button><button id="tb-close">Close</button></div>',
    '<div class="bd">',
    '<div class="row"><span class="muted">Page</span><input id="tb-page" placeholder="Checkout"></div>',
    '<div id="tb-hint" class="muted">Move over an element, then click it to keep its locator. Pause to use the site normally.</div>',
    '<div id="tb-pick" style="display:none;flex-direction:column;gap:6px">',
    '<div class="row"><span class="muted">Name</span><input id="tb-name" placeholder="Pay button"></div>',
    '<div id="tb-cands" style="display:flex;flex-direction:column;gap:4px"></div>',
    '<div class="row"><button class="primary" id="tb-keep">Keep</button><button id="tb-skip">Cancel</button>',
    '<span style="flex:1"></span><button id="tb-copy">Copy code</button></div>',
    '</div>',
    '<div id="tb-kept"></div>',
    '<div class="row"><button class="primary" id="tb-send" disabled>Send to Testbench</button><span class="muted" id="tb-count"></span></div>',
    '</div>'
  ].join('');
  shadow.appendChild(panel);

  var $ = function (id) { return shadow.getElementById ? shadow.getElementById(id) : document.getElementById(id); };
  var pageInput = $('tb-page');
  pageInput.value = squash(document.title).slice(0, 60) || location.pathname;

  var paused = false;
  var pinned = null;
  var chosen = 0;
  var list = [];
  // Kept elements survive moving around the site: the picker is gone after a navigation, so they are
  // parked in sessionStorage and picked up when the bookmarklet is run again on the next page.
  var STORE = 'tb-picker-kept';
  var kept = [];
  try { kept = JSON.parse(sessionStorage.getItem(STORE) || '[]'); } catch (err) { kept = []; }
  function remember() { try { sessionStorage.setItem(STORE, JSON.stringify(kept)); } catch (err) { /* private mode */ } }

  function setState(t) { $('tb-state').textContent = t; }

  function highlight(el) {
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    tag.style.display = 'block';
    tag.style.left = r.left + 'px';
    tag.style.top = (r.top > 22 ? r.top - 20 : r.bottom + 4) + 'px';
    var role = roleOf(el);
    tag.textContent = el.tagName.toLowerCase() + (role ? ' · ' + role : '');
  }

  function showCandidates(el) {
    list = candidates(el).map(function (c) { c.count = countMatches(c); return c; });
    // A locator that matches one element is worth more than a higher-ranked ambiguous one.
    var firstUnique = list.findIndex(function (c) { return c.count === 1; });
    chosen = firstUnique === -1 ? 0 : firstUnique;
    var host = $('tb-cands');
    host.innerHTML = '';
    list.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'cand' + (i === chosen ? ' on' : '');
      var code = document.createElement('code'); code.textContent = playwrightCode(c);
      var uniq = document.createElement('span');
      uniq.className = 'uniq' + (c.count === 1 ? '' : ' dup');
      uniq.textContent = c.count === 1 ? 'unique' : c.count + ' matches';
      row.appendChild(code); row.appendChild(uniq);
      row.addEventListener('click', function () {
        chosen = i;
        Array.prototype.forEach.call(host.children, function (n, k) { n.className = 'cand' + (k === i ? ' on' : ''); });
      });
      host.appendChild(row);
    });
    $('tb-name').value = suggestName(el, list);
    $('tb-pick').style.display = 'flex';
    $('tb-hint').style.display = 'none';
  }

  function clearPick() {
    pinned = null;
    $('tb-pick').style.display = 'none';
    $('tb-hint').style.display = '';
    setState(paused ? 'paused' : 'hovering');
  }

  function renderKept() {
    remember();
    var host = $('tb-kept');
    host.innerHTML = '';
    kept.forEach(function (k, i) {
      var row = document.createElement('div');
      row.className = 'kept';
      var label = document.createElement('span');
      label.style.flex = '1';
      label.textContent = k.page + ' › ' + k.name;
      var code = document.createElement('code');
      code.style.cssText = 'font-family:ui-monospace,monospace;font-size:10.5px;color:#9aa0aa';
      code.textContent = k.locators[0].strategy;
      var del = document.createElement('button');
      del.textContent = '×';
      del.addEventListener('click', function () { kept.splice(i, 1); renderKept(); });
      row.appendChild(label); row.appendChild(code); row.appendChild(del);
      host.appendChild(row);
    });
    $('tb-send').disabled = kept.length === 0;
    $('tb-count').textContent = kept.length ? kept.length + ' element' + (kept.length === 1 ? '' : 's') + ' ready' : '';
  }

  function inPicker(el) { return !!(el && el.closest && el.closest('[data-tb-picker]')); }

  document.addEventListener('mousemove', function (e) {
    if (paused || pinned || inPicker(e.target)) return;
    if (e.target && e.target.nodeType === 1) highlight(e.target);
  }, true);

  document.addEventListener('click', function (e) {
    if (paused || inPicker(e.target)) return;
    // The site's own handler must not fire: a click here means "pick this", not "use the site".
    e.preventDefault();
    e.stopPropagation();
    pinned = e.target;
    setState('picked');
    showCandidates(pinned);
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && pinned) { clearPick(); e.preventDefault(); }
  }, true);

  $('tb-pause').addEventListener('click', function () {
    paused = !paused;
    $('tb-pause').textContent = paused ? 'Resume picking' : 'Pause';
    box.style.display = tag.style.display = paused ? 'none' : 'block';
    setState(paused ? 'paused — use the site normally' : 'hovering');
  });
  $('tb-close').addEventListener('click', function () { root.remove(); });
  $('tb-skip').addEventListener('click', clearPick);
  $('tb-copy').addEventListener('click', function () {
    var text = 'page.' + playwrightCode(list[chosen]);
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { setState('copied'); });
  });
  $('tb-keep').addEventListener('click', function () {
    var name = squash($('tb-name').value);
    var page = squash(pageInput.value);
    if (!name || !page) { setState('give it a page and a name'); return; }
    var c = list[chosen];
    var locator = { strategy: c.strategy, value: c.value };
    if (c.name) locator.name = c.name;
    kept.push({ page: page, name: name, locators: [locator] });
    renderKept();
    clearPick();
  });

  $('tb-send').addEventListener('click', function () {
    var btn = $('tb-send');
    btn.disabled = true;
    setState('sending…');
    fetch(CAPTURE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: TICKET, elements: kept })
    }).then(function (res) {
      if (!res.ok) return res.json().catch(function () { return null; }).then(function (b) {
        throw new Error((b && b.error && b.error.message) || ('Testbench refused it (' + res.status + ')'));
      });
      setState(kept.length + ' saved to the page library');
      kept = [];
      renderKept();
    }).catch(function (err) {
      setState(err.message);
      btn.disabled = false;
    });
  });

  setState('hovering');
  renderKept();
})();
`.replace('__CORE__', LOCATOR_CORE);
