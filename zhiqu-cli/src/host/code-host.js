#!/usr/bin/env node
// 网页 / 桌面应用的代码模式跑的就是命令行这一份循环（第九十四轮，用户 2026-11-02 定的「一份 JS，后端用子进程跑」）。
// 后端（Java 的 JsCodeAgent）起这个进程，stdin / stdout 一行一个 JSON：
//   后端 → 这里：run（开始）、event / error（模型调用的回音）、exec_result（命令跑完了）、tool_result（远程工具的结果）
//   这里 → 后端：model（请后端调一次模型）、exec（请后端跑一条命令）、tool（请后端执行一个 Wiki / 里程碑工具，第九十五轮）、
//                step（轨迹里的一句）、result（收尾）、fatal（出错了）
// 门（是不是管理员、工作区档位、写意图、能不能执行）后端判好了才起这个进程；模型和命令都回到后端去做 —— 这里只有循环和工作区的读、草稿。
// 认不出的消息就停，不猜。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { ApiError } from '../api.js';
import { runTurn } from '../agent.js';
import { BUILTIN_SYSTEM_PROMPT } from '../prompt.js';
import { DraftTools } from '../tools/drafts.js';
import { Ui } from '../ui.js';

/** 一行一个 JSON 的两头。send 写给后端；pending 等后端回音 */
export function createBridge({ input, output }) {
  let seq = 0;
  const pending = new Map();
  // 已经收尾的请求（中断了、出错了、done 了）：后端在半路的回音还可能到 —— 认得、丢掉，不当成「认不出的消息」停下（第九十九轮 review）
  const retired = new Set();
  let onRun = null;
  let closed = false;
  const send = (msg) => { if (!closed) output.write(`${JSON.stringify(msg)}\n`); };
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const fail = (message) => { send({ type: 'fatal', message }); closed = true; lines.close(); };
  lines.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { fail('收到的不是 JSON'); return; }
    if (msg.type === 'run' && onRun) { const f = onRun; onRun = null; f(msg); return; }
    if (retired.has(msg.id) && ['event', 'error', 'exec_result', 'tool_result'].includes(msg.type)) return;
    const waiter = pending.get(msg.id);
    if (!waiter || !['event', 'error', 'exec_result', 'tool_result'].includes(msg.type)) { fail(`认不出的消息：${String(msg.type).slice(0, 40)}`); return; }
    waiter(msg);
  });
  lines.on('close', () => { for (const w of pending.values()) w({ type: 'error', message: '后端关掉了连接', retryable: false }); pending.clear(); });
  const retire = (id) => { pending.delete(id); retired.add(id); };
  return {
    send,
    fail,
    nextRun: () => new Promise((resolve) => { onRun = resolve; }),
    /** 和 Api.stream 一样的样子：事件一个个交给 onEvent，done 之后返回；出错抛 ApiError（循环据此决定重不重试） */
    stream(pathname, body, onEvent, { signal } = {}) {
      const id = `m${++seq}`;
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        const abort = () => { retire(id); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        if (signal) signal.addEventListener('abort', abort, { once: true });
        let output = false;
        pending.set(id, (msg) => {
          if (msg.type === 'error') {
            retire(id); if (signal) signal.removeEventListener('abort', abort);
            reject(new ApiError(msg.message || '模型调用失败', { retryable: Boolean(msg.retryable), beforeOutput: !output, status: msg.status || 0 }));
            return;
          }
          if (msg.name === 'delta' || msg.name === 'tool_call') output = true;
          onEvent(msg.name, msg.data || {});
          if (msg.name === 'done') { retire(id); if (signal) signal.removeEventListener('abort', abort); resolve(); }
        });
        send({ type: 'model', id, body });
      });
    },
    /** 远程工具（Wiki、里程碑计划）：后端照它自己那一套执行，回 { content } */
    tool(name, args, { signal } = {}) {
      const id = `t${++seq}`;
      return new Promise((resolve, reject) => {
        const abort = () => { retire(id); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        if (signal) signal.addEventListener('abort', abort, { once: true });
        pending.set(id, (msg) => {
          retire(id); if (signal) signal.removeEventListener('abort', abort);
          if (msg.type === 'error') reject(new ApiError(msg.message || '远程工具调用失败', { retryable: false }));
          else resolve({ content: String(msg.content ?? '') });
        });
        send({ type: 'tool', id, name, arguments: args });
      });
    },
    exec(request, { signal } = {}) {
      const id = `x${++seq}`;
      return new Promise((resolve) => {
        const abort = () => { retire(id); resolve({ error: '已中断，没有运行完' }); };
        if (signal) signal.addEventListener('abort', abort, { once: true });
        pending.set(id, (msg) => {
          retire(id); if (signal) signal.removeEventListener('abort', abort);
          resolve(msg.type === 'error' ? { error: msg.message || '没有运行' } : msg);
        });
        send({ type: 'exec', id, ...request });
      });
    },
  };
}

/** 「生成了 / 写好了……草稿」「草稿已经生成」这类说法 */
export const CLAIMS_DRAFT = /(生成|写好|写成|写进|创建|建好|准备好|改好)[^。\n]{0,16}草稿|草稿[^。\n]{0,8}已经?(生成|写好|准备好|建好)/;

/** 「退出码 0」「跑了 test.py」「输出：」这类说跑过命令的说法 */
// 「预期输出：」「应该输出：」是教用户怎么验，不是说跑过了（第九十九轮 review）
export const CLAIMS_RUN = /退出码\s*-?\d|(跑|运行)(了|过了|的是)[^。\n]{0,24}(test|测试|\.py|\.js|\.java)|(?<!预期|应该|应当|会)输出(是|为)?[:：]/;

/**
 * 前面的对话（第九十五轮）：网页给的只有每一轮的问和最终回答 —— 原样当成一问一答放进去，模型学的是「不调工具直接答」，
 * 两回照着上一次的结果编了这一次的（0 轮）。命令行的历史里有真的工具调用，没有这个问题。所以合成一段带标注的参考，不当成示范。
 */
export function historyBlock(history) {
  const turns = (Array.isArray(history) ? history : []).filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim());
  if (!turns.length) return [];
  const text = turns.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.trim()}`).join('\n\n');
  return [{ role: 'user', content: `【前面的对话，供参考 —— 里面说到的文件内容、命令结果都是当时的，文件可能已经变了；这一次要的结果用工具重新查、重新跑，不要照抄】\n${text}` },
    { role: 'assistant', content: '好的，前面的对话我当参考；这一次要的结果我用工具重新查。' }];
}

/** 跑一轮：run 消息 → 循环 → result。返回 result（测试直接调） */
export async function runHosted(bridge, run) {
  const local = new DraftTools({ root: run.root, exec: (req, opts) => bridge.exec(req, opts),
    canWrite: Boolean(run.canWrite), canExec: Boolean(run.canExec), commands: Array.isArray(run.commands) ? run.commands.map(String) : [] });
  let transcript = '';
  const ui = new Ui({ input: new PassThrough(), output: new Writable({ write(c, e, cb) { transcript += c; cb(); } }), interactive: false, color: false });
  // 轨迹：每一步（读了什么、改了什么、跑了什么）交给后端，网页的「执行轨迹」照命令行的说法显示
  const step = ui.step.bind(ui);
  ui.step = (text) => { bridge.send({ type: 'step', text: String(text) }); return step(text); };
  const api = { stream: (p, body, onEvent, opts) => bridge.stream(p, body, onEvent, opts),
    post: async (p, body, opts) => {
      if (p !== '/api/harness/tools/call') throw new ApiError('这里没有这个远程接口', { retryable: false });
      return bridge.tool(body.name, body.arguments, opts);
    },
    get: async () => { throw new ApiError('这里没有远程接口', { retryable: false }); } };
  const ctx = {
    api, ui, root: local.root, mode: 'auto', maxRounds: Math.max(1, Math.min(60, Number(run.maxRounds) || 30)), local,
    store: null, session: { id: 'web-code-agent' }, archiveDisabled: true,
    messages: historyBlock(run.history),
    allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() }, usage: { prompt: 0, completion: 0, cached: 0 },
    changedFiles: new Set(), todos: [], system: { text: BUILTIN_SYSTEM_PROMPT }, instructionsText: '', skillsText: '', skills: [],
    verbose: true, model: run.model,
  };
  // 远程工具（第九十五轮）：一直给的那几个 + 真的跑过一次命令之后才给的（create_wiki_patch：判过题才许记薄弱点）。工具表每一轮重建，所以随时变
  const always = Array.isArray(run.remoteTools) ? run.remoteTools : [];
  const afterRun = Array.isArray(run.remoteToolsAfterRun) ? run.remoteToolsAfterRun : [];
  Object.defineProperty(ctx, 'remoteTools', { get: () => (local.ranCommand ? [...always, ...afterRun] : always), enumerable: true });
  // 说的和这一次做的对不上 —— 推一次让它照实做 / 照实说（第九十五轮，真浏览器里两回：0 轮就说「已生成三个文件的草稿」；
  // 0 轮就说「跑了 test_two_sum.py，输出 ok，三组断言全过」—— 解法还是 return []，根本没跑）
  ctx.claimCheck = (text) => {
    const s = String(text || '');
    if (CLAIMS_DRAFT.test(s) && !local.drafts.size) {
      return '这一次你还没有成功调用 write_file / edit_file，并没有生成任何草稿 —— 不要说生成了。要改文件就现在调工具；不用改就照实说你做了什么。';
    }
    if (CLAIMS_RUN.test(s) && !local.ranCommand) {
      return '这一次你没有调用 run_command，什么命令都没跑过 —— 不要说跑了、结果是什么（前面对话里的结果是当时的，文件可能已经变了）。'
        + '要知道结果就现在调 run_command 跑；不跑就照实说没跑。';
    }
    return null;
  };
  const controller = new AbortController();
  const timer = run.timeoutMs ? setTimeout(() => controller.abort(), Number(run.timeoutMs)) : null;
  let error = null;
  try {
    await runTurn(ctx, String(run.message || ''), { signal: controller.signal });
  } catch (e) {
    error = String((e && e.message) || e);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const last = [...ctx.messages].reverse().find((m) => m.role === 'assistant' && !(m.tool_calls || []).length);
  const text = last ? String(last.content || '') : '';
  // 给后端写最终回答用的上下文：和 Java 循环同一个样子（每个工具的结果一段），最后是这份循环自己的结论
  const names = new Map();
  for (const m of ctx.messages) for (const c of m.role === 'assistant' ? m.tool_calls || [] : []) names.set(c.id, c.function.name);
  const context = [...ctx.messages.filter((m) => m.role === 'tool').map((m) => `【工作区 ${names.get(m.tool_call_id) || '工具'}】\n${m.content}`),
    text ? `【代码 agent 的结论】\n${text}` : ''].filter(Boolean).join('\n\n');
  // 调过几次写文件的工具（不管成没成）：后端据此决定最终回答能不能说「这一轮没写成」
  const writeCalls = ctx.messages.reduce((n, m) => n + (m.role === 'assistant' ? (m.tool_calls || []).filter((c) => ['write_file', 'edit_file'].includes(c.function.name)).length : 0), 0);
  return { type: 'result', text, context, drafts: local.draftList(), writeCalls, usage: ctx.usage,
    rounds: ctx.messages.filter((m) => m.role === 'assistant' && (m.tool_calls || []).length).length,
    aborted: controller.signal.aborted, error };
}

async function main() {
  const bridge = createBridge({ input: process.stdin, output: process.stdout });
  const run = await bridge.nextRun();
  let last;
  try {
    last = await runHosted(bridge, run);
  } catch (e) {
    last = { type: 'fatal', message: String((e && e.message) || e) };
  }
  // 管道上的 stdout 是异步的：写完最后一行再退出，不然后端可能收不到 result
  process.stdout.write(`${JSON.stringify(last)}\n`, () => process.exit(0));
}

// 比真实路径（第九十六轮）：import.meta.url 是解过软链的，argv[1] 不是 —— macOS 的临时目录 /var 是 /private/var 的软链，
// 后端把 JAR 里带的源码解到那里，原来两边对不上、main() 不跑，进程一声不响就退了
const realPath = (p) => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
if (process.argv[1] && realPath(fileURLToPath(import.meta.url)) === realPath(process.argv[1])) main();
