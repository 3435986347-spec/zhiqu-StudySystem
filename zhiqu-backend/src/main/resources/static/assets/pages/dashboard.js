// 看板 —— 第三十五轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// 留在壳里、经 zqShared 给的：任务表单（任务页也用）、番茄钟的今日计数 updatePomoCount（它是待补记的一部分 —— 每一页都在补记，
// 记完一个番茄钟时壳要刷新这个数）。state.weekOffset 照旧在壳的 state 上。
// dayReload：页面开着跨过业务日期的零点时壳叫它重新取（原来是壳里的 DAY_RELOAD，看板是最后一个）。

// hm（时:分）第四十八轮才从壳里给过来：原来模块里直接调、壳却没给 —— 例行计划没填时间时一调就 ReferenceError，整个看板画不出来（PageModulesTest）
let api, esc, $, $all, empty, safe, toast, state, today, weekRange, zoneNote, normalizeTask, qKey, qLabel, pLabel, sLabel, fmtDate, hm,
  openTaskForm, updatePomoCount;
export function bind(sh) {
  ({ api, esc, $, $all, empty, safe, toast, state, today, weekRange, zoneNote, normalizeTask, qKey, qLabel, pLabel, sLabel, fmtDate, hm,
    openTaskForm, updatePomoCount } = sh);
}

export const boots = { 'dashboard.html': (sh) => { bind(sh); return bootDashboard(); } };
export const dayReload = { 'dashboard.html': () => bootDashboard() };

async function bootDashboard() {
  if (state.weekOffset == null) state.weekOffset = 0;
  var r = weekRange(state.weekOffset);
  // 番茄钟那两块（任务下拉、今日计数）和总览互不依赖，一起取（第三十九轮：原来排在总览画完之后一个接一个）。
  // 两个都自己接住失败，这里不会有没人管的 rejection
  var pomo = Promise.all([populatePomoTasks(), updatePomoCount()]);
  // 连点「上一周 / 下一周」时几次请求一起在路上，回来的先后不一定（第四十八轮暴力测试）：只画最后一次的
  var seq = state.dashSeq = (state.dashSeq || 0) + 1;
  var data = await api.get('/dashboard/overview?from=' + r[0] + '&to=' + r[1]);
  if (seq !== state.dashSeq) { await pomo; return; }
  var sum = data.summary || {};
  var statNums = $all('.zq-stat-num');
  if (statNums[0]) statNums[0].textContent = sum.pendingToday == null ? sum.todayTasks || 0 : sum.pendingToday;
  if (statNums[1]) statNums[1].textContent = sum.overdue || 0;
  // 逾期：大于 0 时标签旁边一个红点（第四十八轮；原来数字写死大红，0 也红）
  var overdueCard = $('#zq-stat-overdue');
  if (overdueCard) overdueCard.classList.toggle('is-alert', (sum.overdue || 0) > 0);
  if (statNums[2]) statNums[2].textContent = sum.remindersToday || 0;
  if (statNums[3]) statNums[3].textContent = (sum.routineDone || 0) + '/' + (sum.routineTotal || 0);
  // 进度条原来是设计稿写死的 width:60%（0/0、0/1 都显示六成，2026-10-03 走主流程看到的）
  var routineBar = $('#zq-routine-bar');
  if (routineBar) routineBar.style.width = (sum.routineTotal ? Math.min(100, Math.round(100 * (sum.routineDone || 0) / sum.routineTotal)) : 0) + '%';
  var headerDate = $('.zq-page-sub');
  var todayRow = (data.days || []).find(function (d) { return d.today; });
  // 日期和星期都用服务端那一行的：原来是浏览器的日期拼服务端的星期（UTC+14 时「2026-09-29 · 周一」）
  if (headerDate) headerDate.textContent = (todayRow ? todayRow.date + ' · ' + todayRow.weekday : today()) + zoneNote();
  state.weekDays = data.days || [];
  // 点过别的一天（第四十八轮）：重新取完之后还停在那一天。选的那天不在这一周（换过周）就不算数 ——
  // 不清掉的话回到本周时一格都没选中（暴力测试照出来的）；那一周没有今天时先看那一周的第一天
  var keep = state.dashDay && state.weekDays.some(function (d) { return d.date === state.dashDay; }) ? state.dashDay : null;
  state.dashDay = keep;
  renderWeek(data.days || []);
  renderToday(todayRow ? todayRow.items || [] : [], todayRow ? todayRow.date : null);
  if (keep) showDay(keep);
  else if (!todayRow && state.weekDays.length) showDay(state.weekDays[0].date);
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
  await pomo;
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

/** 一个日子里最多画几个点（一个点一件事），多了写「+N」 */
var DOT_MAX = 8;
/**
 * 本周日历（第四十八轮，界面打磨第 5 步）：一天一格 —— 星期、日期（今天是一个实心圆）、一排点（颜色是象限，例行计划灰色，做完的变淡）、几项。
 * 原来每天最多五个灰块「08:00 例…」，标题截到只剩一两个字，七个格子各 225px 高。格子是按钮：点一天，下面的清单换成那一天的。
 */
function renderWeek(days) {
  var host = $('#zq-week');
  if (!host) return;
  host.innerHTML = days.length ? days.map(function (d) {
    var items = d.items || [];
    var on = state.dashDay ? state.dashDay === d.date : !!d.today;
    var dots = items.slice(0, DOT_MAX).map(function (it) {
      return '<i class="' + (it.kind === 'ROUTINE' ? 'r' : qKey(it.quadrant)) + (it.status === 2 || it.completed ? ' done' : '') + '"></i>';
    }).join('') + (items.length > DOT_MAX ? '<span class="zq-day-more">+' + (items.length - DOT_MAX) + '</span>' : '');
    return '<button type="button" class="zq-day' + (d.today ? ' is-today' : '') + (on ? ' is-on' : '') + '" data-day="' + esc(d.date) + '"'
      + ' aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc(d.weekday + ' ' + d.date + '，' + (items.length ? items.length + ' 项' : '没有安排')) + '">'
      + '<span class="zq-day-head"><span class="zq-day-week">' + esc(d.weekday) + '</span><strong class="zq-day-num zq-num">' + esc(d.day) + '</strong></span>'
      + '<span class="zq-day-dots">' + dots + '</span>'
      + '<span class="zq-day-count">' + (items.length ? items.length + ' 项' : '—') + '</span></button>';
  }).join('') : empty('暂无本周安排');
  $all('[data-day]', host).forEach(function (b) { b.onclick = function () { showDay(b.getAttribute('data-day')); }; });
}
/** 点一天：下面的清单换成那一天的；点回今天就是「今天」（选中的那天记在 state.dashDay，重新取数据之后还停在那儿）。 */
function showDay(date) {
  var days = state.weekDays || [];
  var d = days.find(function (x) { return x.date === date; });
  if (!d) return;
  state.dashDay = d.today ? null : d.date;
  $all('#zq-week [data-day]').forEach(function (b) {
    var on = b.getAttribute('data-day') === d.date;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  renderToday(d.items || [], d.date);
}
function renderToday(items, date) {
  var host = $('#zq-today');
  if (!host) return;
  // 标题跟着选的那天：今天就是「今天」，别的日子写「10/09 周四」；以后的日子还没到，不给「完成」按钮
  var row = (state.weekDays || []).find(function (x) { return x.date === date; });
  var isToday = !date || !!(row && row.today);
  var title = $('#zq-today-title');
  if (title) title.textContent = isToday ? '今天' : String(date).slice(5).replace('-', '/') + (row ? ' ' + row.weekday : '');
  var future = !isToday && !!date && date > today();
  host.innerHTML = items.length ? items.map(function (x) {
    var routine = x.kind === 'ROUTINE';
    var done = x.status === 2 || x.completed;
    var color = routine ? 'var(--zq-text3)' : 'var(--zq-' + qKey(x.quadrant) + ')';
    // 一条一行、行间一道细线（第四十八轮；原来一条一张带底色的小卡片，例行计划另一种底色）
    return '<div class="zq-agenda-row' + (done ? ' is-done' : '') + '"><span class="zq-agenda-time zq-num">' + esc(x.time || hm(x.deadline) || '') + '</span>'
      + '<div style="min-width:0;"><div style="line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(x.title) + '</div>'
      + '<div class="zq-agenda-meta"><span class="zq-agenda-tag"><i style="background:' + color + ';"></i>' + esc(routine ? '例行' : qLabel(x.quadrant)) + '</span>'
      + '<span style="flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(x.description || fmtDate(x.deadline)) + '</span></div></div>'
      + (future ? '<span></span>' : '<button class="zq-btn-ghost zq-agenda-btn" data-task-done="' + esc(x.id || '') + '" data-kind="' + esc(x.kind || '') + '" data-date="' + esc(date || '') + '">' + (done ? '已完成' : '完成') + '</button>')
      + '</div>';
  }).join('') : empty(isToday ? '今天暂时没有安排' : '这一天没有安排');
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
  // 一张卡里四格（第四十八轮）：象限色只留在名字前的一个小点上，任务一条一行；原来四张卡、顶上一道 3px 彩边、每条一块彩色底
  host.innerHTML = rows.map(function (row) {
    var q = qKey(row.quadrant);
    var items = (row.items || []).map(function (x) { return '<div class="zq-quad-item" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(x.title) + '</div>'; }).join('')
      || '<div class="zq-quad-empty">没有待办</div>';
    return '<div class="zq-quad"><div class="zq-quad-head"><span class="zq-quad-name"><i style="background:var(--zq-' + q + ');"></i>' + qLabel(row.quadrant) + '</span>'
      + '<span class="zq-num zq-quad-count">' + (row.total || 0) + ' 项</span></div>' + items + '</div>';
  }).join('');
}
/** 离截止还有几天（业务时区的日期差：今天 0、明天 1、逾期是负的）；日期坏了给 null */
function daysUntil(deadline) {
  var d = String(deadline || '').slice(0, 10), t = String(today() || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  var ms = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10));
  return Math.round(ms / 86400000);
}
function dueLabel(n) {
  if (n == null) return '';
  return n < 0 ? '逾期 ' + (-n) + ' 天' : n === 0 ? '今天' : n === 1 ? '明天' : n + ' 天后';
}
function renderDeadlines(list) {
  var host = $('#zq-ddl'); if (!host) return;
  // 右边原来是每条一模一样的「DDL」徽标，什么也没说 —— 换成还有几天，今天和逾期的标红（第四十八轮）
  host.innerHTML = list.length ? list.map(function (d) {
    var n = daysUntil(d.deadline);
    return '<div class="zq-ddl-row"><div style="min-width:0;"><strong style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;font-weight:var(--zq-fw-medium);">' + esc(d.title) + '</strong>'
      + '<span class="zq-ddl-when zq-num">' + esc(fmtDate(d.deadline)) + '</span></div>'
      + '<span class="zq-ddl-due zq-num' + (n != null && n <= 0 ? ' is-near' : '') + '">' + esc(dueLabel(n)) + '</span></div>';
  }).join('') : empty('暂无临近截止的事');
}
