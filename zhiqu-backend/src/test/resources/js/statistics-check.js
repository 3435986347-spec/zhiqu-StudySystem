// 专注统计页的画法（第五十七轮，界面打磨第 8 步）—— 直接 import 发布的 assets/pages/statistics.js，壳的东西用替身。
// 乱序回来的响应另有 latest-check.js。
//
//   用法：node src/test/resources/js/statistics-check.js <zhiqu-api.js 的路径>
//   退出码 0 = 全绿；非 0 = 有判据红了，逐条打印在上面。由 StatisticsLookTest 调用。
//
// 原来每一根柱子上都写数（零也写，十四根柱子上一排「0」），零的柱子是一道灰线，唯一有数的那根也是浅灰；「日 / 周 / 月」按下是 JS 改背景色。
const path = require('path');
const { pathToFileURL } = require('url');
const shellPath = path.resolve(process.argv[2]);

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

(async () => {
  const mod = await import(pathToFileURL(path.join(path.dirname(shellPath), 'pages', 'statistics.js')).href);
  for (const fn of ['paintTrend', 'highlightStatTab', 'legendHtml', 'bind']) {
    if (typeof mod[fn] !== 'function') throw new Error('pages/statistics.js 没有导出 ' + fn);
  }
  const host = { innerHTML: '' };
  const buttons = ['day', 'week', 'month'].map((k) => ({ dataset: { k }, attrs: {}, style: {}, setAttribute(a, v) { this.attrs[a] = String(v); } }));
  mod.bind({
    api: { get: async () => [{ label: '9/27', minutes: 0 }, { label: '9/28', minutes: 30 }, { label: '<b>', minutes: 0 }, { label: '9/30', minutes: 120 }] },
    $: (sel) => (sel === '#zq-bars' ? host : null), $all: (sel) => (sel === '#zq-tabs button' ? buttons : []),
    esc, empty: (s) => '<p class="zq-empty">' + s + '</p>', latestOnly: () => () => true
  });

  console.log('── 柱子 ──');
  await mod.paintTrend('day');
  const bars = host.innerHTML.split('<div class="zq-bar').slice(1);
  judge('四根', bars.length === 4, host.innerHTML);
  judge('零：标成 is-zero、上面不写「0」', bars[0].startsWith(' is-zero"') && bars[0].includes('<span class="zq-bar-val zq-num"></span>'), bars[0]);
  judge('有数的：不标 is-zero、上面写数', bars[1].startsWith('"') && bars[1].includes('<span class="zq-bar-val zq-num">30</span>'), bars[1]);
  judge('高度按最大的那根算（120 → 1、30 → 0.25），交给样式表的 --v', bars[3].includes('style="--v:1.000"') && bars[1].includes('style="--v:0.250"'), host.innerHTML);
  judge('除了 --v 没有别的内联样式', (host.innerHTML.match(/style="/g) || []).length === 4 && !/style="(?!--v:[\d.]+")/.test(host.innerHTML), host.innerHTML);
  judge('悬停说「哪天：多少分钟」（零也说）', bars[0].includes('title="9/27：0 分钟"') && bars[3].includes('title="9/30：120 分钟"'), host.innerHTML);
  judge('日期转义', host.innerHTML.includes('&lt;b&gt;') && !host.innerHTML.includes('<b>'), host.innerHTML);

  console.log('── 日 / 周 / 月 ──');
  mod.highlightStatTab('week');
  judge('按下的是「周」：aria-pressed，不在 JS 里改样子', buttons.map((b) => b.attrs['aria-pressed']).join(',') === 'false,true,false' && Object.keys(buttons[0].style).length === 0,
    JSON.stringify(buttons.map((b) => [b.attrs, b.style])));

  console.log('── 图例 ──');
  const legend = mod.legendHtml([75, 77, 75, 75], 302);
  judge('四行，色块按 data-q、名字、数和百分比', (legend.match(/<div class="zq-legend-row"><i data-q="\d"><\/i>/g) || []).length === 4
    && legend.includes('<span class="zq-legend-name">重要不紧急</span><span class="zq-num">77 项 · 25%</span>'), legend);
  judge('一个任务都没有：百分比是 0，不是 NaN', mod.legendHtml([0, 0, 0, 0], 0).includes('0 项 · 0%') && !mod.legendHtml([0, 0, 0, 0], 0).includes('NaN'));
  judge('没有内联样式', !/style=/.test(legend), legend);

  if (fail) { console.log('\nRED: ' + fail + ' 条'); process.exit(1); }
  console.log('\nALL-GREEN');
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
