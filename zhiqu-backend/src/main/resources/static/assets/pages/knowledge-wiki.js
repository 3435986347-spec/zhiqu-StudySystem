// 知识 Wiki —— 第三十六轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// Markdown 渲染那一套（renderMarkdown、代码块着色、公式、htmlToMarkdown）AI 助手也用，留在壳里经 zqShared 给。
// state.wiki* 照旧放在壳的 state 上（只有这里读写）。wiki-tabs-check.js 从这个文件里抠标签页那一段来跑（要把 paintWikiDoc 换成替身，
// 模块里的函数互相调用、从外面换不掉 —— 所以这一段没改成 import）。

let API, api, token, esc, $, $all, empty, fmtDate, safe, toast, notice, askConfirm, askText, showInfo, openModal, popMenu, state, drafts, keepDraft,
  renderMarkdown, renderMathIn, mathBlockHtml, htmlToMarkdown, openAttachmentPreview, icon, loadModule, codeTokens;
export function bind(sh) {
  ({ API, api, token, esc, $, $all, empty, fmtDate, safe, toast, notice, askConfirm, askText, showInfo, openModal, popMenu, state, drafts, keepDraft,
  renderMarkdown, renderMathIn, mathBlockHtml, htmlToMarkdown, openAttachmentPreview, icon, loadModule, codeTokens } = sh);
}

export const boots = { 'knowledge-wiki.html': (sh) => { bind(sh); return bootKnowledge(); } };

var WIKI_TYPE_MAP = { 目标: 'GOAL', 计划: 'PROJECT', 偏好: 'PREFERENCE', 薄弱点: 'WEAKNESS', 资料: 'RESOURCE', 对话摘要: 'MEMORY', index: 'INDEX', 规则: 'SCHEMA', log: 'LOG' };
async function bootKnowledge() {
  state.wikiPages = flattenKnowledge((await api.get('/knowledge/document-tree')) || []);
  state.wikiCur = state.wikiPages[0] || null;
  state.wikiFilter = { q: '', type: '' };
  var header = $('.zq-main header') || $('header');
  (header ? $all('button', header) : []).forEach(function (b) {
    var t = b.textContent;
    if (/新建知识页/.test(t)) b.onclick = createWikiPage;
    else if (/导入来源/.test(t)) b.onclick = importWikiSource;
    else if (/导入知识库/.test(t)) b.onclick = importWikiVault;
    else if (b.id === 'zq-wiki-attachments') b.onclick = showWikiAttachments;
    else if (/来源记录/.test(t)) b.onclick = function () { return showWikiSources(); };
    else if (/健康检查/.test(t)) b.onclick = runWikiLint;
    else if (/图谱/.test(t)) b.onclick = showWikiGraph;
    else if (/导出/.test(t)) b.onclick = exportWikiMarkdown;
    else if (/待合入变更/.test(t)) { b.id = 'zq-patch-btn'; b.textContent = '待合入变更'; b.onclick = showWikiPatchSets; }
  });
  refreshWikiPatchBadge();
  var aside = $('#zq-tree') && $('#zq-tree').closest('aside');
  if (aside) {
    var searchInput = $('input', aside), typeSel = $('select', aside);
    if (searchInput) searchInput.oninput = function () { state.wikiFilter.q = searchInput.value.trim(); paintWikiTree(); };
    if (typeSel) typeSel.onchange = function () { state.wikiFilter.type = typeSel.selectedIndex === 0 ? '' : typeSel.options[typeSel.selectedIndex].text; paintWikiTree(); };
  }
  if (wikiCmEnabled()) loadWikiCm().catch(function () {});   // 进页面时先取；没取到的话点进编辑时再取一次
  wireWikiEditor();
  wireWikiTabShortcuts();
  paintWikiTree();
  // 先尝试恢复上次的标签页；恢复不出来（第一次来、或那些页都删了）才退回默认第一页。
  if (loadWikiTabs()) {
    var restored = wikiPageById(activeWikiTab() && activeWikiTab().id);
    if (restored) { paintWikiDoc(restored, { history: true }); return; }
    state.wikiTabs = []; state.wikiTabIdx = -1;
  }
  if (state.wikiCur) paintWikiDoc(state.wikiCur);
  else paintWikiTabs();
}
/**
 * 顶上那排查看类按钮（附件、来源记录、待合入变更、健康检查、图谱）和来源详情：点下去当帧就开弹窗、写「正在加载…」，
 * 数据到了填进同一个弹窗（第六十九轮）。原来先等服务器、回来了才开 —— 桌面应用连的是远程库，这段时间按钮一点反应都没有，
 * 以为没点上又点，回来就是两个弹窗；「待合入变更」还要连着等两次同样的请求。
 * 加载失败：关掉这个弹窗、照常提示；数据回来之前弹窗已经关了：数据丢掉、不再填。
 */
var WIKI_LOADING_HTML = '<p class="zq-embed-status" role="status">正在加载…</p>';
var wikiLoadingViews = {};
function openWikiLoadingModal(options) {
  var view = { closed: false }, onClose = options.onClose;
  view.handle = openModal(Object.assign({}, options, { bodyHtml: WIKI_LOADING_HTML,
    onClose: function () { view.closed = true; if (onClose) onClose(); } }));
  // 焦点进弹窗：留在背后的按钮上，再按一次回车又会开一个
  var close = view.handle.mask && view.handle.mask.querySelector('.zq-modal-close');
  if (close) { try { close.focus({ preventScroll: true }); } catch (e) {} }
  return view;
}
function fillWikiModal(handle, spec) {
  var title = handle.mask && handle.mask.querySelector('.zq-modal-title');
  if (title && spec.title) title.textContent = spec.title;
  handle.body.innerHTML = spec.bodyHtml;
  if (spec.onMount) spec.onMount(handle.body, handle);
  var first = handle.body.querySelector && (handle.body.querySelector('[autofocus]') || handle.body.querySelector('input,textarea,select,button'));
  if (first) { try { first.focus({ preventScroll: true }); } catch (e) {} }
}
/** 先开弹窗；load() 回来了，render(data, handle) 给出 { title, bodyHtml, onMount } 填进去（返回空就是不填） */
async function showWikiLoadingView(name, options, load, render) {
  var open = wikiLoadingViews[name];
  if (open && !open.closed) return;
  var view = wikiLoadingViews[name] = openWikiLoadingModal(options);
  await safe(name, async function () {
    var data;
    try { data = await load(); } catch (e) { view.handle.close(); throw e; }
    if (view.closed) return;
    var spec = render(data, view.handle);
    if (spec && !view.closed) fillWikiModal(view.handle, spec);
  });
}
/** 原来 showInfo 的那个样子（一段话 + 「知道了」），填进已经开着的弹窗 */
function wikiInfoSpec(spec) {
  return { title: spec.title, bodyHtml: (spec.html || '<p class="zq-wiki-note is-message">' + esc(spec.message || '') + '</p>')
    + '<div class="zq-modal-actions"><button type="button" class="zq-btn" data-ask="ok">知道了</button></div>',
  onMount: function (body, h) { $('[data-ask="ok"]', body).onclick = h.close; } };
}
async function showWikiAttachments() {
  var auth = token();
  await showWikiLoadingView('附件列表', { title: '知识库附件', width: '720px' }, function () { return api.get('/knowledge/attachments'); }, function (list, handle) {
    if (token() !== auth) { handle.close(); return null; }
    list = list || [];
    return {
    bodyHtml: '<input class="zq-input" id="zq-attachment-search" placeholder="搜索文件名称" aria-label="搜索附件">'
      + '<div class="zq-attachment-list" id="zq-attachment-list"></div>',
    onMount: function (body) {
      var input = body.querySelector('#zq-attachment-search'), area = body.querySelector('#zq-attachment-list');
      function paint() {
        if (token() !== auth) { area.textContent = '请登录后查看附件'; return; }
        var query = input.value.trim().toLowerCase();
        var filtered = list.filter(function (item) { return !query || String(item.name || '').toLowerCase().indexOf(query) >= 0; });
        area.innerHTML = filtered.slice(0, 500).map(function (item) {
          return '<button class="zq-attachment-row" data-attachment-id="' + esc(item.id) + '"><span>' + esc(item.name || '附件')
            + '</span><span class="zq-attachment-size">' + esc(Math.ceil((Number(item.byteSize) || 0) / 1024)) + ' KB</span></button>';
        }).join('') || '<p class="zq-embed-status">' + (query ? '没有匹配附件' : '知识库中还没有附件') + '</p>';
        if (filtered.length > 500) area.innerHTML += '<p class="zq-embed-status">仅显示前 500 个结果，请用文件名筛选。</p>';
        $all('[data-attachment-id]', area).forEach(function (button) {
          button.onclick = function () {
            if (token() !== auth) return;
            var item = list.find(function (row) { return String(row.id) === button.getAttribute('data-attachment-id'); });
            if (item) openAttachmentPreview(item.id, item.name);
          };
        });
      }
      input.oninput = paint; paint();
    }
    };
  });
}
function paintWikiTree() {
  var tree = $('#zq-tree'); if (!tree) return;
  // 目录页数：接真实数据（原“9 页”为静态占位），同时更新收起后的竖条标签
  var total = (state.wikiPages || []).length;
  var cntEl = $('#zq-tree-count'); if (cntEl) cntEl.textContent = total + ' 页';
  var toc = $('#zq-wiki-toc');
  if (toc) {
    var lbl = '目录 · ' + total + ' 页';
    toc.setAttribute('data-zq-label', lbl);
    var rl = $('.zq-rlabel', toc); if (rl) rl.textContent = lbl;
    // 桌面上收起的竖条只有一个图标（第四十四轮），页数在它的提示里
    var xb = $('.zq-xbtn', toc); if (xb) { xb.title = '展开「' + lbl + '」'; xb.setAttribute('aria-label', xb.title); }
  }
  var f = state.wikiFilter || { q: '', type: '' };
  var wantType = f.type ? (WIKI_TYPE_MAP[f.type] || f.type.toUpperCase()) : '';
  var pages = (state.wikiPages || []).filter(function (p) {
    if (f.q && (p.title || '').toLowerCase().indexOf(f.q.toLowerCase()) < 0) return false;
    if (wantType && String(p.pageType || p.type || '').toUpperCase() !== wantType) return false;
    return true;
  });
  tree.innerHTML = pages.map(function (p) {
    var active = state.wikiCur && p.id === state.wikiCur.id;
    // 选中的那一页是 aria-current（底色、字重在样式表的 .zq-wiki-item）
    return '<a data-wiki="' + p.id + '" class="zq-wiki-item"' + (active ? ' aria-current="page"' : '') + '><span>' + esc(p.title) + '</span></a>';
  }).join('') || empty('无匹配页面');
  $all('[data-wiki]', tree).forEach(function (a) {
    var pageOf = function () { return (state.wikiPages || []).find(function (x) { return String(x.id) === a.dataset.wiki; }); };
    // 鼠标停一下、或者按下去（还没松开）就先取正文，见 prefetchWikiPage
    a.onpointerenter = function () { clearTimeout(a._wikiPrefetch); a._wikiPrefetch = setTimeout(function () { prefetchWikiPage(pageOf()); }, WIKI_PREFETCH_HOVER_MS); };
    a.onpointerleave = function () { clearTimeout(a._wikiPrefetch); };
    a.onpointerdown = function () { prefetchWikiPage(pageOf()); };
    // ⌘/Ctrl+点击开新标签，和浏览器里点链接同一个手势
    a.onclick = function (e) { var p = pageOf(); if (p) paintWikiDoc(p, { newTab: e.metaKey || e.ctrlKey }); };
    a.onauxclick = function (e) {
      if (e.button !== 1) return;   // 中键
      e.preventDefault();
      var p = pageOf(); if (p) paintWikiDoc(p, { newTab: true });
    };
    a.oncontextmenu = function (e) {
      e.preventDefault();
      var p = pageOf(); if (!p) return;
      var items = [
        { label: '打开', onClick: function () { paintWikiDoc(p); } },
        { label: '在新标签页打开', onClick: function () { paintWikiDoc(p, { newTab: true }); } }
      ];
      if (!isSystemWikiPage(p)) items.push({ label: '删除该页', danger: true, onClick: function () { deleteWikiPage(p); } });
      popMenu(e.clientX, e.clientY, items);
    };
  });
}
/**
 * 鼠标在目录里的一页上停一小会儿（或按下还没松开），就先把它的正文取回来（第六十九轮）。点下去时多半已经到了 ——
 * 桌面应用连的是远程库，原来第一次打开每一页都要在「正在加载知识页…」上等一次往返。
 * 只取还没取过全文的页；回来 30 秒内点下去才用（再晚就重新取，不拿旧的冒充新的）；换了登录不用；
 * 预取失败就当没有 —— 点下去照常取、照常报错。
 */
var WIKI_PREFETCH_HOVER_MS = 120, WIKI_PREFETCH_FRESH_MS = 30000;
function prefetchWikiPage(p) {
  if (!p || p._full || p.id == null) return;
  if (p._prefetch && p._prefetch.auth === token() && Date.now() - p._prefetch.at < WIKI_PREFETCH_FRESH_MS) return;
  var entry = { at: Date.now(), auth: token() };
  entry.promise = api.get('/knowledge/pages/' + p.id).then(function (detail) { entry.at = Date.now(); return detail; }, function () { return null; });
  p._prefetch = entry;
}
function takeWikiPrefetch(p) {
  var entry = p._prefetch;
  p._prefetch = null;
  if (!entry || entry.auth !== token() || Date.now() - entry.at > WIKI_PREFETCH_FRESH_MS) return null;
  return entry.promise;
}
/**
 * 打开一个知识页。
 *
 * opts:
 *   newTab  —— 在新标签页打开（⌘/Ctrl+点击、中键、右键菜单）
 *   history —— 这次跳转来自前进/返回按钮，不要再往历史栈里压
 *
 * 不带 opts 就是「在当前标签里跳过去」，当前页进 back 栈 —— 浏览器的行为。
 */
async function paintWikiDoc(p, opts) {
  opts = opts || {};
  var authAtStart = token();
  // 正在编辑时点了目录里的别的页：原来改的字直接被新页面冲掉，一声不吭。先存成草稿，回到这一页时能恢复；
  // 第八十三轮起同时马上存上服务器（自动保存），换页不等那一秒
  if (state.wikiDirty) { saveWikiDraftNow(); flushWikiSave(); }
  else { clearTimeout(wikiSaveTimer); wikiSaveTimer = 0; wikiSaveSince = 0; }
  state.wikiDirty = false;
  removeWikiDraftBar();
  trackWikiNavigation(p, opts);
  state.wikiCur = p;
  var doc = $('#zq-doc'), title = wikiTitleEl();
  if (title) title.textContent = p.title || '知识页';
  // 等待新页正文时先退出旧页的编辑会话，不能把旧 DOM 的输入存成新页草稿。
  if (doc) {
    closeWikiCm(doc);
    doc.dataset.editing = '0'; doc.dataset.source = '0'; doc.dataset.loading = '1';
    doc.contentEditable = 'false';
    doc._wikiSourceView = null; doc._wikiPendingView = null;
    syncWikiEditMode(doc);
    if (!p._full && p.id != null) { doc.innerHTML = empty('正在加载知识页…'); placeWikiTitle(doc); }
  }
  // document-tree 只给了折叠后的 summary，正文要按需拉完整内容
  if (!p._full && p.id != null) {
    var prefetched = takeWikiPrefetch(p);
    var detail = (prefetched && await prefetched) || await safe('知识页', function () { return api.get('/knowledge/pages/' + p.id); });
    if (detail) { p.content = detail.content; p.pageType = detail.pageType || p.pageType; p.parentId = detail.parentId; p.sortOrder = detail.sortOrder; p.pinned = detail.pinned; p.version = detail.version; p._full = true; }
  }
  if (state.wikiCur !== p || token() !== authAtStart) return;
  if (doc) {
    doc.dataset.editing = '0'; doc.dataset.source = '0';
    doc.dataset.loading = p.id != null && !p._full ? '1' : '0';
    doc._wikiSourceView = null;
    doc._wikiPendingView = opts.preserveView ? { view: opts.preserveView, page: p, auth: authAtStart, expires: Date.now() + 30000 } : null;
    doc.contentEditable = 'false';
    setSourcePressed(false);
    // 第八十三轮：没开只读就直接是编辑器（像 Obsidian）—— 不再先画阅读视图、点了再拆掉换编辑器（每点一下都要拆、建、量、对位：卡和跳都在这儿）。
    // 编辑器的代码还没到（第一次打开）就先画阅读视图，到了 enterWikiCmEdit 自己换上
    if (doc.dataset.loading !== '1' && !wikiReadOnly() && wikiCmEnabled() && wikiCmModule) enterWikiCmEdit(doc, p, p.content || '', { fresh: true, view: opts.preserveView });
    else {
      showWikiReading(doc, p, opts.preserveView);
      if (doc.dataset.loading !== '1' && !wikiReadOnly() && wikiCmEnabled()) enterWikiCmEdit(doc, p, p.content || '', {});
    }
    showWikiActionBar();
  }
  var insp = $('#zq-insp');
  if (insp) {
    insp.innerHTML = '<div class="zq-wiki-insp">类型：' + esc(p.pageType || p.type || 'NOTE') + '<br>更新：' + esc(fmtDate(p.updatedAt)) + '<br><span class="zq-wiki-insp-tip">直接写，自动保存 · 开启「只读」看排好版的阅读视图 · [[双链]]可跳转</span></div>';
  }
  paintWikiTree();
  paintWikiTabs();
  offerWikiDraft(p);
}

// ── 知识 Wiki 没保存的改动（第十五轮） ─────────────────────────────────
//
// 编辑时打的字存成草稿（drafts，键 wiki.<页 id>，带着开始改时的版本号 base）：刷新、关页、登录过期、点了别的页都还在，
// 回到这一页时顶上一条「恢复 / 丢弃」。恢复后保存用的是 base —— 这一页之后被别人改过的话，乐观锁会挡住，
// 不会拿一份旧草稿盖掉新内容；挡住时草稿还在、字还在编辑框里。
function wikiDraftKey(p) { return 'wiki.' + p.id; }
function currentWikiMarkdown() {
  var doc = $('#zq-doc');
  if (!doc || doc.dataset.editing !== '1') return null;
  if (wikiCmActive(doc)) return wikiCm.handle.getMarkdown();
  return doc.dataset.source === '1' ? ($('#zq-src-ta') ? $('#zq-src-ta').value : '') : htmlToMarkdown(doc);
}
function saveWikiDraftNow() {
  if (state.wikiDraftTimer) { clearTimeout(state.wikiDraftTimer); state.wikiDraftTimer = null; }
  var p = state.wikiCur, md = currentWikiMarkdown();
  if (!p || p.id == null || md == null) return;
  drafts.save(wikiDraftKey(p), md, { base: p._draftBase != null ? p._draftBase : p.version, title: p.title });
}
function wireWikiDrafts(doc) {
  if (!doc || doc.dataset.draftWired) return;
  doc.dataset.draftWired = '1';
  // 源码模式的 textarea 在 doc 里面，它的 input 事件也冒泡到这里
  doc.addEventListener('input', function () {
    if (doc.dataset.editing !== '1' || wikiReadOnly()) return;
    state.wikiDirty = true;
    if (state.wikiCur) state.wikiCur._everEdited = true;
    if (state.wikiDraftTimer) clearTimeout(state.wikiDraftTimer);
    state.wikiDraftTimer = setTimeout(saveWikiDraftNow, 800);
    scheduleWikiSave();
  });
  // 焦点离开正文（点了目录、别的按钮、切到别的应用）、页面藏到后台：马上存，不等那一秒（第八十三轮）
  doc.addEventListener('focusout', function (e) { if (state.wikiDirty && !(e.relatedTarget && doc.contains(e.relatedTarget))) flushWikiSave(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && state.wikiDirty) { saveWikiDraftNow(); flushWikiSave(); } });
  window.addEventListener('pagehide', function () { if (state.wikiDirty) { saveWikiDraftNow(); flushWikiSave(); } });
  // 编辑了还没保存就要走：草稿先存下，浏览器再问一句
  window.addEventListener('beforeunload', function (e) {
    if (!state.wikiDirty) return;
    saveWikiDraftNow();
    e.preventDefault();
    e.returnValue = '';
  });
}
function removeWikiDraftBar() { var b = document.getElementById('zq-wiki-draft'); if (b) b.remove(); }
function offerWikiDraft(p) {
  removeWikiDraftBar();
  var doc = $('#zq-doc');
  if (!doc || !p || p.id == null || doc.dataset.loading === '1') return;
  var d = drafts.load(wikiDraftKey(p));
  if (!d || d.text === (p.content || '')) return;
  var bar = document.createElement('div');
  bar.id = 'zq-wiki-draft';   // 样子在样式表的 #zq-wiki-draft
  var when = new Date(d.at);
  var moved = d.base != null && p.version != null && Number(d.base) !== Number(p.version);
  bar.innerHTML = '<span>这一页有没保存的修改（' + esc((when.getMonth() + 1) + '/' + when.getDate() + ' ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0'))
    + '）' + (moved ? '。之后这一页被改过，恢复后保存时会先问你' : '') + '</span>'
    + '<button class="zq-btn" data-draft="restore">恢复</button><button class="zq-btn-ghost" data-draft="drop">丢弃</button>';
  doc.parentNode.insertBefore(bar, doc);
  $('[data-draft="restore"]', bar).onclick = function () {
    if (wikiReadOnly()) return toast('请先关闭只读开关再恢复草稿');
    removeWikiDraftBar();
    p._draftBase = d.base != null ? d.base : p.version;
    // 草稿是在旧版本上改的、这一页之后又被改过：不自动存（会被乐观锁挡住），直接亮出「用我的覆盖 / 载入别处的版本」
    if (moved) p._saveConflict = true;
    if (wikiCmActive(doc)) wikiCm.handle.setMarkdown(d.text);   // 编辑器一直开着（第八十三轮）：整篇换成草稿，Cmd+Z 回得去
    else if (wikiCmEnabled()) enterWikiCmEdit(doc, p, d.text, { fresh: true });
    else {
      enterWikiEdit();
      if (doc.dataset.source !== '1') toggleWikiSource();
      var ta = $('#zq-src-ta'); if (ta) ta.value = d.text;
    }
    state.wikiDirty = true; p._everEdited = true;
    if (moved) paintWikiSaveState(p); else scheduleWikiSave();
  };
  $('[data-draft="drop"]', bar).onclick = function () { drafts.clear(wikiDraftKey(p)); removeWikiDraftBar(); };
}
// ── 知识 Wiki 的标签页 ────────────────────────────────────────────────
//
// 三件事凑在一起：标签栏、每个标签自己的前进/返回、刷新后还在。
// 形状故意只存 id 不存整页对象：页面内容会被编辑，存快照会让标签显示旧标题。

var WIKI_TABS_KEY = 'zq.wiki.tabs';

function activeWikiTab() {
  return state.wikiTabs[state.wikiTabIdx] || null;
}

function newWikiTab(id, title) {
  return { id: id == null ? null : String(id), title: title || '新标签页', back: [], fwd: [] };
}

/** 把这次跳转记进标签与历史。paintWikiDoc 的第一件事。 */
function trackWikiNavigation(p, opts) {
  var id = p && p.id != null ? String(p.id) : null;
  if (opts.newTab || !state.wikiTabs.length) {
    state.wikiTabs.push(newWikiTab(id, p && p.title));
    state.wikiTabIdx = state.wikiTabs.length - 1;
    saveWikiTabs();
    return;
  }
  var tab = activeWikiTab();
  if (!tab) {
    state.wikiTabs.push(newWikiTab(id, p && p.title));
    state.wikiTabIdx = state.wikiTabs.length - 1;
    saveWikiTabs();
    return;
  }
  // 两个条件各挡一件事，而承重的是后一个：
  //   !opts.history —— 调用方明说「这不是跳转」（前进/返回、切标签、保存后重绘）
  //   tab.id !== id —— 同一页再打开一次不算跳转
  // 扰动实测：去掉 history:true 那些地方历史栈纹丝不动，因为 id 相等这一条已经拦住了。
  // 所以 history 参数是把意图写明白，真正防止「返回按钮原地打转」的是 id 比较。
  if (!opts.history && tab.id && tab.id !== id) {
    tab.back.push(tab.id);
    // 走过新路就没有「前进」可言了 —— 和浏览器一致。
    tab.fwd = [];
    // 历史不必无限长；50 步远超实际需要，但比「无上限」安全。
    if (tab.back.length > 50) tab.back.shift();
  }
  tab.id = id;
  tab.title = (p && p.title) || tab.title;
  saveWikiTabs();
}

function wikiPageById(id) {
  if (id == null) return null;
  return (state.wikiPages || []).find(function (x) { return String(x.id) === String(id); }) || null;
}

/** 前进 / 返回。方向：-1 返回，+1 前进。 */
function wikiHistoryGo(direction) {
  var tab = activeWikiTab();
  if (!tab) return;
  var from = direction < 0 ? tab.back : tab.fwd;
  var to = direction < 0 ? tab.fwd : tab.back;
  if (!from.length) return;
  var targetId = from.pop();
  var target = wikiPageById(targetId);
  if (!target) {
    // 那一页被删了。丢掉这一步继续往回找，而不是卡住 ——
    // 「点了没反应」比「跳过一步」更让人以为按钮坏了。
    saveWikiTabs();
    return wikiHistoryGo(direction);
  }
  if (tab.id) to.push(tab.id);
  tab.id = targetId;
  saveWikiTabs();
  paintWikiDoc(target, { history: true });
}

function closeWikiTab(index) {
  if (index < 0 || index >= state.wikiTabs.length) return;
  if (index === state.wikiTabIdx && state.wikiDirty) { saveWikiDraftNow(); flushWikiSave(); }
  state.wikiTabs.splice(index, 1);
  if (!state.wikiTabs.length) {
    state.wikiTabIdx = -1;
    state.wikiCur = null;
    saveWikiTabs();
    var doc = $('#zq-doc'), title = wikiTitleEl();
    if (doc) {
      doc.dataset.editing = '0'; doc.dataset.source = '0'; doc.dataset.loading = '0';
      closeWikiCm(doc);
      doc.contentEditable = 'false'; state.wikiDirty = false;
      syncWikiEditMode(doc); paintWikiSaveState(null);
      doc.innerHTML = empty('没有打开的页面 · 从左侧目录选一页，或点 + 新建标签');
    }
    if (title) title.textContent = '';
    if (doc) placeWikiTitle(doc);
    paintWikiTabs();
    paintWikiTree();
    return;
  }
  // 关掉的是当前标签或它左边的标签时，索引要跟着往左收 —— 否则会指到别人身上。
  if (state.wikiTabIdx >= state.wikiTabs.length) state.wikiTabIdx = state.wikiTabs.length - 1;
  else if (index < state.wikiTabIdx) state.wikiTabIdx -= 1;
  saveWikiTabs();
  var next = wikiPageById(activeWikiTab().id);
  if (next) paintWikiDoc(next, { history: true });
  else { paintWikiTabs(); paintWikiTree(); }
}

function activateWikiTab(index) {
  if (index === state.wikiTabIdx || index < 0 || index >= state.wikiTabs.length) return;
  state.wikiTabIdx = index;
  saveWikiTabs();
  var target = wikiPageById(state.wikiTabs[index].id);
  // history:true —— 切换标签不是一次「跳转」，不该进任何一个标签的历史栈。
  if (target) paintWikiDoc(target, { history: true });
  else { paintWikiTabs(); paintWikiTree(); }
}

function paintWikiTabs() {
  var bar = $('#zq-wiki-tabs');
  if (!bar) return;
  var tabs = state.wikiTabs || [];
  bar.innerHTML = tabs.map(function (t, i) {
    var on = i === state.wikiTabIdx;
    // 当前标签是 aria-current（底色、上沿那条强调色、字重在样式表的 .zq-wiki-tab）
    return '<div data-wiki-tab="' + i + '" class="zq-wiki-tab"' + (on ? ' aria-current="page"' : '') + ' title="' + esc(t.title || '') + '">' +
      '<span class="zq-wiki-tab-name">' + esc(t.title || '新标签页') + '</span>' +
      '<span data-wiki-tab-close="' + i + '" class="zq-wiki-tab-x" title="关闭">' + icon('x') + '</span></div>';
  }).join('') +
    '<div data-wiki-tab-new="1" class="zq-wiki-tab-new" title="新标签页" aria-label="新标签页">' + icon('plus') + '</div>';

  $all('[data-wiki-tab]', bar).forEach(function (el) {
    el.onclick = function (e) {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-wiki-tab-close')) return;
      activateWikiTab(Number(el.dataset.wikiTab));
    };
    // 中键关闭 —— 浏览器标签页的通用手势
    el.onauxclick = function (e) {
      if (e.button !== 1) return;
      e.preventDefault();
      closeWikiTab(Number(el.dataset.wikiTab));
    };
  });
  $all('[data-wiki-tab-close]', bar).forEach(function (el) {
    el.onclick = function (e) { e.stopPropagation(); closeWikiTab(Number(el.dataset.wikiTabClose)); };
  });
  var plus = $('[data-wiki-tab-new]', bar);
  if (plus) plus.onclick = openWikiQuickSwitch;

  var back = $('#zq-wiki-back'), fwd = $('#zq-wiki-fwd'), tab = activeWikiTab();
  // 没有历史时置灰而不是隐藏：按钮位置固定，标题才不会左右跳。灰的样子在样式表（.zq-wiki-nav .zq-btn-ghost:disabled）
  if (back) back.disabled = !(tab && tab.back.length);
  if (fwd) fwd.disabled = !(tab && tab.fwd.length);
}

/** + 按钮：列出所有页面让用户挑一个，选中后在新标签打开。 */
function openWikiQuickSwitch() {
  var pages = state.wikiPages || [];
  var h = openModal({
    title: '在新标签页打开',
    width: 460,
    bodyHtml: '<input id="zq-qs-input" class="zq-input" placeholder="输入标题筛选…" aria-label="输入标题筛选">' +
      '<div id="zq-qs-list" class="zq-wiki-qs"></div>',
    onMount: function (body) {
      var input = $('#zq-qs-input', body), list = $('#zq-qs-list', body);
      function paint() {
        var q = (input.value || '').trim().toLowerCase();
        var hit = pages.filter(function (p) { return !q || (p.title || '').toLowerCase().indexOf(q) >= 0; });
        list.innerHTML = hit.map(function (p) {
          return '<a data-qs="' + p.id + '" class="zq-wiki-qs-item">' + esc(p.title) + '</a>';
        }).join('') || empty('没有匹配的页面');
        $all('[data-qs]', list).forEach(function (a) {
          a.onclick = function () {
            var target = wikiPageById(a.dataset.qs);
            if (target) { h.close(); paintWikiDoc(target, { newTab: true }); }
          };
        });
      }
      input.oninput = paint;
      paint();
      input.focus();
    }
  });
}

/**
 * 标签页存进 localStorage，刷新后还在。
 *
 * 两处防御：写失败要吞掉（隐私模式下 localStorage 会抛），读回来的东西要当成
 * 不可信数据校验 —— 它可能是上一个版本写的，形状对不上就整份丢掉，而不是让
 * 后面每一次 tab.back.push 都炸。
 */
function saveWikiTabs() {
  try {
    localStorage.setItem(WIKI_TABS_KEY, JSON.stringify({ tabs: state.wikiTabs, idx: state.wikiTabIdx }));
  } catch (e) { /* 存不下就算了，标签页只是便利 */ }
}

function loadWikiTabs() {
  var raw = null;
  try { raw = localStorage.getItem(WIKI_TABS_KEY); } catch (e) { return false; }
  if (!raw) return false;
  var data;
  try { data = JSON.parse(raw); } catch (e) { return false; }
  if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return false;
  var tabs = [];
  data.tabs.forEach(function (t) {
    if (!t || typeof t !== 'object') return;
    // 页可能已经被删掉了 —— 那条标签不该复活
    if (t.id != null && !wikiPageById(t.id)) return;
    tabs.push({
      id: t.id == null ? null : String(t.id),
      title: typeof t.title === 'string' ? t.title : '新标签页',
      back: Array.isArray(t.back) ? t.back.filter(function (x) { return wikiPageById(x); }).map(String) : [],
      fwd: Array.isArray(t.fwd) ? t.fwd.filter(function (x) { return wikiPageById(x); }).map(String) : []
    });
  });
  if (!tabs.length) return false;
  state.wikiTabs = tabs;
  state.wikiTabIdx = Number.isInteger(data.idx) && data.idx >= 0 && data.idx < tabs.length ? data.idx : 0;
  return true;
}

function wireWikiTabShortcuts() {
  if (wireWikiTabShortcuts._done) return;
  wireWikiTabShortcuts._done = true;
  var back = $('#zq-wiki-back'), fwd = $('#zq-wiki-fwd');
  if (back) back.onclick = function () { wikiHistoryGo(-1); };
  if (fwd) fwd.onclick = function () { wikiHistoryGo(1); };
  document.addEventListener('keydown', function (e) {
    if (!$('#zq-wiki-tabs')) return;
    var doc = $('#zq-doc');
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    // 光标在正文里时 ⌘[ ⌘] 是缩进（编辑器的），不抢；第八十三轮编辑器一直开着，原来「在编辑就全不管」等于 ⌘W 也永远不关标签
    var typing = doc && doc.contains(document.activeElement);
    if (e.key === '[' && !typing) { e.preventDefault(); wikiHistoryGo(-1); }
    else if (e.key === ']' && !typing) { e.preventDefault(); wikiHistoryGo(1); }
    else if (e.key === 'w' && state.wikiTabs.length) { e.preventDefault(); closeWikiTab(state.wikiTabIdx); }
  });
}

function wikiExternalUrl(value) {
  var href = String(value || '').trim();
  if (!/^https?:\/\//i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return null;
  try {
    var parsed = new URL(href);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname ? href : null;
  } catch (ignored) { return null; }
}
function wireWikiLinks(doc, scope) {
  scope = scope || doc;
  async function follow(a, newTab) {
    var spec = (a.getAttribute('data-wikilink') || '').split('|')[0];
    var hash = spec.indexOf('#');
    var title = (hash < 0 ? spec : spec.slice(0, hash)).trim();
    var heading = hash < 0 ? '' : spec.slice(hash + 1).trim();
    var target = (state.wikiPages || []).find(function (x) { return (x.title || '') === title; });
    if (!target) { toast('页面不存在：' + title, 'error'); return; }
    await paintWikiDoc(target, { newTab: newTab });
    if (heading && state.wikiCur === target) {
      try { heading = decodeURIComponent(heading); } catch (ignored) {}
      var el = $all('h1,h2,h3,h4,h5,h6', doc).find(function (x) { return (x.textContent || '').trim() === heading; });
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }
  var links = $all('[data-wikilink]', scope);
  if (scope !== doc && scope.matches && scope.matches('[data-wikilink]')) links.unshift(scope);
  links.forEach(function (a) {
    // Markdown 的 [[双链]] 没有 href；让它能由键盘聚焦、回车打开。
    a.tabIndex = 0;
    a.setAttribute('role', 'link');
    a.onkeydown = function (e) {
      if ((doc.dataset.editing === '1' && state.wikiReadOnly !== true) || e.key !== 'Enter' || e.isComposing || e.repeat) return;
      e.preventDefault(); e.stopPropagation();
      follow(a, e.metaKey || e.ctrlKey);
    };
    a.onclick = function (e) {
      if ((doc.dataset.editing === '1' && state.wikiReadOnly !== true)) return;
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡到正文容器，否则跳转后的目标页会立刻进入编辑态
      follow(a, e.metaKey || e.ctrlKey);
    };
    a.onauxclick = function (e) {
      if (e.button !== 1 || (doc.dataset.editing === '1' && state.wikiReadOnly !== true)) return;
      e.preventDefault(); e.stopPropagation();
      follow(a, true);
    };
  });
  // Delegation also covers links inserted by the toolbar and asynchronous note previews.
  if (doc.dataset.wikiExternalLinksWired) return;
  doc.dataset.wikiExternalLinksWired = '1';
  function followExternal(e) {
    if (e.defaultPrevented || doc.dataset.source === '1') return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !doc.contains(a) || a.getAttribute('data-zq-private-download') !== null) return;
    if (e.type === 'keydown' && (e.key !== 'Enter' || e.target !== a || e.repeat || e.isComposing)) return;
    if (e.type === 'click' && e.button !== 0 || e.type === 'auxclick' && e.button !== 1) return;
    var raw = a.getAttribute('href') || '';
    if (/^(?:#|\/(?!\/)|\.\.?\/)/.test(raw)) return;
    e.preventDefault(); e.stopPropagation();
    var selection = window.getSelection && window.getSelection();
    if (e.type !== 'keydown' && selection && !selection.isCollapsed && doc.contains(selection.anchorNode) && doc.contains(selection.focusNode)) return;
    var href = wikiExternalUrl(raw);
    if (!href) { toast('链接地址无效，请使用完整的 HTTP(S) 网址', 'error'); return; }
    // noopener may return null even when the native shell opened the system browser successfully.
    window.open(href, '_blank', 'noopener,noreferrer');
  }
  ['click', 'auxclick', 'keydown'].forEach(function (event) { doc.addEventListener(event, followExternal); });
}
function wireWikiEditor() {
  var doc = $('#zq-doc'); if (!doc) return;
  doc.addEventListener('zq-wiki-embed-ready', function (event) {
    var scope = event.target;
    if (!scope || scope !== doc && !doc.contains(scope)) return;
    // Only the new preview needs initialization; document-level delegates remain on the parent.
    wireWikiLinks(doc, scope);
    syncWikiTaskControls(doc, scope);
    if (!doc._wikiPendingView || doc._wikiEmbedFrame) return;
    doc._wikiEmbedFrame = window.requestAnimationFrame(function () {
      doc._wikiEmbedFrame = null;
      // User input and page/auth changes can invalidate the restore while this frame is queued.
      var pending = doc._wikiPendingView;
      if (pending && pending.page === state.wikiCur && pending.auth === token() && Date.now() < pending.expires) restoreWikiView(doc, pending.view);
    });
  });
  ['pointerdown', 'wheel', 'touchstart', 'keydown', 'input'].forEach(function (event) {
    doc.addEventListener(event, function () { doc._wikiPendingView = null; }, { passive: true });
  });
  // 保留原来的点正文编辑；只读只是可选的防误改开关，链接和嵌入控件仍按原用途响应。
  doc.onclick = function (e) {
    if (e.target && e.target.closest && e.target.closest('a,input,button,.zq-md-image,.zq-embed')) return;
    if (!state.wikiCur || wikiReadOnly() || doc.dataset.editing === '1' || doc.dataset.loading === '1') return;
    // 新编辑器：光标落到原文里点的那个字、那个字停在点的高度（enterWikiCmEdit 在换掉阅读视图之前记下）；简易编辑照旧按坐标放光标
    enterWikiEdit({ focus: { x: e.clientX, y: e.clientY } });
    if (doc.dataset.editing === '1' && !wikiCmActive(doc)) caretAt(e.clientX, e.clientY);
  };
  var modeButton = $('#zq-wiki-mode');
  if (modeButton) modeButton.onclick = toggleWikiReadOnly;
  doc.addEventListener('paste', function (e) {
    if (wikiReadOnly() || doc.dataset.loading === '1' || wikiCmActive(doc)) return;   // 新编辑器：粘贴交给 CodeMirror（图片走它的 onImage）
    var files = Array.from(e.clipboardData && e.clipboardData.files || []);
    var image = files.find(isWikiImageFile);
    if (!image || !state.wikiCur) return;
    e.preventDefault();
    insertWikiImage(image);
  });
  doc.addEventListener('dragover', function (e) {
    if (Array.from(e.dataTransfer && e.dataTransfer.items || []).some(function (item) { return item.kind === 'file'; })) e.preventDefault();
  });
  doc.addEventListener('drop', function (e) {
    // 阻止浏览器把文件拖入只读正文解释成离开知识库并打开本地文件。
    if (Array.from(e.dataTransfer && e.dataTransfer.files || []).length) e.preventDefault();
    if (wikiReadOnly() || doc.dataset.loading === '1' || wikiCmActive(doc)) return;
    var image = Array.from(e.dataTransfer && e.dataTransfer.files || []).find(isWikiImageFile);
    if (!image || !state.wikiCur) return;
    e.preventDefault();
    if (doc.dataset.source !== '1') caretAt(e.clientX, e.clientY);
    insertWikiImage(image);
  });
  // 右键菜单：编辑本页 / 删除本页；编辑态不拦截（保留浏览器原生菜单做粘贴等操作）
  doc.oncontextmenu = function (e) {
    if (wikiReadOnly() || doc.dataset.editing === '1' || !state.wikiCur) return;
    e.preventDefault();
    var p = state.wikiCur;
    var items = [{ label: '编辑本页', onClick: function () { enterWikiEdit(); } }];
    if (!isSystemWikiPage(p)) items.push({ label: '删除本页', danger: true, onClick: function () { deleteWikiPage(p); } });
    popMenu(e.clientX, e.clientY, items);
  };
  // 任务可直接勾选并进入编辑；只读和嵌入笔记中的任务始终不能改。
  doc.addEventListener('change', function (e) {
    var cb = e.target;
    if (!cb || cb.type !== 'checkbox' || wikiCmActive(doc)) return;   // 编辑器里的勾选框自己改原文
    if (wikiReadOnly() || doc.dataset.loading === '1' || cb.closest && cb.closest('[data-embed-markdown]')) {
      cb.checked = typeof cb._wikiLockedChecked === 'boolean' ? cb._wikiLockedChecked : cb.defaultChecked; return;
    }
    if (wikiCmEnabled()) {
      // 新编辑器：阅读视图里第几个勾选框就是原文里第几个任务；进编辑后只改那一个方括号（原来只进了编辑，勾选丢了）
      var boxes = $all('input[type="checkbox"]', doc).filter(function (x) { return !(x.closest && x.closest('[data-embed-markdown]')); });
      var index = boxes.indexOf(cb);
      if (!ensureWikiEditing() || !wikiCmActive(doc)) { cb.checked = !cb.checked; return; }   // 编辑器还没加载好：没改原文，框也别显示成改了
      var marks = wikiCmModule.taskMarkerPositions(wikiCm.handle.getMarkdown());
      if (index >= 0 && index < marks.length) wikiCm.handle.toggleTask(marks[index]);
      return;
    }
    if (!ensureWikiEditing()) return;
    // 勾上的划线变灰在样式表（.zq-task-row>input:checked+span），不再在这里写
    doc.dispatchEvent(new Event('input', { bubbles: true }));
  });
  var section = doc.closest('section'); if (!section) return;
  $all('[data-wiki-cmd]', section).forEach(function (b) {
    // 按下去不抢正文的焦点（第八十三轮：原来只有「图片」这样）—— 焦点一离开编辑器，光标那一行露出的 ## ** 就藏起来，点完又露出来，闪一下；选区也保得住
    b.onmousedown = function (e) { e.preventDefault(); };
    b.onclick = function (e) { e.preventDefault(); wikiToolbar(b.getAttribute('data-wiki-cmd')); };
  });
  var blockSel = $('#zq-wiki-block', section);
  if (blockSel) blockSel.onchange = function () {
    if (!state.wikiCur || !ensureWikiEditing()) return;
    if (doc.dataset.source === '1') return;
    // 新编辑器改的是 Markdown 原文（execCommand 是给 contentEditable 的，用在 CodeMirror 上会直接改它的 DOM）
    if (wikiCmActive(doc)) { wikiCm.handle.setBlock(blockSel.value); blockSel.value = 'P'; return; }
    var v = blockSel.value;
    if (v === 'QUOTE') document.execCommand('formatBlock', false, 'BLOCKQUOTE');
    else if (v === 'CODE') document.execCommand('formatBlock', false, 'PRE');
    else if (v === 'UL') document.execCommand('insertUnorderedList');
    else if (v === 'OL') document.execCommand('insertOrderedList');
    else if (v === 'HR') document.execCommand('insertHorizontalRule');
    // 和 renderMarkdown 画出来的同一个样子：样式在 zhiqu-ui.css 的 .zq-task-row（第五十五轮起不写内联样式）
    else if (v === 'TASK') document.execCommand('insertHTML', false, '<div class="zq-task-row"><input type="checkbox" contenteditable="false"><span>待办事项</span></div>');
    else document.execCommand('formatBlock', false, v);
    blockSel.value = 'P';
  };
  // 页名在正文顶上直接改（第八十四轮，照 Obsidian；原来点工具栏那一行的页名弹窗改）：回车 / 点别处就存、Esc 放弃，回车以后光标进正文开头
  var titleEl = wikiTitleEl();
  if (titleEl && !titleEl.dataset.renameWired) {
    titleEl.dataset.renameWired = '1';
    titleEl.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;   // 输入法正在选字：回车是选字，不是改完
      if (e.key === 'Enter') { e.preventDefault(); commitWikiTitle(true); }
      else if (e.key === 'Escape') { e.preventDefault(); var p = state.wikiCur; titleEl.textContent = p ? (p._pendingTitle || p.title || '') : ''; titleEl.blur(); }
    });
    titleEl.addEventListener('blur', function () { commitWikiTitle(false); });
    // 页名是一行字：贴进来的换行变空格、带格式的只取纯文字
    titleEl.addEventListener('paste', function (e) {
      var text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (text == null) return;
      e.preventDefault();
      document.execCommand('insertText', false, text.replace(/\s*[\r\n]+\s*/g, ' '));
    });
  }
}
/** 页名改完了：和原来一样（空的、没变的不存）；改名和自动保存排同一队（第八十三轮）。enter：回车改完的，光标进正文开头 */
function commitWikiTitle(enter) {
  var titleEl = wikiTitleEl(), p = state.wikiCur, doc = $('#zq-doc');
  if (!titleEl || !p || !doc || p.id == null || titleEl.contentEditable === 'false') return;
  var name = String(titleEl.textContent || '').replace(/\s+/g, ' ').trim(), current = p._pendingTitle || p.title || '';
  if (!name || name === current) titleEl.textContent = current;
  else {
    titleEl.textContent = name;
    p._pendingTitle = name;
    safe('修改名称', async function () {
      // 改名走的是整页保存，要带着正文 —— 目录树不给正文（只给摘要），正文还没取回来（刚打开、或者取失败了）就先取一遍
      if (!p._full) {
        var detail = await api.get('/knowledge/pages/' + p.id);
        p.content = detail.content; p.version = detail.version; p._full = true;
      }
      var md = state.wikiCur === p ? currentWikiMarkdown() : null;
      await saveWikiContent(p, md != null ? md : p.content || '');
    });
  }
  if (enter) {
    titleEl.blur();
    if (wikiCmActive(doc)) wikiCm.handle.focusStart();
  }
}
/** 页名那个节点：#zq-doc 每次重画都整个换掉，这个节点留在这里（事件也在它身上），画完放回最上面 */
var wikiTitleNode = null;
function wikiTitleEl() { return wikiTitleNode || (wikiTitleNode = $('#zq-doc-title')); }
function placeWikiTitle(doc) {
  var t = wikiTitleEl();
  if (t && doc && doc.insertBefore && doc.firstChild !== t) doc.insertBefore(t, doc.firstChild);
}
/** 光标放到窗口坐标 (x, y) 处的字前面 */
function caretAt(x, y) {
  var r = null;
  try {
    if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) { var p = document.caretPositionFromPoint(x, y); if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); } }
  } catch (e) { r = null; }
  if (!r) return;
  var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
function isWikiImageFile(file) {
  return !!file && (/^image\/(png|jpeg|gif|webp)$/i.test(file.type || '') || /\.(png|jpe?g|gif|webp)$/i.test(file.name || ''));
}
function chooseWikiImage() {
  if (!state.wikiCur || !ensureWikiEditing()) return;
  var editContext = wikiEditingContext($('#zq-doc'));
  var picker = document.createElement('input');
  picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
  picker.hidden = true;
  document.body.appendChild(picker);
  picker.onchange = function () {
    var file = picker.files && picker.files[0];
    picker.remove();
    if (file && isWikiEditingContext(editContext)) insertWikiImage(file);
  };
  picker.oncancel = function () { picker.remove(); };
  picker.click();
}
var wikiEditSession = 0;
function insertWikiImage(file, at) {
  var doc = $('#zq-doc'), page = state.wikiCur;
  if (!ensureWikiEditing()) return;
  if (!doc || !page || !isWikiImageFile(file)) return toast('请选择 PNG、JPG、GIF 或 WebP 图片', 'error');
  if (state.wikiImageUploading) return toast('上一张图片还在上传', 'error');
  // 新编辑器：记住插到哪儿（粘贴时的光标、拖放的位置），上传期间接着打字也跟着挪
  var cmHandle = wikiCmActive(doc) ? wikiCm.handle : null;
  var cmMarker = cmHandle ? cmHandle.track(at ? at.from : null, at ? at.to : null) : null;
  var editSession = doc.dataset.wikiEditSession;
  var uploadAuth = token();
  var source = doc.dataset.source === '1';
  var ta = source ? $('#zq-src-ta') : null;
  var offset = ta ? { start: ta.selectionStart, end: ta.selectionEnd } : null;
  var sel = window.getSelection();
  var range = !source && sel.rangeCount && doc.contains(sel.getRangeAt(0).commonAncestorContainer)
    ? sel.getRangeAt(0).cloneRange() : null;
  state.wikiImageUploading = true;
  return safe('插入图片', async function () {
    var uploaded = await api.upload('/knowledge/images', file);
    if (!uploaded || !/^\/api\/knowledge\/images\/[1-9]\d*$/.test(uploaded.url || '')) throw new Error('图片上传结果无效');
    if (token() !== uploadAuth || state.wikiCur !== page || doc.dataset.editing !== '1' || doc.dataset.wikiEditSession !== editSession
        || (doc.dataset.source === '1') !== source) {   // 新编辑器每次挂上都换编辑会话号，换页 / 取消后回来的上传在这里拦下
      toast('图片已上传；当前页面已切换，请回原页重新插入', 'error');
      return;
    }
    var name = String(uploaded.name || file.name || '图片').replace(/[|\]\r\n]/g, ' ');
    var markdown = '![[' + uploaded.url + '|' + name + ']]';
    if (cmHandle) {
      cmHandle.insertAt(cmMarker, markdown);
    } else if (source && ta && ta.isConnected) {
      ta.setRangeText(markdown, offset.start, offset.end, 'end');
      ta.focus();
    } else {
      var holder = document.createElement('div');
      holder.innerHTML = renderMarkdown(markdown);
      var image = holder.querySelector('[data-image-markdown]');
      if (!image) throw new Error('图片插入失败');
      doc.focus({ preventScroll: true });
      var selection = window.getSelection();
      selection.removeAllRanges();
      if (!range || !doc.contains(range.commonAncestorContainer)) {
        range = document.createRange(); range.selectNodeContents(doc); range.collapse(false);
      }
      selection.addRange(range);
      if (!document.execCommand('insertHTML', false, image.outerHTML + '&nbsp;')) {
        range.deleteContents();
        var fragment = range.createContextualFragment(image.outerHTML + '&nbsp;');
        range.insertNode(fragment);
      }
      renderMathIn(doc);
    }
    doc.dispatchEvent(new Event('input', { bubbles: true }));
    toast('图片已加入当前草稿，保存页面后生效');
  }).finally(function () { state.wikiImageUploading = false; if (cmMarker) cmHandle.untrack(cmMarker); });
}
function ensureWikiEditing() {
  var doc = $('#zq-doc');
  if (!doc || !state.wikiCur || wikiReadOnly() || doc.dataset.loading === '1') return false;
  if (doc.dataset.editing !== '1') enterWikiEdit();
  return doc.dataset.editing === '1';
}
function wikiReadOnly() { return state.wikiReadOnly === true; }
function toggleWikiReadOnly() {
  var doc = $('#zq-doc'), p = state.wikiCur;
  if (!doc || !p || doc.dataset.loading === '1') return;
  // 上锁前先存：浏览器里的草稿一直存（第十五轮），改过的马上上服务器（第八十三轮自动保存）
  if (doc.dataset.editing === '1') { saveWikiDraftNow(); if (state.wikiDirty) flushWikiSave(); }
  state.wikiReadOnly = !wikiReadOnly();
  // 迟到的链接弹窗、改名、图片选择不能穿过一次上锁 / 解锁继续改旧会话。
  doc.dataset.wikiEditSession = String(++wikiEditSession);
  // 第八十三轮：像 Obsidian —— 开只读是排好版的阅读视图（嵌入预览、附件都在那儿），关只读回到编辑器。顶上那一段不动
  if (wikiCmEnabled() && (wikiCmActive(doc) || !wikiReadOnly())) {
    if (wikiReadOnly()) {
      var md = currentWikiMarkdown();
      showWikiReading(doc, p, captureWikiView(doc), md != null ? md : p.content);
    } else enterWikiCmEdit(doc, p, doc._wikiReadingMarkdown != null ? doc._wikiReadingMarkdown : p.content || '', {});
    showWikiActionBar();
    return;
  }
  // 编辑器没加载上（简易编辑）：照旧冻结原 DOM / textarea，不重绘、不提交。源码的选区、滚动与未保存内容都留下来。
  syncWikiEditMode(doc);
}
/** 阅读视图（开着只读、或者编辑器的代码还没到）：markdown 不给就是这一页存着的正文 */
function showWikiReading(doc, p, view, markdown) {
  closeWikiCm(doc);
  doc.dataset.editing = '0'; doc.dataset.source = '0';
  doc.contentEditable = 'false';
  doc._wikiReadingMarkdown = markdown != null ? markdown : null;
  doc.innerHTML = renderMarkdown(markdown != null ? markdown : p.content || p.summary || '');
  markDuplicateTitle(doc, p.title);
  markEmptyWikiPage(doc);   // 它读整个正文区的字：页名放回去之前读
  placeWikiTitle(doc);
  renderMathIn(doc);
  wireWikiLinks(doc);
  syncWikiEditMode(doc);
  if (view) restoreWikiView(doc, view);
}
function wikiEditingContext(doc) {
  return { doc: doc, page: state.wikiCur, session: doc.dataset.wikiEditSession, source: doc.dataset.source, auth: token() };
}
function isWikiEditSession(context) {
  return !!context && token() === context.auth && state.wikiCur === context.page && context.doc.dataset.editing === '1' && context.doc.dataset.loading !== '1'
    && context.doc.dataset.wikiEditSession === context.session && context.doc.dataset.source === context.source;
}
function isWikiEditingContext(context) { return !wikiReadOnly() && isWikiEditSession(context); }
function syncWikiEditMode(doc) {
  if (!doc) return;
  var editing = doc.dataset.editing === '1', locked = wikiReadOnly(), unavailable = !state.wikiCur || doc.dataset.loading === '1';
  doc.contentEditable = editing && !locked && doc.dataset.source !== '1' && !wikiCmActive(doc) ? 'true' : 'false';
  if (wikiCmActive(doc)) wikiCm.handle.setReadOnly(locked || unavailable);
  doc.setAttribute('aria-readonly', locked || unavailable ? 'true' : 'false');   // 光标跟着它（样式表的 #zq-doc[aria-readonly="true"]）
  var source = $('#zq-src-ta'); if (source) source.readOnly = locked;
  var emptyHint = doc.querySelector && doc.querySelector('.zq-wiki-empty'); if (emptyHint) emptyHint.textContent = wikiEmptyHint();
  var modeButton = $('#zq-wiki-mode'), label = $('#zq-wiki-mode-label');
  if (modeButton) {
    modeButton.textContent = '只读';
    modeButton.disabled = unavailable;
    modeButton.setAttribute('aria-checked', locked ? 'true' : 'false');
    modeButton.setAttribute('aria-pressed', locked ? 'true' : 'false');
    modeButton.title = unavailable ? '正文尚未加载，请稍候或刷新后重试' : locked ? '关闭只读，恢复直接编辑' : '开启只读，防止误改';
  }
  if (label) label.textContent = locked ? '已开启' : '';
  $all('[data-wiki-cmd], #zq-wiki-block', doc.closest('section')).forEach(function (control) { control.disabled = locked || unavailable; });
  var del = $('[data-wiki-cmd="delete"]', doc.closest('section'));
  if (del) del.hidden = !state.wikiCur || isSystemWikiPage(state.wikiCur);
  syncWikiTaskControls(doc);
  var title = wikiTitleEl();
  if (title) {
    // 页名在正文顶上，没开只读就直接改（第八十四轮，照 Obsidian）；系统页（index / log / 维护规则）不能改名，后端也拦
    var renamable = !locked && !unavailable && !!state.wikiCur && !isSystemWikiPage(state.wikiCur);
    if (!renamable) title.contentEditable = 'false';
    else { try { title.contentEditable = 'plaintext-only'; } catch (e) { title.contentEditable = 'true'; } }   // 不认 plaintext-only 的浏览器退回 true（贴进来的照样只取纯文字）
    title.title = renamable ? '点击修改页面名称' : '';
  }
}
function syncWikiTaskControls(doc, scope) {
  scope = scope || doc;
  var locked = wikiReadOnly(), unavailable = !state.wikiCur || doc.dataset.loading === '1';
  var checkboxes = $all('input[type="checkbox"]', scope);
  if (scope !== doc && scope.matches && scope.matches('input[type="checkbox"]')) checkboxes.unshift(scope);
  checkboxes.forEach(function (checkbox) {
    if (locked) checkbox._wikiLockedChecked = checkbox.checked;
    else delete checkbox._wikiLockedChecked;
    checkbox.disabled = locked || unavailable || !!(checkbox.closest && checkbox.closest('[data-embed-markdown]'));
  });
}
function captureWikiView(doc) {
  var view = { scrollTop: doc.scrollTop || 0, windowX: window.scrollX || 0, windowY: window.scrollY || 0 };
  // 新编辑器里没有 .zq-md：记下顶上那一行在原文里是哪一段（第七十四轮 review：原来按像素恢复，两种排版差得远，保存 / 取消后跳到别处）
  if (wikiCmActive(doc) && wikiCmModule && doc.getBoundingClientRect) {
    var docTop = doc.getBoundingClientRect().top, line = wikiCm.handle.lineAt(docTop + 1), markdown = wikiCm.handle.getMarkdown();
    view.cmAnchor = wikiCmModule.sourceAnchorAt(markdown, line.pos);
    // 第八十轮：量那一段第一个字的顶边，回到阅读时对的也是那个字 —— 顶上那一行可能是代码块的结束行、空行，那一段在下面几行（原来差出 30px）
    var at = view.cmAnchor ? wikiCmModule.sourcePosition(markdown, { text: view.cmAnchor.text, ordinal: view.cmAnchor.ordinal, offset: 0 }) : null;
    view.anchorOffset = (at != null ? wikiCm.handle.charTop(at, view.cmAnchor.text) : line.top) - docTop;
    return view;
  }
  var md = doc.querySelector && doc.querySelector('.zq-md');
  if (!md || !doc.getBoundingClientRect) return view;
  var top = doc.getBoundingClientRect().top;
  var children = Array.from(md.children || []);
  var anchor = children.find(function (child) { var rect = child.getBoundingClientRect(); return rect.height && rect.bottom > top; });
  if (anchor) {
    view.anchorIndex = children.indexOf(anchor);
    view.anchorKey = anchor.tagName + ':' + String(anchor.textContent || '').slice(0, 160);
    view.anchorOffset = anchor.getBoundingClientRect().top - top;
  }
  return view;
}
function restoreWikiView(doc, view) {
  if (!doc || !view) return;
  doc.scrollTop = view.scrollTop;
  var md = doc.querySelector && doc.querySelector('.zq-md');
  var cmTop = md && view.cmAnchor && wikiCmModule && doc.getBoundingClientRect ? wikiCmModule.readingAnchorTop(md, view.cmAnchor) : null;
  if (cmTop != null) doc.scrollTop += cmTop - doc.getBoundingClientRect().top - view.anchorOffset;
  else if (md && doc.getBoundingClientRect && view.anchorKey) {
    var children = Array.from(md.children || []);
    function matches(child) { return child && child.tagName + ':' + String(child.textContent || '').slice(0, 160) === view.anchorKey; }
    var anchor = children[view.anchorIndex];
    if (!matches(anchor)) {
      var nearest = -1;
      children.forEach(function (child, index) {
        if (matches(child) && (nearest < 0 || Math.abs(index - view.anchorIndex) < Math.abs(nearest - view.anchorIndex))) nearest = index;
      });
      anchor = nearest >= 0 ? children[nearest] : children[view.anchorIndex];
    }
    if (anchor) doc.scrollTop += anchor.getBoundingClientRect().top - doc.getBoundingClientRect().top - view.anchorOffset;
  }
  if (window.scrollTo && (window.scrollX !== view.windowX || window.scrollY !== view.windowY)) window.scrollTo(view.windowX, view.windowY);
}
/** opts.focus = { x, y }：点正文进来的，光标落在点的那个字上、那个字不动（第八十轮） */
function enterWikiEdit(opts) {
  var doc = $('#zq-doc'), p = state.wikiCur; if (!doc || !p || wikiReadOnly() || doc.dataset.editing === '1' || doc.dataset.loading === '1') return;
  if (wikiCmEnabled()) { enterWikiCmEdit(doc, p, p.content || '', opts); return; }
  var view = captureWikiView(doc);
  wireWikiDrafts(doc);
  var emptyHint = doc.querySelector && doc.querySelector('.zq-wiki-empty');   // 空页的那句提示不是正文，简易编辑会把 DOM 存回去
  if (emptyHint) emptyHint.remove();
  doc.dataset.editing = '1'; doc.dataset.source = '0'; doc.dataset.wikiEditSession = String(++wikiEditSession);
  doc.contentEditable = 'true';
  showWikiActionBar();
  doc.focus({ preventScroll: true });
  restoreWikiView(doc, view);
}
// ── 编辑内核：CodeMirror 6（第七十轮验证，第八十轮成为默认，docs/rounds/round-80.md） ─────────────────
// 点进编辑是 CodeMirror 6 的实时预览（assets/wiki-cm.js）：编辑的就是 Markdown 原文，
// 保存不经过 htmlToMarkdown（那一步会丢嵌套列表、代码块语言、表格对齐、硬换行）。每一处接入都是「新编辑器在才走」，加载不上就退回原来的。
var wikiCmModule = null, wikiCmLoading = null, wikiCm = null;
// 第八十轮：试用开关（页面检查里的「试试新编辑器 / 换回现在的编辑器」）去掉了，新编辑器是默认；只有它加载不上时这一页退回原来的 contentEditable
var wikiCmFailed = false;
function wikiCmEnabled() { return !wikiCmFailed; }
function wikiCmActive(doc) { return !!(wikiCm && doc && doc.dataset.editor === 'cm'); }
function loadWikiCm() {
  if (!wikiCmLoading) wikiCmLoading = loadModule('wiki-cm.js').then(function (mod) { wikiCmModule = mod; return mod; }, function (e) { wikiCmLoading = null; throw e; });
  return wikiCmLoading;
}
function closeWikiCm(doc) {
  if (wikiCm) { try { wikiCm.handle.destroy(); } catch (e) {} wikiCm = null; }
  if (doc) delete doc.dataset.editor;
}
/** 阅读视图顶上第一个看得见的字：它在原文里是哪一段、屏幕上多高（从工具栏 / 菜单进编辑时让它不动） */
function wikiReadingTop(doc) {
  if (!doc.getBoundingClientRect || typeof getComputedStyle !== 'function') return null;
  var r = doc.getBoundingClientRect(), left = r.left + (parseFloat(getComputedStyle(doc).paddingLeft) || 0);
  for (var y = r.top + 2; y < r.top + Math.min(r.height, 240); y += 6) {
    for (var i = 0; i < 2; i++) {
      var x = left + (i ? 32 : 2), anchor = wikiCmModule.readingAnchor(doc, x, y), top = anchor ? wikiCmModule.readingCharTop(doc, x, y) : null;
      if (top != null && top >= r.top) return { anchor: anchor, top: top };
    }
  }
  return null;
}
function enterWikiCmEdit(doc, p, markdown, opts) {
  if (!wikiCmModule) {   // 进页面时就开始加载；还没到就等它到了再进
    loadWikiCm().then(function () { if (state.wikiCur === p && doc.dataset.editing !== '1' && !wikiReadOnly()) enterWikiCmEdit(doc, p, markdown, opts); }, function () {
      wikiCmFailed = true;
      toast('编辑器没加载上，先用简易编辑（刷新页面会再试一次）', 'error');
      if (state.wikiCur === p && doc.dataset.editing !== '1' && !wikiReadOnly()) enterWikiEdit();
    });
    return;
  }
  wireWikiDrafts(doc);
  closeWikiCm(doc);
  var fresh = !!(opts && opts.fresh);   // 刚打开这一页（第八十三轮）：没有阅读视图可量，从顶上开始、或者回到记下的位置
  var scroll = fresh ? 0 : doc.scrollTop;
  // 换掉阅读视图之前记下：点的那个字（或者顶上第一个字）在原文里是哪儿、屏幕上多高。进去以后让同一个字停在同一个高度 ——
  // 只按像素抄 scrollTop 不行：编辑器上面没画出来的行高度是估的，长页中间点进去整页偏一截（第八十轮，32px）
  var focus = opts && opts.focus, keep = null;
  if (fresh) keep = null;
  else if (focus) {
    var charTop = wikiCmModule.readingCharTop(doc, focus.x, focus.y);
    keep = { anchor: wikiCmModule.readingAnchor(doc, focus.x, focus.y), top: charTop != null ? charTop : focus.y - 10 };
  } else keep = wikiReadingTop(doc);
  doc.dataset.editing = '1'; doc.dataset.source = '0'; doc.dataset.editor = 'cm'; doc.dataset.wikiEditSession = String(++wikiEditSession);
  doc.contentEditable = 'false';
  // 点下去时浏览器在阅读视图里放了一个原生的选区；阅读视图换掉后，WebKit（桌面应用）把它挪到新内容里的某处，编辑器读到它，
  // 光标就从点的那个字跑到了别的行（第八十轮：点正文第二行，光标落在上面的标题上）。换之前先清掉
  try { var nativeSel = window.getSelection && window.getSelection(); if (nativeSel && nativeSel.rangeCount) nativeSel.removeAllRanges(); } catch (e) {}
  doc.innerHTML = '<div class="zq-wiki-cm"></div>';
  placeWikiTitle(doc);
  wikiCm = { page: p, handle: wikiCmModule.mountWikiEditor(doc.querySelector('.zq-wiki-cm'), {
    markdown: markdown, readOnly: wikiReadOnly(),
    titles: function () { return (state.wikiPages || []).map(function (x) { return x.title; }); },
    // 第八十轮：和页名重复的第一行标题在编辑器里也藏起来（阅读时本来就藏）；单击渲染出来的链接打开它（原来只放光标，一点正文就进编辑，链接全都点不动）
    title: function () { return (state.wikiCur === p ? state.wikiCur : p).title; },
    onOpenUrl: function (raw) {
      var href = wikiExternalUrl(raw);
      if (!href) { toast('链接地址无效，请使用完整的 HTTP(S) 网址', 'error'); return; }
      window.open(href, '_blank', 'noopener,noreferrer');
    },
    placeholder: '空白页，直接开始写',
    onNavigate: function (title) { var target = (state.wikiPages || []).find(function (x) { return x.title === title; }); if (target) paintWikiDoc(target); else toast('还没有「' + title + '」这一页'); },
    onChange: function () { doc.dispatchEvent(new Event('input', { bubbles: true })); },
    // 第七十三轮：粘贴 / 拖进的图片走同一个上传；图片、表格用阅读模式同一个渲染画；代码块用同一套颜色
    onImage: function (file, from, to) { insertWikiImage(file, { from: from, to: to }); },
    renderBlock: renderMarkdown,
    hydrate: function (el) { renderMathIn(el, true); },
    codeTokens: function (code, lang) { return codeTokens ? codeTokens(code, lang) : []; }
  }) };
  showWikiActionBar();
  doc.scrollTop = scroll;
  var back = fresh && opts.view;
  if (back && back.cmAnchor && doc.getBoundingClientRect) {
    var pos = wikiCmModule.sourcePosition(markdown, back.cmAnchor);
    if (pos != null) wikiCm.handle.alignPos(pos, doc.getBoundingClientRect().top + (back.anchorOffset || 0), doc, back.cmAnchor.text);
  } else if (back) doc.scrollTop = back.scrollTop || 0;
  var at = keep && keep.anchor ? wikiCmModule.sourcePosition(markdown, keep.anchor) : null;
  if (focus) { if (at != null) wikiCm.handle.focusPos(at, keep.top, doc); else wikiCm.handle.focusAt(focus.x, focus.y); }
  else if (at != null) wikiCm.handle.alignPos(at, keep.top, doc, keep.anchor.text);
}
function wikiCmToolbar(cmd) {
  var handle = wikiCm.handle;
  if (cmd === 'bold') handle.wrap('**');
  else if (cmd === 'italic') handle.wrap('*');
  else if (cmd === 'underline') handle.wrap('<u>', '</u>');
  else if (cmd === 'code') handle.wrap('`');
  else if (cmd === 'image') chooseWikiImage();
  else if (cmd === 'math') handle.insert('\n$$\n\n$$\n');
  else if (cmd === 'source') toggleWikiSource();   // 说一句编辑器里就是原文（第八十轮：原来漏了，点「源码」说「编辑器还没接这个按钮」）
  else if (cmd === 'link' || cmd === 'ref') {
    // 弹窗回来时还得是同一个编辑会话（第七十四轮 review：原来换了页 / 取消了也往拆掉的编辑器里写）；选中的字做链接文字
    var editContext = wikiEditingContext($('#zq-doc'));
    askText({ title: '插入链接', label: '链接地址', placeholder: 'https://…', okText: '插入' }).then(function (url) {
      if (!url || !url.trim() || !isWikiEditingContext(editContext)) return;
      var href = wikiExternalUrl(url.trim());
      if (!href) { toast('链接地址无效，请使用完整的 HTTP(S) 网址', 'error'); return; }
      handle.link(href);
    });
  } else toast('编辑器还没接这个按钮（' + cmd + '）');
}
function wikiToolbar(cmd) {
  // 删除本页（第八十三轮从原来底上那一条挪到工具栏；系统页不给，syncWikiEditMode 藏起来，后端也拦）
  if (cmd === 'delete') { if (state.wikiCur && !isSystemWikiPage(state.wikiCur)) deleteWikiPage(state.wikiCur); return; }
  if (!ensureWikiEditing()) return;
  var doc = $('#zq-doc');
  if (wikiCmActive(doc)) { wikiCmToolbar(cmd); return; }
  if (cmd === 'image') { chooseWikiImage(); return; }
  var editContext = wikiEditingContext(doc);
  if (doc.dataset.source === '1' && cmd !== 'source') return;
  if (cmd === 'bold') document.execCommand('bold');
  else if (cmd === 'italic') document.execCommand('italic');
  else if (cmd === 'underline') document.execCommand('underline');
  else if (cmd === 'code') { var s = window.getSelection().toString(); if (s) document.execCommand('insertHTML', false, '<code>' + esc(s) + '</code>'); }
  else if (cmd === 'link') {
    // 弹窗会夺走 contentEditable 焦点，先存选区、恢复后再 createLink
    var sel0 = window.getSelection();
    var savedRange = sel0.rangeCount ? sel0.getRangeAt(0).cloneRange() : null;
    askText({ title: '插入链接', label: '链接地址', placeholder: 'https://…', okText: '插入' }).then(function (url) {
      if (!isWikiEditingContext(editContext)) return;
      if (!url || !url.trim()) return;
      var href = wikiExternalUrl(url);
      if (!href) { toast('链接地址无效，请使用完整的 HTTP(S) 网址', 'error'); return; }
      doc.focus({ preventScroll: true });
      if (savedRange) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
      document.execCommand('createLink', false, href);
    });
  }
  else if (cmd === 'math') {
    var selM = window.getSelection();
    var savedM = selM.rangeCount ? selM.getRangeAt(0).cloneRange() : null;
    askText({ title: '插入公式块', label: 'LaTeX 公式', placeholder: '例如：\\int_a^b f(x)\\,dx', hint: '行内公式可直接在正文里写 $...$，保存后自动渲染。', okText: '插入' }).then(function (tex) {
      if (!isWikiEditingContext(editContext)) return;
      if (!tex || !tex.trim()) return;
      doc.focus({ preventScroll: true });
      if (savedM) { var sm = window.getSelection(); sm.removeAllRanges(); sm.addRange(savedM); }
      document.execCommand('insertHTML', false, mathBlockHtml(tex.trim()) + '<p><br></p>');
      renderMathIn(doc);
    });
  }
  else if (cmd === 'ref') {
    var selR = window.getSelection();
    var savedR = selR.rangeCount ? selR.getRangeAt(0).cloneRange() : null;
    var m = openModal({
      title: '插入参考链接',
      bodyHtml:
        '<div class="zq-field"><label class="zq-label">显示标题</label><input id="zq-ref-title" class="zq-input" placeholder="例如：公司内部知识库"></div>'
        + '<div class="zq-field"><label class="zq-label">链接地址</label><input id="zq-ref-url" class="zq-input" placeholder="https://…"></div>'
        + '<div class="zq-modal-actions"><button class="zq-btn-ghost" id="zq-ref-cancel">取消</button><button class="zq-btn" id="zq-ref-ok">插入</button></div>',
      onMount: function (body, handle) {
        body.querySelector('#zq-ref-cancel').onclick = handle.close;
        body.querySelector('#zq-ref-ok').onclick = function () {
          if (!isWikiEditingContext(editContext)) { handle.close(); return; }
          var t = body.querySelector('#zq-ref-title').value.trim();
          var u = body.querySelector('#zq-ref-url').value.trim();
          if (!u) return toast('请填写链接地址', 'error');
          if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
          u = wikiExternalUrl(u);
          if (!u) return toast('链接地址无效，请使用完整的 HTTP(S) 网址', 'error');
          handle.close();
          doc.focus({ preventScroll: true });
          if (savedR) { var sr = window.getSelection(); sr.removeAllRanges(); sr.addRange(savedR); }
          document.execCommand('insertHTML', false, '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(t || u) + '</a>&nbsp;');
        };
        body.querySelector('#zq-ref-title').focus();
      }
    });
  }
  else if (cmd === 'source') toggleWikiSource();
}
/** 「源码」按钮按下的样子（第五十五轮换成图标之后，看不出现在是源码还是排版 —— 按下就是源码） */
function setSourcePressed(on) {
  var b = $('#zq-wiki-source'); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
}
/**
 * 正文第一行是一级标题、而且和页名一字不差（第五十五轮）：读的时候不显示第二遍 —— 页名就在上面，一页名字连着出现两遍。
 * 只挂一个类（阅读和排版编辑都藏起来），内容照样留着、保存时原样写回去；源码模式可以修改它。
 */
function markDuplicateTitle(doc, title) {
  var first = doc && doc.querySelector('.zq-md > h1:first-child');
  if (first && String(first.textContent || '').trim() === String(title || '').trim()) first.classList.add('zq-dup-title');
}
/**
 * 新建的页只有一行和页名重复的标题（第八十轮）：读的时候藏起来之后一片空白，看不出这是一页、也看不出能写。
 * 说一句；它不是正文 —— 点它就是点正文（进编辑），新编辑器编辑的是原文、简易编辑进编辑前先拿掉它，都不会被存进去。
 */
function wikiEmptyHint() { return wikiReadOnly() ? '这一页还是空的' : '这一页还是空的，点这里开始写'; }   // 只读时点了不会进编辑，不说「点这里」
function markEmptyWikiPage(doc) {
  if (!doc) return;
  var dup = doc.querySelector('.zq-dup-title');
  var text = String(doc.textContent || '');
  if (dup) text = text.replace(dup.textContent || '', '');
  if (text.trim() || doc.querySelector('img, table, input, .zq-embed, .katex')) return;
  var hint = document.createElement('p');
  hint.className = 'zq-wiki-empty';
  hint.textContent = wikiEmptyHint();
  (doc.querySelector('.zq-md') || doc).appendChild(hint);
}
function toggleWikiSource() {
  var doc = $('#zq-doc'); if (!doc || !ensureWikiEditing()) return;
  if (wikiCmActive(doc)) { toast('编辑器里显示的就是 Markdown 原文：光标所在的地方露出语法'); return; }
  if (doc.dataset.source === '1') {
    var ta = $('#zq-src-ta'); var md = ta ? ta.value : '';
    var view = doc._wikiSourceView;
    doc._wikiSourceView = null;
    doc._wikiPendingView = view ? { view: view, page: state.wikiCur, auth: token(), expires: Date.now() + 30000 } : null;
    doc.dataset.source = '0'; doc.contentEditable = 'true';
    doc.innerHTML = renderMarkdown(md); markDuplicateTitle(doc, state.wikiCur && state.wikiCur.title); placeWikiTitle(doc); renderMathIn(doc); doc.focus({ preventScroll: true });
    syncWikiEditMode(doc);
    wireWikiLinks(doc);
    if (view) restoreWikiView(doc, view);
    setSourcePressed(false);
  } else {
    doc._wikiSourceView = captureWikiView(doc);
    var md2 = htmlToMarkdown(doc);
    doc.dataset.source = '1'; doc.contentEditable = 'false';
    setSourcePressed(true);
    doc.innerHTML = '<textarea id="zq-src-ta" aria-label="Markdown 源码"></textarea>';   // 样子在样式表的 #zq-src-ta
    placeWikiTitle(doc);
    $('#zq-src-ta').value = md2;
    $('#zq-src-ta').focus({ preventScroll: true });
  }
}
// ── 自动保存（第八十三轮）────────────────────────────────────────────
// 像 Obsidian：打字停下 1 秒存一次，一直在打最多 5 秒存一次；切页、关标签、开只读、焦点离开正文、页面藏到后台时马上存。
// 存的时候不重画、不动光标和滚动（原来点「保存」把编辑器拆掉、重画阅读视图，正在改的那段往上跳 33px，第八十三轮量的）。
// 一页同时只有一个保存在路上：回来以后接着存最新的（版本号是上一次回来的那个）。版本号对不上（412，别处改过）就停下、照实说，不拿旧版本盖掉；
// 没存上（断网、服务器忙）说原因、过一会儿自己再试 —— 先原样重发上一次（同一个幂等键：那一次其实存上了的话服务器交回上次的结果，版本号对得上）。
// 打的字照旧先存在浏览器里（drafts，第十五轮）：刷新、断网、关页都还在。
var WIKI_SAVE_IDLE_MS = 1000, WIKI_SAVE_MAX_MS = 5000, WIKI_SAVE_RETRY_MS = 10000;
var wikiSaveTimer = 0, wikiSaveSince = 0, wikiRetryTimer = 0;
function scheduleWikiSave() {
  var p = state.wikiCur;
  if (!p || p.id == null || wikiReadOnly()) return;
  if (p._saveConflict) { paintWikiSaveState(p); return; }
  var now = Date.now();
  if (!wikiSaveSince) wikiSaveSince = now;
  clearTimeout(wikiSaveTimer);
  wikiSaveTimer = setTimeout(flushWikiSave, Math.max(0, Math.min(WIKI_SAVE_IDLE_MS, wikiSaveSince + WIKI_SAVE_MAX_MS - now)));
  paintWikiSaveState(p);
}
/** 马上存当前页（有没存的话）。返回这一次保存的 Promise */
function flushWikiSave() {
  clearTimeout(wikiSaveTimer); wikiSaveTimer = 0; wikiSaveSince = 0;
  var p = state.wikiCur, md = currentWikiMarkdown();
  if (!p || p.id == null || md == null) return Promise.resolve();
  return saveWikiContent(p, md);
}
function isWikiConflict(e) { return !!e && Number(e.code) === 412; }
function saveWikiContent(p, md) {
  if (p._saving) { p._saveNext = md; return p._saving; }
  if (p._saveConflict) { paintWikiSaveState(p); return Promise.resolve(); }
  if (p._retryMd != null && p._retryMd !== md) {
    // 上一次没收到回应：先原样重发那一次，再存现在的
    var later = md; md = p._retryMd; p._saveNext = later;
  }
  if (md === (p.content || '') && !p._pendingTitle && p._draftBase == null) { settleWikiSaved(p, md); return Promise.resolve(); }
  if (!String(md).trim()) { p._saveEmpty = true; paintWikiSaveState(p); return Promise.resolve(); }   // 后端不收空正文：删整页用工具栏的「删除本页」
  p._saveEmpty = false;
  var base = p._draftBase != null ? p._draftBase : p.version, auth = token(), title = p._pendingTitle || p.title;
  clearTimeout(wikiRetryTimer); wikiRetryTimer = 0;
  p._retryMd = md;
  p._saving = api.put('/knowledge/pages/' + p.id, { title: title, content: md, pageType: p.pageType, parentId: p.parentId, sortOrder: p.sortOrder, pinned: p.pinned, version: base })
    .then(function (updated) {
      if (token() !== auth) return;
      p._retryMd = null; p._saveError = null; p._draftBase = null;
      p.content = updated && updated.content != null ? updated.content : md;
      if (updated && updated.version != null) p.version = updated.version;
      if (updated && updated.updatedAt) p.updatedAt = updated.updatedAt;
      if (p._pendingTitle && (!updated || !updated.title || updated.title === p._pendingTitle)) {
        p.title = p._pendingTitle; p._pendingTitle = null;
        if (state.wikiCur === p) { var titleEl = wikiTitleEl(); if (titleEl) titleEl.textContent = p.title; }
        paintWikiTree(); paintWikiTabs(); toast('名称已更新');
      }
      settleWikiSaved(p, md, base);
    }, function (e) {
      if (token() !== auth) return;
      if (state.wikiCur === p && state.wikiDirty) saveWikiDraftNow();
      if (isWikiConflict(e)) {
        p._retryMd = null; p._saveConflict = true; p._saveNext = null;
        if (p._pendingTitle && state.wikiCur === p) { var t = wikiTitleEl(); if (t) t.textContent = p.title; }
        p._pendingTitle = null;
      } else {
        p._saveError = (e && e.message) || '没存上';
        if (!e || !e.uncertain) p._retryMd = null;   // 确定没做的：下一次直接存最新的
        // 断网、服务器忙、回应丢了才过一会儿自己再试；业务上拒了的（原样再发还是拒）等人改了再存、或者点「再试一次」
        if (e && (e.retryable || e.uncertain || e.network)) {
          clearTimeout(wikiRetryTimer);
          wikiRetryTimer = setTimeout(function () { if (state.wikiCur === p && !p._saving) flushWikiSave(); }, WIKI_SAVE_RETRY_MS);
        }
      }
      paintWikiSaveState(p);
    })
    .finally(function () {
      p._saving = null;
      var next = p._saveNext; p._saveNext = null;
      if (next != null && !p._saveConflict && !p._saveError) saveWikiContent(p, next);
      else paintWikiSaveState(p);
    });
  paintWikiSaveState(p);
  return p._saving;
}
/** 存上了：编辑器里还是这一份就不再「没保存」、浏览器里的草稿也清掉；保存期间又改了就留着，等下一次。
 *  留着的草稿是在刚存上的那个版本上改的：版本号跟着换成新的 —— 不然回到这一页时草稿的版本对不上，被当成「别处改过」 */
function settleWikiSaved(p, md, base) {
  var current = state.wikiCur === p ? currentWikiMarkdown() : null;
  if (current == null || current === md) {
    if (state.wikiCur === p) state.wikiDirty = false;
    drafts.clearIf(wikiDraftKey(p), md);
  } else saveWikiDraftNow();   // 保存期间又改了：新的那份马上进浏览器的草稿（版本号已经是刚存上的），下一次自动保存再上服务器
  var left = drafts.load(wikiDraftKey(p));
  if (left && left.text !== md && base != null && Number(left.base) === Number(base)) drafts.save(wikiDraftKey(p), left.text, { base: p.version, title: p.title });
  paintWikiSaveState(p);
}
/** 页名旁边一小行：正在保存… / 已保存 / 没存上（原因，会自己再试）/ 别处改过（停下了，给两个办法） */
function paintWikiSaveState(p) {
  var el = $('#zq-wiki-save-state'); if (!el) return;
  if (!p || state.wikiCur !== p || p.id == null) { el.textContent = ''; el.dataset.state = ''; return; }
  var html = '', kind = '';
  if (p._saveConflict) {
    kind = 'conflict';
    html = '<span>这一页在别处被改过，没有自动保存</span><button type="button" class="zq-btn-ghost zq-sm" data-save-act="mine">用我的覆盖</button>'
      + '<button type="button" class="zq-btn-ghost zq-sm" data-save-act="theirs">载入别处的版本</button>';
  } else if (p._saveEmpty) { kind = 'empty'; html = '正文是空的，没有保存'; }
  else if (p._saving) { kind = 'saving'; html = '正在保存…'; }
  else if (p._saveError) { kind = 'error'; html = '<span>没存上：' + esc(p._saveError) + '，会自己再试</span><button type="button" class="zq-btn-ghost zq-sm" data-save-act="retry">再试一次</button>'; }
  else if (state.wikiDirty) { kind = 'dirty'; html = ''; }
  else if (p.version != null && p._everEdited) { kind = 'saved'; html = '已保存'; }
  if (el.dataset.state === kind && el._html === html) return;
  el.dataset.state = kind; el._html = html; el.innerHTML = html;
  $all('[data-save-act]', el).forEach(function (b) {
    b.onclick = function () {
      var act = b.getAttribute('data-save-act');
      if (act === 'retry') { p._saveError = null; flushWikiSave(); }
      else if (act === 'mine') resolveWikiConflictMine(p);
      else if (act === 'theirs') resolveWikiConflictTheirs(p);
    };
  });
}
/** 「用我的覆盖」：先问一句，取回现在的版本号，用编辑器里的这一份存上去 */
async function resolveWikiConflictMine(p) {
  var ok = await askConfirm({
    title: '用你的这一版覆盖',
    message: '这一页在别处（另一个窗口、另一台设备或 AI）被改过。覆盖会用编辑器里的这一版替换现在的内容 —— 别处后来加的会没了。\n\n想先对照的话点「取消」，在另一个标签页打开这一页看看现在是什么样。',
    okText: '用我的这一版覆盖', danger: true
  });
  if (!ok || state.wikiCur !== p) return;
  safe('覆盖知识页', async function () {
    var latest = await api.get('/knowledge/pages/' + p.id);
    if (state.wikiCur !== p) return;
    p.version = latest.version; p._draftBase = null; p._saveConflict = false; p.content = latest.content;
    var md = currentWikiMarkdown();
    if (md != null) await saveWikiContent(p, md);
  });
}
/** 「载入别处的版本」：编辑器里的这一份先留在浏览器的草稿里（顶上那条「恢复 / 丢弃」还找得回来），重新取这一页 */
function resolveWikiConflictTheirs(p) {
  if (state.wikiDirty) saveWikiDraftNow();
  p._saveConflict = false; p._draftBase = null; p._full = false; p._retryMd = null; p._saveNext = null;
  state.wikiDirty = false;
  paintWikiDoc(p, { history: true });
}
/** 原来底上浮着的「保存 / 取消 / 删除本页」那一条（第八十三轮去掉：自动保存；删除在工具栏）。只剩同步开关和状态 */
function showWikiActionBar() {
  var doc = $('#zq-doc'); if (!doc) return;
  syncWikiEditMode(doc);
  paintWikiSaveState(state.wikiCur);
}
function isSystemWikiPage(p) { return !!p && ['INDEX', 'LOG', 'SCHEMA'].indexOf(String(p.pageType || '').toUpperCase()) >= 0; }
// 删除知识页：action bar 按钮与右键菜单共用（系统页由调用方隐藏入口，后端也会拦截）
async function deleteWikiPage(p) {
  if (!p) return;
  if (await askConfirm({ title: '删除知识页', message: '删除「' + (p.title || '') + '」？它的直接子页会自动迁移到上级目录，指向它的双链会变成悬空链接。', okText: '删除', danger: true })) {
    safe('删除知识页', async function () { await api.del('/knowledge/pages/' + p.id + '?version=' + encodeURIComponent(p.version)); await bootKnowledge(); toast('已删除'); });
  }
}
// 一个 ZIP 根目录下放笔记、子目录和原始附件；导入时能还原关系。
async function exportWikiMarkdown() {
  var currentAtOpen = state.wikiCur;
  var selected = await new Promise(function (resolve) {
    var done = false;
    openModal({
      title: '导出知识库 ZIP',
      bodyHtml: '<p class="zq-wiki-note">Markdown 笔记、目录、图片与附件会放进同一个 wiki 文件夹。</p>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" data-vault-export="cancel">取消</button>'
        + (currentAtOpen ? '<button type="button" class="zq-btn-ghost" data-vault-export="current">当前页及子页</button>' : '')
        + '<button type="button" class="zq-btn" data-vault-export="all">整个知识库</button></div>',
      onMount: function (body, handle) {
        $all('[data-vault-export]', body).forEach(function (button) {
          button.onclick = function () {
            if (done) return;
            done = true;
            var choice = button.dataset.vaultExport;
            handle.close();
            resolve(choice);
          };
        });
      },
      onClose: function () { if (!done) { done = true; resolve('cancel'); } }
    });
  });
  if (selected === 'cancel') return;
  var n = notice('正在打包知识 Wiki…');
  try {
    var path = '/knowledge/vault/export.zip' + (selected === 'current'
      ? '?rootPageId=' + encodeURIComponent(currentAtOpen.id) : '');
    var downloaded = await api.download(path);
    var blob = downloaded.blob;
    var fname = selected === 'current' ? 'zhiqu-wiki-page.zip' : 'zhiqu-wiki-vault.zip';
    if (window.showSaveFilePicker) {
      try {
        var handle = await window.showSaveFilePicker({ suggestedName: fname, types: [{ description: 'Zip 压缩包', accept: { 'application/zip': ['.zip'] } }] });
        var writable = await handle.createWritable();
        await writable.write(blob); await writable.close();
        n.update('已导出：' + fname, { done: true });
        return;
      } catch (e2) {
        if (e2 && e2.name === 'AbortError') { n.close(); return; }
      }
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    n.update('已开始下载：' + fname, { done: true });
  } catch (e) {
    n.update('导出失败：' + (e.message || '未知错误'), { error: true });
  }
}
function importWikiVault() {
  var current = state.wikiCur;
  var closed = false, selectedFile = null, preview = null, confirmedKey = null, busy = false, selectionVersion = 0;
  openModal({
    title: '导入知识库 ZIP',
    width: '620px',
    bodyHtml: '<p class="zq-wiki-note">选择 Obsidian 风格 ZIP。先预览目录、双链、图片和重名处理，确认后才新增页面；现有页面不会被覆盖。</p>'
      + '<div class="zq-field"><label class="zq-label" for="zq-vault-pick">ZIP 文件</label>'
      + '<div class="zq-vault-file"><input id="zq-vault-file" type="file" accept=".zip,application/zip" hidden>'
      + '<button type="button" class="zq-btn-ghost" id="zq-vault-pick" aria-describedby="zq-vault-selected">' + icon('paperclip') + ' 选择 ZIP 文件</button>'
      + '<span id="zq-vault-selected" aria-live="polite">尚未选择文件</span></div></div>'
      + '<div class="zq-field"><label class="zq-label" for="zq-vault-parent">导入位置</label><select id="zq-vault-parent" class="zq-select"><option value="root">知识库根目录</option>'
      + (current && !isSystemWikiPage(current) ? '<option value="current">当前页「' + esc(current.title) + '」下面</option>' : '')
      + '</select></div>'
      + '<div id="zq-vault-preview"></div>'
      + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-vault-cancel">取消</button>'
      + '<button type="button" class="zq-btn-ghost" id="zq-vault-check">预览 ZIP</button>'
      + '<button type="button" class="zq-btn" id="zq-vault-confirm" disabled>确认导入</button></div>',
    onMount: function (body, handle) {
      var fileInput = $('#zq-vault-file', body), parentInput = $('#zq-vault-parent', body);
      var output = $('#zq-vault-preview', body), check = $('#zq-vault-check', body), confirm = $('#zq-vault-confirm', body);
      var fileLabel = $('#zq-vault-selected', body), pick = $('#zq-vault-pick', body);
      $('#zq-vault-cancel', body).onclick = handle.close;
      function invalidate() {
        selectionVersion++;
        preview = null; confirmedKey = null;
        confirm.disabled = true;
        output.textContent = '';
      }
      pick.onclick = function () { fileInput.click(); };
      fileInput.onchange = function () {
        selectedFile = fileInput.files && fileInput.files[0]; invalidate();
        fileLabel.textContent = selectedFile ? selectedFile.name + ' · ' + (selectedFile.size / 1024 / 1024).toFixed(2) + ' MiB' : '尚未选择文件';
      };
      parentInput.onchange = invalidate;
      async function fields() {
        if (parentInput.value !== 'current') return {};
        if (!current) throw new Error('当前页已经关闭，请重新打开导入窗口');
        var detail = await api.get('/knowledge/pages/' + current.id);
        return { parentId: current.id, parentVersion: detail.version };
      }
      check.onclick = function () {
        if (busy) return;
        var file = selectedFile;
        if (!file || !/\.zip$/i.test(file.name || '') || file.size > 20 * 1024 * 1024) {
          toast('请选择不超过 20 MiB 的 ZIP 文件', 'error'); return;
        }
        busy = true; check.disabled = true; confirm.disabled = true;
        var requestedVersion = selectionVersion;
        safe('预览知识库 ZIP', async function () {
          var target = await fields();
          var result = await api.upload('/knowledge/vault/import/preview', file, target);
          if (closed || requestedVersion !== selectionVersion) return;
          preview = { result: result, file: file, target: target };
          confirmedKey = 'ui-vault-' + (typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
          var items = (result.pages || []).slice(0, 30).map(function (page) {
            return '<li>' + esc(page.path) + (page.title !== page.originalTitle ? ' → ' + esc(page.title) : '')
              + (page.folder ? '（目录）' : '') + '</li>';
          }).join('');
          var warnings = (result.warnings || []).slice(0, 20).map(function (warning) {
            return '<li>' + esc(warning) + '</li>';
          }).join('');
          output.innerHTML = '<p>将新增 ' + Number(result.pageCount || 0) + ' 页、'
            + Number(result.attachmentCount || 0) + ' 个附件、' + Number(result.relationshipCount || 0)
            + ' 条双链。</p><ul>' + items + '</ul>'
            + (Number(result.pageCount || 0) > 30 ? '<p>其余页面未在此处展开。</p>' : '')
            + (warnings ? '<p>需要留意：</p><ul>' + warnings + '</ul>' : '');
          confirm.disabled = !result.previewToken;
        }).finally(function () { busy = false; if (!closed) check.disabled = false; });
      };
      confirm.onclick = function () {
        if (closed || busy || !preview || !confirmedKey) return;
        busy = true; confirm.disabled = true; check.disabled = true;
        pick.disabled = true; fileInput.disabled = true; parentInput.disabled = true;
        safe('导入知识库 ZIP', async function () {
          var fieldsToSend = Object.assign({}, preview.target, { previewToken: preview.result.previewToken });
          var result = await api.upload('/knowledge/vault/import/confirm', preview.file, fieldsToSend,
            { 'Idempotency-Key': confirmedKey });
          // 服务端已确认成功；后续只是刷新当前视图。即使树刷新断网，也不能把已提交的导入报成失败。
          var summary = '已导入 ' + Number(result && result.pageCount || 0) + ' 页和 '
            + Number(result && result.attachmentCount || 0) + ' 个附件';
          handle.close();
          try {
            if (state.wikiDirty) { saveWikiDraftNow(); flushWikiSave(); }
            state.wikiPages = flattenKnowledge((await api.get('/knowledge/document-tree')) || []);
            paintWikiTree();
            var firstId = result && result.pageIds && result.pageIds[0];
            var first = (state.wikiPages || []).find(function (page) { return String(page.id) === String(firstId); });
            if (first) await paintWikiDoc(first, { newTab: true });
            toast(summary);
          } catch (refreshError) {
            console.error('[zhiqu-api] 导入成功后界面更新失败：' + (refreshError && refreshError.message || '未知错误'));
            toast(summary + '；界面更新失败，请刷新页面查看', 'error');
          }
        }).finally(function () {
          busy = false;
          if (!closed) {
            pick.disabled = false; fileInput.disabled = false; parentInput.disabled = false;
            check.disabled = false; confirm.disabled = !(preview && preview.result.previewToken);
          }
        });
      };
    },
    onClose: function () { closed = true; }
  });
}
var WIKI_PAGE_TYPES = [['GOAL', '目标'], ['PROJECT', '计划'], ['PREFERENCE', '偏好'], ['WEAKNESS', '薄弱点'], ['RESOURCE', '资料'], ['MEMORY', '对话摘要'], ['NOTE', '备注']];
// 按类型给初始骨架，对齐 claude design 模板各类型页面的结构
function wikiSkeleton(type, title) {
  var body = ({
    GOAL: '## 目标\n\n\n## 阶段里程碑\n- [ ] \n\n## 风险与对策\n- ',
    PROJECT: '## 时间块安排\n- \n\n## 每周检查点\n- [ ] ',
    PREFERENCE: '## 作息偏好\n- \n\n## 提醒方式\n- ',
    WEAKNESS: '## 高频错误\n- \n\n## 待攻克专题\n- [ ] ',
    RESOURCE: '## 教材与讲义\n- \n\n## 题库\n- \n\n## 参考链接\n- ',
    MEMORY: '## 结论\n\n\n## 待办\n- [ ] '
  })[type] || '';
  return '# ' + title + '\n\n' + body + '\n';
}
function createWikiPage() {
  var parentOptions = '<option value="">（根节点）</option>' + (state.wikiPages || []).filter(function (p) {
    return ['INDEX', 'LOG', 'SCHEMA'].indexOf(String(p.pageType || '').toUpperCase()) < 0;
  }).map(function (p) { return '<option value="' + p.id + '">' + esc(p.title) + '</option>'; }).join('');
  var typeOptions = WIKI_PAGE_TYPES.map(function (t) { return '<option value="' + t[0] + '"' + (t[0] === 'NOTE' ? ' selected' : '') + '>' + t[1] + '（' + t[0] + '）</option>'; }).join('');
  openModal({
    title: '新建知识页',
    bodyHtml:
      '<div class="zq-field"><label class="zq-label">页面标题</label><input id="zq-np-title" class="zq-input" placeholder="例如：英语作文素材库"></div>'
      + '<div class="zq-field"><label class="zq-label">类型</label><select id="zq-np-type" class="zq-select">' + typeOptions + '</select></div>'
      + '<div class="zq-field"><label class="zq-label">父节点</label><select id="zq-np-parent" class="zq-select">' + parentOptions + '</select></div>'
      + '<p class="zq-wiki-hint">将按类型生成初始结构（小节 / 任务项），创建后直接打开、可以接着写。</p>'
      + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-np-cancel">取消</button><button type="button" class="zq-btn" id="zq-np-ok">创建</button></div>',
    onMount: function (b, h) {
      $('#zq-np-cancel', b).onclick = h.close;
      $('#zq-np-ok', b).onclick = function () {
        var title = $('#zq-np-title', b).value.trim(); if (!title) return toast('请填写页面标题', 'error');
        var type = $('#zq-np-type', b).value;
        var parentId = $('#zq-np-parent', b).value;
        safe('新建知识页', async function () {
          var body = { title: title, content: wikiSkeleton(type, title), pageType: type };
          if (parentId) body.parentId = Number(parentId);
          var created = await api.post('/knowledge/pages', body);
          h.close(); await bootKnowledge();
          // 建完直接打开、进编辑（第八十轮：原来只说「已创建」，正文还停在原来那一页，要自己去目录里找）
          var page = created && (state.wikiPages || []).find(function (x) { return String(x.id) === String(created.id); });
          if (page) { await paintWikiDoc(page, { newTab: true }); enterWikiEdit(); }
          toast('已创建');
        });
      };
    }
  });
}
var wikiSourceViewToken = 0, wikiSourceViewModal = null;
var wikiSourceDraftRequests = Object.create(null);
function beginWikiSourceView() {
  var previous = wikiSourceViewModal;
  wikiSourceViewModal = null;
  wikiSourceViewToken++;
  if (previous) previous.close();
  return wikiSourceViewToken;
}
function openWikiSourceView(viewToken, options) {
  if (viewToken !== wikiSourceViewToken) return;
  var handle;
  options.onClose = function () {
    if (wikiSourceViewModal === handle) {
      wikiSourceViewModal = null;
      wikiSourceViewToken++;
    }
  };
  handle = openModal(options);
  wikiSourceViewModal = handle;
  var close = handle.mask && handle.mask.querySelector('.zq-modal-close');
  if (close && options.bodyHtml === WIKI_LOADING_HTML) { try { close.focus({ preventScroll: true }); } catch (e) {} }
  return handle;
}
function importWikiSource() {
  var viewToken = beginWikiSourceView();
  openWikiSourceView(viewToken, {
    title: '导入来源',
    bodyHtml:
      '<div class="zq-field"><label class="zq-label">来源标题</label><input id="zq-imp-title" class="zq-input" placeholder="例如：产品需求文档 v2"></div>'
      + '<div class="zq-field"><label class="zq-label">导入方式</label><select id="zq-imp-mode" class="zq-select"><option value="TEXT">粘贴文本 / 链接</option><option value="UPLOAD">上传文件解析</option></select></div>'
      + '<div id="zq-imp-text-box">'
      + '<div class="zq-field"><label class="zq-label">类型</label><select id="zq-imp-type" class="zq-select"><option value="NOTE">笔记 / 文本</option><option value="URL">网址链接</option><option value="FILE">资料摘录</option></select></div>'
      + '<div class="zq-field"><label class="zq-label">内容 / 链接</label><textarea id="zq-imp-content" class="zq-textarea" placeholder="粘贴文本，或填入 http/https 链接"></textarea></div>'
      + '</div>'
      + '<div id="zq-imp-file-box" hidden>'
      + '<div class="zq-field"><label class="zq-label" for="zq-imp-file">选择文件</label><input id="zq-imp-file" type="file" class="zq-input" accept=".pdf,.xlsx,.xls,.txt,.md,.csv,.json,.xml,.png,.jpg,.jpeg,.webp"></div>'
      + '<p class="zq-wiki-hint">pdf / xlsx / txt / md / csv / json / xml 会自动解析正文；图片仅记录文件信息，暂不做内容识别。</p>'
      + '</div>'
      + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-imp-cancel">取消</button><button type="button" class="zq-btn" id="zq-imp-ok">导入</button></div>',
    onMount: function (b, h) {
      var modeSel = $('#zq-imp-mode', b);
      modeSel.onchange = function () {
        var up = modeSel.value === 'UPLOAD';
        $('#zq-imp-text-box', b).hidden = up;
        $('#zq-imp-file-box', b).hidden = !up;
      };
      // 粘贴的一大段原文：弹窗被遮罩点掉、刷新、登录过期都还在（第十五轮）；导入成功才删
      var contentDraft = keepDraft($('#zq-imp-content', b), 'wiki.import.content');
      $('#zq-imp-cancel', b).onclick = h.close;
      var importButton = $('#zq-imp-ok', b);
      importButton.onclick = function () {
        if (importButton.disabled) return;
        var title = $('#zq-imp-title', b).value.trim();
        if (modeSel.value === 'UPLOAD') {
          var file = $('#zq-imp-file', b).files[0];
          if (!file) return toast('请选择要上传的文件', 'error');
          importButton.disabled = true;
          var n = notice('正在上传并解析「' + (title || file.name) + '」…');
          h.close();
          var uploadToken = wikiSourceViewToken;
          return safe('上传来源', async function () {
            var saved;
            try {
              saved = await api.upload('/knowledge/sources/upload', file, title ? { title: title } : {});
              n.update('来源解析完成' + truncatedNote(saved), { done: true });
            } catch (e) { n.update('解析失败：' + (e.message || '未知错误'), { error: true }); throw e; }
            if (uploadToken === wikiSourceViewToken) await showWikiSource(saved.id, saved);
          }).finally(function () { importButton.disabled = false; });
        }
        var content = $('#zq-imp-content', b).value;
        var type = $('#zq-imp-type', b).value;
        if (!title) return toast('请填写来源标题', 'error');
        importButton.disabled = true;
        return safe('导入来源', async function () {
          var saved = await api.post('/knowledge/sources', { title: title, content: content, sourceType: type });
          contentDraft.clear();
          var showSaved = viewToken === wikiSourceViewToken;
          h.close(); toast('来源已导入' + truncatedNote(saved));
          if (showSaved) await showWikiSource(saved.id, saved);
        }).finally(function () { importButton.disabled = false; });
      };
    }
  });
}
async function showWikiSources(page) {
  page = Math.max(1, Number(page) || 1);
  var viewToken = beginWikiSourceView();
  var handle = openWikiSourceView(viewToken, { title: '来源记录', width: '640px', bodyHtml: WIKI_LOADING_HTML });
  await safe('来源记录', async function () {
    var result;
    try { result = (await api.get('/knowledge/sources?page=' + page + '&size=20')) || {}; } catch (e) { handle.close(); throw e; }
    if (viewToken !== wikiSourceViewToken) return;
    var rows = Array.isArray(result.records) ? result.records : [];
    var total = Number(result.total) || 0;
    var pages = Math.max(1, Math.ceil(total / 20));
    fillWikiModal(handle, {
      title: '来源记录 · ' + total + ' 条',
      bodyHtml: '<p class="zq-wiki-note">导入的资料保存在这里。查看正文后，可生成待合入变更；确认合入之后才会成为知识页。</p>'
        + '<div class="zq-wiki-list">'
        + (rows.map(function (source) {
          return '<button type="button" class="zq-btn-ghost zq-wiki-source" data-source="' + esc(source.id) + '">'
            + '<strong>' + esc(source.title || '未命名来源') + '</strong>'
            + (source.createdAt ? '<span class="zq-wiki-source-when">' + esc(fmtDate(source.createdAt)) + '</span>' : '')
            + (source.summary ? '<span class="zq-wiki-source-sum">' + esc(source.summary) + '</span>' : '') + '</button>';
        }).join('') || empty('还没有来源记录，点「导入来源」添加资料。')) + '</div>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-sources-prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>'
        + '<span class="zq-wiki-pager">第 ' + page + ' / ' + pages + ' 页 · 每页 20 条</span>'
        + '<button type="button" class="zq-btn-ghost" id="zq-sources-next"' + (page >= pages ? ' disabled' : '') + '>下一页</button></div>',
      onMount: function (b, h) {
        $all('[data-source]', b).forEach(function (button) {
          button.onclick = function () { h.close(); return showWikiSource(button.dataset.source); };
        });
        $('#zq-sources-prev', b).onclick = function () { if (page > 1) { h.close(); return showWikiSources(page - 1); } };
        $('#zq-sources-next', b).onclick = function () { if (page < pages) { h.close(); return showWikiSources(page + 1); } };
      }
    });
  });
}
async function showWikiSource(id, saved) {
  var viewToken = beginWikiSourceView();
  var handle = openWikiSourceView(viewToken, { title: '来源', width: '720px', bodyHtml: WIKI_LOADING_HTML });
  await safe('查看来源', async function () {
    var source;
    try { source = await api.get('/knowledge/sources/' + encodeURIComponent(id)); } catch (e) { handle.close(); throw e; }
    if (viewToken !== wikiSourceViewToken) return;
    fillWikiModal(handle, {
      title: '来源 · ' + (source.title || '未命名来源'),
      bodyHtml: '<p class="zq-wiki-note">来源已保存。下方是保存的正文，生成变更后还需确认合入，才会写入知识库。' + esc(truncatedNote(saved)) + '</p>'
        + (source.sourceRef ? '<p class="zq-wiki-hint zq-wiki-ref">' + esc(source.sourceRef) + '</p>' : '')
        + '<pre class="zq-wiki-source-text">' + esc(source.content || '') + '</pre>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-source-list">来源记录</button><button type="button" class="zq-btn" id="zq-source-draft">生成待合入变更</button></div>',
      onMount: function (b, h) {
        $('#zq-source-list', b).onclick = function () { h.close(); return showWikiSources(); };
        var draftButton = $('#zq-source-draft', b);
        var requestKey = String(id), running = wikiSourceDraftRequests[requestKey];
        draftButton.disabled = !!running;
        if (running) running.then(function () { draftButton.disabled = false; }, function () { draftButton.disabled = false; });
        draftButton.onclick = function () {
          if (draftButton.disabled || wikiSourceDraftRequests[requestKey]) return;
          draftButton.disabled = true;
          var request = safe('生成待合入变更', async function () {
            await api.post('/knowledge/sources/' + encodeURIComponent(id) + '/patch-set', {});
            if (viewToken === wikiSourceViewToken) {
              h.close();
              await showWikiPatchSets();
            } else await refreshWikiPatchBadge();
          }).finally(function () {
            if (wikiSourceDraftRequests[requestKey] === request) delete wikiSourceDraftRequests[requestKey];
            draftButton.disabled = false;
          });
          wikiSourceDraftRequests[requestKey] = request;
          return request;
        };
      }
    });
  });
}
/** 来源原文超过上限时后端只存前面一段，并在回包里说 {kept, total} —— 这里把它说给用户，不让截断悄悄发生 */
function truncatedNote(saved) {
  var t = saved && saved.truncated;
  return t ? '（原文 ' + t.total + ' 字，只保存了前 ' + t.kept + ' 字）' : '';
}
async function runWikiLint() {
  await showWikiLoadingView('健康检查', { title: '健康检查' }, function () { return api.get('/knowledge/lint/report'); }, function (report) {
    var issues = wikiLintIssues(report);
    var count = issues.length;
    var listHtml = issues.slice(0, 20).map(function (text) {
      return '<div class="zq-wiki-issue">' + esc(text) + '</div>';
    }).join('');
    return wikiInfoSpec({
      html: count
        ? '<p class="zq-wiki-note">发现 ' + count + ' 个问题' + (count > 20 ? '（先列前 20 个）' : '') + '：</p><div class="zq-wiki-issues">' + listHtml + '</div>'
        : '<p class="zq-wiki-ok">' + icon('check') + '未发现问题，知识库链接完好。</p>'
    });
  });
}
/**
 * 后端 buildLintReport 给的是分好类的几组（第六十九轮之前这里读 issues / findings / items —— 一个都不存在，健康检查永远说「未发现问题」）。
 * 算问题的照维护规则那一页说的：悬空链接、孤立页、重复标题、过期计划；「没有来源」只是说明页面不是从对话来的，不算问题。
 */
function wikiLintIssues(report) {
  report = report || {};
  var titles = {};
  (state.wikiPages || []).forEach(function (page) { titles[page.id] = page.title; });
  var list = function (value) { return Array.isArray(value) ? value : []; };
  var issues = [];
  list(report.missingTargets).forEach(function (link) {
    issues.push('悬空链接：「' + (titles[link.sourcePageId] || '某一页') + '」里的 [[' + (link.targetTitle || '') + ']] 没有对应的页面');
  });
  list(report.orphanPages).forEach(function (page) { issues.push('孤立页：「' + (page.title || '') + '」没有链到别的页，也没有页链到它'); });
  list(report.duplicateTitles).forEach(function (group) {
    issues.push('重复标题：「' + (group.title || '') + '」有 ' + list(group.pages).length + ' 页同名，双链只会指向其中一页');
  });
  list(report.stalePlans).forEach(function (page) { issues.push('过期计划：「' + (page.title || '') + '」超过 90 天没有更新'); });
  return issues;
}
// 待合入变更按钮：显示真实的 PENDING patch-set 数量（预置的 “2” 是静态占位，已移除）
async function refreshWikiPatchBadge() {
  var b = $('#zq-patch-btn'); if (!b) return;
  try {
    paintWikiPatchBadge((await api.get('/knowledge/patch-sets?status=PENDING')) || []);
  } catch (e) { b.textContent = '待合入变更'; }
}
function paintWikiPatchBadge(list) {
  var b = $('#zq-patch-btn'); if (!b) return;
  var n = (list || []).length;
  b.textContent = n ? ('待合入变更 ' + n) : '待合入变更';
}
var WIKI_TYPE_COLOR = { GOAL: 'var(--zq-q2)', PROJECT: 'var(--zq-primary)', PREFERENCE: 'var(--zq-q4)', WEAKNESS: 'var(--zq-q1)', RESOURCE: 'var(--zq-q3)', MEMORY: 'var(--zq-accent)', INDEX: 'var(--zq-text3)', SCHEMA: 'var(--zq-text3)', LOG: 'var(--zq-text3)', NOTE: 'var(--zq-text2)' };
async function showWikiGraph() {
  await showWikiLoadingView('知识图谱', { title: '知识图谱', width: '620px' }, function () { return api.get('/knowledge/graph'); }, function (g) {
    var nodes = (g && g.nodes) || [];
    var links = (g && g.links) || [];
    if (!nodes.length) return wikiInfoSpec({ message: '还没有知识页，先创建几页并用 [[双链]] 互相引用吧。' });
    // 环形布局：入度高的页放内圈
    var W = 560, H = 420, cx = W / 2, cy = H / 2;
    var sorted = nodes.slice().sort(function (a, b) { return (b.degree || 0) - (a.degree || 0); });
    var pos = {};
    sorted.forEach(function (n, i) {
      var ring = i === 0 ? 0 : (i <= 6 ? 1 : 2);
      var radius = ring === 0 ? 0 : ring === 1 ? 118 : 180;
      var ringIdx = ring === 0 ? 0 : ring === 1 ? i - 1 : i - 7;
      var ringCount = ring === 0 ? 1 : ring === 1 ? Math.min(6, sorted.length - 1) : Math.max(1, sorted.length - 7);
      var angle = (ringIdx / ringCount) * Math.PI * 2 - Math.PI / 2;
      pos[n.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
    });
    var edgesSvg = links.map(function (l) {
      var s = pos[l.sourcePageId], t = pos[l.targetPageId];
      if (!s) return '';
      if (!t) { // 悬空链接：画到外圈的虚线短线
        return '<line x1="' + s.x + '" y1="' + s.y + '" x2="' + (s.x + 26) + '" y2="' + (s.y - 26) + '" stroke="var(--zq-bad)" stroke-width="1" stroke-dasharray="3,3" opacity=".6"/>';
      }
      return '<line x1="' + s.x + '" y1="' + s.y + '" x2="' + t.x + '" y2="' + t.y + '" stroke="var(--zq-border)" stroke-width="1.2" opacity=".8"/>';
    }).join('');
    var nodesSvg = sorted.map(function (n) {
      var p = pos[n.id];
      var r = Math.min(16, 7 + (n.degree || 0) * 2);
      var color = WIKI_TYPE_COLOR[String(n.type || 'NOTE').toUpperCase()] || 'var(--zq-text2)';
      var label = String(n.title || '').length > 9 ? String(n.title).slice(0, 8) + '…' : String(n.title || '');
      return '<g data-graph-node="' + n.id + '" class="zq-graph-node">'
        + '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="' + color + '" opacity=".88"><title>' + esc(n.title || '') + '</title></circle>'
        + '<text x="' + p.x + '" y="' + (p.y + r + 13) + '" text-anchor="middle" class="zq-graph-label">' + esc(label) + '</text></g>';
    }).join('');
    var legend = Object.keys(WIKI_TYPE_COLOR).filter(function (k) {
      return nodes.some(function (n) { return String(n.type || 'NOTE').toUpperCase() === k; });
    }).map(function (k) {
      // 类型色是数据（--c），点和字的样子在样式表的 .zq-graph-key
      return '<span class="zq-graph-key"><i style="--c:' + WIKI_TYPE_COLOR[k] + '"></i>' + k + '</span>';
    }).join('');
    var missing = (g && g.missingTargets && g.missingTargets.length) || 0;
    return {
      title: '知识图谱 · ' + nodes.length + ' 页 / ' + links.length + ' 链接',
      bodyHtml:
        '<div class="zq-graph"><svg viewBox="0 0 ' + W + ' ' + H + '">' + edgesSvg + nodesSvg + '</svg></div>'
        + '<div class="zq-graph-legend">' + legend + '</div>'
        + (missing ? '<p class="zq-graph-note" data-state="bad">' + missing + ' 个悬空链接（红色虚线），可运行「健康检查」查看明细。</p>' : '')
        + '<p class="zq-graph-note">节点大小 = 被引用次数 · 点击节点跳转到对应页面</p>',
      onMount: function (b, h) {
        $all('[data-graph-node]', b).forEach(function (gn) {
          gn.onclick = function () {
            var target = (state.wikiPages || []).find(function (x) { return String(x.id) === gn.getAttribute('data-graph-node'); });
            if (target) { h.close(); paintWikiDoc(target); }
          };
        });
      }
    };
  });
}
/**
 * 待合入变更：AI（或「从来源生成」）对 Wiki 的修改先成草稿，在这里逐组看过、确认合入或忽略（2026-10-03 走主流程）。
 * 原来这里只列标题，写着「逐条审阅与合入将在后续版本提供」—— 后端的合入 / 驳回接口一直都在，审阅界面只在零页面加载的旧
 * js/knowledge-wiki.js 里，于是「让 AI 写进知识库」走到底是死路：草稿永远合不进去。
 * 合入走后端那一套（行锁、基线核对：读过之后这一页被改过就拒绝并说明），这里不另做判断。
 */
var PATCH_ACTION_LABEL = { UPSERT: '新建或更新', CREATE: '新建', UPDATE: '更新', DELETE: '删除', MOVE: '移动' };
function patchSetCard(ps) {
  var items = Array.isArray(ps.items) ? ps.items : [];
  var itemHtml = items.map(function (it) {
    var action = PATCH_ACTION_LABEL[String(it.actionType || 'UPSERT').toUpperCase()] || it.actionType;
    return '<details class="zq-patch-item">'
      + '<summary><span class="zq-badge">' + esc(action) + '</span>'
      + '<strong>' + esc(it.title || '未命名页面') + '</strong></summary>'
      + '<div class="zq-rev-body">' + renderMarkdown(String(it.content || '')) + '</div></details>';
  }).join('') || '<p class="zq-wiki-hint">这组变更里没有页面。</p>';
  return '<section data-patch-set="' + esc(ps.id) + '" class="zq-patch">'
    + '<div class="zq-patch-head"><div class="zq-patch-what">'
    + '<strong>' + esc(ps.title || ('变更 #' + ps.id)) + '</strong>'
    + (ps.createdAt ? '<span class="zq-num zq-patch-when">' + esc(fmtDate(ps.createdAt)) + '</span>' : '')
    + (ps.summary ? '<p>' + esc(ps.summary) + '</p>' : '')
    + '</div><div class="zq-patch-acts">'
    + '<button type="button" class="zq-btn-ghost" data-patch-reject="' + esc(ps.id) + '">忽略</button>'
    + '<button type="button" class="zq-btn" data-patch-apply="' + esc(ps.id) + '">确认合入</button>'
    + '</div></div>' + itemHtml + '</section>';
}
async function showWikiPatchSets() {
  await showWikiLoadingView('待合入变更', { title: '待合入变更', width: '640px' }, function () { return api.get('/knowledge/patch-sets?status=PENDING'); }, function (list) {
    list = list || [];
    paintWikiPatchBadge(list);   // 角标就用这一份，不再为它多等一次同样的请求
    if (!list.length) return wikiInfoSpec({ message: '当前没有待合入的变更。AI 对知识库的修改建议会先出现在这里，确认后才写入正文。' });
    return {
      title: '待合入变更 · ' + list.length + ' 组',
      bodyHtml: '<p class="zq-wiki-note">点开每一页看看要写进去的内容；确认合入之后才会改动知识库，忽略的不会写入。</p>'
        + '<div class="zq-wiki-list is-patches">' + list.map(patchSetCard).join('') + '</div>',
      onMount: function (body, h) {
        function settle(id, verb, done) {
          var card = $('[data-patch-set="' + id + '"]', body);
          $all('button', card).forEach(function (x) { x.disabled = true; });
          safe(verb, async function () {
            await api.post('/knowledge/patch-sets/' + id + '/' + (verb === '合入变更' ? 'apply' : 'reject'), {});
            card.remove();
            toast(done);
            await refreshWikiPatchBadge();
            await bootKnowledge();
            if (!$('[data-patch-set]', body)) h.close();
          }).finally(function () { $all('button', card).forEach(function (x) { x.disabled = false; }); });
        }
        $all('[data-patch-apply]', body).forEach(function (b) { b.onclick = function () { settle(b.dataset.patchApply, '合入变更', '已合入知识库'); }; });
        $all('[data-patch-reject]', body).forEach(function (b) { b.onclick = function () { settle(b.dataset.patchReject, '忽略变更', '已忽略这组变更'); }; });
      }
    };
  });
}
function flattenKnowledge(nodes) {
  var out = [];
  function walk(n) {
    (Array.isArray(n) ? n : [n]).forEach(function (x) {
      if (!x) return;
      out.push(x);
      walk(x.children || []);
    });
  }
  walk(nodes);
  return out;
}
// 公式块 HTML：data-tex 存源码（esc 后），KaTeX 就绪后由 renderMathIn 真渲染，否则显示样式化源码
