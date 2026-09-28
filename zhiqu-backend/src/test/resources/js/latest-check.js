// 来回切「日 / 周 / 月」时乱序回来的响应 —— 直接跑 assets/zhiqu-api.js 里发布的 latestOnly 与 paintTrend（第十四轮）。
//
//   用法：node src/test/resources/js/latest-check.js <zhiqu-api.js 的路径>
//   打印 ALL-GREEN 且退出码 0 = 全绿。由 LatestResponseTest 调用。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('抠不到起点: ' + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('抠不到终点: ' + endMark);
  return src.slice(a, b);
}
const code = slice('  var latestSeq = {};', '  async function safe(') + slice('  async function paintTrend(type) {', '  async function bootAchievement(');

const host = { innerHTML: '' };
const pending = {};
const api = { get: (path) => new Promise((resolve) => { pending[path] = resolve; }) };
const $ = (sel) => (sel === '#zq-bars' ? host : null);
const esc = (s) => String(s);
const empty = (s) => '<empty>' + s + '</empty>';
const mod = new Function('api', '$', 'esc', 'empty', code + '\nreturn { latestOnly, paintTrend };')(api, $, esc, empty);

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  const day = mod.paintTrend('day');
  const month = mod.paintTrend('month');
  pending['/record/trend?type=month']([{ label: '9月', minutes: 300 }]);
  await tick();
  pending['/record/trend?type=day']([{ label: '9/28', minutes: 45 }]);
  await Promise.all([day, month]);
  judge('先点「日」再点「月」，「日」的响应后回来：画的还是「月」', host.innerHTML.includes('9月') && !host.innerHTML.includes('9/28'), host.innerHTML.slice(0, 200));

  const again = mod.paintTrend('week');
  pending['/record/trend?type=week']([{ label: '第39周', minutes: 120 }]);
  await again;
  judge('只点一次：照常画', host.innerHTML.includes('第39周'), host.innerHTML.slice(0, 200));

  const a = mod.latestOnly('x');
  const b = mod.latestOnly('y');
  judge('不同的键互不影响', a() && b());
  const c = mod.latestOnly('x');
  judge('同一个键：新的一次作废旧的', !a() && c());

  if (fail) { console.log(fail + ' 条红'); process.exit(1); }
  console.log('ALL-GREEN');
})();
