// 知识 Wiki 编辑内核验证版（第七十轮）：跑发布的 knowledge-wiki.js 和 wiki-cm.js。
// 编辑器本身（CodeMirror）在 node 里没有 DOM，换成替身；接入的每一处和纯文本扫描都是真的。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(process.argv[2], 'utf8').replace(/^export /gm, '');
const cmPath = process.argv[3];
// 第七十三轮：阅读视图 → 原文位置的映射要拿真的 renderMarkdown 画出来的标记来量
const apiSource = fs.readFileSync(process.argv[4], 'utf8');
const apiSlice = (a, b) => { const i = apiSource.indexOf(a), j = apiSource.indexOf(b, i); if (i < 0 || j < 0) throw Error('抠不到 ' + a); return apiSource.slice(i, j); };
const { renderMarkdown } = new Function('state', apiSlice('  function esc(v) {', '  function maintainShellCache') + apiSlice('  function mathBlockHtml(', '  // KaTeX 懒加载')
  + '\nreturn {renderMarkdown};')({ wikiPages: [] });
function decode(v) { return v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
/** 只认这些标签的小解析器：节点有 nodeType / nodeValue / tagName / childNodes / parentNode / getAttribute，够 anchorFromCaret 走 */
function parseHtml(html) {
  const root = { nodeType: 1, tagName: 'DIV', childNodes: [], parentNode: null, getAttribute: () => null };
  const stack = [root];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*>|([^<]+)/g)) {
    const parent = stack[stack.length - 1];
    if (m[4] != null) { parent.childNodes.push({ nodeType: 3, nodeValue: decode(m[4]), parentNode: parent }); continue; }
    const tag = m[2].toUpperCase();
    if (m[1]) { while (stack.length > 1 && stack.pop().tagName !== tag) { /* 收到同名的开标签 */ } continue; }
    const attrs = Object.fromEntries([...m[3].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] == null ? '' : decode(a[2])]));
    const el = { nodeType: 1, tagName: tag, childNodes: [], parentNode: parent, getAttribute: (k) => (k in attrs ? attrs[k] : null) };
    parent.childNodes.push(el);
    if (!/^(BR|HR|INPUT|IMG)$/.test(tag)) stack.push(el);
  }
  return root;
}
/** 第 nth 个含 word 的文字节点，光标在 word 的第 k 个字前面 */
function caretIn(root, word, k = 0, nth = 0) {
  const found = [];
  (function walk(n) { if (n.nodeType === 3) { if (n.nodeValue.includes(word)) found.push(n); } else n.childNodes.forEach(walk); })(root);
  const node = found[nth]; if (!node) throw new Error('阅读视图里找不到「' + word + '」');
  return { node, offset: node.nodeValue.indexOf(word) + k };
}

function fixture({ failLoad = false } = {}) {
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const page = { id: 7, title: '嵌套', content: '- 一\n  - 二\n\n```js\nx\n```', version: 3, _full: true };
  const state = { wikiCur: page, wikiDirty: false, wikiPages: [page] };
  const events = {}, writes = [], toasts = [], mounts = [];
  const doc = { dataset: { editing: '0', source: '0' }, style: {}, contentEditable: 'false', scrollTop: 0, firstChild: null,
    set innerHTML(v) { this._html = v; this.firstChild = { host: true }; }, get innerHTML() { return this._html; },
    addEventListener(t, f) { (events[t] ||= []).push(f); }, closest() { return {}; }, dispatchEvent(e) { (events[e.type] || []).forEach((f) => f(e)); },
    focus() {}, contains() { return false; }, setAttribute(k, v) { this[k] = v; } };
  doc.getBoundingClientRect = () => ({ top: 100 });
  const blockSelect = { value: 'P' };
  const elements = { '#zq-wiki-block': blockSelect, '#zq-doc': doc, '#zq-doc-title': { textContent: '', style: {} }, '#zq-wiki-mode': { setAttribute() {} }, '#zq-wiki-mode-label': {} };
  const handle = { calls: [], text: page.content, markers: [],
    getMarkdown() { return this.text; }, setReadOnly(v) { this.calls.push(['readOnly', v]); }, wrap(...m) { this.calls.push(['wrap', ...m]); },
    insert(t) { this.calls.push(['insert', t]); }, focusAt(...a) { this.calls.push(['focusAt', ...a]); }, focusPos(...a) { this.calls.push(['focusPos', ...a]); },
    alignPos(...a) { this.calls.push(['alignPos', ...a]); }, charTop: () => 100,
    track(from, to) { const m = { from, to }; this.markers.push(m); return m; }, insertAt(m, t) { this.calls.push(['insertAt', m.from, m.to, t]); },
    untrack(m) { this.calls.push(['untrack', m.from]); }, toggleTask(pos) { this.calls.push(['toggleTask', pos]); },
    lineAt() { return { pos: 0, top: 100 }; }, setBlock(kind) { this.calls.push(['setBlock', kind]); }, link(href) { this.calls.push(['link', href]); }, destroy() { this.calls.push(['destroy']); } };
  const anchor = { value: null }, charTop = { value: null };
  const cmModule = { mountWikiEditor(host, options) { mounts.push({ host, options }); return handle; },
    readingAnchor: () => anchor.value, readingCharTop: () => charTop.value, sourcePosition: (md, a) => (a ? md.indexOf(a.text) + a.offset : null), taskMarkerPositions: () => [2, 30],
    sourceAnchorAt: () => null, readingBlockFor: () => null, readingAnchorTop: () => null };
  const uploads = [], opened = [];
  const sh = { state, token: () => 'token', esc: String, $: (s) => elements[s] || null, $all: () => [], empty: String, fmtDate: String,
    toast: (m) => toasts.push(m), safe: (_n, fn) => Promise.resolve().then(fn), askConfirm: async () => true, askText: async () => null,
    htmlToMarkdown: () => { throw new Error('验证版编辑器不该走 htmlToMarkdown'); }, renderMarkdown: (t) => t, renderMathIn() {},
    drafts: { load() {}, save() {}, clear() {}, clearIf() {} },
    loadModule: (rel) => { assert.equal(rel, 'wiki-cm.js'); return failLoad ? Promise.reject(new Error('网络断了')) : Promise.resolve(cmModule); },
    api: { get: () => new Promise(() => {}), put(_p, body) { writes.push(body); return Promise.resolve({ content: body.content, version: 4 }); },
      upload(path, file) { uploads.push(file); return new Promise((resolve) => { uploads.resolve = () => resolve({ url: '/api/knowledge/images/9', name: file.name }); }); } },
    codeTokens: () => [] };
  const impl = new Function('document', 'window', 'localStorage', 'getComputedStyle', `
    ${source}
    var realRestoreWikiView = restoreWikiView, realMarkEmptyWikiPage = markEmptyWikiPage;
    trackWikiNavigation = removeWikiDraftBar = removeWikiActionBar = showWikiActionBar = markDuplicateTitle = markEmptyWikiPage = wireWikiLinks
      = paintWikiTabs = paintWikiTree = offerWikiDraft = restoreWikiView = function () {};
    return { bind, enterWikiEdit, saveWikiEdit, paintWikiDoc, wikiToolbar, toggleWikiSource, toggleWikiReadOnly, loadWikiCm, currentWikiMarkdown, wireWikiEditor, markEmptyWikiPage: realMarkEmptyWikiPage,
      insertWikiImage, setChooser(fn) { chooseWikiImage = fn; }, captureWikiView, restoreWikiView: realRestoreWikiView };`)(
    { getElementById: () => null, execCommand() { throw new Error('验证版编辑器不该用 execCommand'); }, createElement: () => ({ style: {} }), body: { appendChild() {} } },
    { addEventListener() {}, getSelection: () => ({ rangeCount: 0 }), open(...a) { opened.push(a); return null; } }, localStorage, () => ({ paddingLeft: '26px' }));
  impl.bind(sh);
  return { impl, page, doc, handle, mounts, writes, toasts, state, store, uploads, anchor, charTop, events, sh, blockSelect, cmModule, opened };
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
    f.impl.wikiToolbar('source');   // 走真的按钮（第八十轮：原来直接调 toggleWikiSource，按钮那条路漏了、说「还没接这个按钮」也绿着）
    f.impl.toggleWikiReadOnly();
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'wrap'), [['wrap', '**'], ['wrap', '*'], ['wrap', '`']]);
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'readOnly').at(-1), ['readOnly', true]);
    assert.ok(f.toasts.some((t) => /Markdown 原文/.test(t)), '「源码」应当说明编辑器里就是原文');
  });
  await check('工具栏上的每个按钮（读 knowledge-wiki.html）在新编辑器里都有着落，没有一个说「还没接这个按钮」', async () => {
    const html = fs.readFileSync(path.resolve(path.dirname(cmPath), '../knowledge-wiki.html'), 'utf8');
    const cmds = [...html.matchAll(/data-wiki-cmd="([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(cmds.length >= 9, '只扫到 ' + cmds.length + ' 个按钮 —— 扫空了？');
    const f = fixture();
    await f.impl.loadWikiCm(); f.impl.enterWikiEdit(); f.impl.setChooser(() => {});
    for (const cmd of cmds) f.impl.wikiToolbar(cmd);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(f.toasts.filter((t) => /还没接/.test(t)), []);
  });
  // ── 第八十轮：试用开关去掉，新编辑器是默认 ──
  await check('默认就是新编辑器：本机什么设置都没存也挂上它（第八十轮去掉了「试试新编辑器 / 换回现在的编辑器」）', async () => {
    const f = fixture();
    assert.equal(f.store.size, 0);
    await f.impl.loadWikiCm(); f.impl.enterWikiEdit();
    assert.equal(f.mounts.length, 1);
    assert.equal(f.doc.dataset.editor, 'cm');
  });
  await check('新编辑器加载不上：说出来，这一次退回简易编辑（contentEditable），不是一点反应都没有', async () => {
    const f = fixture({ failLoad: true });
    f.impl.enterWikiEdit();
    await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    assert.equal(f.mounts.length, 0);
    assert.ok(f.toasts.some((t) => /没加载上/.test(t)), '要说出来：' + JSON.stringify(f.toasts));
    assert.equal(f.doc.dataset.editing, '1', '退回简易编辑之后应当在编辑');
    assert.equal(f.doc.contentEditable, 'true');
  });
  await check('挂编辑器时给它页名（重复的那一行标题要藏）和打开链接的办法：http(s) 打开，别的不开、说出来', async () => {
    const f = fixture();
    await f.impl.loadWikiCm(); f.impl.enterWikiEdit();
    const options = f.mounts[0].options;
    assert.equal(options.title(), f.page.title);
    options.onOpenUrl('https://example.com/zhiqu');
    assert.deepEqual(f.opened, [['https://example.com/zhiqu', '_blank', 'noopener,noreferrer']]);
    options.onOpenUrl('javascript:alert(1)');
    assert.equal(f.opened.length, 1, 'javascript: 不能打开');
    assert.ok(f.toasts.some((t) => /链接地址无效/.test(t)));
  });
  await check('空页（只有和页名重复的标题）读的时候说一句「点这里开始写」（只读时只说空）；有正文的不说', () => {
    const f = fixture();
    const make = (text, dupText) => {
      const md = { children: [], appendChild(el) { this.children.push(el); } };
      return { md, doc: { textContent: text, querySelector: (sel) => (sel === '.zq-dup-title' ? (dupText ? { textContent: dupText } : null) : sel === '.zq-md' ? md : null) } };
    };
    const created = [];
    globalThis.document = { createElement: () => { const el = { className: '', textContent: '' }; created.push(el); return el; } };
    try {
      const empty = make('周报草稿', '周报草稿');
      f.impl.markEmptyWikiPage(empty.doc);
      assert.equal(empty.md.children.length, 1);
      assert.equal(empty.md.children[0].className, 'zq-wiki-empty');
      assert.match(empty.md.children[0].textContent, /点这里开始写/);
      const full = make('周报草稿第一行内容', '周报草稿');
      f.impl.markEmptyWikiPage(full.doc);
      assert.equal(full.md.children.length, 0, '有正文的页不该说空');
      f.state.wikiReadOnly = true;
      const locked = make('周报草稿', '周报草稿');
      f.impl.markEmptyWikiPage(locked.doc);
      assert.equal(locked.md.children[0].textContent, '这一页还是空的', '只读时点了不会进编辑，不说「点这里开始写」');
    } finally { delete globalThis.document; }
  });
  // ── 第七十三轮：第 2 步补齐 ──
  await check('下划线：工具栏包 <u>…</u>，已经包着就去掉；扫描认 <u>，代码里的不算', () => {
    assert.deepEqual(cm.toggleWrap('a b c', 2, 3, '<u>', '</u>'), { changes: [{ from: 2, insert: '<u>' }, { from: 3, insert: '</u>' }], anchor: 5, head: 6 });
    assert.deepEqual(cm.toggleWrap('a <u>b</u> c', 5, 6, '<u>', '</u>'), { changes: [{ from: 2, to: 5, insert: '' }, { from: 6, to: 10, insert: '' }], anchor: 2, head: 3 });
    assert.deepEqual(cm.underlineRanges('x <u>下划线</u> y `<u>不算</u>`', 10).map((r) => [r.from, r.openTo, r.closeFrom, r.to]), [[12, 15, 18, 22]]);
  });
  await check('表格：连续的 | … | 行是一张表（和阅读模式一样认），代码块里的不算', () => {
    const text = '前\n| a | b |\n| --- | --- |\n| 1 | 2 |\n后\n```\n| 不是 | 表 |\n```\n| 单 |';
    assert.deepEqual(cm.tableRanges(text).map((r) => text.slice(r.from, r.to)), ['| a | b |\n| --- | --- |\n| 1 | 2 |', '| 单 |']);
  });
  await check('看得见的字：去掉列表 / 任务 / 标题 / 引用符号、强调符号、链接地址、<u>；[[目标|显示]] 只留显示的字，公式和图片各算一个字', () => {
    const v = cm.visibleText('  - [ ] 带**加粗**和 [[官网改版|官网]]、[链接](https://e.com)、<u>下</u>、$x^2$、`a*b` 与 3*4、![[/api/knowledge/images/2|图]]');
    assert.equal(v[0].text, '带加粗和 官网、链接、下、￼、a*b 与 3*4、￼', '不成对的 * 照样看得见（和 mdInline 一样）');
    assert.equal(v[0].cols[1], '  - [ ] 带**'.length, '「加」应当对着 ** 后面那一列');
    assert.deepEqual(cm.visibleText('| 指标 | 数值 |').map((u) => u.text.trim()), ['指标', '数值'], '表格一格一段');
    assert.deepEqual(cm.visibleText('| --- | :---: |'), [], '分隔行看不见');
    assert.equal(cm.visibleText('## 二级 **标题**')[0].text, '二级 标题');
  });
  await check('点哪儿光标落哪儿：阅读视图里点的字（renderMarkdown 画的真标记）映射回原文的那个位置', () => {
    const md = '# 标题\n\n- 第一项 **加粗**文字\n  - 子项 [[官网改版|官网]] 后面\n- 公式 $x^2$ 之后\n\n| 指标 | 数值 |\n| --- | --- |\n| 留存 | 41% |\n\n> 引用一\n> 引用二\n\n```js\nconst a = 1;\n```\n\n重复的一行\n\n重复的一行\n';
    const root = parseHtml(renderMarkdown(md));
    const at = (word, k, nth = 0) => { const c = caretIn(root, word, k, nth); return cm.sourcePosition(md, cm.anchorFromCaret(root, c.node, c.offset)); };
    assert.equal(at('文字', 1), md.indexOf('文字') + 1, '加粗后面的字');
    assert.equal(at('后面', 1), md.indexOf('后面') + 1, '嵌套项里、双链后面的字');
    assert.equal(at('之后', 1), md.indexOf('之后') + 1, '公式后面的字');
    assert.equal(at('41%', 2), md.indexOf('41%') + 2, '表格里的一格');
    assert.equal(at('引用二', 1), md.indexOf('引用二') + 1, '引用的第二行');
    assert.equal(at('a = ', 2), md.indexOf('a = 1') + 2, '代码块里的字（着色把一行拆成好几个节点）');
    assert.equal(at('重复的一行', 2, 1), md.lastIndexOf('重复的一行') + 2, '同样的一行出现两次，点的是第二次');
    assert.equal(cm.sourcePosition(md, { text: '原文里没有的字', ordinal: 0, offset: 0 }), null, '对不上就交给按坐标找');
  });
  await check('勾选框的位置：按顺序列出原文里每个任务的 [ ]，代码块里的不算', () => {
    const md = '- [ ] 一\n```\n- [ ] 代码里\n```\n  - [x] 二\n* [ ] 三';
    assert.deepEqual(cm.taskMarkerPositions(md).map((p) => md.slice(p, p + 3)), ['[ ]', '[x]', '[ ]']);
    assert.deepEqual(cm.taskMarkerPositions(md), [2, md.indexOf('[x]'), md.lastIndexOf('[ ]')]);
  });
  await check('接入：点正文进编辑，光标按阅读视图里点的字落到原文（落不上才按坐标）；那个字停在阅读时它在屏幕上的高度，挪的是外面滚动的那一层', async () => {
    const placed = (f) => f.handle.calls.filter((c) => c[0] === 'focusPos' || c[0] === 'focusAt' || c[0] === 'alignPos');
    const f = fixture();
    await f.impl.loadWikiCm(); f.impl.wireWikiEditor();
    f.anchor.value = { text: '二', ordinal: 0, offset: 0 }; f.charTop.value = 147;
    f.doc.onclick({ target: {}, clientX: 30, clientY: 160 });
    assert.equal(f.mounts.length, 1);
    assert.deepEqual(placed(f), [['focusPos', f.page.content.indexOf('二'), 147, f.doc]], '那个字在阅读视图里的顶边（不是点的那一点到正文区顶上的距离）');
    const h = fixture();
    await h.impl.loadWikiCm(); h.impl.wireWikiEditor();
    h.anchor.value = { text: '二', ordinal: 0, offset: 0 };
    h.doc.onclick({ target: {}, clientX: 30, clientY: 160 });
    assert.deepEqual(placed(h), [['focusPos', h.page.content.indexOf('二'), 150, h.doc]], '点在字缝里量不出字的顶边：按点的高度估');
    const g = fixture();
    await g.impl.loadWikiCm(); g.impl.wireWikiEditor();
    g.doc.onclick({ target: {}, clientX: 30, clientY: 160 });
    assert.deepEqual(placed(g), [['focusAt', 30, 160]]);
  });
  await check('接入：从菜单 / 工具栏进编辑（不是点正文）：阅读时顶上第一个看得见的字，进去以后停在原来的高度，光标不动', async () => {
    const idx = (f) => f.page.content.indexOf('二');
    const f = fixture();
    await f.impl.loadWikiCm();
    f.doc.getBoundingClientRect = () => ({ top: 100, left: 200, height: 400 });
    const probes = [];
    f.cmModule.readingAnchor = (root, x, y) => { probes.push([x, y]); return y >= 120 && x === 228 ? { text: '二', ordinal: 0, offset: 0 } : null; };
    f.charTop.value = 121;
    f.impl.enterWikiEdit();
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'alignPos' || c[0] === 'focusPos' || c[0] === 'focusAt'), [['alignPos', idx(f), 121, f.doc, '二']], '带上那段字：落在表格 / 公式预览里时在预览里找它');
    assert.deepEqual(probes[0], [228, 102], '从正文区左上角（内边距里面）往下找');
    const g = fixture();
    await g.impl.loadWikiCm();
    g.doc.getBoundingClientRect = () => ({ top: 100, left: 200, height: 400 });
    g.cmModule.readingAnchor = () => ({ text: '二', ordinal: 0, offset: 0 });
    g.cmModule.readingCharTop = (root, x, y) => (y < 130 ? 90 : 131);
    g.impl.enterWikiEdit();
    assert.deepEqual(g.handle.calls.filter((c) => c[0] === 'alignPos'), [['alignPos', idx(g), 131, g.doc, '二']], '顶边已经滚出正文区的那一行不算');
  });
  await check('接入：阅读模式里点勾选框，进编辑后改的就是原文里那一个任务（原来只进了编辑、勾选丢了）', async () => {
    const f = fixture();
    await f.impl.loadWikiCm(); f.impl.wireWikiEditor();
    const boxes = [{ type: 'checkbox', closest: () => null }, { type: 'checkbox', closest: () => null }];
    f.impl.bind(Object.assign({}, f.sh, { $all: (sel) => (/checkbox/.test(sel) ? boxes : []) }));
    f.events.change.forEach((fn) => fn({ target: boxes[1] }));
    assert.equal(f.mounts.length, 1, '要进编辑');
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'toggleTask'), [['toggleTask', 30]], '第二个勾选框对着原文里第二个任务');
  });
  await check('接入：工具栏下划线包 <u>，「插入图片」走选图片；编辑器拿到图片 / 表格 / 代码着色要用的东西', async () => {
    const f = fixture();
    await f.impl.loadWikiCm(); f.impl.enterWikiEdit();
    let chose = 0; f.impl.setChooser(() => { chose++; });
    f.impl.wikiToolbar('underline'); f.impl.wikiToolbar('image');
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'wrap'), [['wrap', '<u>', '</u>']]);
    assert.equal(chose, 1);
    const o = f.mounts[0].options;
    for (const k of ['onImage', 'renderBlock', 'hydrate', 'codeTokens']) assert.equal(typeof o[k], 'function', '没给编辑器 ' + k);
  });
  await check('接入：粘贴 / 拖进的图片上传完插到当时的位置（跟着编辑移动）；上传期间换了页就不插', async () => {
    const f = fixture();
    await f.impl.loadWikiCm(); f.impl.enterWikiEdit();
    f.mounts[0].options.onImage({ name: '图.png', type: 'image/png' }, 3, 3);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(f.uploads.length, 1);
    f.handle.markers[0].from = 5; f.handle.markers[0].to = 5;   // 上传期间前面又打了两个字
    f.uploads.resolve(); await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'insertAt'), [['insertAt', 5, 5, '![[/api/knowledge/images/9|图.png]]']]);
    const g = fixture();
    await g.impl.loadWikiCm(); g.impl.enterWikiEdit();
    g.mounts[0].options.onImage({ name: '图.png', type: 'image/png' }, 3, 3);
    await new Promise((r) => setTimeout(r, 0));
    await g.impl.paintWikiDoc(g.page);
    g.uploads.resolve(); await new Promise((r) => setTimeout(r, 10));
    assert.equal(g.handle.calls.filter((c) => c[0] === 'insertAt').length, 0, '换页之后不该插');
    assert.ok(g.toasts.some((t) => /已上传/.test(t)), '要说一声图片传上去了但没插');
  });
  await check('快捷键：⌘B / ⌘I / ⌘U 和工具栏一样包 ** / * / <u>（旧编辑器是浏览器自己做的，新编辑器要自己接）', () => {
    assert.deepEqual(cm.FORMAT_KEYS.map((k) => [k.key, k.open, k.close || k.open]), [['Mod-b', '**', '**'], ['Mod-i', '*', '*'], ['Mod-u', '<u>', '</u>']]);
  });
  await check('段落格式：选中的几行换成标题 / 引用 / 列表 / 有序 / 任务 / 正文（换掉原来的符号、留着缩进），代码块上下加围栏，分隔线另起一行', () => {
    const apply = (text, from, to, kind) => { let out = text; for (const c of [...cm.setBlock(text, from, to, kind)].sort((x, y) => y.from - x.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to == null ? c.from : c.to); return out; };
    assert.equal(apply('一\n二', 0, 3, 'H2'), '## 一\n## 二');
    assert.equal(apply('- [ ] 待办', 0, 0, 'P'), '待办');
    assert.equal(apply('  - 子', 3, 3, 'OL'), '  1. 子');
    assert.equal(apply('甲\n乙\n丙', 0, 3, 'OL'), '1. 甲\n2. 乙\n丙');
    assert.equal(apply('> 引用', 0, 0, 'TASK'), '- [ ] 引用');
    assert.equal(apply('## 标题', 0, 0, 'QUOTE'), '> 标题');
    assert.equal(apply('  - 子项', 0, 0, 'H3'), '### 子项', '缩进的列表项换成标题要顶格（缩进的 # 不是标题）');
    assert.equal(apply('甲\n乙', 0, 3, 'CODE'), '```\n甲\n乙\n```');
    assert.equal(apply('甲\n乙', 0, 0, 'HR'), '甲\n\n---\n乙');
  });
  await check('接入：新编辑器里段落格式下拉改的是 Markdown（不走 execCommand），选完回到「正文」', async () => {
    const f = fixture();
    await f.impl.loadWikiCm(); f.impl.wireWikiEditor(); f.impl.enterWikiEdit();
    f.blockSelect.value = 'H2'; f.blockSelect.onchange();
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'setBlock'), [['setBlock', 'H2']]);
    assert.equal(f.blockSelect.value, 'P');
  });
  // ── 第七十四轮 review ──
  await check('插入链接：选中的字做链接文字（原来被网址换掉），没选就用网址；方括号、换行不让链接断掉', () => {
    assert.equal(cm.linkMarkdown('官网', 'https://e.com'), '[官网](https://e.com/)');
    assert.equal(cm.linkMarkdown('', 'https://e.com'), '[https://e.com](https://e.com/)');
    assert.equal(cm.linkMarkdown('a [b]\nc', 'https://e.com'), '[a  b  c](https://e.com/)');
    // 第二遍 review：没选字时网址就是链接文字，网址里的括号不能把链接截断；链接文字结尾的反斜杠不能把 ] 转义掉
    assert.equal(cm.linkMarkdown('', 'https://x.com/?a[]=1'), '[https://x.com/?a%5B%5D=1](https://x.com/?a[]=1)', '链接文字里的方括号会把文字提前收尾；网址里的照原样');
    assert.equal(cm.linkMarkdown('看', 'https://e.com/a_(b))'), '[看](https://e.com/a_%28b%29%29)');
    assert.equal(cm.linkMarkdown('C:\\', 'https://e.com'), '[C:\\ ](https://e.com/)');
    assert.equal(cm.linkMarkdown('看', 'https://a.com/x\\'), '[看](https://a.com/x/)', '网址结尾的反斜杠会把 ) 转义掉 —— 照浏览器的写法它就是 /');
    // 第四遍 review：百分号编码会改掉网址本身 —— IPv6 的主机、路径里的反斜杠（浏览器当成 /）
    assert.equal(cm.linkMarkdown('看', 'http://[::1]:8080/'), '[看](http://[::1]:8080/)');
    assert.equal(cm.linkMarkdown('看', 'https://a.com\\docs'), '[看](https://a.com/docs)');
    assert.equal(cm.linkMarkdown('看', 'https://a.com/?q=C:\\'), '[看](https://a.com/?q=C:%5C)', '查询里的反斜杠浏览器不换成 /：结尾那个会把 ) 转义掉');
  });
  await check('接入：插入链接的弹窗回来时还是原来的编辑会话才插（换了页 / 取消了就不插），插的是 handle.link', async () => {
    let answer; const f = fixture();
    await f.impl.loadWikiCm(); f.impl.enterWikiEdit();
    f.impl.bind(Object.assign({}, f.sh, { askText: () => new Promise((r) => { answer = r; }) }));
    f.impl.wikiToolbar('link'); answer('https://e.com'); await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'link' || c[0] === 'insert'), [['link', 'https://e.com']]);
    f.handle.calls.length = 0;
    f.impl.wikiToolbar('link'); await f.impl.paintWikiDoc(f.page); answer('https://e.com'); await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(f.handle.calls.filter((c) => c[0] === 'link' || c[0] === 'insert'), [], '弹窗期间换了页，不该往拆掉的编辑器里写');
  });
  await check('回到阅读模式停在编辑时看着的那一段：原文位置 → 那一行的可见文字和第几次出现 → 阅读视图里同一段的块', () => {
    const md = '# 标题\n\n重复的一行\n\n- 列表项\n  - 子项\n\n重复的一行\n\n| 指标 | 数值 |\n| --- | --- |\n| 留存 | 41% |\n';
    const root = parseHtml(renderMarkdown(md));
    const text = (el) => { let t = ''; (function w(n) { if (n.nodeType === 3) t += n.nodeValue; else n.childNodes.forEach(w); })(el); return t; };
    const second = md.lastIndexOf('重复的一行');
    assert.deepEqual(cm.sourceAnchorAt(md, second + 2), { text: '重复的一行', ordinal: 1 });
    const block = cm.readingBlockFor(root, cm.sourceAnchorAt(md, second));
    const paragraphs = []; (function w(n) { if (n.nodeType === 1) { if (n.tagName === 'P' && text(n) === '重复的一行') paragraphs.push(n); n.childNodes.forEach(w); } })(root);
    assert.equal(block, paragraphs[1], '应当是第二个「重复的一行」');
    assert.equal(text(cm.readingBlockFor(root, cm.sourceAnchorAt(md, md.indexOf('  - 子项')))), '子项');
    assert.equal(cm.readingBlockFor(root, cm.sourceAnchorAt(md, md.indexOf('| --- |'))).tagName, 'TD', '分隔行往下找到下一行的格');
    assert.equal(cm.sourceAnchorAt(md, md.indexOf('\n\n重复') + 1).text, '重复的一行', '空行往下找');
  });
  await check('接入：新编辑器里保存 / 取消前记下顶上那一段是原文的哪一段、它第一个字多高，回到阅读模式让同一个字停在同一个高度（第七十四轮按块、第八十轮按字）', async () => {
    const f = fixture(); await f.impl.loadWikiCm(); f.impl.enterWikiEdit();
    const seen = [];
    f.handle.lineAt = (y) => { seen.push(['lineAt', y]); return { pos: 42, top: 140 }; };
    f.cmModule.sourceAnchorAt = (md, pos) => { seen.push(['anchorAt', md, pos]); return { text: '那一段', ordinal: 1 }; };
    f.cmModule.sourcePosition = (md, a) => { seen.push(['posOf', a]); return 77; };
    f.handle.charTop = (pos, text) => { seen.push(['charTop', pos, text]); return 170; };
    f.doc.scrollTop = 300;
    const view = f.impl.captureWikiView(f.doc);
    assert.deepEqual(seen, [['lineAt', 101], ['anchorAt', f.handle.text, 42], ['posOf', { text: '那一段', ordinal: 1, offset: 0 }], ['charTop', 77, '那一段']],
      '记的是编辑器顶上那一行往下第一段字在原文里的位置，量的是那一段第一个字（顶上那一行可能是代码块的结束行、空行）');
    assert.deepEqual(view.cmAnchor, { text: '那一段', ordinal: 1 });
    assert.equal(view.anchorOffset, 70, '那个字离正文区顶上 70px（不是顶上那一行的 40px）');
    f.cmModule.sourcePosition = () => null;
    assert.equal(f.impl.captureWikiView(f.doc).anchorOffset, 40, '原文里对不上那一段：退回那一行的顶边');
    const md = { children: [] };
    f.doc.querySelector = (q) => (q === '.zq-md' ? md : null);
    f.cmModule.readingAnchorTop = (root, a) => { seen.push(['topOf', root === md, a]); return 500; };
    f.doc.scrollTop = 0;
    f.impl.restoreWikiView(f.doc, view);
    assert.deepEqual(seen[seen.length - 1], ['topOf', true, { text: '那一段', ordinal: 1 }], '阅读视图里按记下的那一段找');
    assert.equal(f.doc.scrollTop, 300 + 500 - 100 - 70, '那个字停在原来离顶上 70px 的地方');
  });
  await check('表格 / 块公式：只动光标不重扫全文（第七十四轮 review），光标进出照样在成品和原文之间换；改了字才重扫', async () => {
    const { EditorState, EditorSelection } = await import(pathToFileURL(path.resolve(path.dirname(cmPath), 'vendor/codemirror/codemirror.js')).href);
    const md = '开头\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n$$\nx^2\n$$\n\n结尾';
    const [mathField, tableField] = cm.blockPreviews({});
    const widgets = (st, field) => { const out = []; st.field(field).deco.between(0, st.doc.length, (from, to, d) => { if (d.spec.widget) out.push(from); }); return out; };
    let st = EditorState.create({ doc: md, extensions: [mathField, tableField] });
    const table0 = st.field(tableField).ranges, math0 = st.field(mathField).ranges;
    assert.equal(table0.length, 1); assert.equal(math0.length, 1);
    assert.deepEqual(widgets(st, tableField), [md.indexOf('| a |')], '光标不在表格里：画成表格');
    st = st.update({ selection: EditorSelection.cursor(md.indexOf('| 1 |') + 2) }).state;
    assert.equal(st.field(tableField).ranges, table0, '只动光标就把全文重扫了一遍（表格）');
    assert.equal(st.field(mathField).ranges, math0, '只动光标就把全文重扫了一遍（块公式）');
    assert.deepEqual(widgets(st, tableField), [], '光标进了表格：露出原文');
    st = st.update({ selection: EditorSelection.cursor(md.indexOf('x^2')) }).state;
    assert.deepEqual(widgets(st, tableField), [md.indexOf('| a |')], '光标离开表格：又画成表格');
    assert.deepEqual(widgets(st, mathField), [], '光标进了块公式：露出原文');
    let owner = Object.getPrototypeOf(st.doc); while (owner && !Object.prototype.hasOwnProperty.call(owner, 'toString')) owner = Object.getPrototypeOf(owner);
    const realToString = owner.toString; let copies = 0;
    owner.toString = function () { copies++; return realToString.call(this); };
    try { st = st.update({ changes: { from: 0, insert: '新' } }).state; } finally { owner.toString = realToString; }
    assert.equal(copies, 1, '打一个字把全文复制了 ' + copies + ' 遍（块公式、表格各一遍）');
    assert.notEqual(st.field(tableField).ranges, table0, '改了字要重扫');
    assert.equal(st.field(tableField).ranges[0].from, md.indexOf('| a |') + 1, '重扫之后位置跟着挪');
  });
  // ── 第八十轮：编辑器的排版和阅读一致、链接单击打开、重复页名藏起来 ──
  await check('块间距的表和阅读模式的样式表一致（改了阅读的边距，这里就红 —— 两边不能各写一份各自对）', () => {
    const css = fs.readFileSync(path.resolve(path.dirname(cmPath), 'zhiqu-ui.css'), 'utf8');
    const margin = (sel) => {
      const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{[^}]*?margin:([^;}]+)').exec(css);
      if (!m) throw new Error('样式表里找不到 ' + sel);
      const v = m[1].trim().split(/\s+/).map((x) => parseFloat(x) || 0);
      return [v[0], v.length >= 3 ? v[2] : v[0]];
    };
    const want = { p: margin('.zq-prose .zq-md p'), h1: margin('.zq-prose .zq-md h1'), h2: margin('.zq-prose .zq-md h2'), h3: margin('.zq-prose .zq-md h3'),
      h4: margin('.zq-prose .zq-md h4'), h5: margin('.zq-prose .zq-md h5'), h6: margin('.zq-prose .zq-md h6'), li: margin('.zq-prose .zq-md ul,.zq-prose .zq-md ol'),
      quote: margin('.zq-prose .zq-md blockquote'), pre: margin('.zq-prose .zq-md pre'), hr: margin('.zq-prose .zq-md hr'), table: margin('.zq-md-table'),
      task: margin('.zq-prose .zq-task-row') };
    for (const [kind, m] of Object.entries(want)) assert.deepEqual(cm.BLOCK_MARGINS[kind], m, kind + ' 的上下边距和阅读模式对不上');
    assert.equal(cm.LIST_ITEM_GAP, margin('.zq-prose .zq-md li')[0], '列表项之间');
    for (const [, [top, bottom]] of Object.entries(cm.BLOCK_MARGINS)) for (const n of [top, bottom, cm.LIST_ITEM_GAP]) assert.ok(cm.LAYOUT_SIZES.includes(n), n + 'px 没有对应的样式');
  });
  await check('任务项是列表外单独的一行（阅读模式画成 .zq-task-row）：顶格的接在列表后面隔列表的下边距、套在列表项里的只隔自己的上边距，任务接任务、任务接列表项都是它的边距', () => {
    const rows = (t) => cm.layoutLines(t).map((x) => (x.blank ? 'gap' + x.gap : x.pad ? x.kind + '+' + x.pad : x.kind));
    const [, taskBottom] = cm.BLOCK_MARGINS.task, [taskTop] = cm.BLOCK_MARGINS.task, listBottom = cm.BLOCK_MARGINS.li[1];
    assert.deepEqual(rows('- a\n- b\n  - c\n- [ ] t1\n- [x] t2\n- d'), ['li', 'li+' + cm.LIST_ITEM_GAP, 'li+' + cm.LIST_ITEM_GAP, 'task+' + Math.max(listBottom, taskTop), 'task+' + Math.max(taskBottom, taskTop), 'li+' + taskBottom],
      '原来任务项当成同一个列表的下一项（隔 5），比阅读少 7px');
    assert.deepEqual(rows('- a\n  - [ ] t\n- b'), ['li', 'task+' + taskTop, 'li+' + taskBottom], '套在列表项里的任务行跟在父项的字后面');
    assert.deepEqual(rows('- a\n\n- [ ] b'), ['li', 'gap' + Math.max(listBottom, taskTop), 'task']);
    assert.deepEqual(rows('- [ ] a\n续行'), ['task', 'p'], '任务项的续行不另起一块');
  });
  await check('段落之间的空行只占 12px（阅读时的段距），一串空行只有第一行占；开头结尾的空行不占；代码块里的空行是内容', () => {
    const rows = (t, title = -1) => cm.layoutLines(t, title).map((x) => (x.blank ? 'gap' + x.gap : x.pad ? x.kind + '+' + x.pad : x.kind));
    assert.deepEqual(rows('一\n\n二\n\n三'), ['p', 'gap12', 'p', 'gap12', 'p']);
    assert.deepEqual(rows('一\n\n\n\n二'), ['p', 'gap12', 'gap0', 'gap0', 'p']);
    assert.deepEqual(rows('\n\n一\n\n'), ['gap0', 'gap0', 'p', 'gap0', 'gap0']);
    assert.deepEqual(rows('# 甲\n\n正文\n\n## 乙\n\n正文'), ['h1', 'gap14', 'p', 'gap30', 'h2', 'gap10', 'p']);
    assert.deepEqual(rows('- a\n- b\n  续\n\n正文'), ['li', 'li+5', 'p', 'gap12', 'p']);
    assert.deepEqual(rows('正文\n## 乙'), ['p', 'h2+30'], '标题紧挨着段落：带上阅读时的上边距');
    assert.deepEqual(rows('```\na\n\nb\n```\n\n后'), ['pre', 'pre', 'pre', 'pre', 'pre', 'gap16', 'p'], '代码块里的空行不能被压扁');
  });
  await check('和页名重复的第一行标题：认得出（只认第一行、一字不差），藏起来之后下一块照阅读时的上边距', () => {
    assert.equal(cm.duplicateTitleLine('# 周报\n\n正文', '周报'), 0);
    assert.equal(cm.duplicateTitleLine('# 周报 \n正文', ' 周报'), 0);
    assert.equal(cm.duplicateTitleLine('# 周报草稿\n', '周报'), -1);
    assert.equal(cm.duplicateTitleLine('正文\n# 周报', '周报'), -1);
    assert.equal(cm.duplicateTitleLine('## 周报', '周报'), -1);
    const rows = (t) => cm.layoutLines(t, cm.duplicateTitleLine(t, '页')).map((x) => (x.blank ? 'gap' + x.gap : x.kind));
    assert.deepEqual(rows('# 页\n\n正文'), ['p', 'gap0', 'p']);
    assert.deepEqual(rows('# 页\n\n## 小节'), ['p', 'gap30', 'h2']);
  });
  await check('挂上编辑器时光标先放在藏起来的重复标题后面（不然一挂上就露出来又藏回去，跳一下）；没有重复标题时在开头', () => {
    assert.equal(cm.startCursor('# 周报\n\n正文', '周报'), 5);
    assert.equal(cm.startCursor('# 周报', '周报'), 4);
    assert.equal(cm.startCursor('# 别的\n正文', '周报'), 0);
    assert.equal(cm.startCursor('', '周报'), 0);
  });
  await check('编辑器里藏起重复页名：光标不在它上面时整行藏起来；光标走上去（⌘↑）才露出来；页名对不上不藏', async () => {
    const { EditorState, EditorSelection } = await import(pathToFileURL(path.resolve(path.dirname(cmPath), 'vendor/codemirror/codemirror.js')).href);
    const md = '# 周报\n\n正文';
    const field = (title) => cm.blockPreviews({ title: () => title })[2];
    const hidden = (st, f) => { const out = []; st.field(f).between(0, st.doc.length, (from, to, d) => { if (d.spec.block) out.push([from, to]); }); return out; };
    let f = field('周报');
    let st = EditorState.create({ doc: md, selection: EditorSelection.cursor(md.indexOf('正文')), extensions: [f] });
    assert.deepEqual(hidden(st, f), [[0, 4]]);
    st = st.update({ selection: EditorSelection.cursor(0) }).state;
    assert.deepEqual(hidden(st, f), [], '光标在标题上：露出来，能改');
    f = field('别的');
    st = EditorState.create({ doc: md, selection: EditorSelection.cursor(md.length), extensions: [f] });
    assert.deepEqual(hidden(st, f), []);
  });
  await check('渲染出来的链接带着地址（单击就能打开）：[文字](网址)、裸网址；光标在上面时露出原文、不带（点了只放光标，照旧能改）；空行带上块间距', async () => {
    const { EditorState, EditorSelection, LanguageSupport, markdownLanguage } = await import(pathToFileURL(path.resolve(path.dirname(cmPath), 'vendor/codemirror/codemirror.js')).href);
    const md = '外部：[官网](https://example.com/zhiqu) 和 https://example.org/x?q=1\n\n结尾';
    const view = (cursor) => {
      const state = EditorState.create({ doc: md, selection: EditorSelection.cursor(cursor), extensions: [new LanguageSupport(markdownLanguage)] });
      return { state, visibleRanges: [{ from: 0, to: md.length }] };
    };
    const links = (v) => { const out = []; cm.inlineDecorations(v, {}).between(0, md.length, (from, to, d) => { const h = d.spec.attributes && d.spec.attributes['data-href']; if (h) out.push([md.slice(from, to), h]); }); return out; };
    const lines = (v) => { const out = []; cm.inlineDecorations(v, {}).between(0, md.length, (from, to, d) => { if (d.spec.class && /cm-zq-gap-/.test(d.spec.class)) out.push(d.spec.class); }); return out; };
    const far = view(md.length);
    assert.deepEqual(links(far), [['官网', 'https://example.com/zhiqu'], ['https://example.org/x?q=1', 'https://example.org/x?q=1']]);
    assert.deepEqual(lines(far), ['cm-zq-gap-12']);
    const inLink = view(md.indexOf('官网') + 1);
    assert.deepEqual(links(inLink).map((x) => x[1]), ['https://example.org/x?q=1'], '光标在链接里：那一个露出原文、不带地址');
  });
  await check('块里面的尺寸和阅读模式的样式表一致：代码框一行是正文的行高（pre 的那一行，13px 的 code 是行内的、撑不矮它）、首尾 ``` 行 = 上下内边距 + 边框、引用上下的内边距', () => {
    const css = fs.readFileSync(path.resolve(path.dirname(cmPath), 'zhiqu-ui.css'), 'utf8');
    const rule = (sel) => {
      const m = new RegExp('^' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}', 'm').exec(css);
      if (!m) throw new Error('样式表里找不到 ' + sel);
      return m[1];
    };
    const prop = (body, name) => { const m = new RegExp('(?:^|;)' + name + ':([^;]+)').exec(body); return m ? m[1].trim() : null; };
    const prose = rule('.zq-prose .zq-md');
    assert.equal(cm.READING_BOX.codeLineHeight, 'calc(' + prop(prose, 'font-size') + ' * ' + prop(prose, 'line-height') + ')', '代码框一行 = 正文的字号 × 行高');
    assert.equal(prop(rule('.zq-md pre'), 'line-height'), null, 'pre 自己改了行高：编辑器里代码行的高度要跟着算');
    assert.equal(prop(rule('.zq-prose .zq-md pre'), 'line-height'), null, 'pre 自己改了行高：编辑器里代码行的高度要跟着算');
    const pre = rule('.zq-md pre'), pad = prop(pre, 'padding').split(/\s+/).map(parseFloat), border = parseFloat(prop(pre, 'border'));
    assert.equal(cm.READING_BOX.fence, pad[0] + border, '``` 行 = 代码框的上内边距 + 边框');
    assert.equal(pad.length >= 3 ? pad[2] : pad[0], pad[0], '代码框上下内边距不一样：首尾两行要分开算');
    const quote = prop(rule('.zq-prose .zq-md blockquote'), 'padding').split(/\s+/).map(parseFloat);
    assert.equal(cm.READING_BOX.quotePad, quote[0], '引用的上内边距');
    assert.equal(quote.length >= 3 ? quote[2] : quote[0], quote[0], '引用上下内边距不一样：首尾两行要分开算');
  });
  await check('引用的第一行、最后一行带上阅读时的上 / 下内边距（一行的引用两个都带）；表格预览里那层不带外边距', async () => {
    const { EditorState, EditorSelection, LanguageSupport, markdownLanguage } = await import(pathToFileURL(path.resolve(path.dirname(cmPath), 'vendor/codemirror/codemirror.js')).href);
    const md = '一\n\n> 甲\n> 乙\n> 丙\n\n二\n\n> 单行\n\n三';
    const state = EditorState.create({ doc: md, selection: EditorSelection.cursor(md.length), extensions: [new LanguageSupport(markdownLanguage)] });
    const got = [];
    cm.inlineDecorations({ state, visibleRanges: [{ from: 0, to: md.length }] }, {}).between(0, md.length, (from, to, d) => {
      const c = d.spec.class || ''; if (/cm-zq-quote-(top|bottom)/.test(c)) got.push(state.doc.lineAt(from).text + ':' + c.replace('cm-zq-quote-', ''));
    });
    assert.deepEqual(got.sort(), ['> 丙:bottom', '> 单行:bottom', '> 单行:top', '> 甲:top'].sort());
    const src = fs.readFileSync(cmPath, 'utf8');
    assert.ok(src.includes("'.cm-zq-table .zq-md-table': { margin: '0' }"), '表格预览里那层的上下 12px 会漏出来，把下一行顶下去');
  });
  await check('代码块着色：编辑器挂的是阅读模式同一套类（.zq-tok-*，颜色在样式表），不是一段一个内联的颜色（第八十一轮）', async () => {
    const { EditorState, EditorSelection, LanguageSupport, markdownLanguage } = await import(pathToFileURL(path.resolve(path.dirname(cmPath), 'vendor/codemirror/codemirror.js')).href);
    const md = '开头\n\n```js\nconst x = 1;\n```\n\n结尾';
    const state = EditorState.create({ doc: md, selection: EditorSelection.cursor(0), extensions: [new LanguageSupport(markdownLanguage)] });
    const codeTokens = (code) => [{ text: 'const', cls: 'zq-tok-k' }, { text: ' x = ', cls: null }, { text: '1', cls: 'zq-tok-n' }, { text: code.slice(10), cls: null }];
    const marks = [];
    cm.inlineDecorations({ state, visibleRanges: [{ from: 0, to: md.length }] }, { codeTokens }).between(0, md.length, (from, to, d) => {
      if (d.spec.attributes && d.spec.attributes.style) marks.push('style:' + d.spec.attributes.style);
      if (/zq-tok-/.test(d.spec.class || '')) marks.push(md.slice(from, to) + ':' + d.spec.class);
    });
    assert.deepEqual(marks, ['const:zq-tok-k', '1:zq-tok-n']);
  });
  console.log(failed ? 'RED: ' + failed : 'ALL-GREEN');
  if (failed) process.exitCode = 1;
})();
