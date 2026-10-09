// 专注统计页 —— 第三十二轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步）。形状见 pages/admin.js 的开头。
// paintTrend 和 bind 另外导出给测试直接 import（latest-check.js：来回切「日 / 周 / 月」时乱序回来的响应；statistics-check.js：柱子和图例的画法）。
// 第五十七轮（界面打磨第 8 步）：按下的样子是 aria-pressed（原来 JS 改 style.background）；柱子、图例的样子在样式表。

let api, esc, $, $all, empty, latestOnly;
export function bind(sh) {
  ({ api, esc, $, $all, empty, latestOnly } = sh);
}

export const boots = { 'statistics.html': (sh) => { bind(sh); return bootStatistics(); } };
export { paintTrend, highlightStatTab, legendHtml };

async function bootStatistics() {
  // 趋势图和上面几个总数互不依赖，一起取（第三十九轮：原来总数回来之后才去取趋势）
  var trend = paintTrend('day');
  trend.catch(function () {});   // 总数先失败的话下面不会再 await 它：别让它的失败成了没人接的 rejection（页面会多弹一句）；await 照样拿到失败
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
  await trend;
  highlightStatTab('day');
  renderQuadrantDonut(stat.quadrantDistribution || {});
}
function highlightStatTab(k) {
  $all('#zq-tabs button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.k === k)); });
}
var QUADRANT_NAMES = ['重要且紧急', '重要不紧急', '紧急不重要', '不重要不紧急'];
/** 图例：色块按 data-q 在样式表里上色 */
function legendHtml(counts, total) {
  return counts.map(function (n, i) {
    var pct = total ? Math.round(n / total * 100) : 0;
    return '<div class="zq-legend-row"><i data-q="' + (i + 1) + '"></i><span class="zq-legend-name">' + QUADRANT_NAMES[i] + '</span><span class="zq-num">' + n + ' 项 · ' + pct + '%</span></div>';
  }).join('');
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
  var center = wrap && wrap.querySelector('.zq-num');
  if (center) center.textContent = total;
  var legendHost = $('#zq-legend');
  if (legendHost) legendHost.innerHTML = legendHtml(counts, total);
}
async function paintTrend(type) {
  var current = latestOnly('trend');
  var list = await api.get('/record/trend?type=' + encodeURIComponent(type));
  if (!current()) return;
  var vals = list.map(function (x) { return Number(x.minutes || x.totalMinutes || x.value || 0); });
  var labels = list.map(function (x) { return x.label || x.date || x.period || ''; });
  var max = Math.max.apply(null, vals.concat([1]));
  var host = $('#zq-bars'); if (!host) return;
  // 有数的：强调色、上面写数；零：只留一道底线、不写「0」（原来十四根柱子上一排 0，唯一有数的那根是浅灰，和零差不多）。
  // 每一根悬停说「哪天：多少分钟」。高度是数据，用 --v（0–1）交给样式表
  host.innerHTML = vals.map(function (v, i) {
    var label = esc(labels[i]);
    return '<div class="zq-bar' + (v ? '' : ' is-zero') + '" title="' + label + '：' + v + ' 分钟">'
      + '<span class="zq-bar-val zq-num">' + (v || '') + '</span>'
      + '<span class="zq-bar-fill" style="--v:' + (v / max).toFixed(3) + '"></span>'
      + '<span class="zq-bar-label">' + label + '</span></div>';
  }).join('') || empty('暂无趋势数据');
}
