// 知识 Wiki 的自动保存（第八十三轮）：跑发布的 knowledge-wiki.js，编辑器换成替身，等待时间调短（停下 40ms 存、一直打最多 120ms 存、失败 80ms 后重试）。
//   用法：node src/test/resources/js/wiki-autosave-check.js <knowledge-wiki.js 的路径>；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8').replace(/^export /gm, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const page = { id: 7, title: '周报', content: '原文', version: 3, _full: true, pageType: 'NOTE' };
  const other = { id: 9, title: '别的', content: '别的正文', version: 1, _full: true };
  const state = { wikiCur: page, wikiDirty: false, wikiPages: [page, other] };
  const events = {}, writes = [], toasts = [], mounts = [], gets = [];
  const doc = { dataset: { editing: '0', source: '0' }, style: {}, contentEditable: 'false', scrollTop: 0, firstChild: null,
    set innerHTML(v) { this._html = v; this.firstChild = { host: true }; }, get innerHTML() { return this._html; },
    addEventListener(t, f) { (events[t] ||= []).push(f); }, closest() { return {}; }, dispatchEvent(e) { (events[e.type] || []).forEach((f) => f(e)); },
    focus() {}, contains() { return false; }, setAttribute(k, v) { this[k] = v; }, getBoundingClientRect: () => ({ top: 100 }) };
  const status = { dataset: {}, set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; }, textContent: '' };
  const title = { textContent: '周报', style: {}, title: '' };
  const elements = { '#zq-doc': doc, '#zq-doc-title': title, '#zq-wiki-mode': { setAttribute() {} }, '#zq-wiki-mode-label': {}, '#zq-wiki-save-state': status, '#zq-wiki-block': { value: 'P' } };
  const handle = { text: page.content, calls: [], getMarkdown() { return this.text; }, setReadOnly() {}, setMarkdown(t) { this.text = t; }, destroy() { this.calls.push('destroy'); },
    focusAt() {}, focusPos() {}, alignPos() {}, lineAt: () => ({ pos: 0, top: 100 }), charTop: () => 100 };
  const cmModule = { mountWikiEditor(host, options) { mounts.push(options); handle.text = options.markdown; return handle; },
    readingAnchor: () => null, readingCharTop: () => null, sourcePosition: () => null, sourceAnchorAt: () => null, readingAnchorTop: () => null };
  const replies = [];   // 每次 PUT 用掉一个：函数（拿到 body 返回 Promise）；用完了就照常成功、版本 +1
  let askReply = null;
  const sh = { state, token: () => 'token', esc: String, $: (s) => elements[s] || null, $all: () => [], empty: String, fmtDate: String,
    toast: (m) => toasts.push(m), safe: (_n, fn) => Promise.resolve().then(fn).catch(() => null), askConfirm: async () => true, askText: async () => askReply,
    htmlToMarkdown: () => { throw new Error('不该走 htmlToMarkdown'); }, renderMarkdown: (t) => t, renderMathIn() {},
    drafts: { store: new Map(), load(k) { return this.store.get(k); }, save(k, text, extra) { this.store.set(k, { text, ...extra }); }, clear(k) { this.store.delete(k); }, clearIf(k, t) { if (this.store.get(k)?.text === t) this.store.delete(k); } },
    loadModule: () => Promise.resolve(cmModule),
    api: { get(p) { gets.push(p); return Promise.resolve({ content: '别处改过的', version: 8 }); },
      put(_p, body) { writes.push(body); const r = replies.shift(); return r ? r(body) : Promise.resolve({ content: body.content, title: body.title, version: body.version + 1 }); } },
    codeTokens: () => [] };
  const impl = new Function('document', 'window', 'localStorage', 'getComputedStyle', `
    ${source}
    WIKI_SAVE_IDLE_MS = 40; WIKI_SAVE_MAX_MS = 120; WIKI_SAVE_RETRY_MS = 80;
    trackWikiNavigation = removeWikiDraftBar = markDuplicateTitle = markEmptyWikiPage = wireWikiLinks = paintWikiTabs = paintWikiTree = offerWikiDraft = restoreWikiView = function () {};
    return { bind, enterWikiEdit, paintWikiDoc, loadWikiCm, wireWikiEditor, flushWikiSave, resolveWikiConflictMine };`)(
    { getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild() {} }, addEventListener() {}, hidden: false },
    { addEventListener() {}, getSelection: () => ({ rangeCount: 0 }) }, { getItem: () => null, setItem() {}, removeItem() {} }, () => ({ paddingLeft: '26px' }));
  impl.bind(sh);
  impl.wireWikiEditor();
  const type = (text) => { handle.text = text; doc.dispatchEvent({ type: 'input' }); };
  return { impl, page, other, state, doc, handle, writes, replies, toasts, mounts, gets, status, title, sh, type, setAsk(v) { askReply = v; } };
}
async function editing() { const f = fixture(); await f.impl.loadWikiCm(); f.impl.enterWikiEdit(); return f; }

(async () => {
  let failed = 0, passed = 0;
  const check = async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } };

  await check('打字停下一会儿就存（不用点保存）；没停之前不发；存的时候不拆编辑器、不重画', async () => {
    const f = await editing();
    f.type('原文，加一句');
    assert.equal(f.writes.length, 0, '一打字就发了，不等停下');
    await wait(80);
    assert.equal(f.writes.length, 1, '停下了没存');
    assert.equal(f.writes[0].content, '原文，加一句');
    assert.equal(f.writes[0].version, 3);
    await wait(5);
    assert.equal(f.page.version, 4);
    assert.equal(f.state.wikiDirty, false);
    assert.equal(f.handle.calls.includes('destroy'), false, '存的时候把编辑器拆了');
    assert.equal(f.mounts.length, 1);
    assert.equal(f.status.dataset.state, 'saved');
  });
  await check('一直在打（每 20ms 一个字，打 300ms）：最多 120ms 存一次，不等打完', async () => {
    const f = await editing();
    for (let i = 1; i <= 15; i++) { f.type('原文' + '字'.repeat(i)); await wait(20); }
    assert.ok(f.writes.length >= 2, '一直在打就一直不存：' + f.writes.length + ' 次');
    await wait(80);
    assert.equal(f.writes.at(-1).content, '原文' + '字'.repeat(15), '最后那一份没存');
    for (let i = 1; i < f.writes.length; i++) assert.equal(f.writes[i].version, f.writes[i - 1].version + 1, '后一次没用前一次回来的版本号');
  });
  await check('别处改过（412）：停下自动保存、照实说，后面再打字也不发；「用我的覆盖」问过以后取现在的版本号再存', async () => {
    const f = await editing();
    f.replies.push(() => Promise.reject(Object.assign(new Error('知识页已被其他窗口修改，请刷新后重试'), { userFacing: true, code: 412 })));
    f.type('我的版本'); await wait(80);
    assert.equal(f.writes.length, 1);
    assert.equal(f.page._saveConflict, true);
    assert.equal(f.status.dataset.state, 'conflict');
    assert.match(f.status.innerHTML, /别处被改过/);
    f.type('我的版本，又改了'); await wait(80);
    assert.equal(f.writes.length, 1, '版本对不上还在往上存（会被挡，或者盖掉别人的）');
    f.doc.dispatchEvent({ type: 'focusout', relatedTarget: null });   // 直接存的那条路（失焦、换页）：同样不能发
    assert.equal(f.writes.length, 1, '冲突以后焦点离开正文又存了');
    await f.impl.resolveWikiConflictMine(f.page); await wait(10);
    assert.deepEqual(f.gets, ['/knowledge/pages/7'], '覆盖之前要取现在的版本号');
    assert.equal(f.writes.length, 2);
    assert.equal(f.writes[1].version, 8, '覆盖要用现在的版本号');
    assert.equal(f.writes[1].content, '我的版本，又改了');
    assert.equal(f.page._saveConflict, false);
  });
  await check('断网（retryable）：说没存上、过一会儿自己再试，连上了就存上；业务上拒了的不自己重发', async () => {
    const f = await editing();
    f.replies.push(() => Promise.reject(Object.assign(new Error('网络连接失败，请检查网络后重试'), { userFacing: true, retryable: true, network: true })));
    f.type('断网时打的'); await wait(60);
    assert.equal(f.writes.length, 1);
    assert.equal(f.status.dataset.state, 'error');
    assert.match(f.status.innerHTML, /网络连接失败/);
    await wait(120);
    assert.equal(f.writes.length, 2, '断网没存上，过了一会儿没自己再试');
    assert.equal(f.writes[1].content, '断网时打的');
    assert.equal(f.page._saveError, null);
    const g = await editing();
    g.replies.push(() => Promise.reject(Object.assign(new Error('标题太长'), { userFacing: true, code: 500 })));
    g.type('被拒的'); await wait(60); await wait(150);
    assert.equal(g.writes.length, 1, '业务上拒了的又自己重发（原样再发还是拒）');
    assert.equal(g.status.dataset.state, 'error');
  });
  await check('回应丢了（uncertain，可能已经存上）：下一次先原样重发那一份（同一个幂等键，存上了就拿回上次的结果、版本号对得上），再存新的', async () => {
    const f = await editing();
    f.replies.push(() => Promise.reject(Object.assign(new Error('不确定有没有保存上'), { userFacing: true, uncertain: true })));
    f.type('第一份'); await wait(60);
    f.type('第二份'); await wait(150);
    assert.deepEqual(f.writes.map((w) => [w.content, w.version]), [['第一份', 3], ['第一份', 3], ['第二份', 4]]);
  });
  await check('改名和自动保存排一队：保存在路上时改名不另发，回来以后带着新标题和新版本号存', async () => {
    const f = await editing();
    let release; f.replies.push((body) => new Promise((r) => { release = () => r({ content: body.content, title: body.title, version: 4 }); }));
    f.type('正文改了'); await wait(60);
    assert.equal(f.writes.length, 1);
    f.setAsk('周报（新）');
    f.title.onclick(); await wait(10);
    assert.equal(f.writes.length, 1, '保存还在路上，改名又发了一个（两个撞版本号，后到的被当成「别处改过」）');
    release(); await wait(20);
    assert.equal(f.writes.length, 2);
    assert.equal(f.writes[1].title, '周报（新）');
    assert.equal(f.writes[1].version, 4);
    assert.equal(f.page.title, '周报（新）');
    assert.ok(f.toasts.includes('名称已更新'));
  });
  await check('换页：旧页马上存（不等那一秒），新页直接挂上编辑器', async () => {
    const f = await editing();
    f.type('走之前打的');
    await f.impl.paintWikiDoc(f.other);
    assert.equal(f.writes.length, 1, '换页时没马上存旧页');
    assert.equal(f.writes[0].content, '走之前打的');
    assert.equal(f.state.wikiCur, f.other);
    assert.equal(f.mounts.length, 2);
    await wait(80);
    assert.equal(f.writes.length, 1, '换页之后又按旧页的计时存了一次');
  });
  await check('焦点离开正文：马上存', async () => {
    const f = await editing();
    f.type('点了别处');
    f.doc.dispatchEvent({ type: 'focusout', relatedTarget: null });
    assert.equal(f.writes.length, 1);
  });
  await check('没改过就不发；删空了不发（后端不收空正文），说一句', async () => {
    const f = await editing();
    await f.impl.flushWikiSave();
    assert.equal(f.writes.length, 0);
    f.type('   '); await wait(80);
    assert.equal(f.writes.length, 0);
    assert.equal(f.status.dataset.state, 'empty');
  });

  console.log(failed === 0 && passed >= 9 ? 'ALL-GREEN（' + passed + ' 条）' : 'RED: ' + failed + ' 条（过了 ' + passed + ' 条）');
  process.exit(failed === 0 && passed >= 9 ? 0 : 1);
})().catch((e) => { console.error('加载失败：' + e.stack); process.exit(1); });
