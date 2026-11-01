#!/usr/bin/env node
// 网页 / 桌面应用的代码模式跑的就是命令行这一份循环（第九十四轮，用户 2026-11-02 定的「一份 JS，后端用子进程跑」）。
// 后端（Java 的 JsCodeAgent）起这个进程，stdin / stdout 一行一个 JSON：
//   后端 → 这里：run（开始）、event / error（模型调用的回音）、exec_result（命令跑完了）
//   这里 → 后端：model（请后端调一次模型）、exec（请后端跑一条命令）、step（轨迹里的一句）、result（收尾）、fatal（出错了）
// 门（是不是管理员、工作区档位、写意图、能不能执行）后端判好了才起这个进程；模型和命令都回到后端去做 —— 这里只有循环和工作区的读、草稿。
// 认不出的消息就停，不猜。
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
  let onRun = null;
  let closed = false;
  const send = (msg) => { if (!closed) output.write(`${JSON.stringify(msg)}\n`); };
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const fail = (message) => { send({ type: 'fatal', message }); closed = true; lines.close(); };
  lines.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { fail('收到的不是 JSON'); return; }
    if (msg.type === 'run' && onRun) { const f = onRun; onRun = null; f(msg); return; }
    const waiter = pending.get(msg.id);
    if (!waiter || !['event', 'error', 'exec_result'].includes(msg.type)) { fail(`认不出的消息：${String(msg.type).slice(0, 40)}`); return; }
    waiter(msg);
  });
  lines.on('close', () => { for (const w of pending.values()) w({ type: 'error', message: '后端关掉了连接', retryable: false }); pending.clear(); });
  return {
    send,
    fail,
    nextRun: () => new Promise((resolve) => { onRun = resolve; }),
    /** 和 Api.stream 一样的样子：事件一个个交给 onEvent，done 之后返回；出错抛 ApiError（循环据此决定重不重试） */
    stream(pathname, body, onEvent, { signal } = {}) {
      const id = `m${++seq}`;
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        const abort = () => { pending.delete(id); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        if (signal) signal.addEventListener('abort', abort, { once: true });
        let output = false;
        pending.set(id, (msg) => {
          if (msg.type === 'error') {
            pending.delete(id); if (signal) signal.removeEventListener('abort', abort);
            reject(new ApiError(msg.message || '模型调用失败', { retryable: Boolean(msg.retryable), beforeOutput: !output, status: msg.status || 0 }));
            return;
          }
          if (msg.name === 'delta' || msg.name === 'tool_call') output = true;
          onEvent(msg.name, msg.data || {});
          if (msg.name === 'done') { pending.delete(id); if (signal) signal.removeEventListener('abort', abort); resolve(); }
        });
        send({ type: 'model', id, body });
      });
    },
    exec(request, { signal } = {}) {
      const id = `x${++seq}`;
      return new Promise((resolve) => {
        const abort = () => { pending.delete(id); resolve({ error: '已中断，没有运行完' }); };
        if (signal) signal.addEventListener('abort', abort, { once: true });
        pending.set(id, (msg) => {
          pending.delete(id); if (signal) signal.removeEventListener('abort', abort);
          resolve(msg.type === 'error' ? { error: msg.message || '没有运行' } : msg);
        });
        send({ type: 'exec', id, ...request });
      });
    },
  };
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
    post: async () => { throw new ApiError('这里没有远程工具', { retryable: false }); },
    get: async () => { throw new ApiError('这里没有远程接口', { retryable: false }); } };
  const ctx = {
    api, ui, root: local.root, mode: 'auto', maxRounds: Math.max(1, Math.min(60, Number(run.maxRounds) || 30)), local,
    store: null, session: { id: 'web-code-agent' }, archiveDisabled: true,
    messages: (Array.isArray(run.history) ? run.history : []).filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content })),
    allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() }, usage: { prompt: 0, completion: 0, cached: 0 },
    changedFiles: new Set(), todos: [], system: { text: BUILTIN_SYSTEM_PROMPT }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    verbose: true, model: run.model,
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
