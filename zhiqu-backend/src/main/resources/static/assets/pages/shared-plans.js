// 参考计划页 —— 第三十三轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// 分类表（planCategory / planCategoryOptions）后台也用，留在壳里经 zqShared 给 —— 三处一致由 PlanCategoryListTest 核对。
//
// 第五十七轮（界面打磨第 8 步）：工具条一行（分类、排序两个下拉，没有「方向」「刷新」）；卡片是类、点赞是图标、键盘能打开；
// 详情换成 openModal（原来 HTML 里另写了一套弹窗），分类写名字、点赞后照现在的筛选重新取、套用在弹窗里选日期。
// 画法的几个函数另外导出给 shared-plans-check.js。

let api, esc, $, $all, empty, fmtDate, safe, toast, openModal, today, latestOnly, normalizeTask, writeKey,
  planCategory, planCategoryOptions, icon;
export function bind(sh) {
  ({ api, esc, $, $all, empty, fmtDate, safe, toast, openModal, today, latestOnly, normalizeTask, writeKey,
    planCategory, planCategoryOptions, icon } = sh);
}

export const boots = { 'shared-plans.html': (sh) => { bind(sh); return bootSharedPlans(); } };
export { planCardsHtml, planDetailHtml, submissionsHtml, sortParams, openPlan };

async function bootSharedPlans() {
  var cat = $('#zq-plan-cat'), sort = $('#zq-plan-sort');
  // 没有小标题的下拉：第一项就说清是什么（「全部分类」，不是「全部」）
  if (cat) { cat.innerHTML = '<option value="">全部分类</option>' + planCategoryOptions(''); cat.onchange = reloadPlans; }
  if (sort) sort.onchange = reloadPlans;
  var submitBtn = $('#zq-plan-submit');
  if (submitBtn) submitBtn.onclick = submitPlanTemplate;
  await reloadPlans();
  await loadMySubmissions();
}
/** 排序下拉的值「time:desc」→ 接口的 sort / order（原来「排序」「方向」两个下拉才说清一件事） */
function sortParams(v) {
  var p = String(v || 'time:desc').split(':');
  return { sort: p[0] === 'likeCount' ? 'likeCount' : 'time', order: p[1] === 'asc' ? 'asc' : 'desc' };
}
/** 照着现在选的分类和排序取 —— 点赞之后也走这里（原来整页重跑启动，列表回到默认、下拉框里还显示着刚才选的） */
function reloadPlans() {
  var cat = $('#zq-plan-cat'), s = sortParams(($('#zq-plan-sort') || {}).value);
  return loadPlans(cat ? cat.value : '', s.sort, s.order);
}

var SUBMISSION_STATUS = { PENDING: '待审核', APPROVED: '已发布', REJECTED: '已驳回', OFFLINE: '已下架' };
/**
 * 我的投稿，含驳回理由。
 *
 * 后台驳回弹窗的文案是「驳回原因（可选，将展示给提交者）」，而在此之前系统里
 * 没有任何地方展示它：公开列表只返回 APPROVED，带审核意见的 reviews 只在
 * adminDetail 里。管理员以为自己写的解释会送达，实际写完就再无出口。
 * 这一块是那句承诺的落地处。
 */
function submissionsHtml(mine) {
  return mine.map(function (p) {
    var st = String(p.status || '').toUpperCase();
    var reason = p.rejectionReason
      ? '<p class="zq-plan-reject"><b>驳回原因：</b>' + esc(p.rejectionReason) + '</p>'
      : (st === 'REJECTED' ? '<p class="zq-plan-reject is-empty">管理员未填写驳回原因。</p>' : '');
    return '<article class="zq-plan-sub"><div class="zq-plan-sub-top"><span class="zq-plan-sub-title">' + esc(p.title || '未命名计划') + '</span>'
      + '<span class="zq-plan-status" data-status="' + esc(st) + '">' + esc(SUBMISSION_STATUS[st] || p.status || '未知') + '</span></div>'
      + '<div class="zq-plan-sub-when">' + esc(fmtDate(p.createdAt) || '') + (p.reviewedAt ? ' · 审核于 ' + esc(fmtDate(p.reviewedAt)) : '') + '</div>'
      + reason + '</article>';
  }).join('');
}
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
  host.innerHTML = submissionsHtml(mine);
}

/** 分类：一个小圆点 + 名字（和看板「今天」的标签一样）；点的颜色按分类表第三栏（q1–q4），样式表按 data-q 画 */
function catTag(p) {
  var known = planCategory(p.category || 'GENERAL') || planCategory('GENERAL');
  return '<span class="zq-plan-cat" data-q="' + known[2] + '"><i></i>' + esc(p.categoryName || known[1]) + '</span>';
}
function likesLabel(n) { return (n || 0) + ' 个赞'; }
function planCardsHtml(plans) {
  return plans.map(function (p) {
    var name = p.title || p.name || '未命名计划';
    return '<article class="zq-plan-card" data-plan="' + esc(p.id) + '" role="button" tabindex="0" aria-label="打开「' + esc(name) + '」">'
      + '<div class="zq-plan-top">' + catTag(p) + '<span class="zq-plan-likes zq-num" title="' + likesLabel(p.likeCount) + '">' + icon('heart') + (p.likeCount || 0) + '</span></div>'
      + '<h3 class="zq-plan-title">' + esc(name) + '</h3>'
      + (p.description ? '<p class="zq-plan-desc">' + esc(p.description) + '</p>' : '')
      + (p.targetAudience || p.applyCount
        ? '<div class="zq-plan-foot"><span>' + esc(p.targetAudience ? '适用：' + p.targetAudience : '') + '</span>'
          + (p.applyCount ? '<span class="zq-num">套用过 ' + p.applyCount + ' 次</span>' : '') + '</div>'
        : '')
      + '</article>';
  }).join('') || empty('还没有参考计划');
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
  host.innerHTML = planCardsHtml(plans);
  $all('[data-plan]', host).forEach(function (b) {
    var open = function () { openPlan(Number(b.dataset.plan)); };
    b.onclick = open;
    b.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
}

function submitPlanTemplate() {
  safe('加载我的任务', async function () {
    var tasks = (((await api.get('/task/page?limit=30')) || {}).items || []).map(normalizeTask);
    var routines = ((await api.get('/routine/list')) || []).slice(0, 30);
    if (!tasks.length && !routines.length) { toast('你还没有任务或例行计划，无法生成模板', 'error'); return; }
    function checkRow(kind, x) {
      return '<label class="zq-pick-row"><input type="checkbox" data-pick="' + kind + '" value="' + esc(x.id) + '" checked><span>' + esc(x.title) + '</span></label>';
    }
    var taskList = tasks.map(function (t) { return checkRow('task', t); }).join('');
    var routineList = routines.map(function (r) { return checkRow('routine', r); }).join('');
    openModal({
      title: '分享我的计划',
      width: '520px',
      bodyHtml:
        '<div class="zq-field"><label class="zq-label" for="zq-spt-title">模板标题</label><input id="zq-spt-title" class="zq-input" placeholder="例如：新项目启动前两周"></div>'
        + '<div class="zq-field"><label class="zq-label" for="zq-spt-cat">分类</label><select id="zq-spt-cat" class="zq-select">' + planCategoryOptions('GENERAL') + '</select></div>'
        + '<div class="zq-field"><label class="zq-label" for="zq-spt-desc">简介（可留空）</label><textarea id="zq-spt-desc" class="zq-textarea zq-textarea-sm" placeholder="一句话说明这套计划适合谁、怎么用"></textarea></div>'
        + '<div class="zq-pick-head"><span class="zq-label">勾选要分享的内容</span><span class="zq-pick-tools"><button type="button" class="zq-btn-ghost zq-btn-xs" id="zq-spt-all">全选</button><button type="button" class="zq-btn-ghost zq-btn-xs" id="zq-spt-none">清空</button></span></div>'
        + '<div class="zq-pick-list zq-pick-tall">'
        + (taskList ? '<div class="zq-pick-group">一次性任务 · ' + tasks.length + '</div>' + taskList : '')
        + (routineList ? '<div class="zq-pick-group">例行计划 · ' + routines.length + '</div>' + routineList : '')
        + '</div>'
        + '<label class="zq-check-line"><input id="zq-spt-consent" type="checkbox"><span>我确认勾选的内容不含个人隐私信息，同意提交给管理员审核，通过后对所有用户可见。</span></label>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-spt-cancel">取消</button><button type="button" class="zq-btn" id="zq-spt-ok">提交审核</button></div>',
      onMount: function (b, h) {
        $('#zq-spt-cancel', b).onclick = h.close;
        $('#zq-spt-all', b).onclick = function () { $all('[data-pick]', b).forEach(function (c) { c.checked = true; }); };
        $('#zq-spt-none', b).onclick = function () { $all('[data-pick]', b).forEach(function (c) { c.checked = false; }); };
        var ok = $('#zq-spt-ok', b);
        ok.onclick = function () {
          if (ok.disabled) return;
          var title = $('#zq-spt-title', b).value.trim(); if (!title) return toast('请填写模板标题', 'error');
          var taskIds = $all('[data-pick="task"]:checked', b).map(function (c) { return Number(c.value); });
          var routineIds = $all('[data-pick="routine"]:checked', b).map(function (c) { return Number(c.value); });
          if (!taskIds.length && !routineIds.length) return toast('至少勾选一个任务或例行计划', 'error');
          // 隐私确认必须由用户显式勾选，不代签
          if (!$('#zq-spt-consent', b).checked) return toast('请先勾选隐私确认', 'error');
          var category = $('#zq-spt-cat', b).value, desc = $('#zq-spt-desc', b).value.trim();
          ok.disabled = true;
          safe('提交计划模板', async function () {
            await api.post('/shared-plans/from-existing', { title: title, description: desc, category: category, taskIds: taskIds, routineIds: routineIds, shareConsent: true });
            h.close(); toast('已提交，等待管理员审核');
            await loadMySubmissions();
          }).finally(function () { ok.disabled = false; });
        };
      }
    });
  });
}

/** 详情：分类写名字（原来写代码「GENERAL」）、点赞是图标按钮、套用在弹窗里选日期（原来弹一个文字框让人手打 YYYY-MM-DD） */
function planDetailHtml(p, day) {
  var tasks = p.tasks || p.taskTemplates || [];
  var routines = p.routines || p.routineTemplates || [];
  var who = p.creator && (p.creator.nickname || p.creator.username);
  function items(list) {
    return list.length ? '<ul class="zq-plan-items">' + list.map(function (x) { return '<li>' + esc(x.title || x.name || '') + '</li>'; }).join('') + '</ul>'
      : '<p class="zq-plan-none">没有</p>';
  }
  return '<div class="zq-plan-meta">' + catTag(p) + (who ? '<span>来自 ' + esc(who) + '</span>' : '')
    + '<button type="button" class="zq-plan-like" id="zq-plan-like" aria-pressed="' + !!p.liked + '" title="点赞" aria-label="点赞，现在 ' + likesLabel(p.likeCount) + '">'
    + icon('heart') + '<span class="zq-num">' + (p.likeCount || 0) + '</span></button></div>'
    + (p.description ? '<p class="zq-plan-detail-desc">' + esc(p.description) + '</p>' : '')
    + '<p class="zq-plan-aud">适用：' + esc(p.targetAudience || p.audience || '未注明') + '</p>'
    + '<h4 class="zq-plan-sec">一次性任务 · ' + tasks.length + '</h4>' + items(tasks)
    + '<h4 class="zq-plan-sec">例行计划 · ' + routines.length + '</h4>' + items(routines)
    + '<div class="zq-plan-apply"><div class="zq-field"><label class="zq-label" for="zq-plan-start">从哪天开始</label>'
    + '<input id="zq-plan-start" type="date" class="zq-input" value="' + esc(day) + '" autofocus></div>'
    + '<button type="button" class="zq-btn" id="zq-plan-apply">套用到我的日历</button></div>';
}
async function openPlan(id) {
  await safe('计划详情', async function () {
    var p = await api.get('/shared-plans/' + id);
    openModal({
      title: p.title || '参考计划',
      width: '560px',
      bodyHtml: planDetailHtml(p, today()),
      onMount: function (b, h) {
        var likeBtn = $('#zq-plan-like', b);
        likeBtn.onclick = function () {
          if (likeBtn.disabled) return;
          likeBtn.disabled = true;
          safe('点赞', async function () {
            var res = await api.post('/shared-plans/' + id + '/like', {});
            likeBtn.setAttribute('aria-pressed', String(!!res.liked));
            likeBtn.setAttribute('aria-label', '点赞，现在 ' + likesLabel(res.likeCount));
            $('.zq-num', likeBtn).textContent = res.likeCount || 0;
            await reloadPlans();
          }).finally(function () { likeBtn.disabled = false; });
        };
        // 这一次打开这个计划就是「一次套用」：键在这里生成，连点、等得不耐烦又点一次，带的都是同一个键 ——
        // 服务器只执行一次（原来连点两下就建两整份任务）。换个开始日期是另一次，所以键里带上日期。
        var applyKey = writeKey();
        var applyBtn = $('#zq-plan-apply', b);
        applyBtn.onclick = async function () {
          if (applyBtn.disabled) return;
          var startDate = $('#zq-plan-start', b).value;
          if (!startDate) return toast('先选从哪天开始', 'error');
          applyBtn.disabled = true;
          try {
            await safe('套用参考计划', async function () {
              await api.post('/shared-plans/' + id + '/apply', { startDate: startDate.trim() }, { 'Idempotency-Key': applyKey + ':' + startDate.trim() });
              toast('已套用到你的日历');
              h.close();
            });
          } finally {
            applyBtn.disabled = false;
          }
        };
      }
    });
  });
}
