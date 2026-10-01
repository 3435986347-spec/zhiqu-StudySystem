// 事件处理里没接住的失败要说出来（第十四轮）—— 直接跑 assets/zhiqu-api.js 里发布的 requestError 与 reportUnhandled。
//
//   用法：node src/test/resources/js/unhandled-check.js <zhiqu-api.js 的路径>
//   打印 ALL-GREEN 且退出码 0 = 全绿。由 UnhandledFailureTest 调用。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('抠不到起点: ' + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('抠不到终点: ' + endMark);
  return src.slice(a, b);
}
const code = slice('  function requestError(message, extra) {', '  function waitMs(')
  + slice('  function reportUnhandled(reason) {', "  window.addEventListener('unhandledrejection'");

const toasts = [];
let redirecting = false;
const env = { toast: (m, k) => toasts.push([m, k]), console: { error: () => {} } };
const mod = new Function('toast', 'console', 'isRedirecting',
  code.replace(/\bredirecting\b/g, 'isRedirecting()') + '\nreturn { requestError, reportUnhandled };')(env.toast, env.console, () => redirecting);

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}

toasts.length = 0;
const said = mod.reportUnhandled(mod.requestError("日期 / 时间「2026-02-30」格式不对，应当像 2026-09-28"));
judge('请求层的错误（服务器回的提示、断网）：原样说出来', said && toasts.length === 1 && toasts[0][0].includes('应当像 2026-09-28') && toasts[0][1] === 'error', JSON.stringify(toasts));

toasts.length = 0;
mod.reportUnhandled(new TypeError("Cannot read properties of null (reading 'value')"));
judge('代码里的错误：说「没有完成」，不把 TypeError 原文给用户', toasts.length === 1 && !/Cannot read/.test(toasts[0][0]) && /没有完成/.test(toasts[0][0]), JSON.stringify(toasts));

toasts.length = 0;
mod.reportUnhandled(Object.assign(new Error('aborted'), { name: 'AbortError' }));
judge('用户自己取消的（AbortError）：不吭声', toasts.length === 0, JSON.stringify(toasts));

toasts.length = 0;
redirecting = true;
mod.reportUnhandled(mod.requestError('未登录或无权限'));
redirecting = false;
judge('正在跳去登录页：不吭声', toasts.length === 0, JSON.stringify(toasts));

judge('请求层的错误都带 userFacing', mod.requestError('x').userFacing === true);

if (fail) { console.log(fail + ' 条红'); process.exit(1); }
console.log('ALL-GREEN');
