// 后台四页（监管后台、账号管理、反馈管理、共享计划审核）—— 第三十一轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步的第二块）。
//
// 页面模块的形状：导出 boots（页面文件名 → 启动函数），壳的 route() 在过了后台页的门（ZQUI.isAdminPage + 服务端角色）之后才 import 它，
// 所以普通用户直达后台页时连这个文件都不下载。用到的壳里的东西都从 zqShared 来：bind() 把它们解构成同名的局部变量 ——
// 这样挪过来的代码一个字不用改（api.get、esc(...)、$('#…') 照旧），而「用了壳没给的东西」由 SettingsDialogTest 的模块判据扫出来。
// 这几页本来就画在页面上（不是弹窗里），所以用壳的 $ / $all 在整页上找元素。

let api, esc, $, $all, empty, fmtDate, safe, toast, askConfirm, askText, showInfo, openModal, planCategory, planCategoryOptions, freqLabel;
function bind(sh) {
  ({ api, esc, $, $all, empty, fmtDate, safe, toast, askConfirm, askText, showInfo, openModal, planCategory, planCategoryOptions, freqLabel } = sh);
}
let feedbackList = [];   // 原来是壳的 state.feedback —— 只有反馈管理这两个函数用

export const boots = {
  'admin.html': (sh) => { bind(sh); return bootAdmin(); },
  'account-admin.html': (sh) => { bind(sh); return bootAccountAdmin(); },
  'feedback-admin.html': (sh) => { bind(sh); return bootFeedbackAdmin(); },
  'shared-plan-admin.html': (sh) => { bind(sh); return bootSharedPlanAdmin(); }
};

async function bootAdmin() {
  var overview = await api.get('/admin/overview');
  var traffic = overview.traffic || {};
  var metrics = [
    ['注册用户', overview.userCount || 0, '总量', 'var(--zq-text)'],
    ['开放反馈', overview.feedbackOpenCount || 0, '待处理', 'var(--zq-primary)'],
    ['运行异常', overview.runtimeIssueOpenCount || 0, '待处理', 'var(--zq-bad)'],
    ['今日请求', traffic.todayRequests || traffic.requestCount || 0, '实时', 'var(--zq-text)'],
    ['AI 调用', traffic.aiRequests || 0, '今日', 'var(--zq-text)'],
    ['限流拦截', traffic.rateLimited || 0, '今日', 'var(--zq-text)']
  ];
  var host = $('#zq-metrics');
  if (host) host.innerHTML = metrics.map(function (m) { return '<article class="zq-stat" style="padding:14px 16px;"><span class="zq-stat-label" style="font-size:11.5px;">' + esc(m[0]) + '</span><strong class="zq-mono" style="display:block;margin-top:7px;font-size:23px;line-height:1;color:' + m[3] + ';">' + esc(m[1]) + '</strong><span style="display:block;margin-top:5px;font-size:11px;color:var(--zq-text3);">' + esc(m[2]) + '</span></article>'; }).join('');
  renderTrafficChart(traffic.minuteBuckets || {});
  await bootAdminIssues();
  await bootAdminRag();
  var refresh = $('header button'); if (refresh) refresh.onclick = function () { safe('刷新后台', bootAdmin); };
}
function renderTrafficChart(buckets) {
  var host = $('#zq-traffic'); if (!host) return;
  var keys = Object.keys(buckets || {});
  if (!keys.length) { host.innerHTML = empty('近 15 分钟暂无请求'); return; }
  var vals = keys.map(function (k) { return Number(buckets[k]) || 0; });
  var max = Math.max.apply(null, vals.concat([1]));
  host.innerHTML = keys.map(function (k, i) {
    var h = Math.max(4, Math.round(vals[i] / max * 128));
    var last = i === keys.length - 1;
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;height:100%;justify-content:flex-end;min-width:0;"><span class="zq-mono" style="font-size:9.5px;color:var(--zq-text3);">' + vals[i] + '</span><div title="' + esc(k) + ' · ' + vals[i] + ' 次" style="width:100%;max-width:30px;height:' + h + 'px;border-radius:3px 3px 2px 2px;background:' + (last ? 'var(--zq-primary)' : 'var(--zq-tint-strong)') + ';"></div><span style="font-size:10px;color:var(--zq-text3);white-space:nowrap;">' + esc(k) + '</span></div>';
  }).join('');
}
async function bootAdminIssues() {
  var host = $('#zq-health');
  if (!host) return;
  var list = await api.get('/admin/runtime-issues?status=OPEN');
  host.innerHTML = list.slice(0, 8).map(function (i) {
    return '<div style="padding:9px 0;border-bottom:1px solid var(--zq-border-soft);"><div style="display:flex;justify-content:space-between;gap:10px;"><strong style="font-size:12.5px;">' + esc(i.category || i.severity || '异常') + '</strong><span class="zq-mono" style="font-size:11px;color:var(--zq-text3);">' + esc(fmtDate(i.createdAt)) + '</span></div><div style="margin-top:4px;font-size:12px;color:var(--zq-text2);line-height:1.45;">' + esc(i.message || '') + '</div></div>';
  }).join('') || empty('当前没有开放异常');
}
async function bootAdminRag() {
  var host = $('#zq-rag-status');
  if (!host) return;
  var status;
  try {
    status = await api.get('/admin/rag/status');
  } catch (error) {
    host.innerHTML = '<div class="zq-empty">RAG 状态读取失败：' + esc(error.message || '未知错误') + '</div>';
    return;
  }
  var sidecar = status.sidecar || {}, active = status.activeGeneration || {};
  var jobs = status.jobs || {}, metrics = status.metrics || {};
  var deadJobs = Number(jobs.DEAD || 0) ? await api.get('/admin/rag/jobs?status=DEAD') : [];
  var generations = (status.generations || []).slice(0, 6);
  var expected = Number(active.expectedSourceCount || 0);
  var progress = expected ? Math.round(Number(active.indexedSourceCount || 0) / expected * 100) : 0;
  host.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;">'
    + ragMetric('服务状态', status.enabled ? (sidecar.ready ? '可用' : '未就绪') : '未启用', sidecar.ready ? 'var(--zq-ok)' : 'var(--zq-warn)')
    + ragMetric('活动索引', active.indexVersion || '尚未启用', 'var(--zq-text)')
    + ragMetric('索引进度', active.id ? progress + '%' : '—', 'var(--zq-primary)')
    + ragMetric('任务积压', Number(jobs.PENDING || 0) + Number(jobs.RETRY || 0), Number(jobs.DEAD || 0) ? 'var(--zq-bad)' : 'var(--zq-text)')
    + '</div><div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;font-size:12px;color:var(--zq-text2);">'
    + '<span>查询 P50：<b class="zq-mono">' + esc(metrics.queryP50Ms == null ? '—' : metrics.queryP50Ms + ' ms') + '</b></span>'
    + '<span>查询 P95：<b class="zq-mono">' + esc(metrics.queryP95Ms == null ? '—' : metrics.queryP95Ms + ' ms') + '</b></span>'
    + '<span>关键词降级：<b class="zq-mono">' + esc(metrics.fallbackCount || 0) + '</b></span>'
    + '<span>越权候选丢弃：<b class="zq-mono">' + esc(metrics.crossScopeDrops || 0) + '</b></span>'
    + '<span>DEAD：<b class="zq-mono">' + esc(jobs.DEAD || 0) + '</b></span></div>'
    + (generations.length ? '<div style="margin-top:14px;border-top:1px solid var(--zq-border-soft);">' + generations.map(function (item) {
        var canActivate = item.status === 'READY' || item.status === 'RETIRED';
        var canDiscard = item.status === 'FAILED';
        return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--zq-border-soft);font-size:12px;">'
          + '<span class="zq-mono" style="width:32px;color:var(--zq-text3);">#' + esc(item.id) + '</span><strong style="min-width:76px;">' + esc(item.status) + '</strong>'
          + '<span style="flex:1;min-width:0;overflow-wrap:anywhere;color:var(--zq-text2);">' + esc(item.indexVersion || '') + ' · ' + esc(item.indexedSourceCount || 0) + '/' + esc(item.expectedSourceCount || 0) + '</span>'
          + (canActivate ? '<button type="button" class="zq-btn-ghost" data-rag-activate="' + item.id + '" style="height:26px;padding:0 9px;">' + (item.status === 'RETIRED' ? '回滚' : '启用') + '</button>' : '')
          + (canDiscard ? '<button type="button" class="zq-btn-ghost" data-rag-discard="' + item.id + '" style="height:26px;padding:0 9px;color:var(--zq-bad);">丢弃</button>' : '') + '</div>';
      }).join('') + '</div>' : '')
    + (deadJobs.length ? '<details style="margin-top:12px;"><summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--zq-bad);">失败任务（' + deadJobs.length + '）</summary><div>' + deadJobs.slice(0, 10).map(function (job) {
        return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--zq-border-soft);font-size:12px;"><span class="zq-mono">#' + esc(job.id) + '</span><span style="flex:1;min-width:0;overflow-wrap:anywhere;">' + esc(job.operation) + ' · ' + esc(job.lastError || '未知错误') + '</span><button type="button" class="zq-btn-ghost" data-rag-retry="' + job.id + '" style="height:26px;padding:0 9px;">重试</button></div>';
      }).join('') + '</div></details>' : '')
    + '<div style="display:flex;gap:8px;margin-top:14px;"><button type="button" class="zq-btn-ghost" id="zq-rag-refresh" style="height:30px;">刷新状态</button>'
    + '<button type="button" class="zq-btn-ghost" id="zq-rag-rebuild" style="height:30px;">新建重建代次</button></div>';
  var refresh = $('#zq-rag-refresh');
  if (refresh) refresh.onclick = function () { safe('刷新 RAG 状态', bootAdminRag); };
  var rebuild = $('#zq-rag-rebuild');
  if (rebuild) rebuild.onclick = async function () {
    if (!await askConfirm({ title: '重建语义索引', message: '系统会创建新索引代次，当前活动索引会继续提供服务。确认开始？', okText: '开始重建' })) return;
    safe('创建重建任务', async function () { await api.post('/admin/rag/rebuild', {}); toast('已创建重建代次'); await bootAdminRag(); });
  };
  $all('[data-rag-activate]', host).forEach(function (button) {
    button.onclick = function () { safe('启用索引代次', async function () { await api.post('/admin/rag/generations/' + button.dataset.ragActivate + '/activate', {}); toast('索引代次已启用'); await bootAdminRag(); }); };
  });
  $all('[data-rag-retry]', host).forEach(function (button) {
    button.onclick = function () { safe('重试索引任务', async function () { await api.post('/admin/rag/jobs/' + button.dataset.ragRetry + '/retry', {}); toast('任务已重新排队'); await bootAdminRag(); }); };
  });
  $all('[data-rag-discard]', host).forEach(function (button) {
    button.onclick = async function () {
      if (!await askConfirm({ title: '丢弃失败索引', message: '将删除该失败代次已生成的向量数据，且不能恢复。确认继续？', okText: '确认丢弃' })) return;
      safe('丢弃失败索引代次', async function () {
        await api.post('/admin/rag/generations/' + button.dataset.ragDiscard + '/discard', {});
        toast('失败索引已进入清理队列');
        await bootAdminRag();
      });
    };
  });
}
function ragMetric(label, value, color) {
  return '<div style="padding:10px 12px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);min-width:0;"><span style="display:block;font-size:11px;color:var(--zq-text3);">'
    + esc(label) + '</span><strong style="display:block;margin-top:5px;font-size:13px;color:' + color + ';overflow-wrap:anywhere;">' + esc(value) + '</strong></div>';
}

async function bootFeedbackAdmin() {
  feedbackList = await api.get('/admin/feedback');
  // 用真实状态（OPEN/CLOSED）重建筛选条，替换演示的三态筛选
  var bar = $('#zq-filters');
  if (bar) {
    var opts = [['all', '全部'], ['OPEN', '待处理'], ['CLOSED', '已关闭']];
    bar.innerHTML = opts.map(function (o, i) {
      return '<button type="button" data-fb="' + o[0] + '" style="height:30px;padding:0 14px;border:none;cursor:pointer;font-size:12.5px;font-weight:600;background:' + (i === 0 ? 'var(--zq-primary)' : 'var(--zq-card)') + ';color:' + (i === 0 ? 'var(--zq-on-primary)' : 'var(--zq-text2)') + ';">' + o[1] + '</button>';
    }).join('');
    $all('[data-fb]', bar).forEach(function (b) {
      b.onclick = function () {
        $all('[data-fb]', bar).forEach(function (x) {
          var on = x === b; x.style.background = on ? 'var(--zq-primary)' : 'var(--zq-card)'; x.style.color = on ? 'var(--zq-on-primary)' : 'var(--zq-text2)';
        });
        renderFeedbackList(b.dataset.fb);
      };
    });
  }
  renderFeedbackList('all');
}
function renderFeedbackList(filter) {
  var host = $('#zq-list'); if (!host) return;
  var list = (feedbackList || []).filter(function (f) {
    var status = (f.status || 'OPEN').toUpperCase();
    return filter === 'all' ? true : status === filter;
  });
  host.innerHTML = list.map(function (f) {
    var open = (f.status || 'OPEN').toUpperCase() !== 'CLOSED';
    return '<article class="zq-card"><div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;"><span class="zq-badge" style="background:' + (open ? 'var(--zq-bad-tint)' : 'var(--zq-ok-tint)') + ';color:' + (open ? 'var(--zq-bad)' : 'var(--zq-ok)') + ';font-weight:700;">' + esc(open ? '待处理' : '已关闭') + '</span><span style="font-size:12.5px;font-weight:600;">' + esc(f.nickname || f.username || ('用户 #' + (f.userId || ''))) + '</span><span class="zq-mono" style="font-size:11.5px;color:var(--zq-text3);">' + esc(fmtDate(f.createdAt)) + '</span>' + (open ? '<span style="margin-left:auto;"><button data-close-feedback="' + f.id + '" class="zq-btn-ghost" style="height:26px;padding:0 11px;font-size:12px;">关闭</button></span>' : '') + '</div><p style="margin:0;font-size:13px;line-height:1.6;">' + esc(f.content || '') + '</p></article>';
  }).join('') || empty('暂无反馈');
  $all('[data-close-feedback]', host).forEach(function (b) { b.onclick = async function () { await api.put('/admin/feedback/' + b.dataset.closeFeedback + '/close'); await bootFeedbackAdmin(); }; });
}

async function bootAccountAdmin() {
  var header = $('.zq-main header') || $('header');
  var searchInput = header && $('input', header);
  var roleSel = header && $('select', header);
  var queryBtn = header && $all('button', header).find(function (b) { return /查询/.test(b.textContent); });
  if (queryBtn) queryBtn.onclick = function () { loadAccounts(searchInput ? searchInput.value.trim() : '', roleSel ? roleSel.selectedIndex : 0); };
  if (searchInput) searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (queryBtn) queryBtn.onclick(); } });
  await loadAccounts('', 0);
}
async function loadAccounts(keyword, roleIdx) {
  var host = $('#zq-rows'); if (!host) return;
  var qs = 'page=1&size=100';
  if (keyword) qs += '&keyword=' + encodeURIComponent(keyword);
  if (roleIdx === 1) qs += '&role=ADMIN';
  else if (roleIdx === 2) qs += '&role=USER';
  var list = await api.get('/admin/users?' + qs);
  var records = list.records || [];
  host.innerHTML = records.map(function (u) {
    var disabled = Number(u.status) === 0;
    return '<div style="display:grid;grid-template-columns:minmax(120px,1.1fr) minmax(150px,1.3fr) 74px 62px 102px 104px 128px;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--zq-border-soft);opacity:' + (disabled ? .6 : 1) + ';"><div style="display:flex;align-items:center;gap:9px;min-width:0;"><div style="width:28px;height:28px;flex:none;border-radius:50%;background:var(--zq-tint);color:var(--zq-primary);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">' + esc((u.nickname || u.username || '知').slice(0, 1)) + '</div><span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(u.nickname || u.username) + '</span></div><span style="font-size:12.5px;color:var(--zq-text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(u.email || u.username) + '</span><span><span class="zq-badge" style="background:' + (u.role === 'ADMIN' ? 'var(--zq-tint)' : 'var(--zq-card-soft)') + ';color:' + (u.role === 'ADMIN' ? 'var(--zq-primary)' : 'var(--zq-text2)') + ';">' + esc(u.role === 'ADMIN' ? '管理员' : '普通用户') + '</span></span><span style="font-size:12px;font-weight:600;color:' + (disabled ? 'var(--zq-bad)' : 'var(--zq-ok)') + ';">' + (disabled ? '已禁用' : '正常') + '</span><span class="zq-mono" style="font-size:12px;color:var(--zq-text2);">' + esc(u.achievementPoints || 0) + ' 点</span><span class="zq-mono" style="font-size:12px;color:var(--zq-text2);">' + esc(fmtDate(u.updatedAt || u.createdAt)) + '</span><span style="display:flex;justify-content:flex-end;gap:6px;"><button data-reset-user="' + u.id + '" class="zq-btn-ghost" style="height:26px;padding:0 8px;font-size:11.5px;">重置密码</button><button data-toggle-user="' + u.id + '" data-next="' + (disabled ? 1 : 0) + '" class="zq-btn-ghost" style="height:26px;padding:0 8px;font-size:11.5px;">' + (disabled ? '启用' : '禁用') + '</button><button data-delete-user="' + u.id + '" class="zq-btn-ghost" style="height:26px;padding:0 8px;font-size:11.5px;">删除</button></span></div>';
  }).join('') || empty('暂无账号');
  var foot = $('.zq-table > div:last-child');
  if (foot) foot.textContent = '共 ' + (list.total || records.length) + ' 个账号';
  var reload = function () { loadAccounts(keyword, roleIdx); };
  $all('[data-delete-user]', host).forEach(function (b) { b.onclick = async function () { if (await askConfirm({ title: '删除账号', message: '确认删除该账号？其数据将按软删除规则处理。', okText: '删除', danger: true })) safe('删除账号', async function () { await api.del('/admin/users/' + b.dataset.deleteUser); reload(); }); }; });
  $all('[data-toggle-user]', host).forEach(function (b) { b.onclick = function () { safe('更新状态', async function () { await api.put('/admin/users/' + b.dataset.toggleUser + '/status?status=' + b.dataset.next); reload(); }); }; });
  $all('[data-reset-user]', host).forEach(function (b) { b.onclick = async function () { if (await askConfirm({ title: '重置密码', message: '重置该账号密码为随机临时密码？原密码将立即失效。', okText: '重置' })) safe('重置密码', async function () { var res = await api.post('/admin/users/' + b.dataset.resetUser + '/reset-password', {}); var pw = res && res.tempPassword ? res.tempPassword : '(已重置)'; await showInfo({ title: '密码已重置', html: '<p style="margin:0 0 10px;font-size:13px;color:var(--zq-text2);">临时密码（请复制并转交用户，登录后尽快修改）：</p><div class="zq-mono" style="margin:0 0 16px;padding:10px 14px;border:1px solid var(--zq-border);border-radius:var(--zq-rs);background:var(--zq-card-soft);font-size:15px;font-weight:600;user-select:all;">' + esc(pw) + '</div>' }); }); }; });
}

async function bootSharedPlanAdmin() {
  var list = await api.get('/admin/shared-plans');
  var host = $('#zq-reviews');
  if (!host) return;
  var groups = { PENDING: [], APPROVED: [], OFFLINE: [], REJECTED: [] };
  (list || []).forEach(function (p) { (groups[String(p.status || '').toUpperCase()] || (groups.PENDING)).push(p); });
  var pendEl = $('#zq-pending');
  if (pendEl) pendEl.textContent = '待审核 ' + groups.PENDING.length + ' 个 · 已发布 ' + groups.APPROVED.length + ' 个';
  function creator(p) { return esc((p.creator && (p.creator.nickname || p.creator.username)) || p.creatorNickname || p.username || '匿名'); }
  function catName(p) { return esc(p.categoryName || (planCategory(p.category) || [])[1] || p.category || '未分类'); }
  function card(p, actions, dim) {
    return '<article class="zq-card" style="' + (dim ? 'opacity:.72;' : '') + '">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;"><span class="zq-badge" style="background:var(--zq-tint);color:var(--zq-primary);">' + catName(p) + '</span><span class="zq-mono" style="font-size:11px;color:var(--zq-text3);">' + esc(fmtDate(p.createdAt)) + '</span></div>'
      + '<h3 data-sp-view="' + p.id + '" title="点击查看完整内容" style="margin:0 0 5px;font-size:15px;font-weight:700;cursor:pointer;">' + esc(p.title || p.name || '未命名') + ' <span style="font-size:11px;font-weight:500;color:var(--zq-primary);">查看 ›</span></h3>'
      + '<p style="margin:0 0 10px;font-size:12.5px;color:var(--zq-text2);line-height:1.55;">' + esc(p.description || '（无简介）') + '</p>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:10px;border-top:1px solid var(--zq-border-soft);"><span style="font-size:12px;color:var(--zq-text3);">' + creator(p) + '</span><span style="display:flex;gap:6px;">' + actions + '</span></div></article>';
  }
  function section(title, items, render) {
    if (!items.length) return '';
    return '<div style="grid-column:1/-1;margin:8px 2px 0;font-size:12.5px;font-weight:700;color:var(--zq-text2);">' + title + ' · ' + items.length + '</div>' + items.map(render).join('');
  }
  var html = '';
  html += section('待审核', groups.PENDING, function (p) {
    return card(p, '<button data-sp-ok="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-ok);">通过</button><button data-sp-no="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-bad);">驳回</button>');
  });
  html += section('已发布', groups.APPROVED, function (p) {
    return card(p, '<button data-sp-edit="' + p.id + '" class="zq-btn-ghost" style="height:28px;">修改</button><button data-sp-down="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-warn);">下架</button>');
  });
  html += section('已下架', groups.OFFLINE, function (p) {
    return card(p, '<button data-sp-ok="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-ok);">重新发布</button><button data-sp-edit="' + p.id + '" class="zq-btn-ghost" style="height:28px;">修改</button><button data-sp-del="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-bad);">删除</button>', true);
  });
  html += section('已驳回', groups.REJECTED, function (p) {
    return card(p, '<button data-sp-ok="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-ok);">通过</button><button data-sp-del="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-bad);">删除</button>', true);
  });
  host.innerHTML = html || empty('暂无共享计划');
  $all('[data-sp-ok]', host).forEach(function (b) { b.onclick = function () { safe('通过', async function () { await api.put('/admin/shared-plans/' + b.dataset.spOk + '/review?action=APPROVE'); toast('已通过发布'); await bootSharedPlanAdmin(); }); }; });
  $all('[data-sp-no]', host).forEach(function (b) { b.onclick = async function () { var note = await askText({ title: '驳回共享计划', label: '驳回原因（可选，将展示给提交者）', textarea: true, okText: '驳回' }); if (note === null) return; safe('驳回', async function () { await api.put('/admin/shared-plans/' + b.dataset.spNo + '/review?action=REJECT&note=' + encodeURIComponent(note || '')); toast('已驳回'); await bootSharedPlanAdmin(); }); }; });
  $all('[data-sp-down]', host).forEach(function (b) { b.onclick = function () { safe('下架', async function () { await api.put('/admin/shared-plans/' + b.dataset.spDown + '/review?action=TAKEDOWN'); toast('已下架'); await bootSharedPlanAdmin(); }); }; });
  $all('[data-sp-del]', host).forEach(function (b) { b.onclick = async function () { if (!await askConfirm({ title: '删除共享计划', message: '确定删除该共享计划？此操作不可恢复。', okText: '删除', danger: true })) return; safe('删除', async function () { await api.del('/admin/shared-plans/' + b.dataset.spDel); toast('已删除'); await bootSharedPlanAdmin(); }); }; });
  $all('[data-sp-edit]', host).forEach(function (b) { b.onclick = function () { editSharedPlan(b.dataset.spEdit); }; });
  $all('[data-sp-view]', host).forEach(function (t) { t.onclick = function () { viewSharedPlan(t.dataset.spView); }; });
}
function viewSharedPlan(id) {
  safe('计划详情', async function () {
    var d = await api.get('/admin/shared-plans/' + id);
    var itemRow = function (x, extra) {
      return '<div style="padding:8px 11px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);"><div style="font-size:12.5px;font-weight:600;">' + esc(x.title || '') + '</div>'
        + (x.description ? '<div style="font-size:11.5px;color:var(--zq-text2);margin-top:2px;line-height:1.5;">' + esc(x.description) + '</div>' : '')
        + '<div class="zq-mono" style="font-size:10.5px;color:var(--zq-text3);margin-top:3px;">' + esc(extra) + '</div></div>';
    };
    var tasks = (d.tasks || []).map(function (t) {
      return itemRow(t, '第' + (t.relativeStartDay == null ? 0 : t.relativeStartDay) + '天起 · 截止第' + (t.relativeDeadlineDay == null ? '—' : t.relativeDeadlineDay) + '天' + (t.preferredTime ? ' · ' + t.preferredTime : '') + (t.durationMinutes ? ' · ' + t.durationMinutes + '分钟' : ''));
    }).join('');
    var routines = (d.routines || []).map(function (r) {
      return itemRow(r, freqLabel(r.frequency, r.daysOfWeek) + (r.preferredTime ? ' · ' + r.preferredTime : '') + (r.durationMinutes ? ' · ' + r.durationMinutes + '分钟' : '') + ' · 第' + (r.relativeStartDay == null ? 0 : r.relativeStartDay) + '~' + (r.relativeEndDay == null ? '—' : r.relativeEndDay) + '天');
    }).join('');
    var reviews = (d.reviews || []).map(function (rv) {
      return '<div style="font-size:11.5px;color:var(--zq-text2);line-height:1.6;"><span class="zq-mono" style="color:var(--zq-text3);">' + esc(fmtDate(rv.createdAt)) + '</span> ' + esc(rv.action || '') + (rv.note ? ' · ' + esc(rv.note) : '') + '</div>';
    }).join('');
    function sec(t, body) { return body ? '<h4 style="margin:14px 0 7px;font-size:12.5px;font-weight:700;">' + t + '</h4><div style="display:flex;flex-direction:column;gap:6px;">' + body + '</div>' : ''; }
    openModal({
      title: (d.title || '共享计划') + ' · ' + esc(d.status || ''),
      width: '560px',
      bodyHtml:
        '<p style="margin:0 0 4px;font-size:13px;color:var(--zq-text2);line-height:1.7;">' + esc(d.description || '（无简介）') + '</p>'
        + '<div style="font-size:12px;color:var(--zq-text3);">' + esc(d.categoryName || d.category || '') + (d.targetAudience ? ' · 适用：' + esc(d.targetAudience) : '') + ' · ♡ ' + (d.likeCount || 0) + ' · 套用 ' + (d.applyCount || 0) + '</div>'
        + sec('一次性任务 · ' + (d.tasks || []).length, tasks || '')
        + sec('例行计划 · ' + (d.routines || []).length, routines || '')
        + sec('审核记录', reviews || '')
        + '<div class="zq-modal-actions" style="margin-top:16px;"><button type="button" class="zq-btn" data-view-close>关闭</button></div>',
      onMount: function (b, h) { $('[data-view-close]', b).onclick = h.close; }
    });
  });
}
function editSharedPlan(id) {
  safe('加载共享计划', async function () {
    var d = await api.get('/admin/shared-plans/' + id);
    var catOptions = planCategoryOptions(d.category);
    openModal({
      title: '修改共享计划',
      width: '520px',
      bodyHtml:
        '<div class="zq-field"><label class="zq-label">标题</label><input id="zq-sp-title" class="zq-input" value="' + esc(d.title || '') + '"></div>'
        + '<div class="zq-field"><label class="zq-label">分类</label><select id="zq-sp-cat" class="zq-select">' + catOptions + '</select></div>'
        + '<div class="zq-field"><label class="zq-label">简介</label><textarea id="zq-sp-desc" class="zq-textarea" style="min-height:100px;">' + esc(d.description || '') + '</textarea></div>'
        + '<div class="zq-field"><label class="zq-label">适用人群（可选）</label><input id="zq-sp-aud" class="zq-input" value="' + esc(d.targetAudience || '') + '"></div>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-sp-cancel">取消</button><button type="button" class="zq-btn" id="zq-sp-save">保存</button></div>',
      onMount: function (bd, h) {
        $('#zq-sp-cancel', bd).onclick = h.close;
        $('#zq-sp-save', bd).onclick = function () {
          var title = $('#zq-sp-title', bd).value.trim(); if (!title) return toast('请填写标题', 'error');
          safe('保存共享计划', async function () {
            await api.put('/admin/shared-plans/' + id, { title: title, category: $('#zq-sp-cat', bd).value, description: $('#zq-sp-desc', bd).value, targetAudience: $('#zq-sp-aud', bd).value });
            h.close(); toast('已保存'); await bootSharedPlanAdmin();
          });
        };
      }
    });
  });
}
