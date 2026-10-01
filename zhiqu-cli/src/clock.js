// 量「过了多久」用单调时钟，不用 Date.now()（第二十一轮）。系统时钟会跳 —— 校时、手动改时间、休眠醒来后同步：
// 往回跳一小时，「思考中」显示 -3600s、搜索的 5 秒预算永远到不了；往前跳，搜索、等登录、等桌面应用一下子就「超时」了。
// Date.now() 只留给要和别处对得上的地方：写进记录的时刻、和文件的修改时间比。
import { performance } from 'node:perf_hooks';

export function monotonic() {
  return performance.now();
}
