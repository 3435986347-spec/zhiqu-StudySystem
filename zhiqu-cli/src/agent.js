// 循环本身：一轮用户消息 → 模型 → 工具 → 模型 → … → 回答。循环与本地工具都在这台电脑上；模型经服务器网关。
//
// 三档权限（用户 2026-09-24 定的）：
//   plan  只读：只下发读 / 搜 / 查的工具，外加 exit_plan_mode —— 计划交上来，用户批准了才切到能写的档位；
//   ask   逐个确认：写文件先给 diff、跑命令先给命令行，问 y/n（a = 本会话都允许这一类）；
//   auto  全自动：写、跑都不问，做完再汇报（每一步照样显示，diff 照样打印）。
// 三档的安全规则一样（guard.js / execrules.js）—— auto 免的是「问」，不是「规则」。
//
// 「下发了什么」和「能执行什么」是同一份清单：每一轮先按档位算出工具表，分派前比对名字，
// 不在表里就拒 —— 模型（或者一段被注入了指令的工具输出）报一个没下发的名字，不会被执行。
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { hunks } from './render/diff.js';
import { formatBytes, termSafe } from './render/term.js';
import { localSchemas, READ_TOOLS, shellSchemas } from './tools/local.js';
import { patchFiles } from './tools/patch.js';
import { describeBoundary, READ_ONLY, WORKSPACE_WRITE } from './tools/sandbox.js';
import { loadSkill, loadSkillSchema } from './skills.js';
import { buildSystemMessage, environmentBlock, today } from './prompt.js';
import { compactMessages, needsCompaction, SUMMARY_INSTRUCTIONS } from './compact.js';
import { dropDanglingToolCalls } from './session.js';
import { ApiError } from './api.js';
import { sleep } from './http.js';
import { parseTodos, TODO_TOOL, todoBlock, todoLines, todoNudge, todoReply, todoSchema, unfinished } from './todos.js';
import { spillLongInput } from './longinput.js';
import { applyGoalUpdate, DEFAULT_MAX_GOAL_TURNS, GOAL_TOOL, goalBlock, goalSchema, MAX_VERIFY_FAILURES, parseVerdict, verificationMaterial, VERIFY_INSTRUCTIONS } from './goal.js';
import { monotonic } from './clock.js';

export const REMOTE_READ_TOOLS = new Set(['search_wiki', 'read_wiki_page', 'read_memory', 'list_tasks']);
/** 远程工具里**直接生效**的（不是草稿）：plan 档不给，ask 档先问（第二十九轮，用户定的「改状态直接做」）。 */
export const REMOTE_DIRECT_WRITE_TOOLS = new Set(['update_task_status']);

/*
 * 思考过程不展示（用户 2026-09-28）：默认只打印结论（不再调工具的那条回复）和改了什么（写 / 删 / 跑命令，写带 diff）。
 * 模型写在工具调用之间的字、读 / 搜 / 列目录这几步，只在状态行的「思考中」后面一闪（ui.startThinking）。
 * ctx.verbose（/verbose、配置 showThinking）切回全显示。
 */
export const QUIET_TOOLS = new Set([...READ_TOOLS, ...REMOTE_READ_TOOLS, 'load_skill', 'find_mcp_tool']);
const quiet = (ctx) => !ctx.verbose;

/**
 * 单条工具输出进上下文前的上限，随模型的窗口走（按字算；中文一字约一个 token）。
 * 由来：窗口 8000 的模型读一个 3 万字的文件，一轮就超了 —— 客户端压缩只能压「更早的轮」，
 * 服务器兜底裁剪又原样留着最近的工具输出，结果整个请求被供应商拒绝。
 */
export function toolOutputCap(window) {
  return Math.max(2_000, Math.min(100_000, Math.floor((window || 64_000) * 0.35)));
}

export function capToolOutput(text, window) {
  const cap = toolOutputCap(window);
  const s = String(text);
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…（这段输出有 ${s.length} 字，超过了这个模型一次能看的量，只给了前 ${cap} 字。`
    + '需要后面的内容就分段取：read_file 用 offset / limit，搜索缩小范围，命令输出重定向不了就换个更窄的命令）';
}
export const DEFAULT_MAX_TOKENS = 16_384;
const MAX_CONTINUATIONS = 2;

// 原地重复（第一百轮，第九十八轮评测 pytest-5840 第三遍）：模型在不调工具的回复里一遍遍写同一段，写满输出上限被截断，
// 循环当它「话没说完」—— 整段留进历史、叫它接着说，它就接着那段往下写，最后 6.8 万字的重复成了回答。
// 两样都要够：压缩比（zlib）≥ 12，而且六成以上的字是前面一字不差出现过的句子 / 行（≥ 16 字）。量过 ——
// 四轮评测 42 遍里长度 ≥ 1500 字的回复：压缩比最高 5.03、重复句最多 33.8%；那三段是 41–114 倍、84–97%。
// 只看压缩比不够：1200 行的表格压缩比 15、一句重复都没有；只看重复句也不够（同一句日志夹着各不相同的哈希）。只看被截断的、不调工具的回复。
export const LOOP_MIN_CHARS = 4_000;
export const LOOP_RATIO = 12;
export const LOOP_REPEATED_SHARE = 0.6;
const LOOP_KEEP_CHARS = 1_200;
export function repeating(text) {
  const s = String(text || '');
  if (s.length < LOOP_MIN_CHARS) return false;
  const b = Buffer.from(s, 'utf8');
  if (b.length / zlib.deflateSync(b).length < LOOP_RATIO) return false;
  const seen = new Set();
  let repeated = 0;
  for (const unit of s.split(/(?<=[\n。！？!?])|(?<=\.\s)/)) {
    const k = unit.trim();
    if (k.length < 16) continue;
    if (seen.has(k)) repeated += k.length; else seen.add(k);
  }
  return repeated / s.length >= LOOP_REPEATED_SHARE;
}
const loopTrimmed = (s) => `${s.slice(0, LOOP_KEEP_CHARS)}\n…（后面 ${s.length - LOOP_KEEP_CHARS} 字是同一段话的重复，已删掉）`;
const LOOP_NUDGE = '（你上一次的回答一直在重复同一段话，写满了单次输出上限，重复的部分已经删掉。不要再复述或回忆；'
  + '按已经读到的内容定下要做什么，直接调用工具去做 —— 拿不准就写一个最小的复现跑一下，用结果说话。）';

export function exitPlanSchema() {
  return {
    type: 'function',
    function: {
      name: 'exit_plan_mode',
      description: '把想好的计划交给用户（只在 plan 档可用）。用户批准后命令行会切到能写的档位，你接着按计划做。',
      parameters: { type: 'object', properties: { plan: { type: 'string', description: '计划，Markdown：要改哪些文件、每一步做什么、怎么验证' } }, required: ['plan'] },
    },
  };
}

// ── MCP 工具太多时按需给（第十八轮） ─────────────────────────────────────
//
// 接了几个 MCP 服务器、几百个工具，每一轮都把全部定义发给模型：300 个工具实测 15 万字 —— 64K 窗口的模型一半以上的地方
// 被工具定义占着，而且每一轮都占。超过窗口的一份（MCP_SCHEMA_SHARE，按一个 token 约 3 个字估）就不全发，
// 改给一个 find_mcp_tool：模型按关键字找，找到的那几个从下一次调用起连定义一起给。
export const MCP_SCHEMA_SHARE = 0.1;
const FIND_MCP_TOOL = 'find_mcp_tool';
const FIND_MCP_LIMIT = 8;

export function mcpOverBudget(ctx, schemas) {
  const window = ctx.model ? ctx.model.effectiveContextWindow || 64_000 : 64_000;
  return JSON.stringify(schemas).length > window * 3 * MCP_SCHEMA_SHARE;
}

export function findMcpSchema(count) {
  return {
    type: 'function',
    function: {
      name: FIND_MCP_TOOL,
      description: `按关键字找 MCP 工具（接了 ${count} 个，太多，不一次全给你）。找到的工具从下一步起就能直接调用。`
        + '要用外部系统（数据库、工单、日历、浏览器……）时先用它找；关键字用中文英文都行，可以给好几个词。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '要找的工具的关键字，比如「issue 创建」「calendar」' } }, required: ['query'] },
    },
  };
}

/** 按关键字给 MCP 工具打分：名字、说明里命中几个词。命中的放进 ctx.mcpActive。 */
export function findMcpTools(ctx, schemas, query) {
  const words = String(query || '').toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  if (!words.length) return { error: '没有给关键字' };
  const scored = schemas.map((t) => {
    const hay = `${t.function.name} ${t.function.description || ''}`.toLowerCase();
    return { t, score: words.filter((w) => hay.includes(w)).length };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, FIND_MCP_LIMIT);
  if (!scored.length) return { content: `没有找到和「${query}」相关的 MCP 工具（一共 ${schemas.length} 个）。换个关键字试试。`, summary: '0 个' };
  ctx.mcpActive = ctx.mcpActive || new Set();
  for (const { t } of scored) ctx.mcpActive.add(t.function.name);
  return {
    content: `找到 ${scored.length} 个，从下一步起可以直接调用：\n${scored.map(({ t }) => `- ${t.function.name}：${(t.function.description || '').slice(0, 160)}`).join('\n')}`,
    summary: `${scored.length} 个`,
  };
}

/** 这一档的命令关在什么里面。网页的由后端按档位定（DraftTools.shellPolicy）。 */
function shellPolicy(ctx) {
  if (ctx.local && ctx.local.shellPolicy) return ctx.local.shellPolicy;
  return ctx.mode === 'plan' ? READ_ONLY : WORKSPACE_WRITE;
}

/** 这一轮给模型哪些工具。 */
export function toolset(ctx) {
  const plan = ctx.mode === 'plan';
  const out = [];
  // 草稿模式（第九十四轮）只下发后端这一次允许的那几个（没有写意图不给写、不能执行不给跑、从来不给删）
  const allowed = ctx.local && ctx.local.allowedTools;
  // 有系统沙箱才给 shell（第一百零九轮），给了就不给 run_command；plan 档也给：沙箱是只读的，系统挡着写
  const sandboxed = Boolean(ctx.local && ctx.local.sandbox);
  for (const t of localSchemas()) {
    if (allowed && !allowed.has(t.function.name)) continue;
    if (sandboxed && t.function.name === 'run_command') continue;
    if (!plan || READ_TOOLS.has(t.function.name)) out.push({ schema: t, kind: 'local' });
  }
  if (sandboxed) for (const t of shellSchemas()) out.push({ schema: t, kind: 'local' });
  for (const t of ctx.remoteTools || []) {
    if (!plan || REMOTE_READ_TOOLS.has(t.function.name)) out.push({ schema: t, kind: 'remote' });
  }
  if (ctx.skills && ctx.skills.length) out.push({ schema: loadSkillSchema(), kind: 'skill' });
  out.push({ schema: todoSchema(), kind: 'todo' });   // 三档都有：plan 档列计划正用得上
  if (ctx.mcp) {
    const mcp = ctx.mcp.schemas({ readOnlyOnly: plan });
    if (mcp.length && mcpOverBudget(ctx, mcp)) {
      // 跟用户说一次（在这里说而不是启动时：启动时还不知道这个模型的窗口有多大）
      if (!ctx.mcpDeferNoted && ctx.ui) {
        ctx.mcpDeferNoted = true;
        ctx.ui.note(`· MCP 工具有 ${mcp.length} 个（定义约 ${Math.round(JSON.stringify(mcp).length / 1000)}K 字，超过这个模型窗口的一成）：不一次全给模型，它要用时先用 find_mcp_tool 找`);
      }
      out.push({ schema: findMcpSchema(mcp.length), kind: 'mcp-find' });
      for (const t of mcp) if (ctx.mcpActive && ctx.mcpActive.has(t.function.name)) out.push({ schema: t, kind: 'mcp' });
    } else {
      for (const t of mcp) out.push({ schema: t, kind: 'mcp' });
    }
  }
  // exec 的只读没有人批准计划：把结论写出来就是了（第一百一十三轮）
  if (plan && !ctx.execReadOnly) out.push({ schema: exitPlanSchema(), kind: 'plan' });
  if (ctx.goal && ctx.goal.status === 'active') out.push({ schema: goalSchema(), kind: 'goal' });
  // 同名只留第一个：本地工具优先于远程 / MCP（MCP 名字有前缀，本不会撞）
  const seen = new Set();
  return out.filter((t) => (seen.has(t.schema.function.name) ? false : seen.add(t.schema.function.name)));
}

export function systemText(ctx) {
  const env = environmentBlock({
    root: ctx.local.root, workspaceName: path.basename(ctx.local.root), mode: ctx.execReadOnly ? 'exec-read' : ctx.mode, commands: ctx.local.commands,
    shell: ctx.local.sandbox ? describeBoundary({ policy: shellPolicy(ctx), network: ctx.local.sandboxNetwork }) : null,
    shellWrites: Boolean(ctx.local.sandbox) && shellPolicy(ctx) === WORKSPACE_WRITE,
    today: today(), draft: Boolean(ctx.local.drafts),
  });
  // 目标、用户这次的原话置顶：在系统内容之后、其它一切之前 —— 每一轮都在，压缩也压不掉。
  // 系统提示排在所有历史前面，改一个字后面的缓存全部失效（第一百零四轮）：这两样很少变；任务清单常变，不放这里，见 TODO_REMIND_ROUNDS
  const pinned = [goalBlock(ctx.goal), requestBlock(ctx)].filter(Boolean).join('\n\n');
  return buildSystemMessage({ systemText: pinned ? `${ctx.system.text.trim()}\n\n${pinned}` : ctx.system.text, env, instructions: ctx.instructionsText, skills: ctx.skillsText });
}

const REQUEST_PIN_CHARS = 6000;

// 任务清单不进系统提示（第一百零四轮）：原来每改一次清单，下一次请求整段历史都没命中缓存。历史只追加不改写 ——
// 清单本来就在 update_todos 那次调用里；隔这么多轮工具，把它附在工具结果后面再说一遍（也记进历史）；压缩掉了就补一条
export const TODO_REMIND_ROUNDS = 8;
function todoInHistory(messages) {
  return messages.some((m) => (Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.function && c.function.name === TODO_TOOL))
    || (typeof m.content === 'string' && m.content.includes('## 任务清单')));
}

// 同一个调用、同样的结果连着来（第一百零四轮）：用户贴的记录里 deepseek-flash 把一条每次都打印 ok 的 node -e 连跑了 94 次，又一版 64 次，
// 用满两次 60 轮；用户问「你在干什么」它认了错，说完「好的」接着跑。failed 只管同样的失败、READ_STREAK 只管只读，成功的重复谁都不管。
// 比的是工具名 + 参数（键的顺序不算）+ 结果（命令用时、后面附的提醒不算）；换一个调用、结果变了、用户新说一句都重新数。
// 第 3 次提醒，第 5 次起不执行，第 7 次停下这一轮。评测 47 遍里连着一样的最多 2 次，不会碰到正常的活
export const REPEAT_WARN = 3;
export const REPEAT_REFUSE = 5;
export const REPEAT_STOP = 7;
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
function callKey(call) {
  const fn = call.function || {};
  const parsed = parseArgs(fn.arguments);
  return `${fn.name}\n${parsed.ok ? JSON.stringify(sortKeys(parsed.value)) : fn.arguments}`;
}
const comparableResult = (content) => String(content).split('\n\n【提醒】')[0].replace(/（\d+(\.\d+)?s）/g, '');
const repeatReminder = (n) => `这个调用你已经连续发了 ${n} 次，参数和结果都一模一样 —— 中间什么都没变，再发一次结果也不会变。`
  + '想清楚你缺的是什么：要看别的信息就换命令或参数，该改代码就去改，做完了就收尾。';
const repeatRefusal = (n) => `没有执行：这是连续第 ${n} 次发一模一样的调用，结果看前面那一次，它不会变。`
  + '换个做法：改命令或参数让它给出你要的信息、去改代码，或者直接说明卡在哪。再这样这一轮会被停下。';

/**
 * 用户这次的原话 —— 只在对话里已经没有原文（被压缩成摘要了）时才放。摘要是转述，
 * 「但 localhost 的不要动」这种约束条件在转述里最容易丢；丢了，做出来的就是另一件事，然后一轮轮返工。
 */
export function requestBlock(ctx) {
  const text = ctx.request && ctx.request.text;
  if (!text) return '';
  if (ctx.messages.some((m) => m.role === 'user' && m.content === text)) return '';
  const shown = text.length > REQUEST_PIN_CHARS
    ? `${text.slice(0, REQUEST_PIN_CHARS - 1500)}\n…（中间略）…\n${text.slice(-1500)}`
    : text;
  return `## 用户这次的原话（对话压缩过，原文放在这里；收尾之前对照它逐条检查）\n${shown}`;
}

/**
 * origin：这条 user 消息不是用户打的（goal 模式推的下一轮 'goal'、命令行自己补的说明 'system'）。
 * /resume 回放记录时靠它区分 —— 否则它们会显示成「› …」，像是用户说的。
 */
function record(ctx, message, origin = null) {
  if (ctx.emit && message.role === 'assistant' && message.content) ctx.emit('completed', { id: ctx.nextItemId(), type: 'agent_message', text: message.content });
  ctx.messages.push(message);
  if (ctx.store && ctx.session) ctx.store.append(ctx.session.id, origin ? { type: 'message', message, origin } : { type: 'message', message });
}

export function parseArgs(raw) {
  if (raw == null || raw === '') return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, error: '参数必须是一个 JSON 对象' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 截断了的参数：从残片里认出 path（给用户和模型一个线索），换成一个小而合法的 JSON。 */
function truncatedArgs(raw) {
  const m = /"path"\s*:\s*"([^"]{1,300})"/.exec(raw || '');
  return JSON.stringify({ _truncated: true, ...(m ? { path: m[1] } : {}) });
}

// ── 模型调用 ─────────────────────────────────────────────────────────────

export const MODEL_RETRY_WAITS = [1000, 3000];

/**
 * 调模型，失败了在安全的时候重来：只有「还没收到任何实质输出」且错误是临时性的（连接断开、服务器 5xx / 429、
 * 空闲超时）才重试 —— 已经输出了一半再重来，用户会看到重复的内容，工具调用也可能重复。
 */
async function callModel(ctx, tools, signal, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callModelOnce(ctx, tools, signal, opts);
    } catch (e) {
      if ((e && e.name === 'AbortError') || (signal && signal.aborted)) throw e;
      const retry = e instanceof ApiError && e.retryable && e.beforeOutput !== false && attempt < MODEL_RETRY_WAITS.length;
      if (!retry) throw e;
      const wait = e.retryAfter ?? MODEL_RETRY_WAITS[attempt];
      ctx.ui.note(`· ${e.message} —— ${(wait / 1000).toFixed(0)} 秒后重试（第 ${attempt + 2} 次）`);
      await sleep(wait, signal);
    }
  }
}

async function callModelOnce(ctx, tools, signal, { render = true, maxTokens = DEFAULT_MAX_TOKENS, messages } = {}) {
  const ui = ctx.ui;
  // 安静模式：不边收边打（收完才知道这是结论还是调工具前的思考 —— 见 runTurn），状态行是「思考中」
  const hush = render && quiet(ctx);
  const md = render && !hush ? ui.markdown() : null;
  let done = null;
  let text = '';
  const toolNames = new Map();
  // 第一个字到来之前显示在等多久（只在终端里）：用户分得清「在等模型」和「卡死了」
  const started = monotonic();
  let waiting = render && !hush ? setInterval(() => ui.status.set(ui.paint.dim(`… 等待模型回复 ${Math.round((monotonic() - started) / 1000)}s`)), 1000) : null;
  if (hush) ui.setActivity('');
  const stopWaiting = () => { if (waiting) { clearInterval(waiting); waiting = null; ui.status.clear(); } };
  const body = {
    modelId: ctx.model ? ctx.model.id : null,
    messages: messages || [{ role: 'system', content: systemText(ctx) }, ...ctx.messages],
    tools: tools.map((t) => t.schema),
    maxTokens,
  };
  if (ctx.effort) body.reasoning = ctx.effort;   // 不说就听服务端的默认
  let thought = 0;
  // 安静模式不边收边打：这时断了，已经收到的那一段就这么没了（第二十二轮实测：回答到一半服务器重启，只剩一句「断开了」）。
  // 把它打出来 —— 用户至少看得到说到哪了。断的两种样子都要：连接出错（下面的 catch）、流好好结束了却没有 done
  const showPartial = () => {
    if (!hush || !text.trim()) return;
    ui.note('（断开前已经收到的：）');
    const partial = ui.markdown();
    partial.feed(text);
    partial.finish();
  };
  try {
  await ctx.api.stream('/api/harness/model/stream', body, (name, data) => {
    if (name !== 'start') stopWaiting();
    if (name === 'start') {
      if (data.droppedMessages > 0 || data.elidedToolOutputs > 0) {
        ui.note(`· 服务器按上下文窗口（${data.contextWindow} token）裁掉了最早的 ${data.droppedMessages} 条消息`
          + `${data.elidedToolOutputs ? `、省略了 ${data.elidedToolOutputs} 段旧的工具输出` : ''}`);
      }
    } else if (name === 'reasoning') {
      // 思考不打进终端（要回传的内容在 done 的 message 里，见 HarnessModelGateway），只说它在想：不然模型想一分钟，看着像卡死了
      thought += String(data.text || '').length;
      if (hush) ui.setActivity(`思考中 ${formatBytes(thought)}`);
      else if (render) ui.status.set(ui.paint.dim(`… 思考中 ${formatBytes(thought)}`));
    } else if (name === 'delta') {
      text += data.text;
      if (md) md.feed(data.text);
    } else if (name === 'tool_call') {
      toolNames.set(data.index, data.name);
      if (md && md.wroteAnything) md.finish();     // 正文说完了才轮到工具：先把这段收尾换行
      if (hush) ui.setActivity(`准备 ${data.name}`);
      else if (render) ui.status.set(ui.paint.dim(`✎ 正在准备 ${data.name} …`));
    } else if (name === 'tool_progress') {
      const tool = toolNames.get(data.index) || '工具';
      if (hush) ui.setActivity(`生成 ${tool} 的内容 ${formatBytes(data.chars)}`);
      else if (render) ui.status.set(ui.paint.dim(`✎ 正在生成 ${tool} 的内容 … ${formatBytes(data.chars)}`));
    } else if (name === 'done') {
      done = data;
    }
  }, { signal });
  } catch (e) {
    if (!(e && e.name === 'AbortError')) showPartial();
    throw e;
  } finally {
    stopWaiting();
  }
  if (!hush) ui.status.clear();
  if (md) md.finish();
  if (!done) {
    showPartial();
    // 服务器把流关了却没发 done（它在收尾、在重启）—— 不是模型的事，和连接断在半路一样说
    throw new Error('回复没有正常结束：服务器那边把流关了，没说完 —— 服务器可能在重启；等一下再说一次就好');
  }
  if (ctx.usage) {
    ctx.usage.prompt += done.usage ? done.usage.promptTokens || 0 : 0;
    ctx.usage.completion += done.usage ? done.usage.completionTokens || 0 : 0;
    // 输入里命中供应商前缀缓存的部分（第九十三轮）：网关在供应商报了时才给；命中的按命中价算钱
    ctx.usage.cached = (ctx.usage.cached || 0) + (done.usage ? done.usage.cachedTokens || 0 : 0);
  }
  return { ...done, text, maxTokens: done.maxTokens || maxTokens };
}

/** /usage 里输入后面那一句「（缓存命中 N，P%）」；没命中、供应商没报就不说。 */
export function cacheNote(prompt, cached) {
  if (!cached || !prompt) return '';
  return `（缓存命中 ${cached}，${Math.round((cached / prompt) * 100)}%）`;
}

// ── 工具 ────────────────────────────────────────────────────────────────

async function confirmWrite(ctx, prep) {
  const ui = ctx.ui;
  const lines = hunks(prep.oldText, prep.newText, 3);
  if (ctx.mode === 'auto' || ctx.allow.write) {
    ui.diff(lines, 16);
    return true;
  }
  ui.diff(lines, 400);
  const pick = await ui.choose(`写入 ${prep.rel}？`, [
    { key: 'y', label: '写入' }, { key: 'n', label: '不写' }, { key: 'a', label: '本会话都允许写文件' },
  ], 'n');
  if (pick === 'a') ctx.allow.write = true;
  return pick === 'y' || pick === 'a';
}

/** 删除单独一道确认、单独一个「本会话都允许」：允许了随便写，不等于允许了随便删。 */
async function confirmDelete(ctx, prep) {
  if (ctx.mode === 'auto' || (ctx.allow && ctx.allow.delete)) return true;
  const pick = await ctx.ui.choose(`删除 ${prep.rel}（${prep.lines} 行，挪进 .zhiqu/trash/，能恢复）？`, [
    { key: 'y', label: '删除' }, { key: 'n', label: '不删' }, { key: 'a', label: '本会话都允许删除' },
  ], 'n');
  if (pick === 'a') ctx.allow.delete = true;
  return pick === 'y' || pick === 'a';
}

async function confirmRun(ctx, prep) {
  if (ctx.mode === 'auto' || ctx.allow.run) return true;
  const pick = await ctx.ui.choose(`运行 ${[prep.command, ...prep.args].join(' ')}${prep.cwdRel === '.' ? '' : `（在 ${prep.cwdRel}）`}？`, [
    { key: 'y', label: '运行' }, { key: 'n', label: '不运行' }, { key: 'a', label: '本会话都允许运行命令' },
  ], 'n');
  if (pick === 'a') ctx.allow.run = true;
  return pick === 'y' || pick === 'a';
}

/** 所有文件的 diff 摆出来，问一次。带删除的：「本会话都允许写文件」不算，和 delete_file 一样要问 */
async function confirmPatch(ctx, prep) {
  const ui = ctx.ui;
  const noAsk = ctx.mode === 'auto' || (ctx.allow.write && (!prep.deletes.length || ctx.allow.delete));
  for (const w of prep.writes) {
    ui.note(`    ${w.movedFrom ? `${w.movedFrom} → ` : ''}${w.rel}${w.creating && !w.movedFrom ? '（新建）' : ''}`);
    ui.diff(hunks(w.oldText, w.newText, 3), noAsk ? 16 : 400);
  }
  for (const d of prep.deletes) ui.note(`    删除 ${d.rel}（${d.lines} 行，挪进 .zhiqu/trash/）`);
  if (noAsk) return true;
  const pick = await ui.choose(`打这个补丁（${prep.files} 个文件）？`, [
    { key: 'y', label: '打' }, { key: 'n', label: '不打' }, { key: 'a', label: '本会话都允许写文件' },
  ], 'n');
  if (pick === 'a') ctx.allow.write = true;
  return pick === 'y' || pick === 'a';
}

async function confirmShell(ctx, prep) {
  if (ctx.allow.run) return true;
  const pick = await ctx.ui.choose(`运行 ${prep.command}${prep.cwdRel === '.' ? '' : `（在 ${prep.cwdRel}）`}？（在系统沙箱里）`, [
    { key: 'y', label: '运行' }, { key: 'n', label: '不运行' }, { key: 'a', label: '本会话都允许运行命令' },
  ], 'n');
  if (pick === 'a') ctx.allow.run = true;
  return pick === 'y' || pick === 'a';
}

/** 没有「本会话都允许」：出沙箱每次都要人点头（「本会话都允许运行命令」只算沙箱里的） */
async function confirmUnsandboxed(ctx, prep) {
  const pick = await ctx.ui.choose(`这条命令可能被系统沙箱挡住了：${prep.command}\n不带沙箱再跑一次？它能读写你电脑上的任何文件、能联网。`, [
    { key: 'n', label: '不跑' }, { key: 'y', label: '不带沙箱跑这一次' },
  ], 'n');
  return pick === 'y';
}

const TASK_STATUS_LABEL = { todo: '待办', doing: '进行中', done: '已完成' };
// search_wiki 第四十五轮起认页面类型（服务端的 WikiPageTypes）：只给类型时显示「查知识库里的目标页」，不显示「查知识库「undefined」」
const WIKI_TYPE_LABEL = { GOAL: '目标', PROJECT: '计划', PREFERENCE: '偏好', WEAKNESS: '薄弱点', RESOURCE: '资料', MEMORY: '对话摘要', NOTE: '备注' };
export function wikiSearchLabel(args = {}) {
  const query = String(args.query ?? '').trim();
  const type = String(args.type ?? '').trim();
  const kind = WIKI_TYPE_LABEL[type.toUpperCase()] || type;
  if (!query) return kind ? `查知识库里的${kind}页` : '列出知识库的页面';
  return `查知识库「${query}」${kind ? `（${kind}页）` : ''}`;
}

/** 改任务状态直接生效：ask 档先问，单独一个「本会话都允许」—— 允许了写文件，不等于允许了改任务。 */
async function confirmTaskStatus(ctx, args) {
  if (ctx.mode === 'auto' || (ctx.allow && ctx.allow.tasks)) return true;
  const label = TASK_STATUS_LABEL[String(args.status)] || String(args.status);
  const pick = await ctx.ui.choose(`把任务 #${String(args.task_id).replace('#', '')} 标成${label}？`, [
    { key: 'y', label: '改' }, { key: 'n', label: '不改' }, { key: 'a', label: '本会话都允许改任务状态' },
  ], 'n');
  if (pick === 'a') ctx.allow.tasks = true;
  return pick === 'y' || pick === 'a';
}

async function confirmMcp(ctx, name) {
  // 每个 MCP 工具第一次用都问 —— 三档都问：MCP 服务器是第三方写的，auto 免不了这一问
  if (ctx.allow.mcp.has(name)) return true;
  const pick = await ctx.ui.choose(`第一次调用 MCP 工具 ${name}，允许吗？`, [
    { key: 'y', label: '允许这一次' }, { key: 'a', label: '本会话都允许它' }, { key: 'n', label: '不允许' },
  ], 'n');
  if (pick === 'a') ctx.allow.mcp.add(name);
  return pick === 'y' || pick === 'a';
}

async function approvePlan(ctx, plan) {
  const ui = ctx.ui;
  ui.line(ui.paint.bold('── 计划'));
  const md = ui.markdown();
  md.feed(`${plan}\n`);
  md.finish();
  const pick = await ui.choose('按这个计划开始做吗？', [
    { key: 'a', label: '开始，全自动（auto）' }, { key: 'y', label: '开始，每步确认（ask）' }, { key: 'n', label: '先不，接着改计划' },
  ], 'n');
  if (pick === 'a' || pick === 'y') {
    setMode(ctx, pick === 'a' ? 'auto' : 'ask');
    return `用户批准了计划，现在是 ${ctx.mode} 档（${ctx.mode === 'auto' ? '写文件、跑命令不再逐个问' : '写文件、跑命令会逐个确认'}）。请按计划开始做，做完再汇报。`;
  }
  return '用户暂时不执行这个计划，还在 plan 档。请根据用户接下来的意见继续完善计划，或者回答用户的问题。';
}

export function setMode(ctx, mode) {
  ctx.mode = mode;
  if (ctx.store && ctx.session) ctx.store.append(ctx.session.id, { type: 'mode', mode });
}

export function describeCall(name, args) {
  switch (name) {
    case 'list_files': return `列出 ${args.path || '工作区根'}`;
    case 'read_file': return `读取 ${args.path}${args.offset ? `（从第 ${args.offset} 行）` : ''}`;
    case 'search': return `搜索「${args.query}」${args.path ? `（在 ${args.path}）` : ''}`;
    case 'write_file': return `${args.append ? '追加到' : '写入'} ${args.path}`;
    case 'edit_file': return `修改 ${args.path}`;
    case 'apply_patch': { const files = patchFiles(args.patch); return `打补丁 ${files.slice(0, 3).join('、')}${files.length > 3 ? ` 等 ${files.length} 个文件` : ''}`; }
    case 'delete_file': return `删除 ${args.path}`;
    case 'run_command': return `运行 ${[args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ')}`;
    case 'shell': return `${args.background ? '后台运行' : '运行'} ${args.command}`;
    case 'shell_output': return `看 ${args.id} 的输出`;
    case 'shell_stop': return `停掉 ${args.id}`;
    case 'load_skill': return `读取 skill ${args.name}${args.file ? ` / ${args.file}` : ''}`;
    case 'find_mcp_tool': return `找 MCP 工具「${args.query}」`;
    case 'exit_plan_mode': return '提交计划';
    case TODO_TOOL: return '更新任务清单';
    case GOAL_TOOL: return `目标状态：${args.status}`;
    case 'search_wiki': return wikiSearchLabel(args);
    case 'read_wiki_page': return `读知识库「${args.title}」`;
    case 'create_wiki_patch': return `生成知识库草稿「${args.title}」`;
    case 'create_study_plan': return '生成计划草稿';
    case 'list_tasks': return '读你的任务';
    case 'update_task_status': return `把任务 #${String(args.task_id).replace('#', '')} 标成${TASK_STATUS_LABEL[String(args.status)] || args.status}`;
    case 'read_memory': return '读长期记忆';
    case 'propose_memory': return '生成长期记忆草稿';
    default: return name.startsWith('mcp__') ? `MCP ${name.slice(5).replace('__', '/')}` : name;
  }
}

/*
 * 模型常把别家 agent 的工具名带过来（replace、str_replace、edit_file、bash、delete_file…）。
 * 原来一律回「这一轮没有给你这个工具」—— 听起来像「暂时不可用」，模型就一遍遍重试，还会自己编一句
 * 「现在可用了」再试，最后放弃替换、整份重写文件。所以要分清两件事：
 *   根本没有这个工具（说「不是暂时的」、说该用哪个、怎么用） vs. 有、但这一档不给（说档位）。
 */
const TOOL_ALIASES = [
  [/^(replace|str_replace|str_replace_editor|str_replace_based_edit_tool|search_replace|edit|multi_edit|multiedit|apply_diff|patch|modify_file|update_file)$/i,
    'edit_file', '改文件里的一段用 edit_file：传 path、old_string（原文，一字不差、只出现一次）、new_string。'],
  [/^(create_file|write|write_to_file|save_file|new_file|create)$/i,
    'write_file', '新建或整份写文件用 write_file（path + content），追加用 append: true；改一段用 edit_file。'],
  [/^(delete|remove|remove_file|rm|unlink|delete_path|trash)$/i,
    'delete_file', '删除文件用 delete_file（传 path；读过或写过的才能删，删掉的挪进 .zhiqu/trash/，能恢复）。'],
  [/^(bash|shell|sh|exec|execute|execute_command|run|run_shell|run_terminal_cmd|terminal)$/i,
    'run_command', '跑命令用 run_command：command 是命令名，args 是参数数组（不接受整行 shell 字符串）。'],
  [/^(ls|list_dir|list_directory|glob|find_files)$/i, 'list_files', '列目录用 list_files。'],
  [/^(cat|view|view_file|open_file|read|read_text_file)$/i, 'read_file', '读文件用 read_file。'],
  [/^(grep|find|search_files|search_code|ripgrep|codebase_search)$/i, 'search', '搜内容用 search（regex: true 按正则，glob 限定文件）。'],
];

function aliasFor(name, ctx) {
  const hit = TOOL_ALIASES.find(([re]) => re.test(String(name || '')));
  if (!hit) return null;
  if (hit[1] === 'run_command' && ctx && ctx.local && ctx.local.sandbox) return { tool: 'shell', hint: '跑命令用 shell：command 是一整条 shell 命令（字符串）。' };
  return { tool: hit[1], hint: hit[2] };
}

/** 任何档位下存在的工具名 —— 用来区分「这一档不给」和「根本没有」。 */
function existingToolNames(ctx) {
  const all = toolset({ ...ctx, mode: 'auto', goal: { status: 'active' } }).map((t) => t.schema.function.name);
  return new Set([...all, 'exit_plan_mode']);
}

/** 安静模式下的读类工具：step 变成状态行上的「在做什么」，result 不打。 */
function hushedUi(ui) {
  return new Proxy(ui, {
    get(target, key) {
      if (key === 'step') return (text) => target.setActivity(text);
      if (key === 'result' || key === 'line' || key === 'note') return () => {};
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function refuseUnoffered(ctx, name, offered) {
  const ui = ctx.ui;
  const available = [...offered.keys()].join('、');
  if (existingToolNames(ctx).has(name)) {
    ui.step(`${name}（${ctx.mode} 档不给这个工具）`);
    ui.result('已拒绝', false);
    return `${name} 在当前的 ${ctx.mode} 档没有下发，没有执行。`
      + (ctx.execReadOnly ? '现在是只读的（zhiqu exec 默认）：改不了文件。把结论写出来；用户要改的话得用 --mode auto 重跑。'
        : ctx.mode === 'plan' ? '现在是只读的 plan 档：想好之后用 exit_plan_mode 提交计划，用户批准后才能写、才能跑。' : '')
      + `这一档能用的：${available}。`;
  }
  const alias = aliasFor(name, ctx);
  ui.step(`${name}（没有这个工具${alias && alias.tool ? `，应当用 ${alias.tool}` : ''}）`);
  ui.result('已拒绝', false);
  return `没有叫 ${name} 的工具 —— 不是暂时不可用，重试也不会有。${alias ? alias.hint : ''}能用的工具：${available}。`;
}

// ── 打转 ────────────────────────────────────────────────────────────────
//
// 「叫它干一个活不要一直偏离然后一直修正」（用户 2026-09-27）。最常见的打转是同一件事一模一样地失败：
// 改同一个文件对不上原文、跑同一条命令报同一个错 —— 模型凭记忆再拼一遍、换个参数再跑一遍，越改越偏。
// 第 3 次失败时在工具结果后面附一句提醒：不拦它，只叫它停下来换个做法。成功一次就重新计数；每一轮（用户的一句话）重新计数。
export const SPIN_LIMIT = 3;

function failed(ctx, key, content, reminder) {
  const n = (ctx.spin.get(key) || 0) + 1;
  ctx.spin.set(key, n);
  return n >= SPIN_LIMIT ? `${content}\n\n【提醒】${reminder(n)}` : content;
}

function succeeded(ctx, key) {
  ctx.spin.delete(key);
}

// 另外两种空转（用户 2026-09-28 贴的记录：DeepSeek 在工具调用之间写了上万字推测、反复读同一个文件，
// 真正的 bug 最后是写脚本做实验找到的）：调工具的回复里写了一大段（> LONG_THINKING 字）；连续 READ_STREAK 次只看不动。
// 都是在工具结果后面附一句，不拦。
export const LONG_THINKING = 3000;
export const READ_STREAK = 8;
const thinkingReminder = (n) => `上面那段分析有 ${n} 字。别在回复里长篇推测：已知的够就直接改；拿不准就写一个最小的复现脚本跑一下，用输出判断。`;
const streakReminder = (n) => `你已经连续查看了 ${n} 次还没动手。已知的够就直接改；拿不准就写一个最小的复现脚本跑一下，用结果说话，不要继续猜。`;

// 第八十八轮（评测重跑的十段记录）：83 次 read_file 有 55 次只读 ≤ 80 行，sympy-23950 把一个文件从 170 行起分 6 次往下挪；
// 234 次带工具的回复里 209 次只发一个调用。每多一轮，整段对话都要重发一遍；到了轮数上限还没有结论（那一题最后的回答是空的）。
// 和上面两条一样，只在工具结果后面附一句，不拦。
export const WRAP_UP_ROUNDS = 3;
const windowReminder = (p, offset) => `你在接着上一次往下读 ${p}（第 ${offset} 行起）。直接读大一点：limit 省掉就是一次最多 2000 行，把要看的那一段一次读完；互相不依赖的读、搜放在同一次回复里一起发。`;
// 第八十九轮加过「改过文件要交活时推一次核对」，第九十轮用尺子量：正确率没有差别（核对推了 35 次没救回一题）、每题多花一半到一倍的 token，
// 第九十一轮用户定了去掉。
/**
 * 不调工具的那条回复之后还要不要推一句（清单没做完）。在问用户问题、最后一轮不推。
 * 要推的话那条先不当结论打出来 —— 原来安静模式下先打一遍结论、推完再打一遍（第八十九轮真模型试出来的）。
 */
function pendingNudge(ctx, text, { nudged, claimChecked, lastRound }) {
  if (lastRound || /[？?]\s*$/.test((text || '').trim())) return null;
  if (!nudged && ctx.mode !== 'plan' && unfinished(ctx.todos).length) return 'todo';
  // 交活时说的和这一轮做的对不上：宿主给的核对（第九十五轮：网页代码模式里一个工具没调就说「已生成三个文件的草稿」），只推一次。命令行里没有这个钩子
  if (!claimChecked && ctx.claimCheck && ctx.claimCheck(text)) return 'claim';
  return null;
}
/**
 * 命令输出在终端里显示哪几行：多了就开头几行 + 结尾几行，中间说省掉了多少（第九十轮）。
 * 原来只给最后 8 行、也不说前面还有：git diff 只看得到最后一段，git status 看不到在哪个分支；测试的汇总在结尾，开头是命令自己的头。
 */
export function shownOutput(lines, head = 3, tail = 5) {
  if (lines.length <= head + tail + 1) return lines;
  return [...lines.slice(0, head), `…（中间省掉 ${lines.length - head - tail} 行）`, ...lines.slice(-tail)];
}
const wrapUpReminder = (left, max) => `再过 ${left} 轮就到这一次的上限（${max} 轮）。开始收尾：改到一半的先改完、跑一次验证，然后用几句话说做到哪了、还差什么。`;
/** 同一个文件接着上一次读到的地方往下读（offset 正好接上，前后差几行也算）：一个文件只提醒一次 */
function readWindowHint(ctx, call) {
  if (!call.function || call.function.name !== 'read_file') return null;
  const args = parseArgs(call.function.arguments);
  if (!args.ok || typeof args.value.path !== 'string') return null;
  const file = args.value.path.replace(/^\.\//, '');
  const offset = Number(args.value.offset) || 1;
  const limit = Number(args.value.limit) || 2000;
  const windows = ctx.readWindows || (ctx.readWindows = new Map());
  const end = windows.get(file);
  windows.set(file, offset > 0 ? offset + limit : Infinity);
  if (end == null || !(offset > 1) || Math.abs(offset - end) > 5) return null;
  const hinted = ctx.readHinted || (ctx.readHinted = new Set());
  if (hinted.has(file)) return null;
  hinted.add(file);
  return windowReminder(file, offset);
}

/**
 * 省上下文：较早几轮「调工具的那几条回复」里的长篇思考，发给模型时只留开头（最近 keep 条原样）。
 * 结论另有不调工具的那条回复；会话记录里是原话（记录是 record 时写的），省略的只是 ctx.messages 这一份。
 */
export const THINKING_KEEP_CHARS = 200;
export const SLIM_THRESHOLD = 0.5;
export function slimThinking(messages, keep = 2) {
  const at = [];
  messages.forEach((m, i) => { if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) at.push(i); });
  let slimmed = 0;
  for (const i of at.slice(0, Math.max(0, at.length - keep))) {
    const c = messages[i].content;
    if (typeof c === 'string' && c.length > THINKING_KEEP_CHARS * 3 && !c.includes('这段思考已省略')) {
      messages[i] = { ...messages[i], content: `${c.slice(0, THINKING_KEEP_CHARS)}…（这段思考已省略，原来 ${c.length} 字）` };
      slimmed++;
    }
  }
  return slimmed;
}

const writeReminder = (file) => (n) => `你已经连续 ${n} 次没能改成 ${file}。停下来：先 read_file 重新读它现在的内容，`
  + '照原文一字不差地拼 edit_file 的 old_string（或者挑一段更短、只出现一次的原文）；不要凭记忆再试。如果是方案本身有问题，先想清楚再动手。';
// 新旧一模一样被拒（第一百轮：评测里连交 6 次同一段）：原文没拼错，叫它重拼 old_string 是指错了方向
const sameEditReminder = (file) => (n) => `你已经连续 ${n} 次没能改成 ${file}，这一次 new_string 和 old_string 一模一样 —— 原文没拼错，是还没定下要改成什么。`
  + '先想清楚这一处改完应该是什么样（拿不准就写一个最小的复现跑一下），再调 edit_file；不要把同一段原样再交一次。';
const runReminder = (line) => (n) => `同一条命令 ${line} 已经连续 ${n} 次失败。先把上面的错误信息完整读一遍，找出根因（不是症状）、`
  + '想清楚要改哪里再改，一次改对；如果是环境问题或者需要用户决定，就停下来说明，不要换着花样重跑。';

async function executeTool(ctx, call, offered, signal) {
  const name = call.function && call.function.name;
  // 读 / 搜 / 列目录、没下发的名字、参数坏了 —— 都是过程，安静模式下只在状态行里一闪，不留成行
  const hush = quiet(ctx) && (QUIET_TOOLS.has(name) || !offered.get(name));
  const ui = hush ? hushedUi(ctx.ui) : ctx.ui;
  const kind = offered.get(name);
  if (!kind) return refuseUnoffered({ ...ctx, ui }, name, offered);
  const parsed = parseArgs(call.function.arguments);
  if (!parsed.ok) {
    ui.step(`${name}（参数不对）`);
    ui.result(parsed.error, false);
    return `参数不是合法的 JSON（${parsed.error}），没有执行。请重新调用。`;
  }
  const args = parsed.value;
  ui.step(describeCall(name, args));
  ctx.steps.push(describeCall(name, args));
  if (ctx.turnStats && QUIET_TOOLS.has(name)) {
    const key = name === 'read_file' || name === 'read_wiki_page' ? 'read' : name === 'list_files' ? 'list' : 'search';
    ctx.turnStats[key] += 1;
  }

  if (kind === 'local') {
    const local = ctx.local;
    if (name === 'list_files' || name === 'read_file' || name === 'search') {
      // 读文件按这个模型一次能看的量给（留一点给头部）：否则它以为看全了，其实后半截被截断了
      const cap = toolOutputCap(ctx.model ? ctx.model.effectiveContextWindow : null) - 300;
      const r = name === 'list_files' ? local.listFiles(args) : name === 'read_file' ? local.readFile(args, { maxChars: cap }) : local.search(args);
      if (r.error) { ui.result(r.error, false); return r.error; }
      ui.result(r.summary);
      return r.content;
    }
    if (name === 'write_file' || name === 'edit_file') {
      const spinKey = `write:${String(args.path || '')}`;
      const prep = name === 'edit_file' ? local.prepareEdit(args) : local.prepareWrite(args);
      if (prep.error) { ui.result(prep.error, false); return failed(ctx, spinKey, prep.error, (prep.unchanged ? sameEditReminder : writeReminder)(args.path)); }
      if (prep.newDirectories.length) ui.note(`    （会连同新建目录 ${prep.newDirectories.join('、')}）`);
      if (!(await confirmWrite(ctx, prep))) {
        ui.result('用户没有同意，没写', false);
        return `用户没有同意写入 ${prep.rel}，文件没有改动。不要原样重试；问问用户想怎么改，或者换个做法。`;
      }
      const r = local.commitWrite(prep);
      if (r.error) { ui.result(r.error, false); return r.error; }
      succeeded(ctx, spinKey);
      ctx.changedFiles.add(prep.rel);
      ui.result(ui.paint.green(`✓ ${r.content.split('（')[0]}  +${r.added} -${r.removed}`));
      if (r.syntax) ui.result(`语法错误：${r.syntax.split('\n')[0]}`, false);
      return r.content;
    }
    if (name === 'apply_patch') {
      const spinKey = `patch:${String(args.patch || '').slice(0, 300)}`;
      const shown = patchFiles(args.patch).join('、') || '补丁';
      const prep = local.preparePatch(args);
      if (prep.error) { ui.result(prep.error, false); return failed(ctx, spinKey, prep.error, (prep.unchanged ? sameEditReminder : writeReminder)(shown)); }
      if (!(await confirmPatch(ctx, prep))) {
        ui.result('用户没有同意，没改', false);
        return `用户没有同意这个补丁，${shown} 都没有改动。不要原样重试；问问用户想怎么改，或者换个做法。`;
      }
      const r = local.commitPatch(prep);
      if (r.error) { ui.result(r.error, false); return r.error; }
      succeeded(ctx, spinKey);
      for (const rel of r.changed) ctx.changedFiles.add(rel);
      ui.result(ui.paint.green(`✓ ${r.summary}`));
      if (r.syntax) ui.result(`语法错误：${r.syntax.split('\n')[0]}`, false);
      return r.content;
    }
    if (name === 'delete_file') {
      const prep = local.prepareDelete(args);
      if (prep.error) { ui.result(prep.error, false); return prep.error; }
      if (!(await confirmDelete(ctx, prep))) {
        ui.result('用户没有同意，没删', false);
        return `用户没有同意删除 ${prep.rel}，文件还在。不要原样重试；问问用户想怎么处理。`;
      }
      const r = local.commitDelete(prep);
      if (r.error) { ui.result(r.error, false); return r.error; }
      ctx.changedFiles.add(`${prep.rel}（已删除）`);
      ui.result(ui.paint.green(`✓ 已删除 ${prep.rel}`) + ui.paint.dim(`  → ${r.trashed}`));
      return r.content;
    }
    if (name === 'shell') {
      const spinKey = `shell:${args.command}${args.cwd ? `@${args.cwd}` : ''}`;
      const prep = local.prepareShell(args);
      if (prep.error) { ui.result(prep.error, false); return failed(ctx, spinKey, prep.error, runReminder(String(args.command))); }
      if (ctx.mode === 'ask' && !(await confirmShell(ctx, prep))) {
        ui.result('用户没有同意，没运行', false);
        return `用户没有同意运行 ${prep.command}。不要原样重试；问问用户，或者换个做法。`;
      }
      if (args.background) {
        const job = await local.startJob(prep, { policy: shellPolicy(ctx), signal });
        if (job.error) { ui.result(job.error, false); return failed(ctx, spinKey, job.error, runReminder(prep.command)); }
        succeeded(ctx, spinKey);
        ui.result(`${job.id} 在后台${job.snap.running ? '跑着' : `结束了（退出码 ${job.snap.exitCode}）`}`, job.snap.running || job.snap.exitCode === 0);
        return job.content;
      }
      let tail = '';
      const onOutput = (s) => { tail = (tail + s).slice(-4000); };
      let r = await local.commitShell(prep, { policy: shellPolicy(ctx), signal, onOutput });
      // 被沙箱挡住：只有 ask 档、用户当场点了才不带沙箱再跑一次（默认不）。plan、auto 只把边界告诉模型
      if (r.blocked && ctx.mode === 'ask' && await confirmUnsandboxed(ctx, prep)) {
        r = await local.commitShell(prep, { unsandboxed: true, signal, onOutput });
      }
      for (const l of shownOutput(r.output.split('\n').filter((x) => x.trim()))) ui.line(`    ${ui.paint.dim(termSafe(l.length > 200 ? `${l.slice(0, 200)}…` : l, { singleLine: true }))}`);
      ui.result(r.summary, r.exitCode === 0);
      if (r.exitCode === 0) { succeeded(ctx, spinKey); return r.content; }
      return failed(ctx, spinKey, r.content, runReminder(prep.command));
    }
    if (name === 'shell_output' || name === 'shell_stop') {
      const r = name === 'shell_output' ? await local.readJob(args, { signal }) : await local.stopJob(args, { signal });
      if (r.error) { ui.result(r.error, false); return r.error; }
      ui.result(r.snap.running ? `${r.snap.id} 还在跑` : `${r.snap.id} 已结束（退出码 ${r.snap.exitCode}）`);
      return r.content;
    }
    if (name === 'run_command') {
      const line = [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ');
      const spinKey = `run:${line}${args.cwd ? `@${args.cwd}` : ''}`;
      const prep = local.prepareRun(args);
      if (prep.error) { ui.result(prep.error, false); return failed(ctx, spinKey, prep.error, runReminder(line)); }
      if (!(await confirmRun(ctx, prep))) {
        ui.result('用户没有同意，没运行', false);
        return `用户没有同意运行 ${[prep.command, ...prep.args].join(' ')}。不要原样重试；问问用户，或者换个做法。`;
      }
      let tail = '';
      const r = await local.commitRun(prep, { signal, onOutput: (s) => { tail = (tail + s).slice(-4000); } });
      for (const l of shownOutput(r.output.split('\n').filter((x) => x.trim()))) ui.line(`    ${ui.paint.dim(termSafe(l.length > 200 ? `${l.slice(0, 200)}…` : l, { singleLine: true }))}`);
      ui.result(r.summary, r.exitCode === 0);
      if (r.exitCode === 0) { succeeded(ctx, spinKey); return r.content; }
      return failed(ctx, spinKey, r.content, runReminder(line));
    }
  }
  if (kind === 'remote') {
    if (REMOTE_DIRECT_WRITE_TOOLS.has(name) && !(await confirmTaskStatus(ctx, args))) {
      ui.result('用户没有允许', false);
      return '用户没有允许改这条任务的状态。';
    }
    try {
      const pre = ctx.prefetched && ctx.prefetched.get(call.id);
      const r = pre ? await pre.then((v) => { if (v.error) throw v.error; return v.value; })
        : await ctx.api.post('/api/harness/tools/call', { sessionId: ctx.session.id, name, arguments: args }, { signal, timeoutMs: 60_000 });
      const drafts = r.drafts || [];
      ui.result(drafts.length ? `草稿：${drafts.map((d) => d.title).join('、')} → 到网页里确认` : '完成');
      return r.content;
    } catch (e) {
      ui.result(e.message, false);
      // 没拿到回应（服务器可能已经做了）：别说成「失败」—— 模型会换个说法再调一次；照原样再调，同一个键，不会重复
      return e.uncertain ? `远程工具没拿到回应：${e.message}` : `远程工具调用失败：${e.message}`;
    }
  }
  if (kind === 'skill') {
    const r = loadSkill(ctx.skills, args);
    if (r.error) { ui.result(r.error, false); return r.error; }
    ui.result(r.summary);
    return r.content;
  }
  if (kind === 'mcp') {
    if (!(await confirmMcp(ctx, name))) {
      ui.result('用户没有允许', false);
      return `用户没有允许调用 ${name}。`;
    }
    const r = await ctx.mcp.call(name, args, { signal });
    if (r.error) { ui.result(r.error, false); return r.error; }
    ui.result(r.summary);
    return r.content;
  }
  if (kind === 'mcp-find') {
    const r = findMcpTools(ctx, ctx.mcp.schemas({ readOnlyOnly: ctx.mode === 'plan' }), args.query);
    if (r.error) { ui.result(r.error, false); return r.error; }
    ui.result(r.summary);
    return r.content;
  }
  if (kind === 'plan') {
    return approvePlan(ctx, String(args.plan || ''));
  }
  if (kind === 'todo') {
    const r = parseTodos(args);
    if (r.error) { ui.result(r.error, false); return r.error; }
    ctx.todos = r.todos;
    ctx.roundsSinceTodo = 0;
    const [head, ...items] = todoLines(r.todos, ui.paint);
    ui.result(head);
    for (const l of items) ui.line(`  ${l}`);
    if (ctx.store && ctx.session) ctx.store.append(ctx.session.id, { type: 'todos', todos: ctx.todos });
    return todoReply(r.todos);
  }
  if (kind === 'goal') {
    const reply = applyGoalUpdate(ctx.goal, args);
    recordGoal(ctx);
    const label = { achieved: '宣告达成', blocked: '宣告卡住', active: '进展' }[ctx.goal.status];
    ui.result(`${label}：${ctx.goal.status === 'blocked' ? ctx.goal.blocker : args.summary || ''}`.slice(0, 200));
    return reply;
  }
  return `不认识的工具：${name}`;
}

/**
 * 同一次回复里的几个远程只读查询（查 Wiki、读记忆）先一起发出去，显示仍按顺序。
 * 只读的才这么做：写类的远程工具会建草稿，顺序和次数都不能乱。
 */
export function prefetchRemoteReads(ctx, calls, offered, signal) {
  ctx.prefetched = new Map();
  for (const call of calls) {
    const name = call.function && call.function.name;
    if (offered.get(name) !== 'remote' || !REMOTE_READ_TOOLS.has(name)) continue;
    const parsed = parseArgs(call.function.arguments);
    if (!parsed.ok) continue;
    ctx.prefetched.set(call.id, ctx.api.post('/api/harness/tools/call', { sessionId: ctx.session.id, name, arguments: parsed.value }, { signal, timeoutMs: 60_000 })
      .then((value) => ({ value }), (error) => ({ error })));
  }
}

// ── 压缩 ────────────────────────────────────────────────────────────────

export async function compactNow(ctx, signal, { manual = false } = {}) {
  const ui = ctx.ui;
  const window = ctx.model ? ctx.model.effectiveContextWindow || 64_000 : 64_000;
  if (manual) ui.step('压缩对话');
  const result = await compactMessages(ctx.messages, window, async (transcriptText) => {
    // 真要调模型压摘要时才说：自动触发、又只有最近一轮可留的时候，这里一句话都不该打
    if (!manual) {
      ui.step(`对话快到上下文上限（窗口 ${window} token 的 80%），把较早的部分压成摘要`);
      // 用户 2026-09-28：1M 的模型被按默认 64000 算、压缩了两次 —— 没填窗口时这里要说出来
      if (ctx.model && !ctx.model.contextWindowTokens) ui.note('    （这个模型没填上下文窗口，按默认算的；它实际更大的话用 /window 设，比如 /window 1m）');
    }
    // 摘要的输出上限随窗口走：窗口 8000 的模型写一份 4096 token 的摘要，压完比压之前还挤，下一轮又要压
    const r = await callModel(ctx, [], signal, {
      render: false, maxTokens: Math.max(512, Math.min(4096, Math.floor(window * 0.12))),
      messages: [{ role: 'system', content: SUMMARY_INSTRUCTIONS }, { role: 'user', content: transcriptText }],
    });
    return r.text.trim() || '（摘要为空）';
  });
  if (!result.summarized && !result.elided) {
    if (manual) ui.result('没什么可压缩的（只有最近的一两轮）');
    return result;
  }
  if (!result.summarized && !manual) ui.step('对话快到上下文上限，省略较早的大段工具输出');
  ctx.messages = result.messages;
  if (ctx.store && ctx.session) {
    ctx.store.append(ctx.session.id, { type: 'compact', messages: ctx.messages, before: result.before, after: result.after });
  }
  ui.result(`压掉 ${result.summarized} 条${result.elided ? `、省略 ${result.elided} 段旧的工具输出` : ''}，约 ${result.before} → ${result.after} token`);
  return result;
}

// ── 一轮 ────────────────────────────────────────────────────────────────

export async function runTurn(ctx, userText, { signal, origin = null } = {}) {
  ctx.steps = [];
  ctx.spin = new Map();
  ctx.repeat = null;
  ctx.changedFiles = ctx.changedFiles || new Set();
  const turnWindow = ctx.model ? ctx.model.effectiveContextWindow || 64_000 : 64_000;
  // 很长的输入存成文件、让模型分段读（见 longinput.js）；只对用户自己说的话
  const spilled = !origin && ctx.local && ctx.local.root ? spillLongInput(ctx.local.root, userText, turnWindow) : null;
  const content = spilled ? spilled.message : userText;
  if (spilled) ctx.ui.note(`· 这条消息很长（${spilled.chars} 字），原文存进了 ${spilled.files.join('、')}，模型会分段读`);
  if (!origin) ctx.request = { text: content };
  record(ctx, { role: 'user', content }, origin);
  if (ctx.session && ctx.store && !ctx.session.title) {
    ctx.session.title = userText.replace(/\s+/g, ' ').slice(0, 40);
    ctx.store.touch(ctx.session.id, { title: ctx.session.title });
  }
  let finalText = '';
  let stalled = false;
  let continuations = 0;
  let nudged = false;
  let claimChecked = false;
  ctx.turnStats = { read: 0, search: 0, list: 0 };
  ctx.readStreak = 0;
  ctx.readWindows = new Map(); ctx.readHinted = new Set();
  if (quiet(ctx)) ctx.ui.startThinking();
  try {
  const maxRounds = ctx.maxRounds || 60;
  for (let round = 0; round < maxRounds; round++) {
    if (signal && signal.aborted) break;
    const window = ctx.model ? ctx.model.effectiveContextWindow || 64_000 : 64_000;
    if (needsCompaction(systemText(ctx), ctx.messages, window)) await compactNow(ctx, signal);
    // 清单不在历史里了（压缩掉了、接回一段压缩过的会话）：补一条
    if (unfinished(ctx.todos).length && !todoInHistory(ctx.messages)) {
      record(ctx, { role: 'user', content: `（任务清单里还有 ${unfinished(ctx.todos).length} 项没做完，对话压缩过，再说一遍）\n\n${todoBlock(ctx.todos)}` }, 'system');
    }
    const tools = toolset(ctx);
    const offered = new Map(tools.map((t) => [t.schema.function.name, t.kind]));
    // 省略旧思考是改写历史，从那条起缓存全部失效（评测上约 1.6 个点，按价算约一成花费）；省下的那点 token 按命中价不值 —— 吃紧了才做
    if (needsCompaction(systemText(ctx), ctx.messages, window, SLIM_THRESHOLD)) slimThinking(ctx.messages);
    const res = await callModel(ctx, tools, signal);
    const message = res.message || { role: 'assistant', content: res.text };
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    // 原地重复：历史和回答里只留开头一段
    const looping = res.finishReason === 'length' && !calls.length && repeating(message.content);
    if (looping) message.content = loopTrimmed(message.content);

    // 安静模式下文字是收完才打的：不调工具的那条就是结论（被截断的结论也是结论的一段），调工具的那条是过程，不打
    const nudge = calls.length || res.finishReason === 'length' ? null
      : pendingNudge(ctx, message.content, { nudged, claimChecked, lastRound: round === maxRounds - 1 });
    if (quiet(ctx) && !calls.length && !nudge && !looping && (message.content || '').trim()) showAnswer(ctx, message.content);
    if (res.finishReason === 'length') {
      // 被截断不是「说完了」：截断的工具调用不执行，告诉模型为什么、该怎么改
      const broken = calls.filter((c) => !parseArgs(c.function.arguments).ok);
      for (const c of broken) c.function.arguments = truncatedArgs(c.function.arguments);
      record(ctx, message);
      if (calls.length) {
        ctx.ui.warn(`模型这一次的输出超过了单次上限（${res.maxTokens} token），被截断了 —— 已让它把文件拆小、分几次写`);
        for (const c of calls) {
          const content = broken.includes(c)
            ? `你这次调用的参数被截断了（超过单次输出上限 ${res.maxTokens} token），没有执行。`
              + '文件很长就分几次写：先用 write_file 写开头，再用 append=true 一段一段追加；或者拆成几个小文件。'
            : '同一次回复里有别的调用被截断了，这个调用也没有执行，请重新发起。';
          record(ctx, { role: 'tool', tool_call_id: c.id, content });
        }
        continue;
      }
      const more = continuations++ < MAX_CONTINUATIONS;
      if (looping) ctx.ui.warn(`模型在原地重复同一段话，写满了单次输出上限 —— 重复的部分已删掉，${more ? '让它直接动手' : '先停在这里'}`);
      if (more) {
        record(ctx, { role: 'user', content: looping ? LOOP_NUDGE : '（你的回答被输出上限截断了，请从断开的地方接着说，不要重复前面的内容）' }, 'system');
        continue;
      }
      if (looping && quiet(ctx)) showAnswer(ctx, message.content);
      finalText = message.content || '';
      break;
    }

    record(ctx, message);
    if (!calls.length) {
      finalText = message.content || '';
      // 清单没做完就收尾：推一次（pendingNudge）
      if (nudge === 'todo') {
        nudged = true;
        record(ctx, { role: 'user', content: todoNudge(ctx.todos) }, 'system');
        continue;
      }
      if (nudge === 'claim') {
        claimChecked = true;
        record(ctx, { role: 'user', content: ctx.claimCheck(message.content) }, 'system');
        continue;
      }
      break;
    }
    prefetchRemoteReads(ctx, calls, offered, signal);
    const thought = (message.content || '').length;
    for (const [i, call] of calls.entries()) {
      if (signal && signal.aborted) break;
      const key = callKey(call);
      const again = ctx.repeat && ctx.repeat.key === key;
      const reminders = [];
      let content;
      if (again && ctx.repeat.count >= REPEAT_REFUSE - 1) {
        ctx.repeat.count += 1;
        ctx.ui.note(`· ${call.function.name} 和前面一模一样，没有执行（连续第 ${ctx.repeat.count} 次）`);
        content = repeatRefusal(ctx.repeat.count);
      } else {
        const itemId = ctx.emit ? ctx.nextItemId() : null;
        const item = ctx.emit ? { id: itemId, type: 'tool_call', name: call.function && call.function.name, arguments: call.function && call.function.arguments } : null;
        if (ctx.emit) ctx.emit('started', item);
        content = capToolOutput(await executeTool(ctx, call, offered, signal), window);
        if (ctx.emit) ctx.emit('completed', { ...item, output: content });
        const result = comparableResult(content);
        const count = again && ctx.repeat.result === result ? ctx.repeat.count + 1 : 1;
        ctx.repeat = { key, result, count };
        if (count >= REPEAT_WARN && !content.includes('\n\n【提醒】')) reminders.push(repeatReminder(count));   // 同样的失败 failed 已经提醒过了
      }
      if (i === 0 && thought > LONG_THINKING) reminders.push(thinkingReminder(thought));
      const name = call.function && call.function.name;
      ctx.readStreak = QUIET_TOOLS.has(name) ? (ctx.readStreak || 0) + 1 : 0;
      if (ctx.readStreak > 0 && ctx.readStreak % READ_STREAK === 0) reminders.push(streakReminder(ctx.readStreak));
      const windowHint = readWindowHint(ctx, call);
      if (windowHint) reminders.push(windowHint);
      if (i === calls.length - 1 && maxRounds > WRAP_UP_ROUNDS * 3 && maxRounds - round - 1 === WRAP_UP_ROUNDS) reminders.push(wrapUpReminder(WRAP_UP_ROUNDS, maxRounds));
      if (i === calls.length - 1) {
        ctx.roundsSinceTodo = (ctx.roundsSinceTodo || 0) + 1;
        if (ctx.roundsSinceTodo >= TODO_REMIND_ROUNDS && unfinished(ctx.todos).length) {
          reminders.push(todoBlock(ctx.todos));
          ctx.roundsSinceTodo = 0;
        }
      }
      if (reminders.length) content += reminders.map((r) => `\n\n【提醒】${r}`).join('');
      record(ctx, { role: 'tool', tool_call_id: call.id, content });
    }
    if (ctx.repeat && ctx.repeat.count >= REPEAT_STOP) {
      stalled = true;
      finalText = `已经停下：模型连续 ${ctx.repeat.count} 次发同一个调用（${ctx.repeat.key.split('\n')[0]}），结果一直没变。说说接下来想怎么做，或者换个模型试试。`;
      ctx.ui.warn(finalText);
      break;
    }
    if (round === maxRounds - 1) {
      ctx.ui.warn(`已经连续调用了 ${maxRounds} 轮工具，先停在这里。说「继续」可以接着做。`);
    }
  }
  } finally {
    ctx.ui.stopThinking();
  }
  if (signal && signal.aborted) ctx.messages = dropDanglingToolCalls(ctx.messages);
  if (ctx.store && ctx.session) ctx.store.touch(ctx.session.id, { messages: ctx.messages.length, model: ctx.model ? ctx.model.label : null });
  return { finalText, stalled, steps: ctx.steps.slice(), changedFiles: [...ctx.changedFiles], stats: { ...ctx.turnStats } };
}

/** 在会话历史后面追加一问一答，不走模型（/review 的结论放回会话，才能接着说「修第 1 条」）。历史只追加。 */
export function recordExchange(ctx, userText, answer) {
  const silent = { ...ctx, emit: null };   // 事件流里的结论由调用方说，这里不再冒一条 agent_message
  record(silent, { role: 'user', content: userText });
  record(silent, { role: 'assistant', content: answer });
  if (!ctx.store || !ctx.session) return;
  if (!ctx.session.title) ctx.session.title = userText.replace(/\s+/g, ' ').slice(0, 40);
  ctx.store.touch(ctx.session.id, { title: ctx.session.title, messages: ctx.messages.length });
}

/** 结论：一次整段打（按 Markdown 渲染）。 */
function showAnswer(ctx, text) {
  if (ctx.exec) return;   // zhiqu exec：结论由它写到 stdout，stderr 里不再打一遍
  const md = ctx.ui.markdown();
  md.feed(text.endsWith('\n') ? text : `${text}\n`);
  md.finish();
}

/** 一轮结束时那一句：这一轮看了什么（安静模式下读 / 搜没有留成行，说个数）。 */
export function statsNote(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.read) parts.push(`读了 ${stats.read} 次文件`);
  if (stats.search) parts.push(`搜了 ${stats.search} 次`);
  if (stats.list) parts.push(`看了 ${stats.list} 次目录`);
  return parts.length ? `· 这一轮${parts.join('、')}` : '';
}

/**
 * 网页里看的那份存档：人说的、助手最后回的，加一行过程。
 *
 * 可靠性这一轮改成了「后台、按顺序、失败的下次再补」：原来每一轮结束都要等两个请求（最多 20 秒）才回到提示符，
 * 失败了那一轮就永远缺在网页上。现在 archiveTurn 只入队，真正的发送串在 ctx.archiveChain 上；发不出去的留在队列里，
 * 下一轮连同新的一起补；退出前 flushArchive 再等一会儿。
 */
export function archiveTurn(ctx, userText, result) {
  if (!ctx.api || !ctx.session || ctx.archiveDisabled) return Promise.resolve();
  const steps = result.steps.length ? `\n\n> 过程：${result.steps.slice(0, 30).join(' · ')}${result.steps.length > 30 ? ` …共 ${result.steps.length} 步` : ''}` : '';
  ctx.archivePending = ctx.archivePending || [];
  ctx.archivePending.push({
    sessionId: ctx.session.id, title: ctx.session.title || userText.slice(0, 40),
    messages: [{ role: 'user', content: userText }, { role: 'assistant', content: (result.finalText || '（没有文字回答）') + steps }],
  });
  ctx.archiveChain = (ctx.archiveChain || Promise.resolve()).then(() => sendPending(ctx));
  return ctx.archiveChain;
}

async function sendPending(ctx) {
  while (ctx.archivePending.length) {
    const item = ctx.archivePending[0];
    try {
      // 一个请求：会话不存在时服务器用 title / workspace 建（原来先开会话再写消息，两个请求）
      await ctx.api.post(`/api/harness/sessions/${item.sessionId}/messages`, {
        title: item.title, workspace: path.basename(ctx.local.root), messages: item.messages,
      // 回应丢了（服务器其实收到了）之后下一轮补发：内容不变，Api 沿用没弄清的那个键 —— 网页上不会多出一份（第二十二轮）。
      // 原来这里另给每条存档一个键，扰动照出它和那条规矩重复：删掉哪一道都不红，留一道
      }, { timeoutMs: 10_000 });
      ctx.archivePending.shift();
    } catch (e) {
      if (!ctx.archiveWarned) {
        ctx.ui.note(`（网页存档暂时没发出去：${e.message}；本地记录不受影响，下一轮会补上）`);
        ctx.archiveWarned = true;
      }
      return;
    }
  }
}

/** 退出前把没发出去的存档再发一次，最多等 timeoutMs。 */
export async function flushArchive(ctx, timeoutMs = 5000) {
  if (!ctx.archiveChain) return;
  const all = ctx.archiveChain.then(() => (ctx.archivePending && ctx.archivePending.length ? sendPending(ctx) : null));
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
}

// ── goal 模式 ──────────────────────────────────────────────────────────

export function recordGoal(ctx) {
  if (ctx.store && ctx.session) ctx.store.append(ctx.session.id, { type: 'goal', goal: ctx.goal });
}

/** 独立核对：不带工具，只看目标、证据与真实的工具结果。 */
export async function verifyGoal(ctx, signal) {
  const r = await callModel(ctx, [], signal, {
    render: false, maxTokens: 1024,
    messages: [{ role: 'system', content: VERIFY_INSTRUCTIONS },
      { role: 'user', content: verificationMaterial(ctx.goal, ctx.messages, [...(ctx.goalChangedFiles || [])]) }],
  });
  return parseVerdict(r.text);
}

/**
 * 追一个目标：一轮接一轮，直到宣告达成且核对通过、宣告卡住、轮数用完或者被打断。
 * 返回 'achieved' | 'blocked' | 'exhausted' | 'aborted'。
 */
export async function runGoal(ctx, { signal, maxTurns = DEFAULT_MAX_GOAL_TURNS, onTurn } = {}) {
  const ui = ctx.ui;
  const goal = ctx.goal;
  ctx.goalChangedFiles = ctx.goalChangedFiles || new Set();
  let text = goal.turns === 0 ? `目标：${goal.text}\n开始做。` : `继续朝目标推进：${goal.text}`;
  for (let i = 0; i < maxTurns; i++) {
    if (signal && signal.aborted) return 'aborted';
    goal.turns += 1;
    ui.note(`· 🎯 目标第 ${goal.turns} 轮`);
    const result = await runTurn(ctx, text, { signal, origin: 'goal' });
    for (const f of result.changedFiles) ctx.goalChangedFiles.add(f);
    if (onTurn) onTurn(text, result);
    if (signal && signal.aborted) return 'aborted';
    if (goal.status === 'blocked') {
      ui.line(ui.paint.yellow(`🎯 卡住了：${goal.blocker}`));
      return 'blocked';
    }
    if (goal.status === 'achieved') {
      ui.step('核对目标是否真的达成');
      const verdict = await verifyGoal(ctx, signal);
      if (verdict.achieved || goal.verifyFailures >= MAX_VERIFY_FAILURES) {
        ui.result(verdict.achieved ? '核对通过' : `核对 ${MAX_VERIFY_FAILURES} 次都没通过，按执行者的证据收尾（请你自己再看一眼）`, verdict.achieved);
        recordGoal(ctx);
        ui.line(ui.paint.green(`🎯 目标达成：${goal.text}`));
        return 'achieved';
      }
      goal.verifyFailures += 1;
      goal.status = 'active';
      recordGoal(ctx);
      ui.result(`核对没通过：${verdict.missing}`, false);
      text = `核对没通过：${verdict.missing}\n把缺的补上，验证过之后再宣告达成。`;
      continue;
    }
    // 模型收尾了，但没宣告达成、也没宣告卡住 —— 不许停
    text = '目标还没有宣告完成。接着做；真做完了就调用 goal_update（status=achieved，附上验证证据），真卡住了就调用 goal_update（status=blocked，写清楚需要用户做什么）。';
  }
  ui.warn(`已经朝目标连续推进了 ${maxTurns} 轮，先停在这里。/goal continue 接着追。`);
  recordGoal(ctx);
  return 'exhausted';
}

export function hostName() {
  return os.hostname().replace(/\.local$/, '');
}
