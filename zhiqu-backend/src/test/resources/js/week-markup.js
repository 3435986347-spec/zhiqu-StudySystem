// 第五十三轮：从发布的 assets/pages/dashboard.js 里抠出 renderWeek 真跑，把一周七格的 HTML 写到文件里 ——
// DesktopWebKitLayoutTest 拿去在真的 WebKit（WKWebView）里量：窄的日历里日期出不出格子。用的是发布的那份画法，不在测试里另抄一份标记。
//   用法：node src/test/resources/js/week-markup.js <dashboard.js 的路径> <写到哪>；打印 ALL-GREEN 且退出码 0 = 写好了。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('/** 一个日子里最多画几个点');
if (a < 0) throw new Error('抠不到 renderWeek 那一段');
const host = { innerHTML: '' };
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fns = new Function('$', '$all', 'esc', 'empty', 'qKey', 'qLabel', 'fmtDate', 'hm', 'today', 'state', 'safe', 'api', 'bootDashboard',
  src.slice(a) + '\nreturn { renderWeek };')(
  (sel) => (sel === '#zq-week' ? host : null), () => [], esc, (t) => '<div class="zq-empty">' + t + '</div>', (q) => 'q' + (q || 4),
  () => '', (v) => String(v || ''), () => '', () => '2026-10-09', {}, () => {}, {}, () => {});
const many = (n) => Array.from({ length: n }, (_, i) => ({ id: i, kind: i % 5 ? 'TASK' : 'ROUTINE', quadrant: (i % 4) + 1, status: i % 7 ? 0 : 2 }));
const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
// 两位数的日期（10、11）和一天几十件事（+36）都放进来：最宽的那种格子
const days = names.map((w, i) => ({ date: '2026-10-' + String(5 + i).padStart(2, '0'), day: 5 + i, weekday: w, today: i === 4, items: many([44, 29, 0, 30, 45, 30, 12][i]) }));
fns.renderWeek(days);
if (!host.innerHTML.includes('zq-day-num')) throw new Error('renderWeek 没画出日子');
fs.writeFileSync(process.argv[3], host.innerHTML);
console.log('ALL-GREEN');
