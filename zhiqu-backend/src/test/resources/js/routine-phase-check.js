// 例行计划今天处在哪一段（没开始 / 进行中 / 已结束）—— routinePhase 直接 import 发布的 assets/pages/routines.js（第三十二轮起是模块；第十四轮）。
// freqLabel 还在壳里（例行计划、参考计划、后台、AI 草稿都用），照旧从 assets/zhiqu-api.js 里取。
//   用法：node src/test/resources/js/routine-phase-check.js <zhiqu-api.js 的路径>；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const shellPath = path.resolve(process.argv[2]);
const src = fs.readFileSync(shellPath, 'utf8');
(async () => {
  const { routinePhase } = await import(pathToFileURL(path.join(path.dirname(shellPath), 'pages', 'routines.js')).href);
  if (typeof routinePhase !== 'function') throw new Error('pages/routines.js 没有导出 routinePhase');
  let fail = 0;
  function judge(name, got, want) {
    if (got === want) console.log('  PASS  ' + name);
    else { console.log('  FAIL  ' + name + '  →  ' + got + '（应为 ' + want + '）'); fail++; }
  }
  const day = '2026-09-28';
  judge('区间里：进行中', routinePhase({ startDate: '2026-09-01', endDate: '2026-10-30' }, day), 'active');
  judge('开始那天：进行中（不是没开始）', routinePhase({ startDate: '2026-09-28', endDate: '2026-10-30' }, day), 'active');
  judge('结束那天：进行中（不是已结束）', routinePhase({ startDate: '2026-09-01', endDate: '2026-09-28' }, day), 'active');
  judge('明天才开始：没开始', routinePhase({ startDate: '2026-09-29', endDate: '2026-10-30' }, day), 'upcoming');
  judge('昨天结束：已结束', routinePhase({ startDate: '2026-07-06', endDate: '2026-09-27' }, day), 'ended');
  judge('跨年：12 月 31 日结束、1 月 1 日看', routinePhase({ startDate: '2026-12-01', endDate: '2026-12-31' }, '2027-01-01'), 'ended');
  judge('没有结束日期：一直进行中', routinePhase({ startDate: '2026-09-01' }, day), 'active');
  judge('带时间的日期只看日期部分', routinePhase({ startDate: '2026-09-28T08:00:00', endDate: '2026-09-28T00:00:00' }, day), 'active');

  // 周期给人看的样子（第十九轮）：原来列表里直接显示 DAILY / WEEKLY
  const fa = src.indexOf('  function freqLabel(frequency, daysOfWeek) {');
  const fb = src.indexOf('\n  }\n', fa);
  if (fa < 0 || fb < 0) throw new Error('抠不到 freqLabel');
  const freqLabel = new Function(src.slice(fa, fb + 4) + '\nreturn freqLabel;')();
  judge('DAILY：每天', freqLabel('DAILY'), '每天');
  judge('没写：按每天', freqLabel(null), '每天');
  judge('WEEKLY + 数组', freqLabel('WEEKLY', [1, 3, 5]), '每周一、三、五');
  judge('WEEKLY + 逗号串（库里的样子）', freqLabel('weekly', '6,7'), '每周六、日');
  judge('WEEKLY 没选星期', freqLabel('WEEKLY', []), '每周');
  judge('越界的星期不显示', freqLabel('WEEKLY', [0, 2, 8]), '每周二');
  judge('认不出的原样', freqLabel('MONTHLY'), 'MONTHLY');
  // 页面开着跨过业务日期的零点（第三十二轮起模块自己导出 dayReload，壳的 watchBusinessDay 叫它）：只重新取列表，不重新跑整页的启动
  // —— bootRoutines 用 addEventListener 接星期按钮，重跑一次每个按钮点一下就提交两遍
  const mod = await import(pathToFileURL(path.join(path.dirname(shellPath), 'pages', 'routines.js')).href);
  const got = [];
  const host = { innerHTML: '' };
  mod.bind({
    api: { get: async (u) => { got.push('GET ' + u); return [{ id: 1, title: 'x', startDate: '2026-09-01', frequency: 'DAILY' }]; } },
    $: (sel) => (sel === '#zq-rt' ? host : null), $all: (sel) => { got.push('$all ' + sel); return []; },
    esc: String, empty: String, safe: (n, f) => f(), toast: () => {}, askConfirm: async () => false, today: () => '2026-09-28',
    latestOnly: () => () => true, keepDraft: () => ({ clear() {} }), normalizeTask: (t) => t, qLabel: String, sLabel: String, freqLabel: () => '每天'
  });
  judge('导出了 dayReload[\'routines.html\']', typeof (mod.dayReload || {})['routines.html'], 'function');
  if (mod.dayReload && mod.dayReload['routines.html']) await mod.dayReload['routines.html']();
  judge('零点时重新取了例行计划', got.includes('GET /routine/list'), true);
  judge('零点时没有重新接星期按钮（没有重跑整页启动）', got.some((x) => x.includes('#zq-wd')), false);
  judge('零点时没有重新取「从任务生成」的来源', got.some((x) => x.includes('/task/page')), false);

  if (fail) { console.log(fail + ' 条红'); process.exit(1); }
  console.log('ALL-GREEN');
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
