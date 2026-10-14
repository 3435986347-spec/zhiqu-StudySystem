// Execute the published modal helper. Simulate both classic and overlay scrollbars;
// the native WebKit layout suite separately measures the real CSS viewport gutter.
const fs = require('fs');
const assert = require('assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
const from = source.indexOf('  // 可复用的 Claude 风格居中弹窗：');
const to = source.indexOf('  // ── 弹窗版 prompt/confirm/alert', from);
if (from < 0 || to < 0) throw new Error('Cannot find published modal helper');

function load({ gutter = 17, stable = false, padding = '8px' } = {}) {
  const events = new Map();
  let document;
  function node(tag = 'div') {
    const classes = new Set();
    const style = { paddingRight: '' };
    const item = {
      tagName: tag.toUpperCase(), style, children: [], parentNode: null,
      classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); }, contains(value) { return classes.has(value); } },
      appendChild(child) { child.parentNode = item; item.children.push(child); return child; },
      addEventListener(name, fn) { (item.events[name] ||= []).push(fn); }, events: {},
      remove() { if (item.parentNode) item.parentNode.children.splice(item.parentNode.children.indexOf(item), 1); item.parentNode = null; },
      focus(options) { item.focusOptions = options; document.activeElement = item; if (!options || !options.preventScroll) window.scrollY = 0; },
      querySelector(selector) { return item.matches && item.matches[selector] || null; },
    };
    Object.defineProperty(item, 'className', { get: () => [...classes].join(' '), set(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(value => classes.add(value)); } });
    Object.defineProperty(item, 'innerHTML', { set(value) {
      item.html = value;
      if (item.classList.contains('zq-modal-mask')) {
        const content = node(), control = node('input'), close = node('button');
        content.matches = { '[autofocus]': control, 'input,textarea,select,button': control };
        item.matches = { '.zq-modal-body': content, '.zq-modal-close': close };
        item.appendChild(content); content.appendChild(control); item.appendChild(close);
      }
    } });
    return item;
  }
  const body = node('body'); body.style.paddingRight = padding;
  const root = node('html');
  // Chromium's root.clientWidth reports the expanded viewport after overflow is
  // hidden even when scrollbar-gutter keeps the actual body layout unchanged.
  Object.defineProperty(root, 'clientWidth', { get() { return 1280 - (!body.classList.contains('zq-modal-open') ? gutter : 0); } });
  Object.defineProperty(body, 'clientWidth', { get() { return 1280 - (stable || !body.classList.contains('zq-modal-open') ? gutter : 0); } });
  document = {
    body, documentElement: root, activeElement: null, createElement: node,
    querySelectorAll(selector) { return selector === '.zq-modal-mask' ? body.children.filter(child => child.classList.contains('zq-modal-mask')) : []; },
    querySelector(selector) { return document.querySelectorAll(selector)[0] || null; },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
    removeEventListener(name, fn) { events.set(name, (events.get(name) || []).filter(listener => listener !== fn)); },
  };
  const window = {
    innerWidth: 1280, scrollX: 11, scrollY: 284,
    getComputedStyle(item) { return { paddingRight: item.style.paddingRight || '0px' }; },
    scrollTo(x, y) { window.scrollX = x; window.scrollY = y; },
  };
  const api = new Function('document', 'window', 'esc', 'icon', source.slice(from, to) + '\nreturn { openModal };')(document, window, value => String(value), () => '');
  return { ...api, body, document, window, events,
    contentWidth() { return body.clientWidth - (parseFloat(body.style.paddingRight) || 0); },
    escape() { for (const listener of [...events.get('keydown') || []]) listener({ key: 'Escape' }); },
  };
}

let failed = 0, passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); } }
test('classic scrollbar: opening and closing preserve the background content width and original padding', () => {
  const view = load(), width = view.contentWidth();
  const dialog = view.openModal({ title: 'Export ZIP' });
  assert.equal(view.contentWidth(), width);
  assert.equal(view.body.style.paddingRight, '25px');
  dialog.close(); assert.equal(view.contentWidth(), width); assert.equal(view.body.style.paddingRight, '8px');
});
test('stable CSS gutter: browser reservation must not be compensated twice', () => {
  const view = load({ stable: true }), width = view.contentWidth(), viewport = view.document.documentElement.clientWidth;
  const dialog = view.openModal({ title: 'Preview ZIP' });
  assert.equal(view.document.documentElement.clientWidth, viewport + 17);
  assert.equal(view.body.clientWidth, viewport);
  assert.equal(view.contentWidth(), width); assert.equal(view.body.style.paddingRight, '8px');
  dialog.close(); assert.equal(view.body.style.paddingRight, '8px');
});
test('overlay scrollbar: no extra gap or inline padding appears on an unpadded body', () => {
  const view = load({ gutter: 0, padding: '' }), width = view.contentWidth();
  const dialog = view.openModal({}); assert.equal(view.contentWidth(), width); assert.equal(view.body.style.paddingRight, '');
  dialog.close(); assert.equal(view.body.style.paddingRight, '');
});
test('autofocus keeps the reading position and requests focus without scrolling', () => {
  const view = load(), dialog = view.openModal({});
  assert.equal(view.window.scrollY, 284); assert.equal(view.window.scrollX, 11);
  assert.equal(dialog.body.querySelector('[autofocus]').focusOptions.preventScroll, true);
  dialog.close(); assert.equal(view.window.scrollY, 284);
});
test('onMount focus cannot scroll the background; close restores the captured reading position', () => {
  const view = load(), dialog = view.openModal({ onMount(body) { body.querySelector('[autofocus]').focus(); } });
  assert.equal(view.window.scrollY, 284);
  view.window.scrollY = 31; dialog.close(); assert.equal(view.window.scrollY, 284);
});
test('nested dialogs retain one gutter and lock until the final dialog closes', () => {
  const view = load(), width = view.contentWidth();
  const first = view.openModal({}), second = view.openModal({});
  assert.equal(view.contentWidth(), width); assert.equal(view.body.style.paddingRight, '25px');
  view.escape(); assert.equal(view.document.querySelectorAll('.zq-modal-mask').length, 1);
  assert(view.body.classList.contains('zq-modal-open')); assert.equal(view.contentWidth(), width);
  first.close(); second.close(); assert(!view.body.classList.contains('zq-modal-open'));
  assert.equal(view.body.style.paddingRight, '8px'); assert.equal(view.window.scrollY, 284);
});
test('out-of-order closing leaves the upper dialog locked and preserves the first reading position', () => {
  const view = load(), width = view.contentWidth();
  const first = view.openModal({}), second = view.openModal({});
  first.close(); assert(view.body.classList.contains('zq-modal-open')); assert.equal(view.contentWidth(), width);
  second.close(); assert.equal(view.window.scrollY, 284); assert.equal(view.body.style.paddingRight, '8px');
});
test('an onClose callback may open another dialog with a fresh, correctly sized scroll lock', () => {
  const view = load(), width = view.contentWidth(); let next;
  const first = view.openModal({ onClose() { next = view.openModal({}); } });
  first.close(); assert.equal(view.contentWidth(), width); assert(view.body.classList.contains('zq-modal-open'));
  next.close(); assert.equal(view.contentWidth(), width); assert.equal(view.window.scrollY, 284);
});
console.log(failed ? `RED: ${failed} assertions (${passed} passed)` : `ALL-GREEN: ${passed} behavioral cases`);
process.exit(failed ? 1 : 0);
