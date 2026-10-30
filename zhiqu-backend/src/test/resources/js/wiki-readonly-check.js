// Execute the published Wiki module: editing stays direct, and read-only is an opt-in lock.
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
  const textarea = { value: '', readOnly: false, focus() {} };
  const elements = { '#zq-doc': doc, '#zq-doc-title': title, '#zq-wiki-mode': mode, '#zq-wiki-mode-label': status, '#zq-src-ta': textarea };
  let markdown = 'original', pending = null, askCount = 0, uploadCalls = 0, askReply = 'Changed', confirmReply = true;
  const document = { execCommand(...args) { commands.push(args); return true; }, getElementById() { return null; }, addEventListener() {} };
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
    wikiCmFailed = true;   // 第八十轮起新编辑器是默认；这里测的是它加载不上时退回的简易编辑（contentEditable）
    // Rendering substitutes keep this fixture focused on the published mode and event handlers.
    var originalPaintWikiDoc = paintWikiDoc;
    trackWikiNavigation = function () {};
    showWikiActionBar = function () { if (typeof syncWikiEditMode === 'function') syncWikiEditMode($('#zq-doc')); };
    paintWikiDoc = async function (page, opts) { state.wikiCur=page; var doc=$('#zq-doc'); doc.dataset.editing='0'; doc.dataset.source='0'; doc.contentEditable='false'; state.wikiDirty=false; if(typeof syncWikiEditMode==='function')syncWikiEditMode(doc); __paints.push({page,opts}); };
    var __paints=[];
    return { bind, wireWikiEditor, enterWikiEdit, wikiToolbar, toggleWikiSource, insertWikiImage, flushWikiSave, resolveWikiConflictMine, originalPaintWikiDoc,
      sync: typeof syncWikiEditMode === 'function' ? syncWikiEditMode : null, paints: __paints };`)(document, window);
  impl.bind(sh); impl.wireWikiEditor();
  if (impl.sync) impl.sync(doc);
  function dispatch(type, props = {}) { const e = { target: { closest() { return null; } }, prevented: false, preventDefault() { this.prevented = true; }, ...props }; if (type === 'click' && doc.onclick) doc.onclick(e); for (const fn of events[type] || []) fn(e); return e; }
  return { impl, state, page, doc, title, mode, status, controls, checkbox, embeddedCheckbox, textarea, writes, commands, drafts, dispatch,
    askCount: () => askCount, uploadCalls: () => uploadCalls,
    setMarkdown(value) { markdown=value; state.wikiDirty=true; }, setPending(value) { pending=value; },
    setAskReply(value) { askReply=value; }, setConfirmReply(value) { confirmReply=value; } };
}
(async () => {
  let passed = 0, failed = 0;
  async function check(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); } }
  await check('the read-only switch starts off while direct formatting stays available', () => {
    const f=fixture(); assert.equal(typeof f.impl.sync, 'function'); assert.equal(f.mode.textContent, '只读'); assert.equal(f.mode['aria-checked'],'false');
    assert.ok(f.controls.every(control=>!control.disabled)); assert.equal(f.checkbox.disabled,false);
    assert.ok(html.includes('id="zq-wiki-mode"')); assert.match(html,/id="zq-wiki-mode"[^>]*role="switch"/);
  });
  await check('clicking ordinary document text directly enters editing', () => { const f=fixture(); f.dispatch('click'); assert.equal(f.doc.dataset.editing,'1'); assert.equal(f.doc.contentEditable,'true'); });
  await check('clicking embedded content or links does not enter editing', () => { const f=fixture(); f.dispatch('click',{target:{closest(){return {};}}}); assert.equal(f.doc.dataset.editing,'0'); });
  await check('formatting directly enters editing without a separate edit action', () => { const f=fixture(); f.impl.wikiToolbar('bold'); assert.equal(f.doc.dataset.editing,'1'); assert.equal(f.commands[0][0],'bold'); });
  await check('title can rename directly while the read-only switch is off', async () => { const f=fixture(); await f.title.onclick(); await Promise.resolve(); await Promise.resolve(); assert.equal(f.askCount(),1); assert.equal(f.writes[0].title,'Changed'); });
  await check('a task can change directly and leaves a saveable draft', () => { const f=fixture(); f.checkbox.checked=true; f.dispatch('change',{target:f.checkbox}); assert.equal(f.doc.dataset.editing,'1'); assert.equal(f.checkbox.checked,true); assert.equal(f.state.wikiDirty,true); });
  await check('switching on read-only prevents all editing entry points', async () => {
    const f=fixture(); f.mode.onclick(); f.dispatch('click'); f.impl.enterWikiEdit(); f.impl.wikiToolbar('bold'); f.impl.toggleWikiSource(); await f.title.onclick();
    assert.equal(f.doc.dataset.editing,'0'); assert.equal(f.doc.contentEditable,'false'); assert.equal(f.mode['aria-checked'],'true'); assert.equal(f.askCount(),0); assert.equal(f.commands.length,0);
    assert.ok(f.controls.every(control=>control.disabled)); assert.ok(f.checkbox.disabled);
  });
  await check('read-only image paste or drop never uploads', async () => {
    const f=fixture(), file={name:'chart.png',type:'image/png'}; f.mode.onclick();
    f.dispatch('paste',{clipboardData:{files:[file]}}); const drop=f.dispatch('drop',{dataTransfer:{files:[file]}}); assert.ok(drop.prevented,'a file drop must not navigate away');
    await Promise.resolve(); await Promise.resolve(); assert.equal(f.uploadCalls(),0); assert.equal(f.doc.dataset.editing,'0');
  });
  // 第八十三轮：自动保存 —— 开只读时马上把没存的字存上（像 Obsidian 切到阅读视图）；原来是「只存本地、不提交」，要点保存
  await check('locking a modified draft preserves visible text, keeps a local draft and saves it right away', () => {
    const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('unsaved draft'); f.doc.innerHTML='visible unsaved draft'; f.mode.onclick();
    assert.equal(f.doc.contentEditable,'false'); assert.equal(f.doc.innerHTML,'visible unsaved draft'); assert.equal(f.doc.dataset.editing,'1'); assert.ok(f.drafts.has('wiki.7'),'locking must persist the local draft'); assert.equal(f.drafts.get('wiki.7').text,'unsaved draft');
    assert.equal(f.writes.length,1,'locking must save the unsaved text'); assert.equal(f.writes[0].content,'unsaved draft');
    f.mode.onclick(); assert.equal(f.doc.contentEditable,'true'); assert.equal(f.doc.innerHTML,'visible unsaved draft'); assert.equal(f.writes.length,1);
  });
  await check('locking source freezes the same textarea and unlocking keeps its text and selection', () => {
    const f=fixture(); f.impl.enterWikiEdit(); f.doc.dataset.source='1'; f.textarea.value='source draft'; f.textarea.selectionStart=5; f.textarea.selectionEnd=9;
    f.mode.onclick(); assert.equal(f.textarea.readOnly,true); assert.ok(f.drafts.has('wiki.7'),'locking source must persist the local draft'); assert.equal(f.drafts.get('wiki.7').text,'source draft');
    f.mode.onclick(); assert.equal(f.textarea.readOnly,false); assert.equal(f.textarea.value,'source draft'); assert.equal(f.textarea.selectionStart,5); assert.equal(f.textarea.selectionEnd,9);
  });
  await check('saving while locked keeps the lock and does not redraw', async () => {
    const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('new text'); f.mode.onclick(); await f.impl.flushWikiSave(); await Promise.resolve();
    assert.equal(f.writes.length,1); assert.equal(f.writes[0].content,'new text'); assert.equal(f.mode['aria-checked'],'true'); assert.equal(f.impl.paints.length,0);
  });
  await check('a failed save leaves the editable text in place and keeps it unsaved', async () => { const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('unsaved'); f.setPending(()=>Promise.reject(Object.assign(Error('offline'),{userFacing:true}))); await f.impl.flushWikiSave().catch(()=>{}); assert.equal(f.doc.dataset.editing,'1'); assert.equal(f.doc.contentEditable,'true'); assert.equal(f.state.wikiDirty,true); assert.equal(f.page._saveError,'offline'); assert.equal(f.drafts.get('wiki.7').text,'unsaved'); });
  await check('typing while a save is pending does not discard newer text', async () => { const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('sent'); let resolve; f.setPending(new Promise(r=>resolve=r)); const saving=f.impl.flushWikiSave(); await Promise.resolve(); f.setMarkdown('newer'); resolve({content:'sent',version:4}); await saving; assert.equal(f.doc.dataset.editing,'1'); assert.equal(f.state.wikiDirty,true); assert.equal(f.drafts.get('wiki.7').text,'newer'); assert.equal(f.drafts.get('wiki.7').base,4); });
  await check('editing parent notes never enables embedded-note task controls', () => { const f=fixture(); f.impl.enterWikiEdit(); assert.equal(f.checkbox.disabled,false); assert.equal(f.embeddedCheckbox.disabled,true); });
  await check('a task change dispatched while locked preserves its current unsaved value', () => { const f=fixture(); f.impl.enterWikiEdit(); f.checkbox.checked=true; f.mode.onclick(); f.checkbox.checked=false; f.dispatch('change',{target:f.checkbox}); assert.equal(f.checkbox.checked,true); });
  await check('late insert-link response cannot mutate the document after lock then unlock', async () => { const f=fixture(); f.impl.enterWikiEdit(); let resolve; f.setAskReply(new Promise(r=>resolve=r)); f.impl.wikiToolbar('link'); f.mode.onclick(); f.mode.onclick(); resolve('https://example.test/'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(f.commands.length,0); });
  await check('late rename response cannot mutate after lock then unlock', async () => { const f=fixture(); f.impl.enterWikiEdit(); let resolve; f.setAskReply(new Promise(r=>resolve=r)); const rename=f.title.onclick(); f.mode.onclick(); f.mode.onclick(); resolve('Late title'); await rename; assert.equal(f.writes.length,0); assert.equal(f.title.textContent,'Example'); });
  // 第八十三轮：版本对不上（412）停下自动保存、不重发；「用我的覆盖」问过之后用户已经去了别的页，就不存
  await check('a version conflict stops autosave and an overwrite confirmed after leaving the page saves nothing', async () => {
    const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('mine'); f.setPending(()=>Promise.reject(Object.assign(Error('知识页已被其他窗口修改，请刷新后重试'),{userFacing:true,code:412})));
    await f.impl.flushWikiSave(); assert.equal(f.page._saveConflict,true); assert.equal(f.writes.length,1);
    f.setPending(null); f.setMarkdown('mine, more'); await f.impl.flushWikiSave(); assert.equal(f.writes.length,1,'kept saving over a newer version');
    let resolve; f.setConfirmReply(new Promise(r=>resolve=r)); const overwrite=f.impl.resolveWikiConflictMine(f.page); f.state.wikiCur={id:9}; resolve(true); await overwrite; await Promise.resolve();
    assert.equal(f.writes.length,1,'overwrote after the user had left the page');
  });
  await check('loading another page closes the old edit session and blocks direct edit entry', () => {
    const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('draft of A'); f.impl.originalPaintWikiDoc({id:9,title:'Still loading'});
    assert.equal(f.doc.dataset.editing,'0'); assert.equal(f.doc.contentEditable,'false'); assert.equal(f.mode.disabled,true); assert.equal(f.drafts.get('wiki.7').text,'draft of A');
    f.dispatch('click'); f.impl.wikiToolbar('bold'); assert.equal(f.doc.dataset.editing,'0'); assert.equal(f.commands.length,0);
    f.dispatch('input'); assert.equal(f.state.wikiDirty,false); assert.equal(f.drafts.has('wiki.9'),false);
  });
  await check('saving then locking clears the unchanged draft without redrawing or unlocking', async () => {
    const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('sent'); let resolve; f.setPending(new Promise(r=>resolve=r)); const saving=f.impl.flushWikiSave(); await Promise.resolve();
    f.mode.onclick(); f.doc.innerHTML='same frozen DOM'; resolve({content:'sent',version:4}); await saving;
    assert.equal(f.state.wikiDirty,false); assert.equal(f.drafts.has('wiki.7'),false); assert.equal(f.mode['aria-checked'],'true'); assert.equal(f.doc.innerHTML,'same frozen DOM'); assert.equal(f.impl.paints.length,0);
  });
  await check('saving then locking and changing text preserves a rebased newer draft', async () => {
    const f=fixture(); f.impl.enterWikiEdit(); f.setMarkdown('sent'); let resolve; f.setPending(new Promise(r=>resolve=r)); const saving=f.impl.flushWikiSave(); await Promise.resolve();
    f.mode.onclick(); f.mode.onclick(); f.setMarkdown('newer after unlocking'); resolve({content:'sent',version:4}); await saving;
    assert.equal(f.state.wikiDirty,true); assert.ok(f.drafts.has('wiki.7')); assert.equal(f.drafts.get('wiki.7').text,'newer after unlocking'); assert.equal(f.drafts.get('wiki.7').base,4); assert.equal(f.impl.paints.length,0);
  });
  assert.ok(passed+failed>=21,'Empty behavior scan');
  if (failed) process.exitCode=1; else console.log('ALL-GREEN');
})().catch(error=>{ console.error(error.stack); process.exitCode=1; });
