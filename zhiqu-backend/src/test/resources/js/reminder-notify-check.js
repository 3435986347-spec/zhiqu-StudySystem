// 页面里的提醒（第二十五轮）：该提醒的有哪些 —— 直接跑 assets/zhiqu-api.js 里发布的 dueReminders（和它用到的 serverTime）。
//   用法：node src/test/resources/js/reminder-notify-check.js <zhiqu-api.js 的路径>；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker), b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('抠不到 ' + startMarker);
  return src.slice(a, b);
}
const serverTimeSrc = grab('  function serverTime(s) {', '  /** 日历日加减天数');
const dueSrc = grab('  var REMIND_LATE_MS = ', '  function reminderText(r) {');
const clock = { offsetMinutes: 480 };   // 业务时区东八区
const dueReminders = new Function('clock', serverTimeSrc + dueSrc + '\nreturn dueReminders;')(clock);

// 此刻 = 2026-10-04 09:00:00（东八区钟面）
const now = Date.UTC(2026, 9, 4, 1, 0, 0);
const list = [
  { id: 1, scheduledAt: '2026-10-04T09:00:00', title: '正好到点' },
  { id: 2, scheduledAt: '2026-10-04T09:00:30', title: '还没到' },
  { id: 3, scheduledAt: '2026-10-04T08:46:00', title: '过去 14 分钟' },
  { id: 4, scheduledAt: '2026-10-04T08:44:00', title: '过去 16 分钟' },
  { id: 5, scheduledAt: '2026-10-04T08:59:00', title: '提醒过了' },
  { id: 6, scheduledAt: 'garbage', title: '时间坏了' },
  { id: null, scheduledAt: '2026-10-04T08:59:00', title: '没有 id' }
];
let fail = 0;
function judge(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + '  →  ' + g + '（应为 ' + w + '）'); fail++; }
}
const got = dueReminders(list, now, { 5: now - 1000 }).map(r => r.id);
judge('到点的、刚过去不到 15 分钟的才提醒；没到的、太久的、提醒过的、时间坏的、没 id 的不提醒', got, [1, 3]);
judge('按业务时区理解钟面：浏览器在别的时区也一样', dueReminders([{ id: 9, scheduledAt: '2026-10-04T09:00:00' }], Date.UTC(2026, 9, 4, 0, 59, 59), {}).length, 0);
judge('空列表', dueReminders([], now, {}), []);
judge('没有 seen 也能用', dueReminders([{ id: 7, scheduledAt: '2026-10-04T08:59:00' }], now, null).map(r => r.id), [7]);
// ── 发提醒走哪条路：桌面应用里走外壳的桥（WKWebView 里网页的 Notification 授权一请求就是「拒绝」），浏览器里走网页通知 ──
const notifySrc = grab('  function desktopBridge() {', '  /**\n   * 该提醒的有哪些');
function world(withBridge, permission) {
  const posted = [], made = [], toasts = [];
  let asked = 0;
  function Notification(title, opts) { made.push(title + '|' + (opts && opts.body)); }
  Notification.permission = permission;
  Notification.requestPermission = () => { asked++; };
  const window = { Notification };
  if (withBridge) window.webkit = { messageHandlers: { zqNotify: { postMessage: m => posted.push(m) } } };
  const fns = new Function('window', 'Notification', 'chime', 'toast', notifySrc + '\nreturn { pageNotify, askNotifyPermission };')(
    window, Notification, () => {}, t => toasts.push(t));
  return { fns, posted, made, toasts, asked: () => asked };
}
const desk = world(true, 'denied');
desk.fns.pageNotify('任务提醒', '发周报', 'zq-reminder-7');
desk.fns.askNotifyPermission();
judge('桌面应用：通知走桥', desk.posted, [{ action: 'notify', title: '任务提醒', body: '发周报', tag: 'zq-reminder-7' }, { action: 'authorize' }]);
judge('桌面应用：不去碰网页通知（那边授权必被拒）', [desk.made.length, desk.asked()], [0, 0]);
judge('桌面应用：页面里照样提示一句', desk.toasts, ['任务提醒：发周报']);
const web = world(false, 'granted');
web.fns.pageNotify('专注结束', '休息一下');
judge('浏览器、授权过：弹网页通知', web.made, ['专注结束|休息一下']);
const webAsk = world(false, 'default');
webAsk.fns.askNotifyPermission();
webAsk.fns.pageNotify('专注结束', '休息一下');
judge('浏览器、还没授权：点击时问一次，没授权前不弹', [webAsk.asked(), webAsk.made.length, webAsk.toasts.length], [1, 0, 1]);

if (fail) { console.log(fail + ' 条红'); process.exit(1); }
console.log('ALL-GREEN');
