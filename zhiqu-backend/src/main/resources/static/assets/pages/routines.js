// 例行计划页 —— 第三十二轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头：
// 导出 boots，壳按 PAGE_MODULES import；bind(sh) 把要用的壳里的东西解构成同名局部变量。
// 另外导出：dayReload（页面开着跨过业务日期的零点时壳叫它重新取数据 —— 只取数据，不重新接按钮）；
// 画法和读表单的几个函数给测试直接 import（routine-phase-check.js、routines-check.js）。
//
// 第五十六轮（界面打磨第 8 步）改成：页面只放「今天」和「全部例行计划」两块，新建和从任务生成是页头的两个弹窗、用同一套设置。
// 原来两张表单常驻在列表上面（31 个计划在 1440 宽时第一屏只露出四条），新建的那张没有星期、时间、提醒；
// 「标记完成」不管今天轮不轮到都给（周六点「每周一、三、五」的，服务端回「该日期不在例行计划范围内」）；打过卡的那一行也看不出来。

let api, esc, $, $all, empty, safe, toast, askConfirm, today, latestOnly, keepDraft, normalizeTask, qLabel, sLabel, freqLabel, openModal, icon;
export function bind(sh) {
  ({ api, esc, $, $all, empty, safe, toast, askConfirm, today, latestOnly, keepDraft, normalizeTask, qLabel, sLabel, freqLabel, openModal, icon } = sh);
}

export const boots = { 'routines.html': (sh) => { bind(sh); return bootRoutines(); } };
export const dayReload = { 'routines.html': () => loadRoutines() };
export { routinePhase, sortRoutines, todayRowsHtml, routineRowsHtml, settingsHtml, readRoutineForm, isoWeekday };

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

async function bootRoutines() {
  var n = $('#zq-rt-new'); if (n) n.onclick = openNewRoutine;
  var g = $('#zq-rt-from-tasks'); if (g) g.onclick = openFromTasks;
  await loadRoutines();
}

// 例行计划今天是什么状态：没开始 / 进行中 / 已结束（日期都是 YYYY-MM-DD，按字符串比就是按日期比）。
// 原来一律当「进行中」、都给「标记完成」—— 已经结束的点了只会报「该日期不在例行计划范围内」（第十四轮连点暴力测试撞见的）
function routinePhase(r, day) {
  if (r.startDate && String(r.startDate).slice(0, 10) > day) return 'upcoming';
  if (r.endDate && String(r.endDate).slice(0, 10) < day) return 'ended';
  return 'active';
}
/** 进行中的在前、没开始的、已结束的在后；同一段里按时间、再按名字 */
function sortRoutines(list, day) {
  var rank = { active: 0, upcoming: 1, ended: 2 };
  return list.slice().sort(function (a, b) {
    return (rank[routinePhase(a, day)] - rank[routinePhase(b, day)])
      || String(a.preferredTime || '').localeCompare(String(b.preferredTime || ''))
      || String(a.title || '').localeCompare(String(b.title || ''));
  });
}
/** YYYY-MM-DD 是星期几（1 = 周一 … 7 = 周日，和服务端 DayOfWeek 一样）—— 按 UTC 算，不受浏览器时区影响 */
function isoWeekday(day) {
  var p = String(day).split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  return d === 0 ? 7 : d;
}
function hm5(t) { return String(t || '08:00').slice(0, 5); }
function meta(r) { return freqLabel(r.frequency, r.daysOfWeek) + ' · ' + (r.durationMinutes || 0) + ' 分钟'; }

/** 「今天」：今天轮到的（/routine/instances 今天一天），和看板「今天」一个画法；打过卡的变淡、按钮写「已完成」 */
function todayRowsHtml(items, day) {
  if (!items.length) return empty('今天没有要做的例行计划');
  return items.map(function (x) {
    var done = !!x.completed;
    return '<div class="zq-agenda-row' + (done ? ' is-done' : '') + '"><span class="zq-agenda-time zq-num">' + esc(hm5(x.preferredTime)) + '</span>'
      + '<div class="zq-rt-main"><div class="zq-rt-title" title="' + esc(x.title) + '">' + esc(x.title) + '</div><div class="zq-agenda-meta">' + esc(meta(x)) + '</div></div>'
      + '<button type="button" class="zq-btn-ghost zq-agenda-btn" data-check-routine="' + esc(x.routineId || x.id) + '" data-date="' + esc(String(x.date || day).slice(0, 10)) + '">' + (done ? '已完成' : '完成') + '</button></div>';
  }).join('');
}
/** 「全部例行计划」：一条一行，删除是悬停才出现的图标按钮（和任务页一样）；没开始的写哪天开始，已结束的变淡 */
function routineRowsHtml(list, day) {
  if (!list.length) return empty('还没有例行计划');
  return sortRoutines(list, day).map(function (r) {
    var phase = routinePhase(r, day);
    var when = phase === 'upcoming' ? ' · ' + String(r.startDate).slice(5, 10).replace('-', '/') + ' 开始'
      : phase === 'ended' ? ' · 已结束（' + String(r.endDate).slice(5, 10).replace('-', '/') + '）' : '';
    return '<div class="zq-rt-row' + (phase === 'ended' ? ' is-ended' : '') + '"><span class="zq-agenda-time zq-num">' + esc(hm5(r.preferredTime)) + '</span>'
      + '<div class="zq-rt-main"><div class="zq-rt-title" title="' + esc(r.title) + '">' + esc(r.title) + '</div><div class="zq-agenda-meta">' + esc(meta(r) + when) + '</div></div>'
      + '<span class="zq-rt-acts"><button type="button" class="zq-icon-btn is-danger" data-del-routine="' + esc(r.id) + '" aria-label="删除「' + esc(r.title) + '」" title="删除">' + icon('trash-2') + '</button></span></div>';
  }).join('');
}

async function loadRoutines() {
  var host = $('#zq-rt'), todayHost = $('#zq-rt-today'); if (!host) return;
  var day = today();
  var current = latestOnly('routines');
  var got = await Promise.all([api.get('/routine/list'), api.get('/routine/instances?from=' + day + '&to=' + day)]);
  if (!current()) return;
  var list = got[0] || [], items = got[1] || [];
  var countEl = $('#zq-rt-count');
  if (countEl) countEl.textContent = list.filter(function (r) { return routinePhase(r, day) === 'active'; }).length + ' 个进行中';
  var todayCount = $('#zq-rt-today-count');
  if (todayCount) todayCount.textContent = items.length ? items.filter(function (x) { return x.completed; }).length + ' / ' + items.length + ' 完成' : '';
  host.innerHTML = routineRowsHtml(list, day);
  if (todayHost) todayHost.innerHTML = todayRowsHtml(items, day);
  $all('[data-check-routine]', todayHost || host).forEach(function (b) {
    b.onclick = function () {
      if (b.disabled) return;
      b.disabled = true;
      // 记到这一行所在的那天（服务端给的日期），不是按下去这一刻的「今天」—— 和看板一样；失败走 safe（原来没接，靠壳的 unhandledrejection 兜底）
      safe('打卡', async function () {
        await api.post('/routine/' + b.dataset.checkRoutine + '/checkin', { checkDate: b.dataset.date || today(), status: 'DONE' });
        await loadRoutines();
      }).finally(function () { b.disabled = false; });
    };
  });
  $all('[data-del-routine]', host).forEach(function (b) {
    b.onclick = async function () {
      if (!await askConfirm({ title: '删除例行计划', message: '删除这个例行计划？相关的未来提醒会一并停止。', okText: '删除', danger: true })) return;
      await safe('删除例行计划', async function () { await api.del('/routine/' + b.dataset.delRoutine); await loadRoutines(); });
    };
  });
}

// ── 新建 / 从任务生成：同一套设置 ────────────────────────────────────────────

/** withText：新建（标题、说明、开始 / 结束日期）；从任务生成没有这几样（标题就是任务名，从今天开始） */
function settingsHtml(day, withText) {
  function field(id, label, control) { return '<div class="zq-field"><label class="zq-label" for="' + id + '">' + label + '</label>' + control + '</div>'; }
  var wd = isoWeekday(day);
  return (withText
    ? field('zq-rtf-title', '名字', '<input id="zq-rtf-title" class="zq-input" maxlength="200" placeholder="例如：写日报">')
      + field('zq-rtf-desc', '说明（可留空）', '<textarea id="zq-rtf-desc" class="zq-textarea zq-rt-desc" placeholder="可写资料、目标或注意事项"></textarea>')
    : '')
    + '<div class="zq-field"><span class="zq-label">多久一次</span><div class="zq-seg" role="group" aria-label="多久一次">'
    + '<button type="button" data-freq="DAILY" aria-pressed="true">每天</button><button type="button" data-freq="WEEKLY" aria-pressed="false">每周</button></div></div>'
    // 星期只在「每周」时出现；默认勾上今天是星期几 —— 服务端不填时也是这么定的，原来不说
    + '<div class="zq-field" data-rt-days hidden><span class="zq-label">每周哪几天</span><div class="zq-rt-days" role="group" aria-label="每周哪几天">'
    + WEEKDAYS.map(function (w, i) { return '<button type="button" class="zq-chip" data-day="' + (i + 1) + '" aria-pressed="' + (i + 1 === wd) + '">' + w + '</button>'; }).join('')
    + '</div></div>'
    + '<div class="zq-form-grid">'
    + field('zq-rtf-time', '几点做', '<input id="zq-rtf-time" type="time" class="zq-input" value="08:00">')
    + field('zq-rtf-dur', '每次多久（分钟）', '<input id="zq-rtf-dur" type="number" min="1" max="1440" step="1" class="zq-input" value="30">')
    + (withText
      ? field('zq-rtf-start', '从哪天开始', '<input id="zq-rtf-start" type="date" class="zq-input" value="' + esc(day) + '">')
        + field('zq-rtf-end', '到哪天（不填就是 30 天）', '<input id="zq-rtf-end" type="date" class="zq-input">')
      : '')
    + '</div>'
    + '<label class="zq-rt-remind"><input type="checkbox" id="zq-rtf-remind" checked><span>早上提醒我（发到「设置 → 提醒」里的推送渠道）</span></label>';
}
/**
 * 表单上读出来的值 → 发给 POST /routine 的内容，或者一句为什么不能交。
 * v：{ title, description, frequency, days: [1..7], time, duration, startDate, endDate, reminder, withText }
 */
function readRoutineForm(v, day) {
  var title = String(v.title || '').trim();
  if (v.withText && !title) return { error: '请写上名字' };
  var weekly = v.frequency === 'WEEKLY';
  var days = (v.days || []).map(Number).filter(function (d) { return d >= 1 && d <= 7; }).sort();
  if (weekly && !days.length) return { error: '每周的要选至少一天' };
  var duration = Number(v.duration);
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) return { error: '每次多久要填 1 到 1440 分钟' };
  var time = String(v.time || '');
  if (!/^\d{2}:\d{2}$/.test(time)) return { error: '几点做没填好' };
  var start = v.withText ? (v.startDate || day) : day;
  var end = v.withText ? (v.endDate || '') : '';
  if (end && end < start) return { error: '结束的日子在开始之前' };
  var body = { title: title, frequency: weekly ? 'WEEKLY' : 'DAILY', durationMinutes: duration, preferredTime: time, reminderEnabled: !!v.reminder, startDate: start };
  if (weekly) body.daysOfWeek = days;
  if (v.withText) { body.description = String(v.description || ''); body.endDate = end; }
  return { body: body };
}
/** 接上弹窗里的分段和星期按钮（按下的样子在样式表：.zq-seg / .zq-chip 的 aria-pressed） */
function wireSettings(b) {
  var daysField = $('[data-rt-days]', b);
  $all('[data-freq]', b).forEach(function (btn) {
    btn.onclick = function () {
      $all('[data-freq]', b).forEach(function (x) { x.setAttribute('aria-pressed', String(x === btn)); });
      daysField.hidden = btn.dataset.freq !== 'WEEKLY';
    };
  });
  $all('[data-day]', b).forEach(function (btn) {
    btn.onclick = function () { btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true')); };
  });
}
function valuesFrom(b, withText) {
  var pressed = $('[data-freq][aria-pressed="true"]', b);
  var v = {
    withText: withText,
    frequency: pressed ? pressed.dataset.freq : 'DAILY',
    days: $all('[data-day][aria-pressed="true"]', b).map(function (x) { return Number(x.dataset.day); }),
    time: $('#zq-rtf-time', b).value, duration: $('#zq-rtf-dur', b).value, reminder: $('#zq-rtf-remind', b).checked
  };
  if (withText) {
    v.title = $('#zq-rtf-title', b).value; v.description = $('#zq-rtf-desc', b).value;
    v.startDate = $('#zq-rtf-start', b).value; v.endDate = $('#zq-rtf-end', b).value;
  }
  return v;
}

function openNewRoutine() {
  var day = today();
  openModal({
    title: '新建例行计划',
    width: '520px',
    bodyHtml: settingsHtml(day, true)
      + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-rtf-cancel">取消</button><button type="button" class="zq-btn" id="zq-rtf-ok">创建</button></div>',
    onMount: function (b, h) {
      wireSettings(b);
      // 打了一半关掉、刷新也还在（第十五轮）；建好了才删
      var keep = [keepDraft($('#zq-rtf-title', b), 'routine.new.title'), keepDraft($('#zq-rtf-desc', b), 'routine.new.desc')];
      $('#zq-rtf-cancel', b).onclick = h.close;
      var ok = $('#zq-rtf-ok', b);
      ok.onclick = function () {
        if (ok.disabled) return;
        var plan = readRoutineForm(valuesFrom(b, true), day);
        if (plan.error) return toast(plan.error, 'error');
        // 连点：提交着就不让再点；建好就关弹窗 —— 原来表单常驻在页面上，回来之后多点的那一下会拿同一个名字再建一个（第十四轮）
        ok.disabled = true;
        safe('创建例行计划', async function () {
          await api.post('/routine', plan.body);
          keep.forEach(function (k) { k.clear(); });
          h.close();
          toast('例行计划已创建');
          await loadRoutines();
        }).finally(function () { ok.disabled = false; });
      };
    }
  });
}

/** 从任务生成：选的那几条（名字和 id）；名字放在 data-title 里，不从显示的字里抠 */
function sourceRowsHtml(tasks) {
  return tasks.slice(0, 20).map(function (t) {
    return '<label class="zq-rt-src-row"><input type="checkbox" value="' + esc(t.id) + '" data-title="' + esc(t.title) + '">'
      + '<span class="zq-rt-main"><span class="zq-rt-title">' + esc(t.title) + '</span><span class="zq-agenda-meta">' + esc(qLabel(t.quadrant) + ' · ' + sLabel(t.status)) + '</span></span></label>';
  }).join('') || empty('没有可选的任务');
}
function openFromTasks() {
  var day = today();
  openModal({
    title: '从任务生成例行计划',
    width: '560px',
    bodyHtml: '<div class="zq-field"><span class="zq-label">选哪些任务</span><div class="zq-seg" role="group" aria-label="任务状态" data-src-filter>'
      + '<button type="button" data-status="" aria-pressed="true">全部</button><button type="button" data-status="0" aria-pressed="false">待办</button><button type="button" data-status="1" aria-pressed="false">进行中</button></div>'
      + '<div class="zq-rt-src" id="zq-rt-src"></div></div>'
      + settingsHtml(day, false)
      + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-rtf-cancel">取消</button><button type="button" class="zq-btn" id="zq-rtf-ok">生成</button></div>',
    onMount: function (b, h) {
      wireSettings(b);
      var src = $('#zq-rt-src', b), ok = $('#zq-rtf-ok', b);
      function countChecked() {
        var n = $all('input[type="checkbox"]:checked', src).length;
        ok.textContent = n ? '生成 ' + n + ' 个' : '生成';
      }
      // 连着点「全部 / 待办 / 进行中」：先发的后回来不许盖掉后点的（LatestResponseTest）
      async function loadSources(status) {
        var current = latestOnly('routine-sources');
        var page = await api.get('/task/page?limit=20' + (status === '' ? '' : '&status=' + status));
        if (!current()) return;
        var tasks = ((page && page.items) || []).map(normalizeTask);
        src.innerHTML = sourceRowsHtml(tasks);
        $all('input[type="checkbox"]', src).forEach(function (c) { c.onchange = countChecked; });
        countChecked();
      }
      $all('[data-src-filter] button', b).forEach(function (btn) {
        btn.onclick = function () {
          $all('[data-src-filter] button', b).forEach(function (x) { x.setAttribute('aria-pressed', String(x === btn)); });
          safe('取任务', function () { return loadSources(btn.dataset.status); });
        };
      });
      $('#zq-rtf-cancel', b).onclick = h.close;
      ok.onclick = function () {
        if (ok.disabled) return;
        var checked = $all('input[type="checkbox"]:checked', src);
        if (!checked.length) return toast('先勾上要生成的任务', 'error');
        var plan = readRoutineForm(valuesFrom(b, false), day);
        if (plan.error) return toast(plan.error, 'error');
        ok.disabled = true;
        ok.textContent = '生成中…';
        var made = 0;
        safe('生成例行计划', async function () {
          try {
            for (var i = 0; i < checked.length; i++) {
              await api.post('/routine', Object.assign({}, plan.body, { title: checked[i].dataset.title || '例行计划' }));
              // 生成一个就去掉一个勾：中途失败了再点「生成」，不会把已经生成的那几个再来一遍
              checked[i].checked = false;
              made++;
            }
          } catch (e) {
            if (made) { countChecked(); await loadRoutines(); throw new Error('生成了 ' + made + ' 个，后面的没成：' + (e.message || e)); }
            throw e;
          }
          h.close();
          toast('已生成 ' + made + ' 个例行计划');
          await loadRoutines();
        }).finally(function () { ok.disabled = false; countChecked(); });
      };
      safe('取任务', function () { return loadSources(''); });
    }
  });
}
