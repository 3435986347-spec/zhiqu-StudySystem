// 看板 —— 第三十五轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// 留在壳里、经 zqShared 给的：任务表单（任务页也用）、番茄钟的今日计数 updatePomoCount（它是待补记的一部分 —— 每一页都在补记，
// 记完一个番茄钟时壳要刷新这个数）。state.weekOffset 照旧在壳的 state 上。
// dayReload：页面开着跨过业务日期的零点时壳叫它重新取（原来是壳里的 DAY_RELOAD，看板是最后一个）。

let api, esc, $, $all, empty, safe, toast, state, today, weekRange, zoneNote, normalizeTask, qKey, qLabel, pLabel, sLabel, fmtDate,
  openTaskForm, updatePomoCount;
export function bind(sh) {
  ({ api, esc, $, $all, empty, safe, toast, state, today, weekRange, zoneNote, normalizeTask, qKey, qLabel, pLabel, sLabel, fmtDate,
    openTaskForm, updatePomoCount } = sh);
}

export const boots = { 'dashboard.html': (sh) => { bind(sh); return bootDashboard(); } };
export const dayReload = { 'dashboard.html': () => bootDashboard() };

async function bootDashboard() {
  if (state.weekOffset == null) state.weekOffset = 0;
  var r = weekRange(state.weekOffset);
  var data = await api.get('/dashboard/overview?from=' + r[0] + '&to=' + r[1]);
  var sum = data.summary || {};
  var statNums = $all('.zq-stat-num');
  if (statNums[0]) statNums[0].textContent = sum.pendingToday == null ? sum.todayTasks || 0 : sum.pendingToday;
  if (statNums[1]) statNums[1].textContent = sum.overdue || 0;
  if (statNums[2]) statNums[2].textContent = sum.remindersToday || 0;
  if (statNums[3]) statNums[3].textContent = (sum.routineDone || 0) + '/' + (sum.routineTotal || 0);
  // 进度条原来是设计稿写死的 width:60%（0/0、0/1 都显示六成，2026-10-03 走主流程看到的）
  var routineBar = $('#zq-routine-bar');
  if (routineBar) routineBar.style.width = (sum.routineTotal ? Math.min(100, Math.round(100 * (sum.routineDone || 0) / sum.routineTotal)) : 0) + '%';
  var headerDate = $('header span');
  var todayRow = (data.days || []).find(function (d) { return d.today; });
  // 日期和星期都用服务端那一行的：原来是浏览器的日期拼服务端的星期（UTC+14 时「2026-09-29 · 周一」）
  if (headerDate) headerDate.textContent = (todayRow ? todayRow.date + ' · ' + todayRow.weekday : today()) + zoneNote();
  renderWeek(data.days || []);
  renderToday(todayRow ? todayRow.items || [] : [], todayRow ? todayRow.date : null);
  renderQuadrants(data.quadrants || []);
  renderDeadlines(data.upcomingDeadlines || []);
  // 周历标题随范围更新
  var weekSection = $('#zq-week') && $('#zq-week').closest('section');
  var weekTitle = weekSection && weekSection.querySelector('.zq-h2');
  if (weekTitle) weekTitle.textContent = r[0].slice(5).replace('-', '/') + ' – ' + r[1].slice(5).replace('-', '/');
  $all('[data-week-nav]').forEach(function (b) {
    b.onclick = function () {
      var nav = b.dataset.weekNav;
      state.weekOffset = nav === 'today' ? 0 : (state.weekOffset + (nav === 'next' ? 1 : -1));
      bootDashboard();
    };
  });
  var add = $('header .zq-btn');
  // 原来只跳到任务页，还要再点一次「新建任务」（2026-10-03 走主流程）；建好之后刷新的是看板
  if (add) add.onclick = function () { openTaskForm(null, bootDashboard); };
  await populatePomoTasks();
  await updatePomoCount();
  if (window.zqApi) window.zqApi.afterRecord = function () { bootDashboard(); };
}
async function populatePomoTasks() {
  var sel = $('#zq-pomo-task'); if (!sel) return;
  try {
    var tasks = ((await api.get('/task/page?status=0&limit=50')).items || []).map(normalizeTask);
    // 看板会被重新取（换周、记完一个番茄钟、跨过零点）：番茄钟正在跑时选好的任务不能被换回「不指定」
    var keep = sel.value;
    sel.innerHTML = '<option value="">（不指定任务）</option>' + tasks.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.title) + '</option>';
    }).join('');
    if (keep && tasks.some(function (t) { return String(t.id) === keep; })) sel.value = keep;
  } catch (e) { /* 忽略：下拉保持默认项 */ }
}

function renderWeek(days) {
  var host = $('#zq-week');
  if (!host) return;
  host.innerHTML = days.length ? days.map(function (d) {
    var items = (d.items || []).slice(0, 5).map(function (it) {
      return '<div style="display:grid;grid-template-columns:36px minmax(0,1fr);gap:6px;align-items:center;padding:6px 7px;border-radius:var(--zq-rs);background:' + (it.kind === 'ROUTINE' ? 'var(--zq-tint)' : 'var(--zq-card)') + ';border:1px solid var(--zq-border-soft);"><span class="zq-mono" style="color:var(--zq-primary);font-size:10.5px;font-weight:600;">' + esc(it.time || hm(it.deadline) || '') + '</span><span style="min-width:0;overflow:hidden;color:var(--zq-text);font-size:11.5px;font-weight:500;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.title) + '</span></div>';
    }).join('') || '<div style="padding:10px 0;text-align:center;color:var(--zq-text3);font-size:11.5px;">无安排</div>';
    return '<div style="min-height:225px;padding:10px;border:1px solid ' + (d.today ? 'var(--zq-primary)' : 'var(--zq-border-soft)') + ';border-radius:var(--zq-rs);background:' + (d.today ? 'var(--zq-tint)' : 'var(--zq-card-soft)') + ';"><div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;"><span style="color:' + (d.today ? 'var(--zq-primary)' : 'var(--zq-text2)') + ';font-size:11.5px;font-weight:700;">' + esc(d.weekday) + '</span><strong class="zq-mono" style="font-size:18px;color:' + (d.today ? 'var(--zq-primary)' : 'var(--zq-text)') + ';">' + esc(d.day) + '</strong></div><div style="display:flex;flex-direction:column;gap:7px;">' + items + '</div></div>';
  }).join('') : empty('暂无本周安排');
}
function renderToday(items, date) {
  var host = $('#zq-today');
  if (!host) return;
  host.innerHTML = items.length ? items.map(function (x) {
    var routine = x.kind === 'ROUTINE';
    var q = routine ? 'routine' : qKey(x.quadrant);
    var color = routine ? 'var(--zq-primary)' : 'var(--zq-' + q + ')';
    return '<div style="display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:12px;align-items:center;padding:8px 12px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:' + (routine ? 'var(--zq-tint)' : 'var(--zq-card)') + ';opacity:' + (x.status === 2 || x.completed ? .58 : 1) + ';"><span class="zq-mono" style="color:var(--zq-primary);font-size:12.5px;font-weight:600;">' + esc(x.time || hm(x.deadline) || '') + '</span><div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(x.title) + '</div><div style="display:flex;gap:6px;margin-top:4px;align-items:center;min-width:0;"><span class="zq-badge" style="background:var(--zq-tint);color:' + color + ';">' + esc(routine ? '例行' : qLabel(x.quadrant)) + '</span><span style="flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--zq-text2);font-size:11.5px;">' + esc(x.description || fmtDate(x.deadline)) + '</span></div></div><button class="zq-btn-ghost" data-task-done="' + esc(x.id || '') + '" data-kind="' + esc(x.kind || '') + '" data-date="' + esc(date || '') + '" style="height:28px;padding:0 11px;font-size:12px;">' + (x.status === 2 || x.completed ? '已完成' : '完成') + '</button></div>';
  }).join('') : empty('今天暂时没有安排');
  $all('[data-task-done]', host).forEach(function (btn) {
    btn.onclick = function () {
      var id = btn.getAttribute('data-task-done');
      if (!id) return;
      safe('完成', async function () {
        // 打卡记到这一行所在的那天（服务端给的日期），不是按下去这一刻浏览器算的「今天」：页面开着跨过零点、还没刷新时，
        // 用户看着的是昨天的列表，点的就是昨天那一条
        if (btn.getAttribute('data-kind') === 'ROUTINE') await api.post('/routine/' + id + '/checkin', { checkDate: btn.getAttribute('data-date') || today(), status: 'DONE' });
        else await api.put('/task/' + id + '/status?status=2');
        await bootDashboard();
      });
    };
  });
}
function renderQuadrants(rows) {
  var host = $('#zq-quad'); if (!host) return;
  host.innerHTML = rows.map(function (row) {
    var q = qKey(row.quadrant);
    var items = (row.items || []).map(function (x) { return '<div style="padding:7px 9px;border-radius:var(--zq-rs);background:var(--zq-' + q + '-bg);font-size:12px;font-weight:500;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(x.title) + '</div>'; }).join('') || '<div style="font-size:12px;color:var(--zq-text3);">暂无关键任务</div>';
    return '<div style="min-height:150px;padding:13px;border:1px solid var(--zq-' + q + '-border);border-radius:var(--zq-rs);background:var(--zq-card);border-top:3px solid var(--zq-' + q + ');"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;"><span style="font-size:12px;font-weight:700;color:var(--zq-' + q + ');white-space:nowrap;">' + qLabel(row.quadrant) + '</span><span class="zq-mono" style="font-size:12px;font-weight:600;color:var(--zq-text3);">' + (row.total || 0) + ' 项</span></div><div style="display:flex;flex-direction:column;gap:7px;">' + items + '</div></div>';
  }).join('');
}
function renderDeadlines(list) {
  var host = $('#zq-ddl'); if (!host) return;
  host.innerHTML = list.length ? list.map(function (d) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--zq-border-soft);"><div style="min-width:0;"><strong style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px;line-height:1.35;font-weight:600;">' + esc(d.title) + '</strong><span style="display:block;margin-top:3px;color:var(--zq-text2);font-size:11.5px;">' + esc(fmtDate(d.deadline)) + '</span></div><span class="zq-badge zq-mono" style="flex:none;background:var(--zq-card-soft);color:var(--zq-text2);">DDL</span></div>';
  }).join('') : empty('暂无临近 DDL');
}
