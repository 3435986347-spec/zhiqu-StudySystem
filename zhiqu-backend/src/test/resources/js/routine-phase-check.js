// 例行计划今天处在哪一段（没开始 / 进行中 / 已结束）—— 直接跑 assets/zhiqu-api.js 里发布的 routinePhase（第十四轮）。
//   用法：node src/test/resources/js/routine-phase-check.js <zhiqu-api.js 的路径>；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('  function routinePhase(r, day) {');
const b = src.indexOf('  async function loadRoutines() {', a);
if (a < 0 || b < 0) throw new Error('抠不到 routinePhase');
const routinePhase = new Function(src.slice(a, b) + '\nreturn routinePhase;')();
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
if (fail) { console.log(fail + ' 条红'); process.exit(1); }
console.log('ALL-GREEN');
