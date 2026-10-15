// Run the published Wiki double-link handler with click gestures, not a duplicate routing implementation.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('function wireWikiLinks(');
const end = source.indexOf('function wireWikiEditor() {', start);
if (start < 0 || end < 0) throw new Error('Cannot find published Wiki link handler');
const code = source.slice(start, end);

function fixture() {
  const page = { id: 2, title: 'Target' };
  const state = { wikiPages: [page], wikiCur: null };
  const calls = [];
  const attrs = {};
  const link = {
    getAttribute: name => name === 'data-wikilink' ? 'Target' : attrs[name],
    setAttribute(name, value) { attrs[name] = value; }
  };
  const doc = { dataset: { editing: '0' }, addEventListener() {} };
  const wire = new Function('state', '$all', 'toast', 'paintWikiDoc', code + '\nreturn wireWikiLinks;')(
    state,
    selector => selector === '[data-wikilink]' ? [link] : [],
    message => { throw new Error('Unexpected toast: ' + message); },
    async (target, opts) => { calls.push({ target, opts }); state.wikiCur = target; }
  );
  wire(doc);
  return { link, doc, page, calls, state };
}
function event(props = {}) {
  return { metaKey: false, ctrlKey: false, button: 0, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
}
let checks = 0;
function check(name, fn) { checks++; try { fn(); console.log('PASS ' + name); } catch(error) { console.error('FAIL ' + name + ': ' + error.message); process.exitCode=1; } }
check('plain double-link click uses the current tab', () => {
  const f = fixture(), e = event();
  f.link.onclick(e);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.newTab, false);
  assert.ok(e.prevented && e.stopped);
});
for (const key of ['metaKey', 'ctrlKey']) {
  check(key + ' double-link click opens a new tab', () => {
    const f = fixture(), e = event({ [key]: true });
    f.link.onclick(e);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].target, f.page);
    assert.equal(f.calls[0].opts.newTab, true);
  });
}
check('middle-click double link opens a new tab', () => {
  const f = fixture(), e = event({ button: 1 });
  f.link.onauxclick(e);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.newTab, true);
  assert.ok(e.prevented && e.stopped);
});
check('Wiki double link is focusable and Enter follows it', () => {
  const f = fixture(), e = event({ key: 'Enter' });
  assert.equal(f.link.tabIndex, 0);
  assert.equal(f.link.getAttribute('role'), 'link');
  assert.equal(typeof f.link.onkeydown, 'function');
  f.link.onkeydown(e);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.newTab, false);
  assert.ok(e.prevented && e.stopped);
});
check('Ctrl+Enter on a Wiki double link opens a new tab', () => {
  const f = fixture(), e = event({ key: 'Enter', ctrlKey: true });
  f.link.onkeydown(e);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.newTab, true);
});
check('clicking a double link while editing does not navigate', () => {
  const f = fixture();
  f.doc.dataset.editing = '1';
  f.link.onclick(event({ metaKey: true }));
  assert.equal(f.calls.length, 0);
});
for (const [gesture, props] of [['onclick',{}],['onkeydown',{key:'Enter'}],['onauxclick',{button:1}]]) {
  check('a locked unsaved draft still follows Wiki links via ' + gesture, () => {
    const f=fixture(); f.doc.dataset.editing='1'; f.state.wikiReadOnly=true; const e=event(props); f.link[gesture](e);
    assert.equal(f.calls.length,1); assert.ok(e.prevented && e.stopped);
  });
}
assert.ok(checks >= 10, 'Empty behavior scan');
if (!process.exitCode) console.log('ALL-GREEN');
