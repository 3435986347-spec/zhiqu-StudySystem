// 知识 Wiki 编辑内核验证版（第七十轮）：跑发布的 knowledge-wiki.js 和 wiki-cm.js。
// 编辑器本身（CodeMirror）在 node 里没有 DOM，换成替身；接入的每一处和纯文本扫描都是真的。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(process.argv[2], 'utf8').replace(/^export /gm, '');
const cmPath = process.argv[3];

function fixture({ flag = 'cm' } = {}) {
  const store = new Map(flag ? [['zq.wikiEditor', flag]] : []);
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const page = { id: 7, title: '嵌套', content: '- 一\n  - 二\n\n```js\nx\n```', version: 3, _full: true };
  const state = { wikiCur: page, wikiDirty: false, wikiPages: [page] };
  const events = {}, writes = [], toasts = [], mounts = [];
  const doc = { dataset: { editing: '0', source: '0' }, style: {}, contentEditable: 'false', scrollTop: 0, firstChild: null,
    set innerHTML(v) { this._html = v; this.firstChild = { host: true }; }, get innerHTML() { return this._html; },
    addEventListener(t, f) { (events[t] ||= []).push(f); }, closest() { return {}; }, dispatchEvent(e) { (events[e.type] || []).forEach((f) => f(e)); },
    focus() {}, contains() { return false; }, setAttribute(k, v) { this[k] = v; } };
  const elements = { '#zq-doc': doc, '#zq-doc-title': { textContent: '', style: {} }, '#zq-wiki-mode': { setAttribute() {} }, '#zq-wiki-mode-label': {} };
  const handle = { calls: [], text: page.content,
    getMarkdown() { return this.text; }, setReadOnly(v) { this.calls.push(['readOnly', v]); }, wrap(m) { this.calls.push(['wrap', m]); },
    insert(t) { this.calls.push(['insert', t]); }, focusAt() {}, destroy() { this.calls.push(['destroy']); } };
  const cmModule = { mountWikiEditor(host, options) { mounts.push({ host, options }); return handle; } };
  const sh = { state, token: () => 'token', esc: String, $: (s) => elements[s] || null, $all: () => [], empty: String, fmtDate: String,
    toast: (m) => toasts.push(m), safe: (_n, fn) => Promise.resolve().then(fn), askConfirm: async () => true, askText: async () => null,
    htmlToMarkdown: () => { throw new Error('验证版编辑器不该走 htmlToMarkdown'); }, renderMarkdown: (t) => t, renderMathIn() {},
    drafts: { load() {}, save() {}, clear() {}, clearIf() {} }, loadModule: (rel) => { assert.equal(rel, 'wiki-cm.js'); return Promise.resolve(cmModule); },
    api: { get: () => new Promise(() => {}), put(_p, body) { writes.push(body); return Promise.resolve({ content: body.content, version: 4 }); } } };
  const impl = new Function('document', 'window', 'localStorage', `
    ${source}
    trackWikiNavigation = removeWikiDraftBar = removeWikiActionBar = showWikiActionBar = markDuplicateTitle = wireWikiLinks
      = paintWikiTabs = paintWikiTree = offerWikiDraft = restoreWikiView = function () {};
    return { bind, enterWikiEdit, saveWikiEdit, paintWikiDoc, wikiToolbar, toggleWikiSource, toggleWikiReadOnly, loadWikiCm, currentWikiMarkdown };`)(
    { getElementById: () => null, execCommand() { throw new Error('验证版编辑器不该用 execCommand'); } },
    { addEventListener() {}, getSelection: () => ({ rangeCount: 0 }) }, localStorage);
  impl.bind(sh);
  return { impl, page, doc, handle, mounts, writes, toasts, state, store };
}

(async () => {
  let failed = 0;
  const check = async (name, fn) => { try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } };
  const cm = await import(pathToFileURL(path.resolve(cmPath)).href);

  await check('扫描：[[双链]] / [[目标|显示]] / ![[嵌入]]，转义的不算', () => {
    const links = cm.wikiLinkRanges('见 [[官网改版]] 和 [[用户访谈|访谈]]，![[图]]，\\[[不是]]');
    assert.deepEqual(links.map((l) => [l.target, l.label, l.embed]), [['官网改版', '官网改版', false], ['用户访谈', '访谈', false], ['图', '图', true]]);
  });
  await check('扫描：行内公式 $…$；$$、转义的 \\$、贴着空格的都不算', () => {
    assert.deepEqual(cm.inlineMathRanges('行内 $E = mc^2$ 和 $$x$$ 以及 \\$5 和 $ 3 $').map((m) => m.tex), ['E = mc^2']);
    assert.deepEqual(cm.blockMathRanges('a\n$$\n\\int x\n$$\nb').map((m) => m.tex), ['\\int x']);
  });
  await check('加粗按钮：没包着就加 **，已经包着就去掉（选区跟着走）', () => {
    assert.deepEqual(cm.toggleWrap('a b c', 2, 3, '**'), { changes: [{ from: 2, insert: '**' }, { from: 3, insert: '**' }], anchor: 4, head: 5 });
    assert.deepEqual(cm.toggleWrap('a **b** c', 4, 5, '**'), { changes: [{ from: 2, to: 4, insert: '' }, { from: 5, to: 7, insert: '' }], anchor: 2, head: 3 });
  });
  await check('开关开着：点进编辑挂上编辑器，拿的是这一页的 Markdown 原文；正文本身不再 contentEditable', async () => {
    const f = fixture();
    await f.impl.loadWikiCm();
    f.impl.enterWikiEdit();
    assert.equal(f.mounts.length, 1);
    assert.equal(f.mounts[0].options.markdown, f.page.content);
    assert.equal(f.doc.dataset.editor, 'cm');
    assert.equal(f.doc.dataset.editing, '1');
    assert.equal(f.doc.contentEditable, 'false');
  });
  await check('保存发的就是编辑器里的原文（不经过 htmlToMarkdown，嵌套和代码块语言原样）', async () => {
    const f = fixture();
    await f.impl.loadWikiCm(); f.impl.enterWikiEdit();
    f.handle.text = f.page.content + '\n\n新加一行';
    assert.equal(f.impl.currentWikiMarkdown(), f.handle.text, '草稿也要存编辑器里的原文');
    await f.impl.saveWikiEdit();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].content, '- 一\n  - 二\n\n```js\nx\n```\n\n新加一行');
  });
  await check('换页 / 取消：编辑器先拆掉再画正文', async () => {
    const f = fixture();
    await f.impl.loadWikiCm(); f.impl.enterWikiEdit();
    await f.impl.paintWikiDoc(f.page);
    assert.deepEqual(f.handle.calls.at(-1), ['destroy']);
    assert.equal(f.doc.dataset.editor, undefined);
  });
  await check('只读开关传到编辑器；工具栏的加粗 / 斜体 / 代码变成 Markdown 标记；「源码」不切换', async () => {
    const f = fixture();
    await f.impl.loadWikiCm(); f.impl.enterWikiEdit();
    f.impl.wikiToolbar('bold'); f.impl.wikiToolbar('italic'); f.impl.wikiToolbar('code');
    f.impl.toggleWikiSource();
    f.impl.toggleWikiReadOnly();
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'wrap'), [['wrap', '**'], ['wrap', '*'], ['wrap', '`']]);
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'readOnly').at(-1), ['readOnly', true]);
    assert.ok(f.toasts.some((t) => /Markdown 原文/.test(t)), '「源码」应当说明验证版里就是原文');
  });
  await check('开关关着：一点不碰验证版（不加载、不挂载，照旧是 contentEditable）', async () => {
    const f = fixture({ flag: null });
    f.impl.enterWikiEdit();
    assert.equal(f.mounts.length, 0);
    assert.equal(f.doc.dataset.editor, undefined);
    assert.equal(f.doc.contentEditable, 'true');
  });
  console.log(failed ? 'RED: ' + failed : 'ALL-GREEN');
  if (failed) process.exitCode = 1;
})();
