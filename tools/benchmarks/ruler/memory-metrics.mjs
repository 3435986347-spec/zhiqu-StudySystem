// 尺子第三版的量法（第一百四十四轮，docs/memory-plan.md 第 8 步）：从一段会话记录（.zhiqu/sessions/<id>.jsonl 的事件）里算
// 压缩后几步才动手、重复读取占多少、清单是不是只进不退、命中率、花费。纯函数，不调模型 —— 判据直接喂造出来的事件。
//
// 口径：
//   - 「一步」= 一次带工具调用的模型回答（assistant 且有 tool_calls）。
//   - 「动手」= 调了写类工具（write_file / edit_file / apply_patch / delete_file）或者跑了命令（shell / run_command）。
//   - 压缩后几步才动手：每次压缩（compact 事件里真的写了摘要的那种）之后，到第一次动手隔了几步；之后再也没动手的记 null。
//   - 重复读取：同一个文件同一段（path + offset + limit）在上一次写它之后又读了一遍。占全部读取的比例。
//   - 清单倒退：某一项标过 completed，后来的清单里它又不是 completed（或不见了、又以 pending 回来）。
//   - 命中率：usage 事件里 cached / prompt（没报 cached 的那几次不算进分母）。
//   - 花费：按每百万 token 的价（命中 / 未命中 / 输出）算，价钱由调用方给。

export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'delete_file']);
export const RUN_TOOLS = new Set(['shell', 'run_command']);
const READ_TOOL = 'read_file';

const argsOf = (call) => {
  try { return JSON.parse(call.function && call.function.arguments || '{}') || {}; } catch { return {}; }
};

/** apply_patch 改到的文件（*** Update File: / *** Add File: / *** Delete File:） */
function patchedFiles(args) {
  const out = [];
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  let m;
  while ((m = re.exec(String(args.patch || args.input || '')))) out.push(m[1].trim());
  return out;
}

const norm = (p) => String(p || '').replace(/^\.\//, '');

export function sessionMetrics(events, { price = null } = {}) {
  let steps = 0;
  let pendingCompactAt = null;
  const stepsToAct = [];
  let reads = 0;
  let repeated = 0;
  const seen = new Map();          // path -> Set(区段)；写一次就清掉这个文件的
  let compactions = 0;
  const done = new Set();
  let regressions = 0;
  const regressed = [];
  let prompt = 0; let cachedBase = 0; let cached = 0; let completion = 0; let calls = 0;

  for (const e of events) {
    if (e.type === 'compact') {
      // 真的写了摘要的才算（只清理不摘要的那种 before/after 也在，但消息里没有摘要那条）
      const summarized = Array.isArray(e.messages) && e.messages.some((m) => typeof m.content === 'string' && /^【之前对话的摘要/.test(m.content));
      if (summarized) {
        compactions++;
        if (pendingCompactAt != null) stepsToAct.push(null);
        pendingCompactAt = steps;
      }
    } else if (e.type === 'usage') {
      calls++;
      prompt += e.prompt || 0;
      completion += e.completion || 0;
      if (e.cached != null) { cachedBase += e.prompt || 0; cached += e.cached; }
    } else if (e.type === 'todos' && Array.isArray(e.todos)) {
      const now = new Map(e.todos.map((t) => [String(t.content || '').trim(), t.status]));
      for (const item of done) {
        if (now.get(item) !== 'completed') { regressions++; regressed.push(item); done.delete(item); }
      }
      for (const [item, status] of now) if (status === 'completed') done.add(item);
    } else if (e.type === 'message' && e.message && e.message.role === 'assistant' && (e.message.tool_calls || []).length) {
      steps++;
      let acted = false;
      for (const call of e.message.tool_calls) {
        const name = call.function && call.function.name;
        const args = argsOf(call);
        if (WRITE_TOOLS.has(name)) {
          acted = true;
          const files = name === 'apply_patch' ? patchedFiles(args) : [norm(args.path)];
          for (const f of files) seen.delete(norm(f));
        } else if (RUN_TOOLS.has(name)) {
          acted = true;
        } else if (name === READ_TOOL) {
          reads++;
          const p = norm(args.path);
          const span = `${args.offset ?? 1}:${args.limit ?? ''}`;
          const spans = seen.get(p) || new Set();
          if (spans.has(span)) repeated++;
          spans.add(span);
          seen.set(p, spans);
        }
      }
      if (acted && pendingCompactAt != null) { stepsToAct.push(steps - pendingCompactAt); pendingCompactAt = null; }
    }
  }
  if (pendingCompactAt != null) stepsToAct.push(null);
  const cost = price ? (cached * price.hit + (prompt - cached) * price.miss + completion * price.output) / 1e6 : null;
  return {
    steps, compactions, stepsToAct,
    reads, repeatedReads: repeated, repeatedShare: reads ? repeated / reads : 0,
    todoRegressions: regressions, regressed,
    calls, prompt, completion, cached, hitRate: cachedBase ? cached / cachedBase : null,
    cost,
  };
}

/** 一组跑出来的指标合成一行（中位数、通过率），给报告用 */
export function summarize(rows) {
  const median = (xs) => {
    const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const acts = rows.flatMap((r) => (r.metrics ? r.metrics.stepsToAct : []));
  return {
    runs: rows.length,
    passRate: rows.length ? rows.filter((r) => r.pass).length / rows.length : 0,
    compactions: rows.reduce((n, r) => n + (r.metrics ? r.metrics.compactions : 0), 0),
    medianStepsToAct: median(acts),
    neverActedAfterCompaction: acts.filter((x) => x == null).length,
    repeatedShare: median(rows.map((r) => r.metrics && r.metrics.repeatedShare)),
    todoRegressions: rows.reduce((n, r) => n + (r.metrics ? r.metrics.todoRegressions : 0), 0),
    hitRate: median(rows.map((r) => r.metrics && r.metrics.hitRate)),
    cost: rows.reduce((n, r) => n + (r.metrics && r.metrics.cost || 0), 0),
  };
}
