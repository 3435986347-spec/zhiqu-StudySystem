// 页面的「今天」（第二十一轮）的行为判据 —— 直接跑 assets/zhiqu-api.js 里发布的那段业务时钟。
//
//   用法：node src/test/resources/js/clock-check.js <zhiqu-api.js 的路径>
//   退出码 0 = 全绿；非 0 = 有判据红了，逐条打印在上面。
//
// 由 FrontendClockTest 调用。原来 today() 是浏览器所在时区的日历日，又被当成数据发给服务端（打卡、番茄钟、新建例行计划）：
// UTC+14 的浏览器发「明天」、比东八区晚的过了北京时间零点把打卡记到昨天。这里把 node 进程的时区换成六个地方（node 会跟着
// process.env.TZ 变），再把本机时钟拨快一年，看算出来的「今天」、这一周、服务端时间换成的时刻是不是始终是业务时区的。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('抠不到起点: ' + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('抠不到终点: ' + endMark);
  return src.slice(a, b);
}
// 从 localDate 起抠：它就在业务时钟上面，today() 要是退回 localDate() 也得跑得起来、判得出来（扰动照出来的：原来只抠业务时钟，
// 退回去之后是 ReferenceError，判据红的原因不对）
const clockSrc = slice('  function localDate(d) {', '  /** 浏览器的钟面和业务时区不一样时');
if (!/function today\(/.test(clockSrc) || !/function weekRange\(/.test(clockSrc)) throw new Error('抠出来的片段里没有 today / weekRange —— 抠错地方了');

/** 每次一个新的页面：模块里的状态（时区、时钟差）从头开始。 */
function freshPage() {
  return new Function(clockSrc + '\nreturn { applyServerClock, today, weekRange, serverTime, addDays, businessDate, nowMs };')();
}

let fail = 0;
function judge(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}

// 本机时钟：Date.now() 和不带参数的 new Date() 都要换 —— 只换 Date.now 的话 new Date() 读的还是真的钟，
// 判据跑在一天里的什么时候就成了变量（扰动照出来的）
const RealDate = Date;
let fakeNow = RealDate.now();
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(fakeNow); else super(...args); }
  static now() { return fakeNow; }
}
global.Date = FakeDate;
/** 浏览器在 tz、本机时钟读数是 browserClock，服务器此刻是 serverNow（业务时区 Asia/Shanghai）时打开一页。 */
function pageAt(tz, serverNow, browserClock = serverNow) {
  process.env.TZ = tz;
  fakeNow = browserClock;
  const p = freshPage();
  p.applyServerClock({ zone: 'Asia/Shanghai', today: 'ignored', now: serverNow, offsetMinutes: 480 }, browserClock, browserClock);
  return p;
}

const ZONES = ['Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Etc/GMT+12', 'Europe/London', 'America/New_York'];
const at = (iso) => Date.parse(iso);

try {
  // 北京时间 2026-09-28 23:30（周一）：基里巴斯已经是 29 号，洛杉矶还是 28 号上午
  const lateMonday = at('2026-09-28T15:30:00Z');
  for (const tz of ZONES) {
    const p = pageAt(tz, lateMonday);
    judge(`${tz}：今天是业务日期`, p.today() === '2026-09-28', p.today());
    const w = p.weekRange(0);
    judge(`${tz}：这一周是业务日期所在的周一到周日`, w[0] === '2026-09-28' && w[1] === '2026-10-04', w.join(' ~ '));
    judge(`${tz}：服务端的时间（业务时区的钟面）换成的是同一个时刻`,
      p.serverTime('2026-09-28T22:51:47') === at('2026-09-28T14:51:47Z'), String(p.serverTime('2026-09-28T22:51:47')));
  }

  // 北京时间零点那一刻翻页：23:59:59 还是今天，00:00:00 是明天 —— 不管浏览器在哪
  for (const tz of ZONES) {
    judge(`${tz}：北京时间 23:59:59 还是 28 号`, pageAt(tz, at('2026-09-28T15:59:59Z')).today() === '2026-09-28');
    judge(`${tz}：北京时间 00:00:00 就是 29 号`, pageAt(tz, at('2026-09-28T16:00:00Z')).today() === '2026-09-29');
  }

  // 本机时钟不准：快一年、慢一天 —— 算日期用服务器的钟
  // （本机时钟是全局的：每一页的判断要在下一页换掉它之前做完）
  const yearAhead = pageAt('Asia/Shanghai', lateMonday, lateMonday + 365 * 86400000);
  judge('本机时钟快了一年：今天仍是服务器的今天', yearAhead.today() === '2026-09-28', yearAhead.today());
  judge('此刻（nowMs）按服务器的钟', Math.abs(yearAhead.nowMs() - lateMonday) < 1000, String(yearAhead.nowMs() - lateMonday));
  const dayBehind = pageAt('Europe/London', lateMonday, lateMonday - 86400000);
  judge('本机时钟慢了一天：今天仍是服务器的今天', dayBehind.today() === '2026-09-28', dayBehind.today());

  // 周的边界：周日深夜、周一零点、跨年那一周
  const sundayNight = pageAt('America/Los_Angeles', at('2026-10-04T15:59:59Z'));
  judge('周日 23:59:59：还是这一周', sundayNight.weekRange(0).join() === '2026-09-28,2026-10-04', sundayNight.weekRange(0).join());
  const mondayZero = pageAt('Pacific/Kiritimati', at('2026-10-04T16:00:00Z'));
  judge('周一 00:00：换到下一周', mondayZero.weekRange(0).join() === '2026-10-05,2026-10-11', mondayZero.weekRange(0).join());
  const newYear = pageAt('America/New_York', at('2026-12-31T16:00:00Z'));
  judge('跨年：2027-01-01（周五）所在的周从 2026-12-28 到 2027-01-03', newYear.today() === '2027-01-01' && newYear.weekRange(0).join() === '2026-12-28,2027-01-03', newYear.today() + ' ' + newYear.weekRange(0).join());
  judge('跨年：下一周、上一周', newYear.weekRange(1).join() === '2027-01-04,2027-01-10' && newYear.weekRange(-1).join() === '2026-12-21,2026-12-27', newYear.weekRange(1).join() + ' / ' + newYear.weekRange(-1).join());

  // 日历上加减天数：闰日、月末、跨年，以及浏览器所在时区的夏令时那一天（纽约 2026-11-01 多出一小时）
  const ny = pageAt('America/New_York', at('2026-11-01T12:00:00Z'));
  const cases = [['2028-02-28', 1, '2028-02-29'], ['2027-02-28', 1, '2027-03-01'], ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -1, '2026-02-28'], ['2026-11-01', 1, '2026-11-02'], ['2026-03-08', 1, '2026-03-09'], ['2026-10-31', 7, '2026-11-07']];
  for (const [d, n, want] of cases) judge(`${d} ${n > 0 ? '+' : ''}${n} 天 = ${want}（浏览器在纽约）`, ny.addDays(d, n) === want, ny.addDays(d, n));
} finally {
  global.Date = RealDate;
}

// 与其它判据脚本同一个约定：自报 ALL-GREEN 且退出码 0 才算过（NodeRunner 两样都查）
console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
