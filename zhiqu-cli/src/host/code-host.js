#!/usr/bin/env node
// 网页 / 桌面应用的代码模式跑的就是命令行这一份循环（第九十四轮，用户 2026-11-02 定的「一份 JS，后端用子进程跑」）。
// 后端（Java 的 JsCodeAgent）起这个进程，stdin / stdout 一行一个 JSON：
//   后端 → 这里：run（开始）、event / error（模型调用的回音）、exec_result（命令跑完了）、tool_result（远程工具的结果）
//   这里 → 后端：model（请后端调一次模型）、exec（请后端跑一条命令）、tool（请后端执行一个 Wiki / 里程碑工具，第九十五轮）、
//                step（轨迹里的一句）、trace（回答里按顺序列出的一步，第一百二十七轮，形状见 steps.js）、result（收尾）、fatal（出错了）
// 门（是不是管理员、工作区档位、写意图、能不能执行）后端判好了才起这个进程；模型和命令都回到后端去做 —— 这里只有循环和工作区的读、草稿。
// 认不出的消息就停，不猜。
import { normalizeEffort } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { ApiError } from '../api.js';
import { runTurn } from '../agent.js';
import { initPrompt } from '../instructions.js';
import { StepLog } from '../steps.js';
import { BUILTIN_SYSTEM_PROMPT } from '../prompt.js';
import { collectChanges, nothingReport, parseReviewWords, renderReport, reviewSpec, runReview } from '../review.js';
import { detectSandbox } from '../tools/sandbox.js';
import { ArtifactTools, DraftTools } from '../tools/drafts.js';
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

/**
 * 「已写入文件」「新建了 `./计划.md`」这类说写了文件的说法（第一百二十一轮）。生成到产物时没有草稿，模型说的是这个，
 * 「……草稿」那条对不上：线上一次 0 个文件、回答却是「## 已写入文件」，连内容都编了。
 */
export const CLAIMS_FILE = /(已经?|成功)(写入|写好|写进|新建|创建|生成|保存)了?[^。\n]{0,20}(文件|\.[A-Za-z][A-Za-z0-9]{0,5}\b)|(写入|新建|创建|生成|保存)了\s*[`'"「]?[^\s。\n`'"」]{0,60}\.[A-Za-z][A-Za-z0-9]{0,5}\b|文件[^。\n]{0,8}已经?(写入|写好|写进|保存|生成|创建|建好)/;

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

/**
 * 网页输入框里的 /review（第一百一十八轮）：和命令行同一份 —— 取 diff 的 git 关在只读沙箱里、能叫起程序的配置都关掉，
 * 模型在单独的上下文里看，结论按格式核过。这里的 ctx.local.sandbox 只是「后端有沙箱」的记号，git 是这个进程自己跑的，要真的那一份。
 * 返回给用户看的结论。
 */
const STOPPED = '审查没做完（到时间了或者被中断了），没有结论。';
async function reviewHosted(ctx, message, signal, home) {
  const words = parseReviewWords(message.trim().split(/\s+/).filter(Boolean).slice(1));
  const spec = words.error ? words : reviewSpec(words);
  if (spec.error) return spec.error;
  const guard = ctx.local.guard;
  const changes = await collectChanges({ root: ctx.local.root, sandbox: detectSandbox(), readable: (f) => guard.extensionAllowed(f), target: spec.target, signal, home });
  if (changes.aborted) return STOPPED;
  if (changes.error) return changes.error;
  if (changes.nothing) return renderReport(nothingReport(changes));
  ctx.ui.step(`在看${changes.label}（${changes.files.length + changes.untracked.length} 个文件，只读）`);
  const r = await runReview(ctx, changes, { signal, instructions: spec.instructions });
  if (r.aborted) return STOPPED;
  return r.error || r.text;
}

/** 跑一轮：run 消息 → 循环 → result。返回 result（测试直接调） */
export async function runHosted(bridge, run) {
  const Tools = run.artifact ? ArtifactTools : DraftTools;   // 生成到产物：写进临时空间，不走草稿
  const local = new Tools({ root: run.root, exec: (req, opts) => bridge.exec(req, opts),
    canWrite: Boolean(run.canWrite), canExec: Boolean(run.canExec), canShell: Boolean(run.canShell), shellWrite: Boolean(run.shellWrite), hosted: Boolean(run.hosted),
    sandboxNetwork: typeof run.sandboxNetwork === 'string' ? run.sandboxNetwork : 'off', commands: Array.isArray(run.commands) ? run.commands.map(String) : [] });
  let transcript = '';
  const ui = new Ui({ input: new PassThrough(), output: new Writable({ write(c, e, cb) { transcript += c; cb(); } }), interactive: false, color: false });
  // 轨迹：每一步（读了什么、改了什么、跑了什么）交给后端，网页的「执行轨迹」照命令行的说法显示
  const step = ui.step.bind(ui);
  ui.step = (text) => { bridge.send({ type: 'step', text: String(text) }); return step(text); };
  // 回答里按顺序列出的每一步（第一百二十七轮，像 Codex）：开始一条、结束一条，形状见 steps.js
  const stepLog = new StepLog((s) => bridge.send({ type: 'trace', step: s }));
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
    verbose: true, model: run.model, stepLog,
    // 网页输入框下面选的思考档位（第一百零八轮）；明说，不听服务端给命令行的默认（第五十四轮：工具轮想起来，一问要等几分钟）
    effort: normalizeEffort(run.effort) || 'instant',
  };
  // 远程工具（第九十五轮）：一直给的那几个 + 真的跑过一次命令之后才给的（create_wiki_patch：判过题才许记薄弱点）。工具表每一轮重建，所以随时变
  const always = Array.isArray(run.remoteTools) ? run.remoteTools : [];
  const afterRun = Array.isArray(run.remoteToolsAfterRun) ? run.remoteToolsAfterRun : [];
  Object.defineProperty(ctx, 'remoteTools', { get: () => (local.ranCommand ? [...always, ...afterRun] : always), enumerable: true });
  // 说的和这一次做的对不上 —— 推一次让它照实做 / 照实说（第九十五轮，真浏览器里两回：0 轮就说「已生成三个文件的草稿」；
  // 0 轮就说「跑了 test_two_sum.py，输出 ok，三组断言全过」—— 解法还是 return []，根本没跑）
  // 审查的结论是 JSON，引用的代码里什么话都可能有：不拿它核对（命令行的 /review 也没有这一道）
  if (run.command !== 'review') ctx.claimCheck = (text) => {
    const s = String(text || '');
    if (CLAIMS_DRAFT.test(s) && !local.drafts.size && !(local.wrote && local.wrote.size)) {
      return '这一次你还没有成功调用 write_file / edit_file / apply_patch，并没有生成任何草稿 —— 不要说生成了。要改文件就现在调工具；不用改就照实说你做了什么。';
    }
    // 跑过命令的不判：auto 档的 shell 可能直接写了文件，这里看不出来 —— 宁可不推，不能错推
    const wroteAny = local.drafts.size || (local.wrote && local.wrote.size);   // 选了文件夹记在草稿里，生成到产物记在 wrote 里
    if (CLAIMS_FILE.test(s) && !wroteAny && !local.ranCommand) {
      return '这一次你一个文件都没有写（没有调用 write_file / edit_file / apply_patch，也没跑命令）—— 不要说写入了、新建了、生成了文件，也不要把文件内容编出来。'
        + '要写就现在调工具写；缺信息（写什么、叫什么名字）就照实问用户。';
    }
    if (CLAIMS_RUN.test(s) && !local.ranCommand) {
      const runTool = local.sandbox ? 'shell' : 'run_command';
      return `这一次你没有调用 ${runTool}，什么命令都没跑过 —— 不要说跑了、结果是什么（前面对话里的结果是当时的，文件可能已经变了）。`
        + `要知道结果就现在调 ${runTool} 跑；不跑就照实说没跑。`;
    }
    return null;
  };
  const controller = new AbortController();
  const timer = run.timeoutMs ? setTimeout(() => controller.abort(), Number(run.timeoutMs)) : null;
  let error = null;
  let reviewed = null;
  // /init、/review 要项目文件夹：页面已经拦过，这里是最后一道（生成到产物时根目录是临时空间，没什么可看、写了也没人读）
  const command = run.command === 'init' || run.command === 'review' ? run.command : null;
  const needsFolder = command && run.artifact;
  const before = ctx.messages.length;
  try {
    if (needsFolder) reviewed = `/${command} 要先选一个项目文件夹，现在是生成到产物，没有项目可看。`;
    else if (command === 'review') reviewed = await reviewHosted(ctx, String(run.message || ''), controller.signal, typeof run.home === 'string' ? run.home : undefined);
    else await runTurn(ctx, command === 'init' ? initPrompt(fs.existsSync(path.join(local.root, 'ZHIQU.md'))) : String(run.message || ''), { signal: controller.signal });
  } catch (e) {
    error = String((e && e.message) || e);
    // 审查的过程在单独的上下文里，这里没有别的字：不写一句，最终回答就只能照空的编
    if (command === 'review') reviewed = `审查没做完：${error}`;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const last = [...ctx.messages].reverse().find((m) => m.role === 'assistant' && !(m.tool_calls || []).length);
  const text = reviewed != null ? reviewed : last ? String(last.content || '') : '';
  // 给用户的回答（第一百二十一轮）：后端原样用它，不再另调一次模型重写 —— 重写的那一步照上一轮的选项编过「已写入文件」，其实一个都没写。
  // 只认这一次新说的、没出错没被打断的：历史那段后面跟着一句固定的「好的，前面的对话我当参考」，半路断了时 last 会是它（或者上一轮的旧回答）
  const own = [...ctx.messages.slice(before)].reverse().find((m) => m.role === 'assistant' && !(m.tool_calls || []).length);
  const conclusion = reviewed != null ? reviewed : !error && !controller.signal.aborted && own ? String(own.content || '').trim() : '';
  // 给后端写最终回答用的上下文：和 Java 循环同一个样子（每个工具的结果一段），最后是这份循环自己的结论
  const names = new Map();
  for (const m of ctx.messages) for (const c of m.role === 'assistant' ? m.tool_calls || [] : []) names.set(c.id, c.function.name);
  const context = [...ctx.messages.filter((m) => m.role === 'tool').map((m) => `【工作区 ${names.get(m.tool_call_id) || '工具'}】\n${m.content}`),
    text ? `【代码 agent 的结论】\n${text}` : ''].filter(Boolean).join('\n\n');
  // 调过几次写文件的工具（不管成没成）：后端据此决定最终回答能不能说「这一轮没写成」
  const writeCalls = ctx.messages.reduce((n, m) => n + (m.role === 'assistant' ? (m.tool_calls || []).filter((c) => ['write_file', 'edit_file', 'apply_patch'].includes(c.function.name)).length : 0), 0);
  return { type: 'result', text, conclusion, context, drafts: local.draftList(), writeCalls, usage: ctx.usage,
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
