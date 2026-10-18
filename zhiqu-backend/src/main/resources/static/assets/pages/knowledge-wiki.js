// 知识 Wiki —— 第三十六轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// Markdown 渲染那一套（renderMarkdown、代码块着色、公式、htmlToMarkdown）AI 助手也用，留在壳里经 zqShared 给。
// state.wiki* 照旧放在壳的 state 上（只有这里读写）。wiki-tabs-check.js 从这个文件里抠标签页那一段来跑（要把 paintWikiDoc 换成替身，
// 模块里的函数互相调用、从外面换不掉 —— 所以这一段没改成 import）。

let API, api, token, esc, $, $all, empty, fmtDate, safe, toast, notice, askConfirm, askText, showInfo, openModal, popMenu, state, drafts, keepDraft,
  renderMarkdown, renderMathIn, mathBlockHtml, htmlToMarkdown, openAttachmentPreview, icon, loadModule;
export function bind(sh) {
  ({ API, api, token, esc, $, $all, empty, fmtDate, safe, toast, notice, askConfirm, askText, showInfo, openModal, popMenu, state, drafts, keepDraft,
  renderMarkdown, renderMathIn, mathBlockHtml, htmlToMarkdown, openAttachmentPreview, icon, loadModule } = sh);
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
  if (wikiCmEnabled()) loadWikiCm();
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
  return { title: spec.title, bodyHtml: (spec.html || '<p style="margin:0 0 16px;font-size:13.5px;line-height:1.7;color:var(--zq-text2);white-space:pre-wrap;">' + esc(spec.message || '') + '</p>')
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
    return '<a data-wiki="' + p.id + '" style="display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:var(--zq-rs);cursor:pointer;background:' + (active ? 'var(--zq-tint)' : 'transparent') + ';"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:' + (active ? 'var(--zq-fw-medium)' : 'var(--zq-fw-regular)') + ';color:var(--zq-text2);">' + esc(p.title) + '</span></a>';
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
  // 正在编辑时点了目录里的别的页：原来改的字直接被新页面冲掉，一声不吭。先存成草稿，回到这一页时能恢复
  if (state.wikiDirty) saveWikiDraftNow();
  state.wikiDirty = false;
  removeWikiDraftBar();
  trackWikiNavigation(p, opts);
  state.wikiCur = p;
  removeWikiActionBar();
  var doc = $('#zq-doc'), title = $('#zq-doc-title');
  if (title) title.textContent = p.title || '知识页';
  // 等待新页正文时先退出旧页的编辑会话，不能把旧 DOM 的输入存成新页草稿。
  if (doc) {
    closeWikiCm(doc);
    doc.dataset.editing = '0'; doc.dataset.source = '0'; doc.dataset.loading = '1';
    doc.contentEditable = 'false';
    doc._wikiSourceView = null; doc._wikiPendingView = null;
    syncWikiEditMode(doc);
    if (!p._full && p.id != null) doc.innerHTML = empty('正在加载知识页…');
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
    doc.innerHTML = renderMarkdown(p.content || p.summary || '');
    markDuplicateTitle(doc, p.title);
    renderMathIn(doc);
    wireWikiLinks(doc);
    showWikiActionBar();
    if (opts.preserveView) restoreWikiView(doc, opts.preserveView);
  }
  var insp = $('#zq-insp');
  if (insp) {
    insp.innerHTML = '<div style="padding:12px 14px;font-size:12px;color:var(--zq-text2);line-height:1.6;">类型：' + esc(p.pageType || p.type || 'NOTE') + '<br>更新：' + esc(fmtDate(p.updatedAt)) + '<br><span style="color:var(--zq-text3);">点击正文即可编辑 · 开启「只读」可防止误改 · [[双链]]可跳转</span>'
      + wikiEditorSwitchHtml() + '</div>';
    wireWikiEditorSwitch(insp);
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
    if (state.wikiDraftTimer) clearTimeout(state.wikiDraftTimer);
    state.wikiDraftTimer = setTimeout(saveWikiDraftNow, 800);
  });
  window.addEventListener('pagehide', function () { if (state.wikiDirty) saveWikiDraftNow(); });
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
  bar.id = 'zq-wiki-draft';
  bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin:0 0 12px;padding:9px 12px;border:1px solid var(--zq-tint-strong);border-radius:var(--zq-rs);background:var(--zq-tint);font-size:12.5px;color:var(--zq-text);';
  var when = new Date(d.at);
  var moved = d.base != null && p.version != null && Number(d.base) !== Number(p.version);
  bar.innerHTML = '<span style="flex:1;">这一页有没保存的修改（' + esc((when.getMonth() + 1) + '/' + when.getDate() + ' ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0'))
    + '）' + (moved ? '。之后这一页被改过，恢复后保存时会先问你' : '') + '</span>'
    + '<button class="zq-btn" data-draft="restore" style="height:28px;">恢复</button><button class="zq-btn-ghost" data-draft="drop" style="height:28px;">丢弃</button>';
  doc.parentNode.insertBefore(bar, doc);
  $('[data-draft="restore"]', bar).onclick = function () {
    if (wikiReadOnly()) return toast('请先关闭只读开关再恢复草稿');
    removeWikiDraftBar();
    if (wikiCmEnabled()) enterWikiCmEdit(doc, p, d.text);
    else {
      enterWikiEdit();
      if (doc.dataset.source !== '1') toggleWikiSource();
      var ta = $('#zq-src-ta'); if (ta) ta.value = d.text;
    }
    p._draftBase = d.base != null ? d.base : p.version;
    state.wikiDirty = true;
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
  if (index === state.wikiTabIdx && state.wikiDirty) saveWikiDraftNow();
  state.wikiTabs.splice(index, 1);
  if (!state.wikiTabs.length) {
    state.wikiTabIdx = -1;
    state.wikiCur = null;
    saveWikiTabs();
    var doc = $('#zq-doc'), title = $('#zq-doc-title');
    if (doc) {
      doc.dataset.editing = '0'; doc.dataset.source = '0'; doc.dataset.loading = '0';
      doc.contentEditable = 'false'; state.wikiDirty = false;
      removeWikiActionBar(); syncWikiEditMode(doc);
      doc.innerHTML = empty('没有打开的页面 · 从左侧目录选一页，或点 + 新建标签');
    }
    if (title) title.textContent = '';
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
    return '<div data-wiki-tab="' + i + '" title="' + esc(t.title || '') + '" style="' +
      'display:flex;align-items:center;gap:6px;max-width:190px;padding:7px 8px 7px 12px;cursor:pointer;' +
      'border-right:1px solid var(--zq-border-soft);font-size:12.5px;white-space:nowrap;' +
      'background:' + (on ? 'var(--zq-card)' : 'transparent') + ';' +
      'color:' + (on ? 'var(--zq-text)' : 'var(--zq-text2)') + ';' +
      'font-weight:' + (on ? 'var(--zq-fw-medium)' : 'var(--zq-fw-regular)') + ';' +
      'box-shadow:' + (on ? 'inset 0 2px 0 var(--zq-primary)' : 'none') + ';">' +
      '<span style="overflow:hidden;text-overflow:ellipsis;">' + esc(t.title || '新标签页') + '</span>' +
      '<span data-wiki-tab-close="' + i + '" title="关闭" style="flex:0 0 auto;width:16px;height:16px;' +
      'display:flex;align-items:center;justify-content:center;border-radius:4px;' +
      'color:var(--zq-text3);font-size:13px;line-height:1;">' + icon('x') + '</span></div>';
  }).join('') +
    '<div data-wiki-tab-new="1" title="新标签页" style="display:flex;align-items:center;justify-content:center;' +
    'width:30px;flex:0 0 auto;cursor:pointer;color:var(--zq-text3);font-size:15px;">+</div>';

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
  // 没有历史时置灰而不是隐藏：按钮位置固定，标题才不会左右跳。
  if (back) { back.disabled = !(tab && tab.back.length); back.style.opacity = back.disabled ? '.35' : '1'; }
  if (fwd) { fwd.disabled = !(tab && tab.fwd.length); fwd.style.opacity = fwd.disabled ? '.35' : '1'; }
}

/** + 按钮：列出所有页面让用户挑一个，选中后在新标签打开。 */
function openWikiQuickSwitch() {
  var pages = state.wikiPages || [];
  var h = openModal({
    title: '在新标签页打开',
    width: 460,
    bodyHtml: '<input id="zq-qs-input" class="zq-input" placeholder="输入标题筛选…" style="width:100%;margin-bottom:10px;">' +
      '<div id="zq-qs-list" style="max-height:52vh;overflow:auto;display:flex;flex-direction:column;gap:2px;"></div>',
    onMount: function (body) {
      var input = $('#zq-qs-input', body), list = $('#zq-qs-list', body);
      function paint() {
        var q = (input.value || '').trim().toLowerCase();
        var hit = pages.filter(function (p) { return !q || (p.title || '').toLowerCase().indexOf(q) >= 0; });
        list.innerHTML = hit.map(function (p) {
          return '<a data-qs="' + p.id + '" style="display:block;padding:8px 10px;border-radius:var(--zq-rs);' +
            'cursor:pointer;font-size:13px;color:var(--zq-text2);">' + esc(p.title) + '</a>';
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
    // 编辑正文时 ⌘[ 是缩进之类的编辑操作，不抢
    if (doc && doc.dataset.editing === '1') return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === '[') { e.preventDefault(); wikiHistoryGo(-1); }
    else if (e.key === ']') { e.preventDefault(); wikiHistoryGo(1); }
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
  doc.style.cursor = 'text';
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
    enterWikiEdit();
    if (wikiCmActive(doc)) wikiCm.handle.focusAt(e.clientX, e.clientY);
    else caretAt(e.clientX, e.clientY);
  };
  var modeButton = $('#zq-wiki-mode');
  if (modeButton) modeButton.onclick = toggleWikiReadOnly;
  doc.addEventListener('paste', function (e) {
    if (wikiReadOnly() || doc.dataset.loading === '1' || wikiCmActive(doc)) return;   // 验证版：粘贴交给 CodeMirror（图片还没接）
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
    if (!cb || cb.type !== 'checkbox' || wikiCmActive(doc)) return;   // 验证版的勾选框自己改原文
    if (wikiReadOnly() || doc.dataset.loading === '1' || cb.closest && cb.closest('[data-embed-markdown]')) {
      cb.checked = typeof cb._wikiLockedChecked === 'boolean' ? cb._wikiLockedChecked : cb.defaultChecked; return;
    }
    if (!ensureWikiEditing()) return;
    var span = cb.nextElementSibling;
    if (span) { span.style.textDecoration = cb.checked ? 'line-through' : 'none'; span.style.color = cb.checked ? 'var(--zq-text3)' : 'var(--zq-text)'; }
    doc.dispatchEvent(new Event('input', { bubbles: true }));
  });
  var section = doc.closest('section'); if (!section) return;
  $all('[data-wiki-cmd]', section).forEach(function (b) {
    if (b.getAttribute('data-wiki-cmd') === 'image') b.onmousedown = function (e) { e.preventDefault(); };
    b.onclick = function (e) { e.preventDefault(); wikiToolbar(b.getAttribute('data-wiki-cmd')); };
  });
  var blockSel = $('#zq-wiki-block', section);
  if (blockSel) blockSel.onchange = function () {
    if (!state.wikiCur || !ensureWikiEditing()) return;
    if (doc.dataset.source === '1') return;
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
  // 标题点击改名（系统页 index/log/维护规则 除外）
  var titleEl = $('#zq-doc-title');
  if (titleEl) {
    titleEl.onclick = async function () {
      var p = state.wikiCur; if (!p || !ensureWikiEditing()) return;
      if (['INDEX', 'LOG', 'SCHEMA'].indexOf(String(p.pageType || '').toUpperCase()) >= 0) return toast('系统页不可改名', 'error');
      var editContext = wikiEditingContext(doc);
      var name = await askText({ title: '修改页面名称', label: '页面名称', value: p._pendingTitle || p.title || '' });
      if (!isWikiEditingContext(editContext)) return;
      if (!name || !name.trim()) return;
      if (name.trim() === p.title) { p._pendingTitle = null; titleEl.textContent = p.title; return; }
      p._pendingTitle = name.trim();
      titleEl.textContent = p._pendingTitle;
      safe('修改名称', async function () {
        if (!isWikiEditingContext(editContext)) return;
        // 改名走的是整页保存，要带着正文 —— 目录树不给正文（只给摘要），正文还没取回来（刚打开、或者取失败了）
        // 就先取一遍。不取的话后端会拒（「内容不能为空」），用户看到的是改名莫名失败。
        if (!p._full) {
          var detail = await api.get('/knowledge/pages/' + p.id);
          if (!isWikiEditingContext(editContext)) return;
          p.content = detail.content; p.version = detail.version; p._full = true;
        }
        var updated = await api.put('/knowledge/pages/' + p.id, { title: p._pendingTitle, content: p.content, pageType: p.pageType, parentId: p.parentId, sortOrder: p.sortOrder, pinned: p.pinned, version: p.version });
        if (token() !== editContext.auth) return;
        p.title = updated && updated.title ? updated.title : p._pendingTitle;
        p._pendingTitle = null;
        if (updated && updated.version != null) p.version = updated.version;
        if (state.wikiCur === p) titleEl.textContent = p.title;
        paintWikiTree(); toast('名称已更新');
      });
    };
  }
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
  picker.style.display = 'none';
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
function insertWikiImage(file) {
  var doc = $('#zq-doc'), page = state.wikiCur;
  if (!ensureWikiEditing()) return;
  if (!doc || !page || !isWikiImageFile(file)) return toast('请选择 PNG、JPG、GIF 或 WebP 图片', 'error');
  if (state.wikiImageUploading) return toast('上一张图片还在上传', 'error');
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
        || (doc.dataset.source === '1') !== source) {
      toast('图片已上传；当前页面已切换，请回原页重新插入', 'error');
      return;
    }
    var name = String(uploaded.name || file.name || '图片').replace(/[|\]\r\n]/g, ' ');
    var markdown = '![[' + uploaded.url + '|' + name + ']]';
    if (source && ta && ta.isConnected) {
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
  }).finally(function () { state.wikiImageUploading = false; });
}
function ensureWikiEditing() {
  var doc = $('#zq-doc');
  if (!doc || !state.wikiCur || wikiReadOnly() || doc.dataset.loading === '1') return false;
  if (doc.dataset.editing !== '1') enterWikiEdit();
  return doc.dataset.editing === '1';
}
function wikiReadOnly() { return state.wikiReadOnly === true; }
function toggleWikiReadOnly() {
  var doc = $('#zq-doc');
  if (!doc || !state.wikiCur || doc.dataset.loading === '1') return;
  // 冻结原 DOM / textarea，不重绘、不提交。源码的选区、滚动与未保存内容都留下来。
  if (doc.dataset.editing === '1') saveWikiDraftNow();
  state.wikiReadOnly = !wikiReadOnly();
  // 迟到的链接弹窗、改名、图片选择不能穿过一次上锁 / 解锁继续改旧会话。
  doc.dataset.wikiEditSession = String(++wikiEditSession);
  syncWikiEditMode(doc);
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
  doc.setAttribute('aria-readonly', locked || unavailable ? 'true' : 'false');
  doc.style.cursor = locked ? 'default' : 'text';
  var source = $('#zq-src-ta'); if (source) source.readOnly = locked;
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
  syncWikiTaskControls(doc);
  var title = $('#zq-doc-title');
  if (title) {
    title.style.cursor = locked || unavailable ? 'default' : 'pointer';
    title.title = locked || unavailable ? '' : '点击修改页面名称';
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
  if (md && doc.getBoundingClientRect && view.anchorKey) {
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
function enterWikiEdit() {
  var doc = $('#zq-doc'), p = state.wikiCur; if (!doc || !p || wikiReadOnly() || doc.dataset.editing === '1' || doc.dataset.loading === '1') return;
  if (wikiCmEnabled()) { enterWikiCmEdit(doc, p, p.content || ''); return; }
  var view = captureWikiView(doc);
  wireWikiDrafts(doc);
  doc.dataset.editing = '1'; doc.dataset.source = '0'; doc.dataset.wikiEditSession = String(++wikiEditSession);
  doc.contentEditable = 'true'; doc.style.outline = 'none';
  showWikiActionBar();
  doc.focus({ preventScroll: true });
  restoreWikiView(doc, view);
}
// ── 编辑内核验证版（第七十轮，docs/rounds/round-70.md） ─────────────────────────
// localStorage「zq.wikiEditor」=「cm」时，点进编辑换成 CodeMirror 6 的实时预览（assets/wiki-cm.js）：编辑的就是 Markdown 原文，
// 保存不经过 htmlToMarkdown（那一步会丢嵌套列表、代码块语言、表格对齐、硬换行）。默认关：每一处接入都是「开着才走」。
var wikiCmModule = null, wikiCmLoading = null, wikiCm = null;
function wikiCmEnabled() { try { return localStorage.getItem('zq.wikiEditor') === 'cm'; } catch (e) { return false; } }
function wikiCmActive(doc) { return !!(wikiCm && doc && doc.dataset.editor === 'cm'); }
function loadWikiCm() {
  if (!wikiCmLoading) wikiCmLoading = loadModule('wiki-cm.js').then(function (mod) { wikiCmModule = mod; return mod; }, function (e) { wikiCmLoading = null; throw e; });
  return wikiCmLoading;
}
function closeWikiCm(doc) {
  if (wikiCm) { try { wikiCm.handle.destroy(); } catch (e) {} wikiCm = null; }
  if (doc) delete doc.dataset.editor;
}
function enterWikiCmEdit(doc, p, markdown) {
  if (!wikiCmModule) {   // 进页面时就开始加载；还没到就等它到了再进
    loadWikiCm().then(function () { if (state.wikiCur === p && doc.dataset.editing !== '1') enterWikiCmEdit(doc, p, markdown); }, function (e) { toast(e.message, 'error'); });
    return;
  }
  wireWikiDrafts(doc);
  var scroll = doc.scrollTop;
  doc.dataset.editing = '1'; doc.dataset.source = '0'; doc.dataset.editor = 'cm'; doc.dataset.wikiEditSession = String(++wikiEditSession);
  doc.contentEditable = 'false';
  doc.innerHTML = '<div class="zq-wiki-cm"></div>';
  wikiCm = { page: p, handle: wikiCmModule.mountWikiEditor(doc.firstChild, {
    markdown: markdown, readOnly: wikiReadOnly(),
    titles: function () { return (state.wikiPages || []).map(function (x) { return x.title; }); },
    onNavigate: function (title) { var target = (state.wikiPages || []).find(function (x) { return x.title === title; }); if (target) paintWikiDoc(target); else toast('还没有「' + title + '」这一页'); },
    onChange: function () { doc.dispatchEvent(new Event('input', { bubbles: true })); }
  }) };
  showWikiActionBar();
  doc.scrollTop = scroll;
}
/** 页面检查里的切换（桌面应用没有地址栏和开发者工具，要在这里切才试得到中文输入法） */
function wikiEditorSwitchHtml() {
  var on = wikiCmEnabled();
  return '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--zq-border-soft);">编辑器：' + (on ? '验证版（CodeMirror）' : '现在的')
    + '<br><button type="button" class="zq-btn-ghost" id="zq-wiki-editor-switch" style="height:26px;margin-top:6px;font-size:12px;">'
    + (on ? '换回现在的编辑器' : '试试新编辑器（验证版）') + '</button></div>';
}
function wireWikiEditorSwitch(root) {
  var button = $('#zq-wiki-editor-switch', root); if (!button) return;
  button.onclick = function () {
    var doc = $('#zq-doc');
    if (doc && doc.dataset.editing === '1') return toast('先保存或取消这一页的编辑，再切换编辑器');
    var on = !wikiCmEnabled();
    try { if (on) localStorage.setItem('zq.wikiEditor', 'cm'); else localStorage.removeItem('zq.wikiEditor'); } catch (e) { return toast('这个浏览器不让存设置，切换不了', 'error'); }
    if (on) loadWikiCm();
    var box = button.parentNode; box.outerHTML = wikiEditorSwitchHtml(); wireWikiEditorSwitch(root);
    toast(on ? '已换成验证版编辑器：点正文进入编辑，编辑的就是 Markdown 原文' : '已换回现在的编辑器');
  };
}
function wikiCmToolbar(cmd) {
  var handle = wikiCm.handle;
  if (cmd === 'bold') handle.wrap('**');
  else if (cmd === 'italic') handle.wrap('*');
  else if (cmd === 'code') handle.wrap('`');
  else if (cmd === 'math') handle.insert('\n$$\n\n$$\n');
  else if (cmd === 'link' || cmd === 'ref') {
    askText({ title: '插入链接', label: '链接地址', placeholder: 'https://…', okText: '插入' }).then(function (url) {
      var href = url && wikiExternalUrl(url.trim());
      if (href && wikiCm) handle.insert('[' + href + '](' + href + ')');
    });
  } else toast('验证版还没接这个按钮（' + cmd + '）');
}
function wikiToolbar(cmd) {
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
        + '<div class="zq-field" style="margin-top:12px;"><label class="zq-label">链接地址</label><input id="zq-ref-url" class="zq-input" placeholder="https://…"></div>'
        + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;"><button class="zq-btn-ghost" id="zq-ref-cancel" style="height:32px;">取消</button><button class="zq-btn" id="zq-ref-ok" style="height:32px;">插入</button></div>',
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
function toggleWikiSource() {
  var doc = $('#zq-doc'); if (!doc || !ensureWikiEditing()) return;
  if (wikiCmActive(doc)) { toast('验证版编辑器里显示的就是 Markdown 原文：光标所在的地方露出语法'); return; }
  if (doc.dataset.source === '1') {
    var ta = $('#zq-src-ta'); var md = ta ? ta.value : '';
    var view = doc._wikiSourceView;
    doc._wikiSourceView = null;
    doc._wikiPendingView = view ? { view: view, page: state.wikiCur, auth: token(), expires: Date.now() + 30000 } : null;
    doc.dataset.source = '0'; doc.contentEditable = 'true';
    doc.innerHTML = renderMarkdown(md); markDuplicateTitle(doc, state.wikiCur && state.wikiCur.title); renderMathIn(doc); doc.focus({ preventScroll: true });
    syncWikiEditMode(doc);
    wireWikiLinks(doc);
    if (view) restoreWikiView(doc, view);
    setSourcePressed(false);
  } else {
    doc._wikiSourceView = captureWikiView(doc);
    var md2 = htmlToMarkdown(doc);
    doc.dataset.source = '1'; doc.contentEditable = 'false';
    setSourcePressed(true);
    doc.innerHTML = '<textarea id="zq-src-ta" style="width:100%;min-height:360px;border:1px solid var(--zq-border);border-radius:var(--zq-rs);padding:12px;font-size:13px;line-height:1.7;font-family:var(--zq-fontM);background:var(--zq-input-bg);color:var(--zq-text);resize:vertical;box-sizing:border-box;"></textarea>';
    $('#zq-src-ta').value = md2;
    $('#zq-src-ta').focus({ preventScroll: true });
  }
}
function showWikiActionBar() {
  removeWikiActionBar();
  var doc = $('#zq-doc'); if (!doc) return;
  syncWikiEditMode(doc);
  var bar = document.createElement('div');
  bar.id = 'zq-wiki-actions';
  bar.className = 'zq-wiki-actionbar';
  bar.dataset.editing = doc.dataset.editing === '1' ? '1' : '0';
  // 系统页（index/log/维护规则）不给删除入口，后端也会拦截
  var isSysPage = state.wikiCur && ['INDEX', 'LOG', 'SCHEMA'].indexOf(String(state.wikiCur.pageType || '').toUpperCase()) >= 0;
  bar.innerHTML = '<button class="zq-btn" id="zq-wiki-save" style="height:30px;">保存</button><button class="zq-btn-ghost" id="zq-wiki-cancel" style="height:30px;">取消</button>' + (isSysPage ? '' : '<button class="zq-btn-ghost" id="zq-wiki-del" style="height:30px;margin-left:auto;color:var(--zq-bad);">删除本页</button>');
  doc.parentNode.appendChild(bar);
  $('#zq-wiki-save').onclick = saveWikiEdit;
  // history:true —— 取消编辑是重绘当前页，不是一次跳转，不该压进返回栈
  $('#zq-wiki-cancel').onclick = cancelWikiEdit;
  if ($('#zq-wiki-del')) $('#zq-wiki-del').onclick = function () { deleteWikiPage(state.wikiCur); };
}
function cancelWikiEdit() {
  var doc = $('#zq-doc'), cur = state.wikiCur;
  if (!doc || !cur) return;
  var view = doc.dataset.source === '1' && doc._wikiSourceView ? doc._wikiSourceView : captureWikiView(doc);
  state.wikiDirty = false;
  drafts.clear(wikiDraftKey(cur)); cur._draftBase = null;
  paintWikiDoc(cur, { history: true, preserveView: view });
}
function isSystemWikiPage(p) { return !!p && ['INDEX', 'LOG', 'SCHEMA'].indexOf(String(p.pageType || '').toUpperCase()) >= 0; }
// 删除知识页：action bar 按钮与右键菜单共用（系统页由调用方隐藏入口，后端也会拦截）
async function deleteWikiPage(p) {
  if (!p) return;
  if (await askConfirm({ title: '删除知识页', message: '删除「' + (p.title || '') + '」？它的直接子页会自动迁移到上级目录，指向它的双链会变成悬空链接。', okText: '删除', danger: true })) {
    safe('删除知识页', async function () { await api.del('/knowledge/pages/' + p.id + '?version=' + encodeURIComponent(p.version)); await bootKnowledge(); toast('已删除'); });
  }
}
function removeWikiActionBar() { var b = document.getElementById('zq-wiki-actions'); if (b) b.remove(); }
async function saveWikiEdit() {
  var doc = $('#zq-doc'), p = state.wikiCur; if (!doc || !p || doc.dataset.editing !== '1' || doc.dataset.loading === '1') return;
  var editContext = wikiEditingContext(doc);
  var md = wikiCmActive(doc) ? wikiCm.handle.getMarkdown() : doc.dataset.source === '1' ? ($('#zq-src-ta') ? $('#zq-src-ta').value : '') : htmlToMarkdown(doc);
  // 恢复的是一份旧版本上改的草稿，而这一页之后被改过：直接按旧版本存会被乐观锁挡住，而且每次都挡 —— 刷新重试也一样，
  // 草稿永远存不进去（第十五轮真浏览器里走出来的死胡同）。所以先明说，用户点了「替换」才按现在的版本存。
  if (p._draftBase != null && p.version != null && Number(p._draftBase) !== Number(p.version)) {
    var replace = await askConfirm({
      title: '这一页在你离开之后被改过',
      message: '编辑框里是你当时没保存的那一版。直接保存会用它替换现在的内容 —— 别处后来加的会没了。\n\n想先对照的话点「取消」，在另一个标签页打开这一页看看现在是什么样。',
      okText: '用我的这一版替换',
      danger: true
    });
    if (!replace || !isWikiEditSession(editContext)) return;
    p._draftBase = p.version;
  }
  var editSession = doc.dataset.wikiEditSession, saveAuth = token();
  var saveButton = $('#zq-wiki-save');
  if (saveButton && saveButton.disabled) return;
  if (saveButton) saveButton.disabled = true;
  return safe('保存知识页', async function () {
    var baseVersion = p._draftBase != null ? p._draftBase : p.version;
    var updated = await api.put('/knowledge/pages/' + p.id, { title: p.title, content: md, pageType: p.pageType, parentId: p.parentId, sortOrder: p.sortOrder, pinned: p.pinned, version: baseVersion });
    if (token() !== saveAuth) return;
    // Saving an old page must not redraw a new page, and typing during the request must not be discarded.
    p._draftBase = null;
    p.content = updated && updated.content != null ? updated.content : md;
    if (updated && updated.version != null) p.version = updated.version;
    if (updated && updated.updatedAt) p.updatedAt = updated.updatedAt;
    if (state.wikiCur !== p || doc.dataset.wikiEditSession !== editSession || doc.dataset.editing !== '1') {
      if (state.wikiCur === p && doc.dataset.editing === '1') {
        // 保存期间切换只读会结束旧会话；回执只更新草稿状态，不能重绘或改变现在的开关。
        if (currentWikiMarkdown() === md) { state.wikiDirty = false; drafts.clearIf(wikiDraftKey(p), md); }
        else { state.wikiDirty = true; saveWikiDraftNow(); }
      } else {
        var newerDraft = drafts.load(wikiDraftKey(p));
        if (newerDraft && newerDraft.text !== md && Number(newerDraft.base) === Number(baseVersion)) {
          drafts.save(wikiDraftKey(p), newerDraft.text, { base: p.version, title: p.title });
        } else drafts.clearIf(wikiDraftKey(p), md);
      }
      toast('知识页已保存'); return;
    }
    if (currentWikiMarkdown() !== md) {
      state.wikiDirty = true;
      saveWikiDraftNow();
      toast('已保存提交的内容，后续修改仍留在当前草稿'); return;
    }
    drafts.clear(wikiDraftKey(p));
    state.wikiDirty = false;
    var view = doc.dataset.source === '1' && doc._wikiSourceView ? doc._wikiSourceView : captureWikiView(doc);
    await paintWikiDoc(p, { history: true, preserveView: view });
    toast('已保存');
  }).finally(function () { if (saveButton && saveButton.isConnected) saveButton.disabled = false; });
}
// 一个 ZIP 根目录下放笔记、子目录和原始附件；导入时能还原关系。
async function exportWikiMarkdown() {
  var currentAtOpen = state.wikiCur;
  var selected = await new Promise(function (resolve) {
    var done = false;
    openModal({
      title: '导出知识库 ZIP',
      bodyHtml: '<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:var(--zq-text2);">Markdown 笔记、目录、图片与附件会放进同一个 wiki 文件夹。</p>'
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
    bodyHtml: '<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:var(--zq-text2);">选择 Obsidian 风格 ZIP。先预览目录、双链、图片和重名处理，确认后才新增页面；现有页面不会被覆盖。</p>'
      + '<div class="zq-field"><label class="zq-label" for="zq-vault-pick">ZIP 文件</label>'
      + '<div class="zq-vault-file"><input id="zq-vault-file" type="file" accept=".zip,application/zip" hidden>'
      + '<button type="button" class="zq-btn-ghost" id="zq-vault-pick" aria-describedby="zq-vault-selected">' + icon('paperclip') + ' 选择 ZIP 文件</button>'
      + '<span id="zq-vault-selected" aria-live="polite">尚未选择文件</span></div></div>'
      + '<div class="zq-field"><label class="zq-label" for="zq-vault-parent">导入位置</label><select id="zq-vault-parent" class="zq-select"><option value="root">知识库根目录</option>'
      + (current && !isSystemWikiPage(current) ? '<option value="current">当前页「' + esc(current.title) + '」下面</option>' : '')
      + '</select></div>'
      + '<div id="zq-vault-preview" style="max-height:38vh;overflow:auto;margin:12px 0;font-size:12.5px;line-height:1.6;color:var(--zq-text2);"></div>'
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
          output.innerHTML = '<p style="margin:0 0 8px;">将新增 ' + Number(result.pageCount || 0) + ' 页、'
            + Number(result.attachmentCount || 0) + ' 个附件、' + Number(result.relationshipCount || 0)
            + ' 条双链。</p><ul style="margin:0 0 10px;padding-left:20px;">' + items + '</ul>'
            + (Number(result.pageCount || 0) > 30 ? '<p>其余页面未在此处展开。</p>' : '')
            + (warnings ? '<p>需要留意：</p><ul style="padding-left:20px;">' + warnings + '</ul>' : '');
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
            if (state.wikiDirty) saveWikiDraftNow();
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
      + '<p style="margin:0 0 12px;font-size:12px;color:var(--zq-text3);line-height:1.6;">将按类型生成初始结构（小节 / 任务项），创建后点击「编辑」继续填写。</p>'
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
          await api.post('/knowledge/pages', body);
          h.close(); await bootKnowledge(); toast('已创建');
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
      + '<div class="zq-field"><label class="zq-label">内容 / 链接</label><textarea id="zq-imp-content" class="zq-textarea" style="min-height:110px;" placeholder="粘贴文本，或填入 http/https 链接"></textarea></div>'
      + '</div>'
      + '<div id="zq-imp-file-box" style="display:none;">'
      + '<div class="zq-field"><label class="zq-label" for="zq-imp-file">选择文件</label><input id="zq-imp-file" type="file" class="zq-input" style="height:auto;padding:7px 12px;" accept=".pdf,.xlsx,.xls,.txt,.md,.csv,.json,.xml,.png,.jpg,.jpeg,.webp"></div>'
      + '<p style="margin:0 0 12px;font-size:12px;color:var(--zq-text3);line-height:1.6;">pdf / xlsx / txt / md / csv / json / xml 会自动解析正文；图片仅记录文件信息，暂不做内容识别。</p>'
      + '</div>'
      + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-imp-cancel">取消</button><button type="button" class="zq-btn" id="zq-imp-ok">导入</button></div>',
    onMount: function (b, h) {
      var modeSel = $('#zq-imp-mode', b);
      modeSel.onchange = function () {
        var up = modeSel.value === 'UPLOAD';
        $('#zq-imp-text-box', b).style.display = up ? 'none' : '';
        $('#zq-imp-file-box', b).style.display = up ? '' : 'none';
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
      bodyHtml: '<p style="margin:0 0 12px;font-size:12.5px;color:var(--zq-text2);line-height:1.6;">导入的资料保存在这里。查看正文后，可生成待合入变更；确认合入之后才会成为知识页。</p>'
        + '<div style="display:flex;flex-direction:column;gap:8px;max-height:55vh;overflow-y:auto;">'
        + (rows.map(function (source) {
          return '<button type="button" class="zq-btn-ghost" data-source="' + esc(source.id) + '" style="display:block;text-align:left;height:auto;white-space:normal;padding:12px;border:1px solid var(--zq-border-soft);">'
            + '<strong style="display:block;font-size:13.5px;">' + esc(source.title || '未命名来源') + '</strong>'
            + (source.createdAt ? '<span style="display:block;margin-top:3px;font-size:11px;color:var(--zq-text3);">' + esc(fmtDate(source.createdAt)) + '</span>' : '')
            + (source.summary ? '<span style="display:block;margin-top:5px;font-size:12px;line-height:1.6;color:var(--zq-text2);">' + esc(source.summary) + '</span>' : '') + '</button>';
        }).join('') || empty('还没有来源记录，点「导入来源」添加资料。')) + '</div>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-sources-prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>'
        + '<span style="font-size:12px;color:var(--zq-text3);">第 ' + page + ' / ' + pages + ' 页 · 每页 20 条</span>'
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
      bodyHtml: '<p style="margin:0 0 10px;font-size:12.5px;color:var(--zq-text2);line-height:1.6;">来源已保存。下方是保存的正文，生成变更后还需确认合入，才会写入知识库。' + esc(truncatedNote(saved)) + '</p>'
        + (source.sourceRef ? '<p style="margin:0 0 10px;font-size:11.5px;color:var(--zq-text3);overflow-wrap:anywhere;">' + esc(source.sourceRef) + '</p>' : '')
        + '<pre style="margin:0;padding:14px;max-height:55vh;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.8 var(--zq-fontBody);border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);">' + esc(source.content || '') + '</pre>'
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
      return '<div style="padding:7px 10px;border:1px solid var(--zq-border-soft);border-left:3px solid var(--zq-warn);border-radius:var(--zq-rs);background:var(--zq-card-soft);font-size:12.5px;line-height:1.55;">' + esc(text) + '</div>';
    }).join('');
    return wikiInfoSpec({
      html: count
        ? '<p style="margin:0 0 12px;font-size:13px;color:var(--zq-text2);">发现 ' + count + ' 个问题' + (count > 20 ? '（先列前 20 个）' : '') + '：</p><div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;max-height:280px;overflow-y:auto;">' + listHtml + '</div>'
        : '<p style="display:flex;align-items:center;gap:6px;margin:0 0 16px;font-size:13.5px;color:var(--zq-ok);font-weight:var(--zq-fw-medium);">' + icon('check') + '未发现问题，知识库链接完好。</p>'
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
  b.style.display = '';
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
      return '<g data-graph-node="' + n.id + '" style="cursor:pointer;">'
        + '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="' + color + '" opacity=".88"><title>' + esc(n.title || '') + '</title></circle>'
        + '<text x="' + p.x + '" y="' + (p.y + r + 13) + '" text-anchor="middle" style="font-size:10.5px;fill:var(--zq-text2);">' + esc(label) + '</text></g>';
    }).join('');
    var legend = Object.keys(WIKI_TYPE_COLOR).filter(function (k) {
      return nodes.some(function (n) { return String(n.type || 'NOTE').toUpperCase() === k; });
    }).map(function (k) {
      return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--zq-text2);"><i style="width:9px;height:9px;border-radius:50%;background:' + WIKI_TYPE_COLOR[k] + ';display:inline-block;"></i>' + k + '</span>';
    }).join('');
    var missing = (g && g.missingTargets && g.missingTargets.length) || 0;
    return {
      title: '知识图谱 · ' + nodes.length + ' 页 / ' + links.length + ' 链接',
      bodyHtml:
        '<div style="border:1px solid var(--zq-border-soft);border-radius:var(--zq-rm);background:var(--zq-card-soft);overflow:hidden;"><svg viewBox="0 0 ' + W + ' ' + H + '" style="display:block;width:100%;height:auto;">' + edgesSvg + nodesSvg + '</svg></div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;">' + legend + '</div>'
        + (missing ? '<p style="margin:10px 0 0;font-size:12px;color:var(--zq-bad);">' + missing + ' 个悬空链接（红色虚线），可运行「健康检查」查看明细。</p>' : '')
        + '<p style="margin:8px 0 0;font-size:11.5px;color:var(--zq-text3);">节点大小 = 被引用次数 · 点击节点跳转到对应页面</p>',
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
    return '<details style="border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card);margin-top:6px;">'
      + '<summary style="cursor:pointer;padding:7px 10px;font-size:12.5px;"><span class="zq-badge" style="background:var(--zq-tint);color:var(--zq-primary);margin-right:6px;">' + esc(action) + '</span>'
      + '<strong>' + esc(it.title || '未命名页面') + '</strong></summary>'
      + '<div class="zq-rev-body" style="padding:4px 12px 10px;font-size:13px;line-height:1.7;max-height:260px;overflow-y:auto;">' + renderMarkdown(String(it.content || '')) + '</div></details>';
  }).join('') || '<p style="margin:6px 0 0;font-size:12px;color:var(--zq-text3);">这组变更里没有页面。</p>';
  return '<section data-patch-set="' + esc(ps.id) + '" style="padding:11px 13px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rm);background:var(--zq-card-soft);">'
    + '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;"><div style="min-width:0;">'
    + '<strong style="font-size:13.5px;">' + esc(ps.title || ('变更 #' + ps.id)) + '</strong>'
    + (ps.createdAt ? '<span class="zq-num" style="margin-left:8px;font-size:11px;color:var(--zq-text3);">' + esc(fmtDate(ps.createdAt)) + '</span>' : '')
    + (ps.summary ? '<p style="margin:4px 0 0;font-size:12px;color:var(--zq-text2);line-height:1.6;">' + esc(ps.summary) + '</p>' : '')
    + '</div><div style="display:flex;gap:6px;flex:none;">'
    + '<button type="button" class="zq-btn-ghost" data-patch-reject="' + esc(ps.id) + '" style="height:28px;padding:0 11px;font-size:12px;">忽略</button>'
    + '<button type="button" class="zq-btn" data-patch-apply="' + esc(ps.id) + '" style="height:28px;padding:0 11px;font-size:12px;">确认合入</button>'
    + '</div></div>' + itemHtml + '</section>';
}
async function showWikiPatchSets() {
  await showWikiLoadingView('待合入变更', { title: '待合入变更', width: '640px' }, function () { return api.get('/knowledge/patch-sets?status=PENDING'); }, function (list) {
    list = list || [];
    paintWikiPatchBadge(list);   // 角标就用这一份，不再为它多等一次同样的请求
    if (!list.length) return wikiInfoSpec({ message: '当前没有待合入的变更。AI 对知识库的修改建议会先出现在这里，确认后才写入正文。' });
    return {
      title: '待合入变更 · ' + list.length + ' 组',
      bodyHtml: '<p style="margin:0 0 10px;font-size:12.5px;color:var(--zq-text2);line-height:1.6;">点开每一页看看要写进去的内容；确认合入之后才会改动知识库，忽略的不会写入。</p>'
        + '<div style="display:flex;flex-direction:column;gap:10px;max-height:62vh;overflow-y:auto;">' + list.map(patchSetCard).join('') + '</div>',
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
