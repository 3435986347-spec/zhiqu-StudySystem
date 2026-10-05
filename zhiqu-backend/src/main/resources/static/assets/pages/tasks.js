// 任务页 —— 第三十四轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// 任务表单（openTaskForm）看板也用，留在壳里经 zqShared 给；列表的状态（state.tasks / taskQuery / taskTotal）照旧放在壳的 state 上 ——
// 表单编辑时要从那里找原来那条任务。挪过来的代码只改了一处：打开表单时把 bootTasks 作为「保存之后刷新什么」传进去
// （原来表单默认就刷新任务页，任务页挪走之后壳里没有 bootTasks 了）。

let api, esc, $, $all, empty, fmtDate, safe, askConfirm, state, latestOnly, normalizeTask, qKey, qLabel, pLabel, sLabel, openTaskForm;
export function bind(sh) {
  ({ api, esc, $, $all, empty, fmtDate, safe, askConfirm, state, latestOnly, normalizeTask, qKey, qLabel, pLabel, sLabel, openTaskForm } = sh);
}

export const boots = { 'tasks.html': (sh) => { bind(sh); return bootTasks(); } };

async function bootTasks() {
  var selects = $all('.zq-card .zq-select');
  var queryBtn = $all('.zq-card .zq-btn')[0], newBtn = $all('.zq-card .zq-btn')[1];
  if (queryBtn) queryBtn.onclick = loadTasks;
  if (newBtn) newBtn.onclick = function () { openTaskForm(null, bootTasks); };
  await loadTasks();
  async function loadTasks() {
    var params = new URLSearchParams();
    var q = selects[0] ? selects[0].selectedIndex : 0, s = selects[1] ? selects[1].selectedIndex : 0, p = selects[2] ? selects[2].selectedIndex : 0;
    if (q) params.set('quadrant', q);
    if (s) params.set('status', s - 1);
    if (p) params.set('priority', p - 1);
    params.set('sortBy', selects[3] && selects[3].selectedIndex === 1 ? 'deadline' : selects[3] && selects[3].selectedIndex === 2 ? 'priority' : 'updatedAt');
    params.set('sortOrder', selects[4] && selects[4].selectedIndex === 1 ? 'asc' : 'desc');
    var current = latestOnly('tasks');
    var page = await api.get('/task/page?' + params.toString() + '&offset=0&limit=' + TASK_PAGE_SIZE);
    if (!current()) return;
    state.taskQuery = params.toString();
    state.tasks = (page.items || []).map(normalizeTask);
    state.taskTotal = Number(page.total || 0);
    renderTaskRows(state.tasks);
  }
}

/**
 * 任务页一次取一页（第十七轮）。用了两年的账号有几千条任务：原来一次全取回来（1.6MB）、画出四万多个节点，
 * 页面要卡好几秒。现在先给 100 条，「加载更多」再取下一页；页脚写的是真的总数。
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
function renderTaskRows(list) {
  var host = $('#zq-rows'); if (!host) return;
  host.innerHTML = list.length ? list.map(function (t) {
    var q = qKey(t.quadrant);
    return '<div style="display:grid;grid-template-columns:minmax(200px,2.2fr) 104px 64px 78px 118px 118px 108px;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--zq-border-soft);opacity:' + (t.status === 2 ? .55 : 1) + ';"><div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.title) + '</div><div style="font-size:11.5px;color:var(--zq-text3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.description || '—') + '</div></div><span><span class="zq-badge" style="background:var(--zq-' + q + '-bg);color:var(--zq-' + q + ');">' + qLabel(t.quadrant) + '</span></span><span style="font-size:12.5px;font-weight:600;">' + pLabel(t.priority) + '</span><span><button data-cycle-task="' + t.id + '" style="display:inline-flex;align-items:center;height:22px;padding:0 9px;border:1px solid var(--zq-border);border-radius:999px;background:var(--zq-card-soft);color:var(--zq-text2);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">' + sLabel(t.status) + '</button></span><span class="zq-num" style="font-size:12px;color:var(--zq-text2);">' + esc(fmtDate(t.deadline)) + '</span><span class="zq-num" style="font-size:12px;color:var(--zq-text2);">' + esc(fmtDate(t.reminderTime)) + '</span><span style="display:flex;justify-content:flex-end;gap:6px;"><button class="zq-btn-ghost" data-edit-task="' + t.id + '" style="height:26px;padding:0 10px;font-size:12px;">编辑</button><button class="zq-btn-ghost" data-del-task="' + t.id + '" style="height:26px;padding:0 10px;font-size:12px;">删除</button></span></div>';
  }).join('') : empty('暂无任务');
  var total = Math.max(state.taskTotal || 0, list.length);
  if (total > list.length) {
    host.insertAdjacentHTML('beforeend', '<div style="padding:12px 16px;text-align:center;"><button class="zq-btn-ghost" data-more-tasks style="height:30px;">加载更多（还有 ' + (total - list.length) + ' 条）</button></div>');
    var more = $('[data-more-tasks]', host);
    if (more) more.onclick = function () { more.disabled = true; safe('加载任务', loadMoreTasks); };
  }
  var foot = $('.zq-table > div:last-child span');
  if (foot) foot.textContent = '共 ' + total + ' 条' + (total > list.length ? '（显示了 ' + list.length + ' 条）' : '');
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
