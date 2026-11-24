// 进程没正常结束时记下原因（第一百七十一轮，docs/agent-efficiency-plan.md 第 6 步）。
//
// 用户那段会话里进程两次中途没了（11-23 12:21、12:38），什么都没记：下次启动只能说「进程中途没了」，
// 用户把 4087 字的终端输出整段贴进来，只为了说「继续这个」。
// - 接得住的（未捕获的异常、终端被关 SIGHUP、被结束 SIGTERM）：同步往会话记录里写一行 { type: 'exit', … } 再退；
// - 接不住的（SIGKILL、内存不够被系统杀掉）：平时每记一次用量顺带记一下内存（usage 行的 rss），下次至少说得出最后的内存占用；
// - 下次启动时把原因说出来，直接回车就接着那一段（cli.js 的 noteUnfinished / repl）。
import fs from 'node:fs';

const SIGNAL_CODES = { SIGHUP: 1, SIGTERM: 15 };
export const rssMb = () => Math.round(process.memoryUsage().rss / 1_048_576);

/** 记一行退出原因（同步写：信号处理和异常处理里不能等） */
export function recordExit(ctx, info) {
  if (!ctx || !ctx.store || !ctx.session || String(ctx.session.id).startsWith('ephemeral-')) return;
  try {
    ctx.store.append(ctx.session.id, { type: 'exit', ...info, rss: rssMb(), working: Boolean(ctx.working), lastTool: ctx.lastTool || null });
  } catch { /* 写不了也得退 */ }
}

/**
 * 装上：返回卸下的函数。exit(code) 可注入（测试）；onError 在记完之后把错误照旧打出来。
 * 不管 SIGINT：Ctrl+C 由界面自己处理（打断这一轮），不是进程没了。
 */
export function installExitRecorder(ctx, { exit = (code) => process.exit(code), onError = (e) => { process.stderr.write(`${e && e.stack ? e.stack : e}\n`); } } = {}) {
  const onSignal = (signal) => {
    recordExit(ctx, { reason: 'signal', signal });
    exit(128 + (SIGNAL_CODES[signal] || 0));
  };
  const onException = (e) => {
    recordExit(ctx, { reason: 'error', error: String(e && e.message ? e.message : e).slice(0, 500) });
    onError(e);
    exit(1);
  };
  const handlers = Object.keys(SIGNAL_CODES).map((s) => [s, () => onSignal(s)]);
  for (const [s, h] of handlers) process.on(s, h);
  process.on('uncaughtException', onException);
  const uninstall = () => {
    for (const [s, h] of handlers) process.off(s, h);
    process.off('uncaughtException', onException);
  };
  // 测试直接调：node 的测试运行器自己也听 uncaughtException，emit 一个会把测试本身弄挂
  uninstall.handlers = { signal: onSignal, exception: onException };
  return uninstall;
}

const TAIL_BYTES = 256 * 1024;
/** 一段会话最后的退出记录和最后记下的内存（只读文件末尾一截：记录可能几十 MB） */
export function lastExit(file) {
  let buf;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, TAIL_BYTES);
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
    } finally { fs.closeSync(fd); }
  } catch { return { exit: null, rss: null }; }
  let exit = null;
  let rss = null;
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.includes('"type":"exit"') && !line.includes('"type":"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }   // 第一行可能是半行
    if (e.type === 'exit') exit = e;
    if (Number.isFinite(e.rss)) rss = e.rss;
  }
  return { exit, rss };
}

/** 给人看的原因 */
export function exitReason({ exit, rss }) {
  const mem = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`);
  if (exit && exit.reason === 'signal') {
    const what = exit.signal === 'SIGHUP' ? '终端被关掉了（SIGHUP）' : exit.signal === 'SIGTERM' ? '进程被结束了（SIGTERM）' : `收到 ${exit.signal}`;
    return `${what}${exit.working ? `，当时正在干活${exit.lastTool ? `（最后一个工具 ${exit.lastTool}）` : ''}` : ''}`;
  }
  if (exit && exit.reason === 'error') return `命令行内部出错：${exit.error}${exit.lastTool ? `（最后一个工具 ${exit.lastTool}）` : ''}`;
  return `没来得及记下原因（可能是被强行杀掉，或者内存不够被系统结束${rss ? `；最后记下的内存占用 ${mem(rss)}` : ''}）`;
}
