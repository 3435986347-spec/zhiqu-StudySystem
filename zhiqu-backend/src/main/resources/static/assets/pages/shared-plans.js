// 参考计划页 —— 第三十三轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// 分类表（planCategory / planCategoryOptions）后台也用，留在壳里经 zqShared 给 —— 三处一致由 PlanCategoryListTest 核对。

let api, esc, $, $all, empty, fmtDate, safe, toast, openModal, showInfo, askText, today, latestOnly, normalizeTask, writeKey,
  planCategory, planCategoryOptions;
export function bind(sh) {
  ({ api, esc, $, $all, empty, fmtDate, safe, toast, openModal, showInfo, askText, today, latestOnly, normalizeTask, writeKey,
    planCategory, planCategoryOptions } = sh);
}

export const boots = { 'shared-plans.html': (sh) => { bind(sh); return bootSharedPlans(); } };

async function bootSharedPlans() {
  // 详情弹窗的遮罩、×、取消（第二十四轮：原来调示例脚本里的全局 closeModal）
  $all('#zq-modal [data-close-modal]').forEach(function (b) { b.onclick = function () { $('#zq-modal').style.display = 'none'; }; });
  var filterCard = $('.zq-card');
  var selects = filterCard ? $all('select', filterCard) : [];
  if (selects[0]) selects[0].innerHTML = planCategoryOptions('', true);
  var submitBtn = $('header .zq-btn');
  if (submitBtn) submitBtn.onclick = submitPlanTemplate;
  var refreshBtn = filterCard && $all('button', filterCard).find(function (b) { return /刷新/.test(b.textContent); });
  var doLoad = function () {
    var category = selects[0] ? selects[0].value : '';
    var sort = selects[1] && selects[1].selectedIndex === 1 ? 'likeCount' : 'time';
    var order = selects[2] && selects[2].selectedIndex === 1 ? 'asc' : 'desc';
    loadPlans(category, sort, order);
  };
  if (refreshBtn) refreshBtn.onclick = function () { doLoad(); loadMySubmissions(); };
  selects.forEach(function (s) { s.onchange = doLoad; });
  await loadPlans('', 'time', 'desc');
  await loadMySubmissions();
}

var SUBMISSION_STATUS = {
  PENDING:  { label: '待审核', tone: 'var(--zq-text2)' },
  APPROVED: { label: '已发布', tone: 'var(--zq-q2)' },
  REJECTED: { label: '已驳回', tone: 'var(--zq-q1)' },
  OFFLINE:  { label: '已下架', tone: 'var(--zq-text3)' }
};
/**
 * 我的投稿，含驳回理由。
 *
 * 后台驳回弹窗的文案是「驳回原因（可选，将展示给提交者）」，而在此之前系统里
 * 没有任何地方展示它：公开列表只返回 APPROVED，带审核意见的 reviews 只在
 * adminDetail 里。管理员以为自己写的解释会送达，实际写完就再无出口。
 * 这一块是那句承诺的落地处。
 */
async function loadMySubmissions() {
  var section = $('#zq-my-submissions'), host = $('#zq-my-sub-list');
  if (!section || !host) return;
  var mine;
  try {
    mine = await api.get('/shared-plans/mine');
  } catch (e) {
    section.hidden = true;   // 拉不到就整块不显示，不在公开列表下面留一条错误
    return;
  }
  mine = mine || [];
  if (!mine.length) { section.hidden = true; return; }
  section.hidden = false;
  host.innerHTML = mine.map(function (p) {
    var st = SUBMISSION_STATUS[String(p.status || '').toUpperCase()]
      || { label: p.status || '未知', tone: 'var(--zq-text3)' };
    var reason = p.rejectionReason
      ? '<div style="margin-top:8px;padding:9px 11px;border-radius:var(--zq-rs);background:var(--zq-q1-bg);'
        + 'color:var(--zq-q1);font-size:12.5px;line-height:1.55;"><b>驳回原因：</b>' + esc(p.rejectionReason) + '</div>'
      : (String(p.status || '').toUpperCase() === 'REJECTED'
          ? '<div style="margin-top:8px;font-size:12px;color:var(--zq-text3);">管理员未填写驳回原因。</div>'
          : '');
    return '<article style="padding:13px 15px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rm);'
      + 'background:var(--zq-card);"><div style="display:flex;align-items:center;gap:10px;">'
      + '<span style="font-size:14px;font-weight:var(--zq-fw-medium);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;'
      + 'white-space:nowrap;">' + esc(p.title || '未命名计划') + '</span>'
      + '<span class="zq-badge" style="color:' + st.tone + ';">' + esc(st.label) + '</span></div>'
      + '<div style="margin-top:4px;font-size:11.5px;color:var(--zq-text3);">'
      + esc(fmtDate(p.createdAt) || '') + (p.reviewedAt ? ' · 审核于 ' + esc(fmtDate(p.reviewedAt)) : '')
      + '</div>' + reason + '</article>';
  }).join('');
}
async function loadPlans(category, sort, order) {
  var host = $('#zq-plans'); if (!host) return;
  var qs = [];
  if (category) qs.push('category=' + category);
  if (sort) qs.push('sort=' + sort);
  if (order) qs.push('order=' + order);
  var current = latestOnly('shared-plans');
  var plans = await api.get('/shared-plans' + (qs.length ? '?' + qs.join('&') : '')) || [];
  if (!current()) return;
  // 原来这里是设计稿写死的「已审核模板 · 4 个」，从来不变（2026-10-01 用户报）。接口不分页，列表有几个就是几个
  var count = $('#zq-plan-count');
  if (count) count.textContent = ((planCategory(category) || [])[1] || '已审核模板') + ' · ' + plans.length + ' 个';
  host.innerHTML = plans.map(function (p) {
    var known = planCategory(p.category || 'GENERAL');
    var k = known ? known[2] : 'q4';
    return '<article data-plan="' + p.id + '" style="padding:16px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rm);background:var(--zq-card);box-shadow:var(--zq-sh1);cursor:pointer;"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;"><span class="zq-badge" style="background:var(--zq-' + k + '-bg);color:var(--zq-' + k + ');font-weight:var(--zq-fw-medium);">' + esc(p.categoryName || (known || planCategory('GENERAL'))[1]) + '</span><span class="zq-num" style="font-size:12px;color:var(--zq-text3);">♡ ' + esc(p.likeCount || 0) + '</span></div><h3 style="margin:0 0 6px;font-size:15.5px;font-weight:var(--zq-fw-medium);">' + esc(p.title || p.name) + '</h3><p style="margin:0 0 10px;font-size:12.5px;color:var(--zq-text2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(p.description || '') + '</p><div style="display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--zq-text3);border-top:1px solid var(--zq-border-soft);padding-top:9px;"><span>' + esc(p.targetAudience || p.audience || '通用') + '</span><span>' + esc(p.creatorNickname || (p.creator && (p.creator.nickname || p.creator.username)) || '') + '</span></div></article>';
  }).join('') || empty('暂无参考计划');
  $all('[data-plan]', host).forEach(function (b) { b.onclick = function () { openPlan(Number(b.dataset.plan)); }; });
}
function submitPlanTemplate() {
  safe('加载我的任务', async function () {
    var tasks = (((await api.get('/task/page?limit=30')) || {}).items || []).map(normalizeTask);
    var routines = ((await api.get('/routine/list')) || []).slice(0, 30);
    if (!tasks.length && !routines.length) { toast('你还没有任务或例行计划，无法生成模板', 'error'); return; }
    function checkRow(kind, x) {
      return '<label style="display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);cursor:pointer;font-size:12.5px;"><input type="checkbox" data-pick="' + kind + '" value="' + x.id + '" checked style="accent-color:var(--zq-primary);flex:none;"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(x.title || x.name || '') + '</span></label>';
    }
    var taskList = tasks.map(function (t) { return checkRow('task', t); }).join('');
    var routineList = routines.map(function (r) { return checkRow('routine', r); }).join('');
    openModal({
      title: '分享我的计划',
      width: '520px',
      bodyHtml:
        '<div class="zq-field"><label class="zq-label">模板标题</label><input id="zq-spt-title" class="zq-input" placeholder="例如：新项目启动前两周"></div>'
        + '<div class="zq-field"><label class="zq-label">分类</label><select id="zq-spt-cat" class="zq-select">' + planCategoryOptions('GENERAL') + '</select></div>'
        + '<div class="zq-field"><label class="zq-label">简介（可留空）</label><textarea id="zq-spt-desc" class="zq-textarea" style="min-height:70px;" placeholder="一句话说明这套计划适合谁、怎么用"></textarea></div>'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin:2px 0 7px;"><span class="zq-label">勾选要分享的内容</span><span style="display:flex;gap:8px;"><button type="button" class="zq-btn-ghost" id="zq-spt-all" style="height:24px;padding:0 9px;font-size:11.5px;">全选</button><button type="button" class="zq-btn-ghost" id="zq-spt-none" style="height:24px;padding:0 9px;font-size:11.5px;">清空</button></span></div>'
        + '<div style="max-height:250px;overflow-y:auto;display:flex;flex-direction:column;gap:5px;margin-bottom:10px;">'
        + (taskList ? '<div style="font-size:11.5px;font-weight:var(--zq-fw-medium);color:var(--zq-text2);margin:3px 0 1px;">一次性任务 · ' + tasks.length + '</div>' + taskList : '')
        + (routineList ? '<div style="font-size:11.5px;font-weight:var(--zq-fw-medium);color:var(--zq-text2);margin:6px 0 1px;">例行计划 · ' + routines.length + '</div>' + routineList : '')
        + '</div>'
        + '<label style="display:flex;align-items:flex-start;gap:8px;margin:0 0 12px;font-size:12px;color:var(--zq-text2);line-height:1.6;cursor:pointer;"><input id="zq-spt-consent" type="checkbox" style="accent-color:var(--zq-primary);margin-top:2px;flex:none;"><span>我确认勾选的内容不含个人隐私信息，同意提交给管理员审核，通过后对所有用户可见。</span></label>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-spt-cancel">取消</button><button type="button" class="zq-btn" id="zq-spt-ok">提交审核</button></div>',
      onMount: function (b, h) {
        $('#zq-spt-cancel', b).onclick = h.close;
        $('#zq-spt-all', b).onclick = function () { $all('[data-pick]', b).forEach(function (c) { c.checked = true; }); };
        $('#zq-spt-none', b).onclick = function () { $all('[data-pick]', b).forEach(function (c) { c.checked = false; }); };
        $('#zq-spt-ok', b).onclick = function () {
          var title = $('#zq-spt-title', b).value.trim(); if (!title) return toast('请填写模板标题', 'error');
          var taskIds = $all('[data-pick="task"]:checked', b).map(function (c) { return Number(c.value); });
          var routineIds = $all('[data-pick="routine"]:checked', b).map(function (c) { return Number(c.value); });
          if (!taskIds.length && !routineIds.length) return toast('至少勾选一个任务或例行计划', 'error');
          // 隐私确认必须由用户显式勾选，不代签
          if (!$('#zq-spt-consent', b).checked) return toast('请先勾选隐私确认', 'error');
          var category = $('#zq-spt-cat', b).value, desc = $('#zq-spt-desc', b).value.trim();
          safe('提交计划模板', async function () {
            await api.post('/shared-plans/from-existing', { title: title, description: desc, category: category, taskIds: taskIds, routineIds: routineIds, shareConsent: true });
            h.close(); toast('已提交，等待管理员审核');
          });
        };
      }
    });
  });
}
async function openPlan(id) {
  await safe('计划详情', async function () {
    var p = await api.get('/shared-plans/' + id);
    var tasks = p.tasks || p.taskTemplates || [];
    var routines = p.routines || p.routineTemplates || [];
    var modal = $('#zq-modal');
    if (!modal) {
      await showInfo({ title: p.title || '参考计划', message: (p.description || '') + '\n\n任务：' + tasks.length + ' 个\n例行计划：' + routines.length + ' 个' });
      return;
    }
    $('#zm-title').textContent = p.title || '参考计划';
    $('#zm-meta').textContent = (p.creator && (p.creator.nickname || p.creator.username) ? '来自 ' + (p.creator.nickname || p.creator.username) + ' · ' : '') + (p.category || '未分类') + ' · 已审核';
    $('#zm-likes').textContent = (p.liked ? '♥ ' : '♡ ') + (p.likeCount || 0);
    $('#zm-desc').textContent = p.description || '';
    $('#zm-aud').textContent = '适用：' + (p.targetAudience || p.audience || '未注明');
    $('#zm-items').innerHTML = [
      '<strong style="font-size:12px;">一次性任务 ' + tasks.length + ' 个</strong>',
      tasks.map(function (x) { return '<div style="padding:8px 10px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);font-size:12.5px;">' + esc(x.title || x.name || '') + '</div>'; }).join(''),
      '<strong style="font-size:12px;margin-top:8px;">例行计划 ' + routines.length + ' 个</strong>',
      routines.map(function (x) { return '<div style="padding:8px 10px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);font-size:12.5px;">' + esc(x.title || x.name || '') + '</div>'; }).join('')
    ].join('');
    var buttons = $all('#zq-modal .zq-btn, #zq-modal .zq-btn-ghost');
    var applyBtn = buttons.find(function (b) { return /套用/.test(b.textContent); });
    // 这一次打开这个计划就是「一次套用」：键在这里生成，连点、等得不耐烦又点一次，带的都是同一个键 ——
    // 服务器只执行一次（原来连点两下就建两整份任务）。换个开始日期是另一次，所以键里带上日期。
    var applyKey = writeKey();
    if (applyBtn) applyBtn.onclick = async function () {
      if (applyBtn.disabled) return;
      var startDate = await askText({ title: '套用参考计划', label: '开始日期', value: today(), hint: '格式 YYYY-MM-DD，计划内任务将从该日期起排入你的日历。', okText: '套用' });
      if (!startDate || !startDate.trim()) return;
      applyBtn.disabled = true;
      try {
        await api.post('/shared-plans/' + id + '/apply', { startDate: startDate.trim() }, { 'Idempotency-Key': applyKey + ':' + startDate.trim() });
        toast('已套用到你的日历');
        modal.style.display = 'none';
      } finally {
        applyBtn.disabled = false;
      }
    };
    $('#zm-likes').onclick = async function () {
      var res = await api.post('/shared-plans/' + id + '/like', {});
      $('#zm-likes').textContent = (res.liked ? '♥ ' : '♡ ') + (res.likeCount || 0);
      await bootSharedPlans();
    };
    $('#zm-likes').style.cursor = 'pointer';
    modal.style.display = 'flex';
  });
}
