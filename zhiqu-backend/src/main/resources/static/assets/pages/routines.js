// 例行计划页 —— 第三十二轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头：
// 导出 boots，壳按 PAGE_MODULES import；bind(sh) 把要用的壳里的东西解构成同名局部变量，挪过来的代码一个字不用改。
// 另外导出：dayReload（页面开着跨过业务日期的零点时壳叫它重新取数据 —— 只取数据，不重新绑事件：bootRoutines 用 addEventListener，
// 重跑一次每个按钮点一下就提交两遍）；routinePhase 和 bind 给测试直接 import（routine-phase-check.js）。

let api, esc, $, $all, empty, safe, toast, askConfirm, today, latestOnly, keepDraft, normalizeTask, qLabel, sLabel, freqLabel;
export function bind(sh) {
  ({ api, esc, $, $all, empty, safe, toast, askConfirm, today, latestOnly, keepDraft, normalizeTask, qLabel, sLabel, freqLabel } = sh);
}
let routineDrafts = null;   // 原来是壳的 state.routineDrafts —— 标题、说明两个输入框的草稿，只接一次

export const boots = { 'routines.html': (sh) => { bind(sh); return bootRoutines(); } };
export const dayReload = { 'routines.html': () => loadRoutines() };
export { routinePhase };

async function bootRoutines() {
  await loadRoutineSources(0);
  await loadRoutines();
  var buttons = $all('button.zq-btn, button.zq-btn-ghost');
  var createBtn = buttons.find(function (b) { return /创建例行计划/.test(b.textContent); });
  if (createBtn) createBtn.onclick = createRoutineFromForm;
  var genBtn = buttons.find(function (b) { return /生成例行计划/.test(b.textContent); });
  if (genBtn) genBtn.onclick = generateRoutinesFromTasks;
  var genSection = $all('section').find(function (s) { return /从任务生成/.test(s.textContent); });
  if (genSection) {
    var filterSel = $('select', genSection);
    var refreshBtn = $all('button', genSection).find(function (b) { return /刷新/.test(b.textContent); });
    if (filterSel) filterSel.onchange = function () { loadRoutineSources(filterSel.selectedIndex); };
    if (refreshBtn) refreshBtn.onclick = function () { loadRoutineSources(filterSel ? filterSel.selectedIndex : 0); };
  }
  // 开始日期默认今天、结束日期空着（服务器按开始日期 +29 天）。原来 HTML 里写死 2026-07-06 → 2026-08-30，
  // 是设计稿上的日期：过了那天照默认值建出来的就是一个已经结束的计划（第十四轮真浏览器里看到的）
  var newSection = $all('section').find(function (s) { return /新建例行计划/.test(s.textContent); });
  var startInput = newSection && $('input[type="date"]', newSection);
  if (startInput && !startInput.value) startInput.value = today();
  // 标题、说明打了一半刷新也还在（第十五轮）；建好之后清空（见 createRoutineFromForm）
  if (newSection && !routineDrafts) {
    routineDrafts = [keepDraft($('input[placeholder*="英语单词"]', newSection), 'routine.new.title'),
      keepDraft($('textarea', newSection), 'routine.new.desc')];
  }
  // 星期选择器接线（点亮/熄灭），仅前端状态，提交时读取
  $all('#zq-wd button').forEach(function (b) {
    if (b.dataset.wired) return; b.dataset.wired = '1';
    b.addEventListener('click', function () {
      b.dataset.on = b.dataset.on === '1' ? '0' : '1';
      var on = b.dataset.on === '1';
      b.style.borderColor = on ? 'var(--zq-primary)' : 'var(--zq-border)';
      b.style.background = on ? 'var(--zq-tint)' : 'var(--zq-card)';
      b.style.color = on ? 'var(--zq-primary)' : 'var(--zq-text2)';
    });
  });
}
async function loadRoutineSources(statusIdx) {
  var params = statusIdx === 1 ? '&status=0' : statusIdx === 2 ? '&status=1' : '';
  var current = latestOnly('routine-sources');
  var tasks = ((await api.get('/task/page?limit=20' + params)).items || []).map(normalizeTask);
  if (!current()) return;
  renderRoutineSources(tasks);
}
function selectedWeekdays() {
  var days = [];
  $all('#zq-wd button').forEach(function (b, i) { if (b.dataset.on === '1') days.push(i + 1); });
  return days;
}
async function generateRoutinesFromTasks() {
  var genSection = $all('section').find(function (s) { return /从任务生成/.test(s.textContent); });
  if (!genSection) return;
  var checked = $all('#zq-src input[type="checkbox"]').filter(function (c) { return c.checked; });
  if (!checked.length) return toast('请先勾选要生成的任务', 'error');
  var selects = $all('select', genSection);
  var freqSel = selects[1], remindSel = selects[2];
  var frequency = freqSel && freqSel.selectedIndex === 1 ? 'WEEKLY' : 'DAILY';
  var duration = Number(($('input[type="number"]', genSection) || {}).value || 45);
  var pref = ($('input[type="time"]', genSection) || {}).value || '08:00';
  var reminderEnabled = !remindSel || remindSel.selectedIndex === 0;
  var days = selectedWeekdays();
  await safe('生成例行计划', async function () {
    for (var i = 0; i < checked.length; i++) {
      var label = checked[i].closest('label');
      var titleEl = label && label.querySelector('div > div');
      var title = titleEl ? titleEl.textContent : '例行计划';
      var payload = { title: title, frequency: frequency, durationMinutes: duration, preferredTime: pref, reminderEnabled: reminderEnabled, startDate: today() };
      if (frequency === 'WEEKLY' && days.length) payload.daysOfWeek = days;
      await api.post('/routine', payload);
    }
    // 生成完把勾去掉：勾还在的话，回来之后再点一下就把同一批任务又生成一遍（同「新建例行计划」清空表单）
    checked.forEach(function (c) { c.checked = false; });
    toast('已生成 ' + checked.length + ' 个例行计划');
    await loadRoutines();
  });
}
function renderRoutineSources(tasks) {
  var host = $('#zq-src'); if (!host) return;
  host.innerHTML = tasks.slice(0, 20).map(function (t) {
    return '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card);cursor:pointer;"><input type="checkbox" value="' + t.id + '" style="accent-color:var(--zq-primary);"><div style="min-width:0;flex:1;"><div style="font-size:13px;font-weight:var(--zq-fw-medium);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.title) + '</div><div style="font-size:11.5px;color:var(--zq-text3);margin-top:2px;">' + esc(qLabel(t.quadrant) + ' · ' + sLabel(t.status)) + '</div></div></label>';
  }).join('') || empty('暂无可选择任务');
}
// 例行计划今天是什么状态：没开始 / 进行中 / 已结束（日期都是 YYYY-MM-DD，按字符串比就是按日期比）。
// 原来一律当「进行中」、都给「标记完成」—— 已经结束的点了只会报「该日期不在例行计划范围内」（第十四轮连点暴力测试撞见的）
function routinePhase(r, day) {
  if (r.startDate && String(r.startDate).slice(0, 10) > day) return 'upcoming';
  if (r.endDate && String(r.endDate).slice(0, 10) < day) return 'ended';
  return 'active';
}
async function loadRoutines() {
  var host = $('#zq-rt'); if (!host) return;
  var list = await api.get('/routine/list');
  var day = today();
  var active = list.filter(function (r) { return routinePhase(r, day) === 'active'; }).length;
  // 标题旁那句「N 个进行中」原来是设计稿写死的「5 个进行中」，从来不变
  // 按 id 找（第二十四轮）：原来按「个进行中」这几个字找那个 span —— 字是设计稿写死的「5 个进行中」，删掉示例数据就找不到了
  var countEl = $('#zq-rt-count');
  if (countEl) countEl.textContent = active + ' 个进行中';
  host.innerHTML = list.length ? list.map(function (r) {
    var phase = routinePhase(r, day);
    var when = phase === 'upcoming' ? ' · ' + String(r.startDate).slice(5, 10).replace('-', '/') + ' 开始'
      : phase === 'ended' ? ' · 已结束（' + String(r.endDate).slice(5, 10).replace('-', '/') + '）' : '';
    var check = phase === 'active' ? '<button data-check-routine="' + r.id + '" class="zq-btn-ghost" style="height:28px;padding:0 11px;font-size:12px;">标记完成</button>' : '';
    return '<div style="display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card);"><div class="zq-num" style="flex:none;min-width:46px;height:32px;padding:0 8px;border-radius:var(--zq-rs);background:var(--zq-tint);color:var(--zq-primary);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:var(--zq-fw-medium);">' + esc((r.preferredTime || '08:00').slice(0, 5)) + '</div><div style="flex:1;min-width:0;"><div style="font-size:13.5px;font-weight:var(--zq-fw-medium);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(r.title) + '</div><div style="font-size:11.5px;color:var(--zq-text2);margin-top:3px;">' + esc(freqLabel(r.frequency, r.daysOfWeek) + ' · ' + (r.durationMinutes || 0) + ' 分钟' + when) + '</div></div>' + check + '<button data-del-routine="' + r.id + '" class="zq-btn-ghost" style="height:28px;padding:0 11px;font-size:12px;">删除</button></div>';
  }).join('') : empty('暂无例行计划');
  $all('[data-check-routine]', host).forEach(function (b) { b.onclick = async function () { await api.post('/routine/' + b.dataset.checkRoutine + '/checkin', { status: 'DONE' }); await loadRoutines(); }; });
  $all('[data-del-routine]', host).forEach(function (b) { b.onclick = async function () { if (await askConfirm({ title: '删除例行计划', message: '删除这个例行计划？相关的未来提醒会一并停止。', okText: '删除', danger: true })) { await api.del('/routine/' + b.dataset.delRoutine); await loadRoutines(); } }; });
}
async function createRoutineFromForm() {
  var section = $all('section').find(function (s) { return /新建例行计划/.test(s.textContent); });
  if (!section) return;
  var title = $('input[placeholder*="英语单词"]', section).value.trim();
  if (!title) return toast('请输入标题', 'error');
  await safe('创建例行计划', async function () {
    await api.post('/routine', {
      title: title,
      description: $('textarea', section).value || '',
      frequency: $('select', section).selectedIndex === 0 ? 'DAILY' : 'WEEKLY',
      durationMinutes: Number($('input[type="number"]', section).value || 45),
      startDate: $('input[type="date"]', section).value || today(),
      endDate: $all('input[type="date"]', section)[1]?.value || '',
      preferredTime: '08:00',
      reminderEnabled: true
    });
    // 建好就清空标题和说明：这是页面上常驻的表单，不像弹窗那样一建就关。不清的话，
    // 回来之后多点的那一下（第十四轮真浏览器：双击后又补了一下）会拿同一个标题再建一个
    $('input[placeholder*="英语单词"]', section).value = '';
    $('textarea', section).value = '';
    (routineDrafts || []).forEach(function (d) { d.clear(); });
    toast('例行计划已创建'); await loadRoutines();
  });
}
