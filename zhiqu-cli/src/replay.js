// /resume 之后把那段会话之前的聊天记录原样显示出来（2026-09-25 用户要的）。
//
// 原来 /resume 只说一句「接着这段会话（N 条记录）」，模型那边有上下文，用户这边屏幕是空的 ——
// 不记得上次聊到哪、改了哪些文件，只能凭印象接着说。
//
// 显示的是原话（SessionStore.transcript），不是发给模型的那一份：压缩过的话，模型只看得到摘要，
// 但用户翻回去要看的是当时说了什么。每一步的写法和当时一样（⏺ 做了什么、⎿ 结果的第一行），
// 不是用户打的 user 消息（goal 模式推的下一轮、命令行补的说明）不显示成「› …」。
import { describeCall, parseArgs } from './agent.js';
import { generatedOrigin } from './origins.js';

const RESULT_CHARS = 120;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return content == null ? '' : String(content);
}

function firstLine(text) {
  const line = text.split('\n').find((l) => l.trim()) || '';
  return line.length > RESULT_CHARS ? `${line.slice(0, RESULT_CHARS)}…` : line;
}

function originOf(entry) {
  if (entry.origin) return entry.origin;
  // 没有 origin 标记的旧记录：靠命令行自己写的那几句固定开头认
  return generatedOrigin(textOf(entry.message.content));
}

/** 把 transcript() 的条目画出来。返回画了几条用户消息（没有就说没有）。 */
export function replayTranscript(ui, entries) {
  const said = entries.filter((e) => e.kind === 'message');
  if (!said.length) {
    ui.note('· 这段会话还没有聊天记录');
    return 0;
  }
  ui.line(ui.paint.dim('── 之前的记录 ──'));
  let users = 0;
  for (const e of entries) {
    if (e.kind === 'compact') {
      ui.note('· （这里压缩过一次：之后模型看到的是上面这些的摘要，这里照样显示原话）');
      continue;
    }
    if (e.kind === 'mode') {
      ui.note(`· 档位切到 ${e.mode}`);
      continue;
    }
    const m = e.message;
    if (m.role === 'user') {
      const origin = originOf(e);
      if (origin === 'system') continue;
      const text = textOf(m.content);
      if (origin === 'goal') {
        ui.note(`· 🎯 ${firstLine(text)}`);
        continue;
      }
      users++;
      ui.line();
      ui.line(`${ui.paint.bold('›')} ${text}`);
      continue;
    }
    if (m.role === 'assistant') {
      const text = textOf(m.content);
      if (text.trim()) {
        const md = ui.markdown();
        md.feed(text.endsWith('\n') ? text : `${text}\n`);
        md.finish();
      }
      for (const call of m.tool_calls || []) {
        const name = call.function && call.function.name;
        const parsed = parseArgs(call.function && call.function.arguments);
        ui.step(describeCall(name, parsed.ok ? parsed.value : {}));
      }
      continue;
    }
    if (m.role === 'tool') ui.result(firstLine(textOf(m.content)));
  }
  ui.line(ui.paint.dim('── 以上是之前的记录 ──'));
  return users;
}
