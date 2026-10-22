// Round 64: execute the shipped UI shell, exercise panel state and accessibility.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const src = fs.readFileSync(process.argv[2], 'utf8');

function element(tag = 'div') {
  const attrs = {}, classes = new Set(), events = {}, found = {};
  const node = {
    tagName: tag.toUpperCase(), style: { setProperty(k, v) { this[k] = v; } }, dataset: {}, children: [],
    parentElement: null, parentNode: null, offsetWidth: 210, isConnected: true,
    classList: { add(...xs) { xs.forEach(x => classes.add(x)); }, remove(...xs) { xs.forEach(x => classes.delete(x)); },
      contains(x) { return classes.has(x); }, toggle(x, on) { const yes = on === undefined ? !classes.has(x) : !!on; if (yes) classes.add(x); else classes.delete(x); return yes; } },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
    hasAttribute(k) { return k in attrs; }, removeAttribute(k) { delete attrs[k]; },
    addEventListener(t, f) { (events[t] ||= []).push(f); },
    fire(t, extra = {}) { (events[t] || []).forEach(f => f({ target: node, stopPropagation() {}, preventDefault() {}, ...extra })); },
    appendChild(c) { c.parentNode = c.parentElement = node; node.children.push(c); return c; },
    insertBefore(c) { c.parentNode = c.parentElement = node; node.children.unshift(c); return c; },
    contains(c) { return c === node || node.children.some(x => x.contains(c)) || Object.values(found).some(x => x.contains(c)); },
    querySelector(sel) { return found[sel] ||= element('button'); }, querySelectorAll() { return []; },
    focus() { if (node._document) node._document.activeElement = node; },
    getBoundingClientRect() { return { width: 210, height: 300, left: 0, top: 0, right: 210, bottom: 300 }; },
  };
  Object.defineProperty(node, 'className', { get: () => [...classes].join(' '), set: value => { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(x => classes.add(x)); } });
  return node;
}
function load({ mobile = false, reduced = false, stored, dir = 'left', width = '210px' } = {}) {
  const host = element(), panel = element('aside'), content = element(), input = element('input');
  panel.id = 'motion-' + dir; panel.style.flexBasis = width;
  panel.setAttribute('data-zq-collapse', dir); panel.setAttribute('data-zq-label', dir === 'left' ? '目录' : '页面检查');
  host.appendChild(panel); panel.appendChild(content); content.appendChild(input);
  const events = {}, timers = new Map(), frames = new Map(), queries = {}; let seq = 0;
  const values = new Map(stored === undefined ? [] : [['zq.c.' + panel.id, stored]]);
  const document = { readyState: 'complete', documentElement: element('html'), body: element('body'), activeElement: null,
    getElementById() { return null; }, querySelector() { return null; },
    querySelectorAll(sel) { return sel === '[data-zq-collapse]' ? [panel] : []; },
    createElement(tag) { const el = element(tag); el._document = document; return el; },
    addEventListener(t, f) { (events[t] ||= []).push(f); } };
  input._document = document;
  const window = { document, location: { pathname: '/knowledge-wiki.html', search: '', hash: '' },
    localStorage: { getItem(k) { return values.has(k) ? values.get(k) : null; }, setItem(k, v) { values.set(k, v); } },
    sessionStorage: { getItem() { return null; } }, innerWidth: mobile ? 390 : 1440, innerHeight: 900,
    getComputedStyle(el) { return { flexBasis: el.style.flexBasis || 'auto' }; },
    matchMedia(query) { return queries[query] ||= { matches: query.includes('max-width') ? mobile : query.includes('reduced-motion') ? reduced : false,
      handlers: [], addEventListener(t, f) { this.handlers.push(f); }, addListener(f) { this.handlers.push(f); } }; },
    setTimeout(f, ms) { const id = ++seq; timers.set(id, { f, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(f) { const id = ++seq; frames.set(id, f); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener() {} };
  window.window = window;
  vm.runInContext(src, vm.createContext({ ...window, console }), { filename: 'zhiqu-ui.js' });
  const rail = panel.children.find(c => c.classList.contains('zq-rail'));
  const collapse = panel.children.find(c => c.classList.contains('zq-cbtn'));
  const expand = rail.querySelector('.zq-xbtn'); expand._document = document;
  function flush() { for (const [id, f] of [...frames]) { if (frames.delete(id)) f(); } for (const [id, timer] of [...timers]) { if (timers.delete(id)) timer.f(); } }
  function emit(t, ev) { (events[t] || []).forEach(f => f({ target: document.body, stopPropagation() {}, preventDefault() {}, ...ev })); }
  return { panel, content, input, collapse, rail, expand, document, values, queries, timers, frames, flush, emit };
}

let failed = 0, passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } }
for (const [dir, width] of [['left', '218px'], ['right', '262px']]) {
  test(dir + ': init preserves width without playing a transition and initializes accessibility', () => {
    const r = load({ dir, width, stored: '1' });
    assert.equal(r.panel.style['--zq-panel-expanded-width'], width);
    assert(r.panel.classList.contains('zq-collapsed'));
    assert(!r.panel.classList.contains('zq-panel-opening') && !r.panel.classList.contains('zq-panel-closing'));
    assert.equal(r.expand.getAttribute('aria-expanded'), 'false');
    assert.equal(r.content.getAttribute('aria-hidden'), 'true'); assert(r.content.hasAttribute('inert'));
  });
  test(dir + ': toggles remain reachable and content is inert while closed', () => {
    const r = load({ dir, stored: '1' }); r.expand.fire('click'); r.flush();
    assert(!r.panel.classList.contains('zq-collapsed'));
    assert.equal(r.expand.getAttribute('aria-expanded'), 'true'); assert(!r.content.hasAttribute('inert'));
    r.input.focus(); r.collapse.fire('click');
    assert(r.document.activeElement === r.expand); assert(r.content.hasAttribute('inert'));
    assert.equal(r.values.get('zq.c.' + r.panel.id), '1');
    r.expand.fire('click'); assert(r.document.activeElement === r.collapse);
  });
}
test('mobile: temporary overlay preserves desktop preference and closes with Escape', () => {
  const r = load({ mobile: true, stored: '0' }); r.expand.fire('click'); r.flush();
  assert(!r.panel.classList.contains('zq-collapsed')); r.input.focus();
  r.panel.fire('keydown', { key: 'Escape', target: r.input });
  assert(r.panel.classList.contains('zq-collapsed')); assert(r.panel.classList.contains('zq-panel-closing'));
  assert.equal(r.values.get('zq.c.' + r.panel.id), '0');
  r.flush(); assert(!r.panel.classList.contains('zq-panel-closing')); assert(r.document.activeElement === r.expand);
});
test('mobile: fast close/open reverses and cancels stale completion', () => {
  const r = load({ mobile: true }); r.expand.fire('click'); r.flush(); r.collapse.fire('click');
  assert(r.panel.classList.contains('zq-panel-closing')); r.expand.fire('click'); r.flush();
  assert(!r.panel.classList.contains('zq-collapsed')); assert(!r.panel.classList.contains('zq-panel-closing'));
  assert(!r.content.hasAttribute('inert')); assert.equal(r.expand.getAttribute('aria-expanded'), 'true');
});
test('mobile: reduced motion and changing the system setting finish immediately', () => {
  const r = load({ mobile: true, reduced: true }); r.expand.fire('click'); r.collapse.fire('click');
  assert(r.panel.classList.contains('zq-collapsed')); assert(!r.panel.classList.contains('zq-panel-closing')); assert.equal(r.timers.size, 0);
  const active = load({ mobile: true }); active.expand.fire('click'); active.flush(); active.collapse.fire('click');
  const mq = active.queries['(prefers-reduced-motion: reduce)']; assert(mq);
  mq.matches = true; mq.handlers.forEach(f => f());
  assert(!active.panel.classList.contains('zq-panel-closing')); assert.equal(active.timers.size, 0);
});
test('breakpoint change cleans animation and restores remembered desktop state', () => {
  const r = load({ mobile: true, stored: '0' }); r.expand.fire('click'); r.flush(); r.collapse.fire('click');
  const mq = r.queries['(max-width: 760px)']; mq.matches = false; mq.handlers.forEach(f => f()); r.flush();
  assert(!r.panel.classList.contains('zq-collapsed')); assert(!r.panel.classList.contains('zq-panel-closing'));
  assert(!r.content.hasAttribute('inert'));
});
test('collapsed content focus guard redirects late/dynamic controls', () => {
  const r = load(); r.input.focus(); r.panel.fire('focusin', { target: r.input });
  assert(r.document.activeElement === r.expand);
});
test('closing a scrolled panel keeps the rail visible and restores reading position on reopen', () => {
  const r = load({ stored: '0' }); r.panel.scrollTop = 188; r.input.focus(); r.collapse.fire('click');
  assert.equal(r.panel.scrollTop, 0); r.expand.fire('click'); assert.equal(r.panel.scrollTop, 188);
});
console.log(failed ? `RED: ${failed} assertions (${passed} passed)` : `ALL-GREEN: ${passed} behavioral cases`);
process.exit(failed ? 1 : 0);
