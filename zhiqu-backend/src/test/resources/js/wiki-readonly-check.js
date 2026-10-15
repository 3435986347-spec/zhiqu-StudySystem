// Execute the published Wiki module: reading must never silently switch into editing.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8').replace(/^export /gm, '');
const html = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : '';
function fixture() {
  const events = {}, commands = [], writes = [], uploads = [], drafts = new Map(), paints = [];
  const page = { id: 7, title: 'Example', content: 'original', version: 3, _full: true };
  const state = { wikiCur: page, wikiDirty: false, wikiPages: [page] };
  const controls = Array.from({ length: 3 }, () => ({ disabled: false }));
  const checkbox = { type: 'checkbox', checked: false, defaultChecked: false, disabled: false, nextElementSibling: { style: {} } };
  const embeddedCheckbox = { type: 'checkbox', disabled: false, closest() { return {}; } };
  const mode = { textContent: '', disabled: false, setAttribute(name, value) { this[name] = value; } };
  const status = { textContent: '' };
  const title = { textContent: 'Example', style: {}, title: '' };
  const section = {};
  const doc = { dataset: { editing: '0', source: '0' }, style: {}, contentEditable: 'false', scrollTop: 90,
    addEventListener(type, fn) { (events[type] ||= []).push(fn); }, closest() { return section; },
    dispatchEvent(event) { for (const listener of events[event.type] || []) listener(event); },
    focus() {}, contains() { return false; }, setAttribute(name, value) { this[name] = value; } };
  const elements = { '#zq-doc': doc, '#zq-doc-title': title, '#zq-wiki-mode': mode, '#zq-wiki-mode-label': status, '#zq-src-ta': { value: '', focus() {} } };
  let markdown = 'original', pending = null, askCount = 0, uploadCalls = 0, askReply = 'Changed', confirmReply = true;
  const document = { execCommand(...args) { commands.push(args); return true; }, getElementById() { return null; } };
  const window = { addEventListener() {}, scrollX: 0, scrollY: 0, getSelection() { return { rangeCount: 0, toString() { return ''; } }; } };
  const api = { get() { return new Promise(()=>{}); }, put(_path, body) { writes.push(body); return (typeof pending === 'function' ? pending() : pending) || Promise.resolve({ content: body.content, version: 4 }); }, upload() { uploadCalls++; return Promise.resolve({ url: '/api/knowledge/images/1' }); } };
  const sh = { state, api, token: () => 'token', esc: String, $: selector => elements[selector] || null,
    $all: (selector, target) => selector === 'input[type="checkbox"]' && target === doc ? [checkbox,embeddedCheckbox]
      : selector === '[data-wiki-cmd], #zq-wiki-block' ? controls : [],
    safe: (_name, fn) => Promise.resolve().then(fn).catch(() => null), toast() {}, empty: String,
    askText: async () => { askCount++; return askReply; }, askConfirm: async () => confirmReply,
    htmlToMarkdown: () => markdown,
    drafts: { load: k => drafts.get(k), save(k, text, extra) { drafts.set(k, { text, ...extra }); }, clear: k => drafts.delete(k), clearIf(k, text) { if (drafts.get(k)?.text === text) drafts.delete(k); } } };
  const impl = new Function('document', 'window', `
    ${source}
    // Rendering substitutes keep this fixture focused on the published mode and event handlers.
    var originalPaintWikiDoc = paintWikiDoc;
    trackWikiNavigation = function () {};
    showWikiActionBar = function () { if (typeof syncWikiEditMode === 'function') syncWikiEditMode($('#zq-doc')); };
    paintWikiDoc = async function (page, opts) { state.wikiCur=page; var doc=$('#zq-doc'); doc.dataset.editing='0'; doc.dataset.source='0'; doc.contentEditable='false'; state.wikiDirty=false; if(typeof syncWikiEditMode==='function')syncWikiEditMode(doc); __paints.push({page,opts}); };
    var __paints=[];
    return { bind, wireWikiEditor, enterWikiEdit, wikiToolbar, toggleWikiSource, insertWikiImage, saveWikiEdit, cancelWikiEdit, originalPaintWikiDoc,
      sync: typeof syncWikiEditMode === 'function' ? syncWikiEditMode : null, paints: __paints };`)(document, window);
  impl.bind(sh); impl.wireWikiEditor();
  if (impl.sync) impl.sync(doc);
  function dispatch(type, props = {}) { const e = { target: { closest() { return null; } }, prevented: false, preventDefault() { this.prevented = true; }, ...props }; if (type === 'click' && doc.onclick) doc.onclick(e); for (const fn of events[type] || []) fn(e); return e; }
  return { impl, state, page, doc, title, mode, status, controls, checkbox, embeddedCheckbox, writes, commands, drafts, dispatch,
    askCount: () => askCount, uploadCalls: () => uploadCalls,
    setMarkdown(value) { markdown=value; state.wikiDirty=true; }, setPending(value) { pending=value; },
    setAskReply(value) { askReply=value; }, setConfirmReply(value) { confirmReply=value; } };
}
(async () => {
  let passed = 0, failed = 0;
  async function check(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); } }
  await check('the document starts with a visible reading indicator and explicit edit button', () => {
    const f=fixture(); assert.equal(typeof f.impl.sync, 'function'); assert.equal(f.mode.textContent, '编辑'); assert.equal(f.status.textContent, '只读');
    assert.ok(html.includes('id="zq-wiki-mode"')); assert.ok(html.includes('id="zq-wiki-mode-label"'));
  });
  await check('clicking reading text only selects text', () => { const f=fixture(); f.dispatch('click'); assert.equal(f.doc.dataset.editing, '0'); assert.equal(f.doc.contentEditable, 'false'); });
  await check('reading disables formatting and task changes', () => { const f=fixture(); assert.ok(f.controls.every(control=>control.disabled)); assert.ok(f.checkbox.disabled); });
  await check('title cannot rename from reading mode', async () => { const f=fixture(); await f.title.onclick(); assert.equal(f.askCount(),0); assert.equal(f.writes.length,0); });
  await check('format and source commands cannot enter editing from reading mode', () => { const f=fixture(); f.impl.wikiToolbar('bold'); f.impl.toggleWikiSource(); assert.equal(f.doc.dataset.editing,'0'); assert.equal(f.doc.dataset.source,'0'); assert.equal(f.commands.length,0); });
  await check('pasting or dropping an image in reading mode never uploads', async () => {
    const f=fixture(), file={name:'chart.png',type:'image/png'};
    f.dispatch('paste',{clipboardData:{files:[file]}}); const drop=f.dispatch('drop',{dataTransfer:{files:[file]}}); assert.ok(drop.prevented,'a file drop must not navigate away');
    await Promise.resolve(); await Promise.resolve(); assert.equal(f.uploadCalls(),0); assert.equal(f.doc.dataset.editing,'0');
  });
  await check('explicit editing enables fields and formatting', () => { const f=fixture(); assert.equal(typeof f.mode.onclick,'function'); f.mode.onclick(); assert.equal(f.doc.dataset.editing,'1'); assert.equal(f.doc.contentEditable,'true'); assert.ok(f.controls.every(control=>!control.disabled)); assert.equal(f.checkbox.disabled,false); f.impl.wikiToolbar('bold'); assert.equal(f.commands[0][0],'bold'); });
  await check('the read-only switch saves successfully before leaving editing', async () => { const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('new text'); assert.equal(typeof f.mode.onclick,'function'); await f.mode.onclick(); assert.equal(f.writes.length,1); assert.equal(f.writes[0].content,'new text'); assert.equal(f.doc.dataset.editing,'0'); assert.equal(f.mode.textContent,'编辑'); });
  await check('failed save leaves the editable draft in place', async () => { const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('unsaved'); f.setPending(()=>Promise.reject(Error('offline'))); assert.equal(typeof f.mode.onclick,'function'); await f.mode.onclick(); assert.equal(f.doc.dataset.editing,'1'); assert.equal(f.doc.contentEditable,'true'); assert.equal(f.state.wikiDirty,true); });
  await check('typing while a save is pending does not discard the newer draft or force reading', async () => { const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('sent'); let resolve; f.setPending(new Promise(r=>resolve=r)); assert.equal(typeof f.mode.onclick,'function'); const saving=f.mode.onclick(); await Promise.resolve(); f.setMarkdown('newer'); resolve({content:'sent',version:4}); await saving; assert.equal(f.doc.dataset.editing,'1'); assert.equal(f.state.wikiDirty,true); assert.equal(f.drafts.get('wiki.7').text,'newer'); });
  await check('editing parent notes never enables embedded-note task controls', () => { const f=fixture(); f.impl.enterWikiEdit(); assert.equal(f.checkbox.disabled,false); assert.equal(f.embeddedCheckbox.disabled,true); });
  await check('a task change dispatched in reading mode cannot mutate the task', () => { const f=fixture(); f.checkbox.checked=true; f.dispatch('change',{target:f.checkbox}); assert.equal(f.checkbox.checked,false); assert.equal(f.doc.dataset.editing,'0'); });
  await check('a late insert-link response cannot modify the document after returning to reading', async () => { const f=fixture(); f.impl.enterWikiEdit(); let resolve; f.setAskReply(new Promise(r=>resolve=r)); f.impl.wikiToolbar('link'); f.impl.cancelWikiEdit(); resolve('https://example.test/'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(f.commands.length,0); assert.equal(f.doc.dataset.editing,'0'); });
  await check('a late rename response cannot enter a new edit session of the same page', async () => { const f=fixture(); f.impl.enterWikiEdit(); let resolve; f.setAskReply(new Promise(r=>resolve=r)); const rename=f.title.onclick(); f.impl.cancelWikiEdit(); f.impl.enterWikiEdit(); resolve('Late title'); await rename; assert.equal(f.writes.length,0); assert.equal(f.title.textContent,'Example'); });
  await check('a conflict confirmation cannot save after the user leaves its editing session', async () => { const f=fixture(); f.impl.enterWikiEdit(); f.page._draftBase=2; let resolve; f.setConfirmReply(new Promise(r=>resolve=r)); const saving=f.mode.onclick(); f.impl.cancelWikiEdit(); resolve(true); await saving; assert.equal(f.writes.length,0); assert.equal(f.doc.dataset.editing,'0'); });
  await check('loading another page immediately closes the previous edit session', () => {
    const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('draft of A');
    f.impl.originalPaintWikiDoc({id:9,title:'Still loading'});
    assert.equal(f.doc.dataset.editing,'0'); assert.equal(f.doc.contentEditable,'false'); assert.equal(f.mode.disabled,true);
    assert.equal(f.drafts.get('wiki.7').text,'draft of A'); f.mode.onclick(); assert.equal(f.doc.dataset.editing,'0');
    f.dispatch('input'); assert.equal(f.state.wikiDirty,false); assert.equal(f.drafts.has('wiki.9'),false);
  });
  assert.ok(passed+failed>=16,'Empty behavior scan');
  if (failed) process.exitCode=1; else console.log('ALL-GREEN');
})().catch(error=>{ console.error(error.stack); process.exitCode=1; });
