// 知识 Wiki —— 第三十六轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// Markdown 渲染那一套（renderMarkdown、代码块着色、公式、htmlToMarkdown）AI 助手也用，留在壳里经 zqShared 给。
// state.wiki* 照旧放在壳的 state 上（只有这里读写）。wiki-tabs-check.js 从这个文件里抠标签页那一段来跑（要把 paintWikiDoc 换成替身，
// 模块里的函数互相调用、从外面换不掉 —— 所以这一段没改成 import）。

let API, api, token, esc, $, $all, empty, fmtDate, safe, toast, notice, askConfirm, askText, showInfo, openModal, popMenu, state, drafts, keepDraft,
  renderMarkdown, renderMathIn, mathBlockHtml, htmlToMarkdown, icon;
export function bind(sh) {
  ({ API, api, token, esc, $, $all, empty, fmtDate, safe, toast, notice, askConfirm, askText, showInfo, openModal, popMenu, state, drafts, keepDraft,
  renderMarkdown, renderMathIn, mathBlockHtml, htmlToMarkdown, icon } = sh);
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
    return '<a data-wiki="' + p.id + '" style="display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:var(--zq-rs);cursor:pointer;background:' + (active ? 'var(--zq-tint)' : 'transparent') + ';"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:' + (active ? 700 : 500) + ';color:var(--zq-text2);">' + esc(p.title) + '</span></a>';
  }).join('') || empty('无匹配页面');
  $all('[data-wiki]', tree).forEach(function (a) {
    var pageOf = function () { return (state.wikiPages || []).find(function (x) { return String(x.id) === a.dataset.wiki; }); };
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
  // 正在编辑时点了目录里的别的页：原来改的字直接被新页面冲掉，一声不吭。先存成草稿，回到这一页时能恢复
  if (state.wikiDirty) saveWikiDraftNow();
  state.wikiDirty = false;
  removeWikiDraftBar();
  trackWikiNavigation(p, opts);
  state.wikiCur = p;
  removeWikiActionBar();
  var doc = $('#zq-doc'), title = $('#zq-doc-title');
  if (title) title.textContent = p.title || '知识页';
  // document-tree 只给了折叠后的 summary，正文要按需拉完整内容
  if (!p._full && p.id != null) {
    var detail = await safe('知识页', function () { return api.get('/knowledge/pages/' + p.id); });
    if (detail) { p.content = detail.content; p.pageType = detail.pageType || p.pageType; p.parentId = detail.parentId; p.sortOrder = detail.sortOrder; p.pinned = detail.pinned; p.version = detail.version; p._full = true; }
  }
  if (state.wikiCur !== p) return;
  if (doc) {
    doc.dataset.editing = '0'; doc.dataset.source = '0';
    doc.contentEditable = 'false';
    doc.innerHTML = renderMarkdown(p.content || p.summary || '');
    renderMathIn(doc);
    wireWikiLinks(doc);
  }
  var insp = $('#zq-insp');
  if (insp) insp.innerHTML = '<div style="padding:12px 14px;font-size:12px;color:var(--zq-text2);line-height:1.6;">类型：' + esc(p.pageType || p.type || 'NOTE') + '<br>更新：' + esc(fmtDate(p.updatedAt)) + '<br><span style="color:var(--zq-text3);">点击正文即可编辑 · [[双链]]可跳转</span></div>';
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
    if (doc.dataset.editing !== '1') return;
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
  if (!doc || !p || p.id == null) return;
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
    removeWikiDraftBar();
    enterWikiEdit();
    if (doc.dataset.source !== '1') toggleWikiSource();
    var ta = $('#zq-src-ta'); if (ta) ta.value = d.text;
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
  state.wikiTabs.splice(index, 1);
  if (!state.wikiTabs.length) {
    state.wikiTabIdx = -1;
    state.wikiCur = null;
    saveWikiTabs();
    var doc = $('#zq-doc'), title = $('#zq-doc-title');
    if (doc) doc.innerHTML = empty('没有打开的页面 · 从左侧目录选一页，或点 + 新建标签');
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
      'font-weight:' + (on ? 600 : 500) + ';' +
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

function wireWikiLinks(doc) {
  $all('[data-wikilink]', doc).forEach(function (a) {
    a.onclick = function (e) {
      if (doc.dataset.editing === '1') return;
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡到正文容器，否则跳转后的目标页会立刻进入编辑态
      var t = a.getAttribute('data-wikilink');
      var target = (state.wikiPages || []).find(function (x) { return (x.title || '') === t; });
      if (target) paintWikiDoc(target, { newTab: e.metaKey || e.ctrlKey }); else toast('页面不存在：' + t, 'error');
    };
    a.onauxclick = function (e) {
      if (e.button !== 1 || doc.dataset.editing === '1') return;
      e.preventDefault(); e.stopPropagation();
      var t = a.getAttribute('data-wikilink');
      var target = (state.wikiPages || []).find(function (x) { return (x.title || '') === t; });
      if (target) paintWikiDoc(target, { newTab: true });
    };
  });
}
function wireWikiEditor() {
  var doc = $('#zq-doc'); if (!doc) return;
  doc.style.cursor = 'text';
  // 点正文进入编辑，但链接/勾选框/按钮等正文内控件的点击不算（外链点击、双链跳转不应触发编辑）
  doc.onclick = function (e) {
    if (e.target && e.target.closest && e.target.closest('a,input,button')) return;
    if (state.wikiCur && doc.dataset.editing !== '1') enterWikiEdit();
  };
  // 右键菜单：编辑本页 / 删除本页；编辑态不拦截（保留浏览器原生菜单做粘贴等操作）
  doc.oncontextmenu = function (e) {
    if (doc.dataset.editing === '1' || !state.wikiCur) return;
    e.preventDefault();
    var p = state.wikiCur;
    var items = [{ label: '编辑本页', onClick: function () { enterWikiEdit(); } }];
    if (!isSystemWikiPage(p)) items.push({ label: '删除本页', danger: true, onClick: function () { deleteWikiPage(p); } });
    popMenu(e.clientX, e.clientY, items);
  };
  // 任务勾选框：勾选即切换删除线样式；未在编辑态则进入编辑态以便保存
  doc.addEventListener('change', function (e) {
    var cb = e.target;
    if (!cb || cb.type !== 'checkbox') return;
    var span = cb.nextElementSibling;
    if (span) { span.style.textDecoration = cb.checked ? 'line-through' : 'none'; span.style.color = cb.checked ? 'var(--zq-text3)' : 'var(--zq-text)'; }
    if (doc.dataset.editing !== '1') enterWikiEdit();
  });
  var section = doc.closest('section'); if (!section) return;
  $all('[data-wiki-cmd]', section).forEach(function (b) {
    b.onclick = function (e) { e.preventDefault(); wikiToolbar(b.getAttribute('data-wiki-cmd')); };
  });
  var blockSel = $('#zq-wiki-block', section);
  if (blockSel) blockSel.onchange = function () {
    if (!state.wikiCur) return; ensureWikiEditing();
    if (doc.dataset.source === '1') return;
    var v = blockSel.value;
    if (v === 'QUOTE') document.execCommand('formatBlock', false, 'BLOCKQUOTE');
    else if (v === 'CODE') document.execCommand('formatBlock', false, 'PRE');
    else if (v === 'UL') document.execCommand('insertUnorderedList');
    else if (v === 'OL') document.execCommand('insertOrderedList');
    else if (v === 'HR') document.execCommand('insertHorizontalRule');
    else if (v === 'TASK') document.execCommand('insertHTML', false, '<div class="zq-task-row" style="display:flex;gap:9px;align-items:flex-start;margin:7px 0;"><input type="checkbox" contenteditable="false" style="accent-color:var(--zq-primary);margin-top:5px;flex:none;"><span>待办事项</span></div>');
    else document.execCommand('formatBlock', false, v);
    blockSel.value = 'P';
  };
  // 标题点击改名（系统页 index/log/维护规则 除外）
  var titleEl = $('#zq-doc-title');
  if (titleEl) {
    titleEl.style.cursor = 'pointer';
    titleEl.title = '点击修改页面名称';
    titleEl.onclick = async function () {
      var p = state.wikiCur; if (!p) return;
      if (['INDEX', 'LOG', 'SCHEMA'].indexOf(String(p.pageType || '').toUpperCase()) >= 0) return toast('系统页不可改名', 'error');
      var name = await askText({ title: '修改页面名称', label: '页面名称', value: p._pendingTitle || p.title || '' });
      if (!name || !name.trim()) return;
      if (name.trim() === p.title) { p._pendingTitle = null; titleEl.textContent = p.title; return; }
      p._pendingTitle = name.trim();
      titleEl.textContent = p._pendingTitle;
      safe('修改名称', async function () {
        // 改名走的是整页保存，要带着正文 —— 目录树不给正文（只给摘要），正文还没取回来（刚打开、或者取失败了）
        // 就先取一遍。不取的话后端会拒（「内容不能为空」），用户看到的是改名莫名失败。
        if (!p._full) {
          var detail = await api.get('/knowledge/pages/' + p.id);
          p.content = detail.content; p.version = detail.version; p._full = true;
        }
        var updated = await api.put('/knowledge/pages/' + p.id, { title: p._pendingTitle, content: p.content, pageType: p.pageType, parentId: p.parentId, sortOrder: p.sortOrder, pinned: p.pinned, version: p.version });
        p.title = updated && updated.title ? updated.title : p._pendingTitle;
        p._pendingTitle = null;
        if (updated && updated.version != null) p.version = updated.version;
        titleEl.textContent = p.title;
        paintWikiTree(); toast('名称已更新');
      });
    };
  }
}
function ensureWikiEditing() { var doc = $('#zq-doc'); if (doc && doc.dataset.editing !== '1') enterWikiEdit(); }
function enterWikiEdit() {
  var doc = $('#zq-doc'), p = state.wikiCur; if (!doc || !p || doc.dataset.editing === '1') return;
  wireWikiDrafts(doc);
  doc.dataset.editing = '1'; doc.dataset.source = '0';
  doc.contentEditable = 'true'; doc.style.outline = 'none';
  doc.focus();
  showWikiActionBar();
}
function wikiToolbar(cmd) {
  ensureWikiEditing();
  var doc = $('#zq-doc');
  if (doc.dataset.source === '1' && cmd !== 'source') return;
  if (cmd === 'bold') document.execCommand('bold');
  else if (cmd === 'italic') document.execCommand('italic');
  else if (cmd === 'underline') document.execCommand('underline');
  else if (cmd === 'code') { var s = window.getSelection().toString(); if (s) document.execCommand('insertHTML', false, '<code style="background:var(--zq-card-soft);padding:1px 5px;border-radius:4px;">' + esc(s) + '</code>'); }
  else if (cmd === 'link') {
    // 弹窗会夺走 contentEditable 焦点，先存选区、恢复后再 createLink
    var sel0 = window.getSelection();
    var savedRange = sel0.rangeCount ? sel0.getRangeAt(0).cloneRange() : null;
    askText({ title: '插入链接', label: '链接地址', placeholder: 'https://…', okText: '插入' }).then(function (url) {
      if (!url || !url.trim()) return;
      doc.focus();
      if (savedRange) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
      document.execCommand('createLink', false, url.trim());
    });
  }
  else if (cmd === 'math') {
    var selM = window.getSelection();
    var savedM = selM.rangeCount ? selM.getRangeAt(0).cloneRange() : null;
    askText({ title: '插入公式块', label: 'LaTeX 公式', placeholder: '例如：\\int_a^b f(x)\\,dx', hint: '行内公式可直接在正文里写 $...$，保存后自动渲染。', okText: '插入' }).then(function (tex) {
      if (!tex || !tex.trim()) return;
      doc.focus();
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
          var t = body.querySelector('#zq-ref-title').value.trim();
          var u = body.querySelector('#zq-ref-url').value.trim();
          if (!u) return toast('请填写链接地址', 'error');
          if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
          handle.close();
          doc.focus();
          if (savedR) { var sr = window.getSelection(); sr.removeAllRanges(); sr.addRange(savedR); }
          document.execCommand('insertHTML', false, '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" style="color:var(--zq-primary);text-decoration:underline;text-underline-offset:3px;">' + esc(t || u) + '</a>&nbsp;');
        };
        body.querySelector('#zq-ref-title').focus();
      }
    });
  }
  else if (cmd === 'source') toggleWikiSource();
}
function toggleWikiSource() {
  var doc = $('#zq-doc'); if (!doc) return;
  if (doc.dataset.source === '1') {
    var ta = $('#zq-src-ta'); var md = ta ? ta.value : '';
    doc.dataset.source = '0'; doc.contentEditable = 'true';
    doc.innerHTML = renderMarkdown(md); renderMathIn(doc); doc.focus();
  } else {
    var md2 = htmlToMarkdown(doc);
    doc.dataset.source = '1'; doc.contentEditable = 'false';
    doc.innerHTML = '<textarea id="zq-src-ta" style="width:100%;min-height:360px;border:1px solid var(--zq-border);border-radius:var(--zq-rs);padding:12px;font-size:13px;line-height:1.7;font-family:var(--zq-fontM);background:var(--zq-input-bg);color:var(--zq-text);resize:vertical;box-sizing:border-box;"></textarea>';
    $('#zq-src-ta').value = md2;
  }
}
function showWikiActionBar() {
  removeWikiActionBar();
  var doc = $('#zq-doc'); if (!doc) return;
  var bar = document.createElement('div');
  bar.id = 'zq-wiki-actions';
  bar.style.cssText = 'display:flex;gap:8px;padding:10px 26px 18px;border-top:1px solid var(--zq-border-soft);background:var(--zq-card);';
  // 系统页（index/log/维护规则）不给删除入口，后端也会拦截
  var isSysPage = state.wikiCur && ['INDEX', 'LOG', 'SCHEMA'].indexOf(String(state.wikiCur.pageType || '').toUpperCase()) >= 0;
  bar.innerHTML = '<button class="zq-btn" id="zq-wiki-save" style="height:30px;">保存</button><button class="zq-btn-ghost" id="zq-wiki-cancel" style="height:30px;">取消</button>' + (isSysPage ? '' : '<button class="zq-btn-ghost" id="zq-wiki-del" style="height:30px;margin-left:auto;color:var(--zq-bad);">删除本页</button>');
  doc.parentNode.appendChild(bar);
  $('#zq-wiki-save').onclick = saveWikiEdit;
  // history:true —— 取消编辑是重绘当前页，不是一次跳转，不该压进返回栈
  $('#zq-wiki-cancel').onclick = function () {
    // 取消 = 明确不要这些改动：草稿一起删，不再提示恢复
    var cur = state.wikiCur;
    state.wikiDirty = false;
    if (cur) { drafts.clear(wikiDraftKey(cur)); cur._draftBase = null; }
    paintWikiDoc(state.wikiCur, { history: true });
  };
  if ($('#zq-wiki-del')) $('#zq-wiki-del').onclick = function () { deleteWikiPage(state.wikiCur); };
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
  var doc = $('#zq-doc'), p = state.wikiCur; if (!doc || !p) return;
  var md = doc.dataset.source === '1' ? ($('#zq-src-ta') ? $('#zq-src-ta').value : '') : htmlToMarkdown(doc);
  // 恢复的是一份旧版本上改的草稿，而这一页之后被改过：直接按旧版本存会被乐观锁挡住，而且每次都挡 —— 刷新重试也一样，
  // 草稿永远存不进去（第十五轮真浏览器里走出来的死胡同）。所以先明说，用户点了「替换」才按现在的版本存。
  if (p._draftBase != null && p.version != null && Number(p._draftBase) !== Number(p.version)) {
    var replace = await askConfirm({
      title: '这一页在你离开之后被改过',
      message: '编辑框里是你当时没保存的那一版。直接保存会用它替换现在的内容 —— 别处后来加的会没了。\n\n想先对照的话点「取消」，在另一个标签页打开这一页看看现在是什么样。',
      okText: '用我的这一版替换',
      danger: true
    });
    if (!replace) return;
    p._draftBase = p.version;
  }
  safe('保存知识页', async function () {
    var baseVersion = p._draftBase != null ? p._draftBase : p.version;
    var updated = await api.put('/knowledge/pages/' + p.id, { title: p.title, content: md, pageType: p.pageType, parentId: p.parentId, sortOrder: p.sortOrder, pinned: p.pinned, version: baseVersion });
    // 存上了才删草稿；被乐观锁挡住时走不到这里，草稿和编辑框里的字都还在
    drafts.clear(wikiDraftKey(p));
    p._draftBase = null;
    state.wikiDirty = false;
    p.content = updated && updated.content != null ? updated.content : md;
    if (updated && updated.version != null) p.version = updated.version;
    if (updated && updated.updatedAt) p.updatedAt = updated.updatedAt;
    // history:true —— 保存后重绘的还是这一页，压进返回栈会让「返回」原地打转
    paintWikiDoc(p, { history: true });
    toast('已保存');
  });
}
// 导出整个知识 Wiki 为 Obsidian 风格 Markdown zip；优先让用户选保存位置
async function exportWikiMarkdown() {
  var n = notice('正在打包知识 Wiki…');
  try {
    var headers = {}; if (token()) headers.Authorization = 'Bearer ' + token();
    var res = await fetch(API + '/knowledge/export/markdown', { headers: headers, credentials: 'same-origin' });
    var cd = res.headers.get('Content-Disposition') || '';
    var isAttachment = /attachment/i.test(cd);
    var ct = res.headers.get('Content-Type') || '';
    if (!res.ok || (!isAttachment && ct.indexOf('application/json') >= 0)) {
      var j = null; try { j = await res.json(); } catch (e) {}
      throw new Error((j && j.message) || ('导出失败(' + res.status + ')'));
    }
    var blob = await res.blob();
    var fname = 'zhiqu-wiki-markdown.zip';
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
      + '<p style="margin:0 0 12px;font-size:12px;color:var(--zq-text3);line-height:1.6;">将按类型生成初始结构（小节 / 任务项），创建后点正文即可继续编辑。</p>'
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
function importWikiSource() {
  openModal({
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
      $('#zq-imp-ok', b).onclick = function () {
        var title = $('#zq-imp-title', b).value.trim();
        if (modeSel.value === 'UPLOAD') {
          var file = $('#zq-imp-file', b).files[0];
          if (!file) return toast('请选择要上传的文件', 'error');
          var n = notice('正在上传并解析「' + (title || file.name) + '」…');
          h.close();
          safe('上传来源', async function () {
            try {
              var saved = await api.upload('/knowledge/sources/upload', file, title ? { title: title } : {});
              n.update('来源解析完成' + truncatedNote(saved), { done: true });
            } catch (e) { n.update('解析失败：' + (e.message || '未知错误'), { error: true }); throw e; }
          });
          return;
        }
        var content = $('#zq-imp-content', b).value;
        var type = $('#zq-imp-type', b).value;
        if (!title) return toast('请填写来源标题', 'error');
        safe('导入来源', async function () {
          var saved = await api.post('/knowledge/sources', { title: title, content: content, sourceType: type });
          contentDraft.clear();
          h.close(); toast('来源已导入' + truncatedNote(saved));
        });
      };
    }
  });
}
/** 来源原文超过上限时后端只存前面一段，并在回包里说 {kept, total} —— 这里把它说给用户，不让截断悄悄发生 */
function truncatedNote(saved) {
  var t = saved && saved.truncated;
  return t ? '（原文 ' + t.total + ' 字，只保存了前 ' + t.kept + ' 字）' : '';
}
async function runWikiLint() {
  await safe('健康检查', async function () {
    var report = await api.get('/knowledge/lint/report');
    var issues = (report && (report.issues || report.findings || report.items)) || [];
    if (!Array.isArray(issues)) issues = [];
    var count = issues.length || ((report && report.total) || 0);
    var listHtml = issues.slice(0, 20).map(function (it) {
      var text = typeof it === 'string' ? it : (it.message || it.title || it.description || JSON.stringify(it));
      return '<div style="display:flex;gap:8px;padding:7px 10px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);font-size:12.5px;line-height:1.55;"><span style="color:var(--zq-warn);flex:none;">⚠</span><span>' + esc(text) + '</span></div>';
    }).join('');
    await showInfo({
      title: '健康检查',
      html: count
        ? '<p style="margin:0 0 12px;font-size:13px;color:var(--zq-text2);">发现 ' + count + ' 个问题（如悬空链接等）：</p><div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;max-height:280px;overflow-y:auto;">' + listHtml + '</div>'
        : '<p style="display:flex;align-items:center;gap:6px;margin:0 0 16px;font-size:13.5px;color:var(--zq-ok);font-weight:var(--zq-fw-medium);">' + icon('check') + '未发现问题，知识库链接完好。</p>'
    });
  });
}
// 待合入变更按钮：显示真实的 PENDING patch-set 数量（预置的 “2” 是静态占位，已移除）
async function refreshWikiPatchBadge() {
  var b = $('#zq-patch-btn'); if (!b) return;
  try {
    var list = await api.get('/knowledge/patch-sets?status=PENDING');
    var n = (list || []).length;
    b.textContent = n ? ('待合入变更 ' + n) : '待合入变更';
    b.style.display = '';
  } catch (e) { b.textContent = '待合入变更'; }
}
var WIKI_TYPE_COLOR = { GOAL: 'var(--zq-q2)', PROJECT: 'var(--zq-primary)', PREFERENCE: 'var(--zq-q4)', WEAKNESS: 'var(--zq-q1)', RESOURCE: 'var(--zq-q3)', MEMORY: 'var(--zq-accent)', INDEX: 'var(--zq-text3)', SCHEMA: 'var(--zq-text3)', LOG: 'var(--zq-text3)', NOTE: 'var(--zq-text2)' };
async function showWikiGraph() {
  await safe('知识图谱', async function () {
    var g = await api.get('/knowledge/graph');
    var nodes = (g && g.nodes) || [];
    var links = (g && g.links) || [];
    if (!nodes.length) { await showInfo({ title: '知识图谱', message: '还没有知识页，先创建几页并用 [[双链]] 互相引用吧。' }); return; }
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
    openModal({
      title: '知识图谱 · ' + nodes.length + ' 页 / ' + links.length + ' 链接',
      width: '620px',
      bodyHtml:
        '<div style="border:1px solid var(--zq-border-soft);border-radius:var(--zq-rm);background:var(--zq-card-soft);overflow:hidden;"><svg viewBox="0 0 ' + W + ' ' + H + '" style="display:block;width:100%;height:auto;">' + edgesSvg + nodesSvg + '</svg></div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;">' + legend + '</div>'
        + (missing ? '<p style="margin:10px 0 0;font-size:12px;color:var(--zq-bad);">⚠ ' + missing + ' 个悬空链接（红色虚线），可运行「健康检查」查看明细。</p>' : '')
        + '<p style="margin:8px 0 0;font-size:11.5px;color:var(--zq-text3);">节点大小 = 被引用次数 · 点击节点跳转到对应页面</p>',
      onMount: function (b, h) {
        $all('[data-graph-node]', b).forEach(function (gn) {
          gn.onclick = function () {
            var target = (state.wikiPages || []).find(function (x) { return String(x.id) === gn.getAttribute('data-graph-node'); });
            if (target) { h.close(); paintWikiDoc(target); }
          };
        });
      }
    });
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
      + '<div class="zq-md" style="padding:4px 12px 10px;font-size:13px;line-height:1.7;max-height:260px;overflow-y:auto;">' + renderMarkdown(String(it.content || '')) + '</div></details>';
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
  await safe('待合入变更', async function () {
    var list = (await api.get('/knowledge/patch-sets?status=PENDING')) || [];
    await refreshWikiPatchBadge();
    if (!list.length) { await showInfo({ title: '待合入变更', message: '当前没有待合入的变更。AI 对知识库的修改建议会先出现在这里，确认后才写入正文。' }); return; }
    openModal({
      title: '待合入变更 · ' + list.length + ' 组',
      width: '640px',
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
    });
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
