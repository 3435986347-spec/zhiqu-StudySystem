// 干活中途补充（docs/steer-plan.md，第一百五十轮起）。
//
// 一轮回答里本来就有「缝」：一次模型调用说完、一批工具跑完。原来这些缝上谁都不看 —— 用户中途说的话进了排队，
// 等整轮结束才作为下一句发出去。现在一轮配一个收件箱：入口（命令行的回车、宿主收到的 say）往里放，
// 循环每走到一条缝把它倒进上下文（一条标明「中途补充」的 user 消息），模型下一次调用就看得到。
//
// 只追加一条 user 消息，前面的历史一个字不改（缓存，第一百零四轮）；插在整批工具结果之后（OpenAI 要求 tool_calls 后面紧跟每一条结果）。

/** 一句的上限：这是补充，不是再发一篇文章（和网页 /say 的上限一致） */
export const STEER_CHARS = 4000;
/** 一次倒进去的合计上限 */
export const STEER_BATCH_CHARS = 8000;

/**
 * 补充那条消息的开头。不标的话模型会把它当成一个新问题、丢下做到一半的活（第一百三十三轮最终写作那段同样的理由）。
 * replay / session 靠这句开头认出「这是中途补充」（老记录、没带 origin 的也认得）。
 */
export const STEER_LEAD = '（用户在你干活的过程中补充了下面的话。它比原来的要求新：有冲突以它为准，不冲突就一并做到。'
  + '做到一半的事先想清楚还要不要接着做，不要从头再来。）';

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n…（后面的截掉了，原话太长）` : text);

/**
 * 一轮的收件箱。
 *   push(text)：入口放话；箱子关了（这一轮在收尾）或者是空话就返回 false —— 入口把它变成下一轮的第一句
 *   take()：循环在缝上取走全部
 *   close()：这一轮收尾，返回没取走的原话（交回入口）
 */
export class Inbox {
  constructor() {
    this.items = [];
    this.closed = false;
  }

  push(text) {
    const said = String(text ?? '').trim();
    if (this.closed || !said) return false;
    this.items.push(said);
    return true;
  }

  size() { return this.items.length; }

  take() { return this.items.splice(0); }

  close() {
    this.closed = true;
    return this.items.splice(0);
  }
}

/** 几句合成一条消息的正文 */
export function steerMessage(items) {
  const parts = [];
  let left = STEER_BATCH_CHARS;
  for (const raw of items) {
    if (left <= 0) { parts.push('…（后面还有几句，太长截掉了）'); break; }
    const text = clip(clip(raw, STEER_CHARS), left);
    left -= text.length;
    parts.push(text);
  }
  return `${STEER_LEAD}\n\n${parts.join('\n\n')}`;
}

/** 一条记录里的 user 消息是不是中途补充（去掉开头那句，给回放 / 显示用） */
export function steerText(content) {
  const text = String(content ?? '');
  return text.startsWith(STEER_LEAD) ? text.slice(STEER_LEAD.length).trim() : null;
}
