// 任务页 —— 第三十四轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// 任务表单（openTaskForm）看板也用，留在壳里经 zqShared 给；列表的状态（state.tasks / taskQuery / taskTotal）照旧放在壳的 state 上 ——
// 表单编辑时要从那里找原来那条任务。打开表单时把 bootTasks 作为「保存之后刷新什么」传进去。
// 第五十二轮（界面打磨第 6 步）：五个下拉 +「查询」换成一行工具条（搜索、状态分段、「筛选」展开第二行，改了就查）；
// 表格的行从一长串内联样式换成样式表里的类（列宽只在 .zq-task-grid 写一处），编辑 / 删除悬停或键盘移到这一行时才出现。

let api, esc, $, $all, empty, fmtDate, safe, askConfirm, state, latestOnly, normalizeTask, qKey, qLabel, pLabel, sLabel, openTaskForm,
  icon, nowMs, serverTime, today;
export function bind(sh) {
  ({ api, esc, $, $all, empty, fmtDate, safe, askConfirm, state, latestOnly, normalizeTask, qKey, qLabel, pLabel, sLabel, openTaskForm,
    icon, nowMs, serverTime, today } = sh);
}

export const boots = { 'tasks.html': (sh) => { bind(sh); return bootTasks(); } };

/** 新建、编辑、删除、换状态之后都叫它：工具条只接一次，列表按现在的条件重新取 */
async function bootTasks() {
  wireTools();
  await loadTasks();
}

/** 搜索框打字停多久才查（每个字都查的话，打「周报」要发四趟） */
var SEARCH_DELAY_MS = 300;
/** 排序的默认值（「筛选」上的数字不算它） */
var DEFAULT_SORT = 'updatedAt:desc';

/** 工具条上现在的条件 */
function readFilters() {
  var pressed = $('.zq-task-tools .zq-seg [aria-pressed="true"]');
  var val = function (sel) { var el = $(sel); return el ? el.value : ''; };
  return { keyword: val('#zq-task-q'), status: pressed ? pressed.dataset.status : '', quadrant: val('#zq-task-quadrant'), priority: val('#zq-task-priority'),
    sort: val('#zq-task-sort') || DEFAULT_SORT };
}
/** 条件 → 查询参数（纯函数，tasks-check.js 直接跑） */
function taskParams(f) {
  var params = new URLSearchParams();
  if (f.quadrant) params.set('quadrant', f.quadrant);
  if (f.status !== '') params.set('status', f.status);
  if (f.priority !== '') params.set('priority', f.priority);
  var sort = String(f.sort || DEFAULT_SORT).split(':');
  params.set('sortBy', sort[0]);
  params.set('sortOrder', sort[1] === 'asc' ? 'asc' : 'desc');
  var kw = String(f.keyword || '').trim();
  if (kw) params.set('keyword', kw);
  return params;
}
/** 「筛选」里改过几个（象限、优先级、不是默认的排序）—— 收起来的时候按钮上写出来，不然看不出列表被筛过 */
function extraCount(f) {
  return (f.quadrant ? 1 : 0) + (f.priority !== '' ? 1 : 0) + (f.sort && f.sort !== DEFAULT_SORT ? 1 : 0);
}
function isFiltered(f) {
  return !!(String(f.keyword || '').trim() || f.status !== '' || f.quadrant || f.priority !== '');
}

var toolsWired = false;
var searchTimer = null;
function wireTools() {
  if (toolsWired) return;
  toolsWired = true;
  var reload = function () { clearTimeout(searchTimer); safe('查任务', loadTasks); };
  var newBtn = $('#zq-task-new');
  if (newBtn) newBtn.onclick = function () { openTaskForm(null, bootTasks); };
  var q = $('#zq-task-q');
  if (q) {
    q.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(reload, SEARCH_DELAY_MS); });
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); reload(); } });
  }
  $all('.zq-task-tools .zq-seg button').forEach(function (b) {
    b.onclick = function () {
      $all('.zq-task-tools .zq-seg button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      reload();
    };
  });
  var more = $('#zq-task-more'), panel = $('#zq-task-filters');
  if (more && panel) {
    more.onclick = function () {
      panel.hidden = !panel.hidden;
      more.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    };
  }
  ['#zq-task-quadrant', '#zq-task-priority', '#zq-task-sort'].forEach(function (sel) {
    var el = $(sel); if (el) el.onchange = function () { paintMore(); reload(); };
  });
  var clear = $('#zq-task-clear');
  if (clear) clear.onclick = function () { clearFilters(); reload(); };
}
/** 「筛选」按钮上的数字 */
function paintMore() {
  var label = $('#zq-task-more-label'), more = $('#zq-task-more');
  var n = extraCount(readFilters());
  if (label) label.textContent = n ? '筛选 · ' + n : '筛选';
  if (more) more.classList.toggle('is-active', n > 0);
}
/** 回到什么都不筛：搜索框清空、状态「全部」、象限 / 优先级「全部」、排序默认 */
function clearFilters() {
  var q = $('#zq-task-q'); if (q) q.value = '';
  $all('.zq-task-tools .zq-seg button').forEach(function (x) { x.setAttribute('aria-pressed', x.dataset.status === '' ? 'true' : 'false'); });
  ['#zq-task-quadrant', '#zq-task-priority'].forEach(function (sel) { var el = $(sel); if (el) el.value = ''; });
  var sort = $('#zq-task-sort'); if (sort) sort.value = DEFAULT_SORT;
  paintMore();
}

async function loadTasks() {
  var f = readFilters();
  var params = taskParams(f);
  // 连着打字、连点分段时几趟请求一起在路上，回来的先后不一定：只认最后一次的
  var current = latestOnly('tasks');
  var page = await api.get('/task/page?' + params.toString() + '&offset=0&limit=' + TASK_PAGE_SIZE);
  if (!current()) return;
  state.taskQuery = params.toString();
  state.tasks = (page.items || []).map(normalizeTask);
  state.taskTotal = Number(page.total || 0);
  state.taskCapped = !!page.searchCapped;
  state.taskFiltered = isFiltered(f);
  renderTaskRows(state.tasks);
}

/**
 * 任务页一次取一页（第十七轮）。用了两年的账号有几千条任务：原来一次全取回来（1.6MB）、画出四万多个节点，
 * 页面要卡好几秒。现在先给 100 条，「加载更多」再取下一页；页头写的是真的总数。
 */
var TASK_PAGE_SIZE = 100;
async function loadMoreTasks() {
  var query = state.taskQuery;
  var page = await api.get('/task/page?' + query + '&offset=' + state.tasks.length + '&limit=' + TASK_PAGE_SIZE);
  // 这期间换了筛选条件（loadTasks 重新来过）：这一页是旧条件下的，不能接到新列表后面
  if (query !== state.taskQuery) return;
  state.tasks = state.tasks.concat((page.items || []).map(normalizeTask));
  state.taskTotal = Number(page.total || 0);
  renderTaskRows(state.tasks);
}

/** 时间写短一点：今年的不写年份（「10-14 09:00」），别的年份只写日期 —— 截止和提醒挤进一格，表格在最窄的桌面窗口里也不用横着滚 */
function shortWhen(v, thisYear) {
  var s = fmtDate(v);
  if (s === '—') return s;
  return s.slice(0, 4) === thisYear ? s.slice(5) : s.slice(0, 10);
}
/**
 * 一行（纯函数）：标题点了就编辑；象限是小圆点 + 名字（和看板一样）；截止和提醒在一格里（提醒是下面一行小字）、逾期没做完的截止时间红字；
 * 编辑 / 删除是两个图标按钮。原来截止、提醒各一列，表格最少 880px 宽 —— 桌面应用最窄时正文只有 700px 上下，编辑 / 删除在右边滚出去看不见
 */
function taskRowHtml(t, now, thisYear) {
  var overdue = t.status !== 2 && !!t.deadline && serverTime(t.deadline) < now;
  var name = esc(t.title);
  return '<div class="zq-task-line zq-task-grid' + (t.status === 2 ? ' is-done' : '') + '">'
    + '<div class="zq-task-main"><button type="button" class="zq-task-title" data-edit-task="' + t.id + '" title="编辑">' + name + '</button>'
    + (t.description ? '<div class="zq-task-desc">' + esc(t.description) + '</div>' : '') + '</div>'
    + '<span class="zq-task-quad"><i class="' + qKey(t.quadrant) + '"></i>' + esc(qLabel(t.quadrant)) + '</span>'
    + '<span class="zq-task-pri">' + esc(pLabel(t.priority)) + '</span>'
    + '<span class="zq-task-st"><button type="button" class="zq-task-status' + (t.status === 1 ? ' is-doing' : '') + '" data-cycle-task="' + t.id
    + '" title="点一下换到下一个状态：待办 → 进行中 → 已完成">' + esc(sLabel(t.status)) + '</button></span>'
    + '<span class="zq-task-time"><span class="zq-task-when zq-num' + (overdue ? ' is-overdue" title="已经过了截止时间' : '') + '">' + esc(shortWhen(t.deadline, thisYear)) + '</span>'
    + (t.reminderTime ? '<span class="zq-task-remind zq-num" title="提醒时间">提醒 ' + esc(shortWhen(t.reminderTime, thisYear)) + '</span>' : '') + '</span>'
    + '<span class="zq-task-acts">'
    + '<button type="button" class="zq-icon-btn" data-edit-task="' + t.id + '" aria-label="编辑「' + name + '」" title="编辑">' + icon('pencil') + '</button>'
    + '<button type="button" class="zq-icon-btn is-danger" data-del-task="' + t.id + '" aria-label="删除「' + name + '」" title="删除">' + icon('trash-2') + '</button>'
    + '</span></div>';
}
/** 页头那一行小字：共几条 / 找到几条；关键词搜索看的条数到了上限要说出来（不然「没找到」可能是假的） */
function countText(total, shown, filtered, capped) {
  var t = (filtered ? '找到 ' : '共 ') + total + ' 条';
  if (total > shown) t += '（先显示 ' + shown + ' 条）';
  if (capped) t += ' · 只在前 5000 条里找了';
  return t;
}
function renderTaskRows(list) {
  var host = $('#zq-rows'); if (!host) return;
  var now = nowMs(), thisYear = today().slice(0, 4);
  var total = Math.max(state.taskTotal || 0, list.length);
  if (list.length) host.innerHTML = list.map(function (t) { return taskRowHtml(t, now, thisYear); }).join('');
  else if (state.taskFiltered) host.innerHTML = '<div class="zq-empty">没有符合条件的任务 <button type="button" class="zq-btn-ghost" data-clear-filters>清除筛选</button></div>';
  else host.innerHTML = empty('还没有任务 —— 点右上角「新建任务」，或者在 AI 助手里说一句');
  var count = $('#zq-task-count');
  if (count) count.textContent = countText(total, list.length, state.taskFiltered, state.taskCapped);
  if (total > list.length) {
    host.insertAdjacentHTML('beforeend', '<div class="zq-task-more-row"><button type="button" class="zq-btn-ghost" data-more-tasks>加载更多（还有 ' + (total - list.length) + ' 条）</button></div>');
    var more = $('[data-more-tasks]', host);
    if (more) more.onclick = function () { more.disabled = true; safe('加载任务', loadMoreTasks); };
  }
  var clear = $('[data-clear-filters]', host);
  if (clear) clear.onclick = function () { clearFilters(); safe('查任务', loadTasks); };
  $all('[data-cycle-task]', host).forEach(function (b) { b.onclick = function () { cycleTask(Number(b.dataset.cycleTask)); }; });
  $all('[data-del-task]', host).forEach(function (b) { b.onclick = function () { deleteTask(Number(b.dataset.delTask)); }; });
  $all('[data-edit-task]', host).forEach(function (b) { b.onclick = function () { safe('打开任务', function () { return openTaskForm(Number(b.dataset.editTask), bootTasks); }); }; });
}

async function deleteTask(id) {
  if (!await askConfirm({ title: '删除任务', message: '确定删除这个任务？删除后不可恢复。', okText: '删除', danger: true })) return;
  await safe('删除任务', async function () { await api.del('/task/' + id); await bootTasks(); });
}
async function cycleTask(id) {
  var t = state.tasks.find(function (x) { return x.id === id; }); if (!t) return;
  await safe('切换状态', async function () { await api.put('/task/' + id + '/status?status=' + ((t.status + 1) % 3)); await bootTasks(); });
}
