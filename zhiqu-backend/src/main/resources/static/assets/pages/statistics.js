// 专注统计页 —— 第三十二轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// paintTrend 和 bind 另外导出给测试直接 import（latest-check.js：来回切「日 / 周 / 月」时乱序回来的响应）。

let api, esc, $, $all, empty, latestOnly;
export function bind(sh) {
  ({ api, esc, $, $all, empty, latestOnly } = sh);
}

export const boots = { 'statistics.html': (sh) => { bind(sh); return bootStatistics(); } };
export { paintTrend };

async function bootStatistics() {
  var stat = await api.get('/record/statistics');
  var nums = $all('.zq-stat-num');
  if (nums[0]) nums[0].textContent = stat.consecutiveDays || 0;
  if (nums[1]) nums[1].textContent = stat.totalMinutes || stat.totalStudyMinutes || 0;
  // 接口给的是 completedTaskCount / totalTaskCount —— 原来读 completedTasks / totalTasks，这两格永远是 0（第十七轮看到的）
  if (nums[2]) nums[2].textContent = stat.completedTaskCount || 0;
  if (nums[3]) nums[3].textContent = stat.totalTaskCount || 0;
  window.setTab = function (k) { highlightStatTab(k); paintTrend(k); };
  // 日 / 周 / 月三个按钮写在页面里（第二十四轮：原来由设计稿的示例脚本画出来，删掉示例之后这里自己接）
  $all('#zq-tabs button[data-k]').forEach(function (b) { b.onclick = function () { window.setTab(b.dataset.k); }; });
  await paintTrend('day');
  highlightStatTab('day');
  renderQuadrantDonut(stat.quadrantDistribution || {});
}
function highlightStatTab(k) {
  $all('#zq-tabs button').forEach(function (b) {
    var on = b.dataset.k === k;
    b.style.background = on ? 'var(--zq-primary)' : 'var(--zq-card)';
    b.style.color = on ? 'var(--zq-on-primary)' : 'var(--zq-text2)';
  });
}
/** 四象限的分布：/record/statistics 已经按象限数好了（一条 GROUP BY）。原来另外取回全部任务在页面里再数一遍（第十七轮：三千条任务就是 1.6MB） */
function renderQuadrantDonut(distribution) {
  var donut = $('#zq-donut'); if (!donut) return;
  var counts = [1, 2, 3, 4].map(function (q) { return Number((distribution || {})[q] || 0); });
  var total = counts.reduce(function (a, b) { return a + b; }, 0);
  var C = 2 * Math.PI * 66, acc = 0;
  donut.innerHTML = total ? counts.map(function (n, i) {
    if (!n) return '';
    var len = n / total * C;
    var seg = '<circle cx="86" cy="86" r="66" fill="none" stroke="var(--zq-q' + (i + 1) + ')" stroke-width="22" stroke-dasharray="' + len.toFixed(1) + ' ' + (C - len).toFixed(1) + '" stroke-dashoffset="' + (-acc).toFixed(1) + '" transform="rotate(-90 86 86)"></circle>';
    acc += len; return seg;
  }).join('') : '<circle cx="86" cy="86" r="66" fill="none" stroke="var(--zq-card-soft)" stroke-width="22"></circle>';
  var wrap = donut.parentElement;
  var center = wrap && wrap.querySelector('.zq-mono');
  if (center) center.textContent = total;
  var legendHost = $('#zq-legend');
  if (legendHost) {
    var labels = ['重要且紧急', '重要不紧急', '紧急不重要', '不重要不紧急'];
    legendHost.innerHTML = counts.map(function (n, i) {
      var pct = total ? Math.round(n / total * 100) : 0;
      return '<div style="display:flex; align-items:center; gap:8px; font-size:12.5px;"><span style="width:10px; height:10px; flex:none; border-radius:3px; background:var(--zq-q' + (i + 1) + ');"></span><span style="flex:1; color:var(--zq-text2);">' + labels[i] + '</span><span class="zq-mono" style="font-weight:600;">' + n + ' 项 · ' + pct + '%</span></div>';
    }).join('');
  }
}
async function paintTrend(type) {
  var current = latestOnly('trend');
  var list = await api.get('/record/trend?type=' + encodeURIComponent(type));
  if (!current()) return;
  var vals = list.map(function (x) { return Number(x.minutes || x.totalMinutes || x.value || 0); });
  var labels = list.map(function (x) { return x.label || x.date || x.period || ''; });
  var max = Math.max.apply(null, vals.concat([1]));
  var host = $('#zq-bars'); if (!host) return;
  host.innerHTML = vals.map(function (v, i) {
    var h = Math.max(3, Math.round(v / max * 168));
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;height:100%;justify-content:flex-end;"><span class="zq-mono" style="font-size:10px;color:var(--zq-text3);">' + v + '</span><div style="width:100%;max-width:34px;height:' + h + 'px;border-radius:4px 4px 2px 2px;background:var(--zq-tint-strong);"></div><span style="font-size:10.5px;color:var(--zq-text3);white-space:nowrap;">' + esc(labels[i]) + '</span></div>';
  }).join('') || empty('暂无趋势数据');
}
