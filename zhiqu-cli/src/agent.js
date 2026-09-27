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
import { hunks } from './render/diff.js';
import { formatBytes } from './render/term.js';
import { localSchemas, READ_TOOLS } from './tools/local.js';
import { loadSkill, loadSkillSchema } from './skills.js';
import { buildSystemMessage, environmentBlock, today } from './prompt.js';
import { compactMessages, needsCompaction, SUMMARY_INSTRUCTIONS } from './compact.js';
import { dropDanglingToolCalls } from './session.js';
import { ApiError } from './api.js';
import { sleep } from './http.js';
import { parseTodos, TODO_TOOL, todoBlock, todoLines, todoNudge, todoReply, todoSchema, unfinished } from './todos.js';
import { spillLongInput } from './longinput.js';
import { applyGoalUpdate, DEFAULT_MAX_GOAL_TURNS, GOAL_TOOL, goalBlock, goalSchema, MAX_VERIFY_FAILURES, parseVerdict, verificationMaterial, VERIFY_INSTRUCTIONS } from './goal.js';

export const REMOTE_READ_TOOLS = new Set(['search_wiki', 'read_wiki_page', 'read_memory']);

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

/** 这一轮给模型哪些工具。 */
export function toolset(ctx) {
  const plan = ctx.mode === 'plan';
  const out = [];
  for (const t of localSchemas()) {
    if (!plan || READ_TOOLS.has(t.function.name)) out.push({ schema: t, kind: 'local' });
  }
  for (const t of ctx.remoteTools || []) {
    if (!plan || REMOTE_READ_TOOLS.has(t.function.name)) out.push({ schema: t, kind: 'remote' });
  }
  if (ctx.skills && ctx.skills.length) out.push({ schema: loadSkillSchema(), kind: 'skill' });
  out.push({ schema: todoSchema(), kind: 'todo' });   // 三档都有：plan 档列计划正用得上
  if (ctx.mcp) for (const t of ctx.mcp.schemas({ readOnlyOnly: plan })) out.push({ schema: t, kind: 'mcp' });
  if (plan) out.push({ schema: exitPlanSchema(), kind: 'plan' });
  if (ctx.goal && ctx.goal.status === 'active') out.push({ schema: goalSchema(), kind: 'goal' });
  // 同名只留第一个：本地工具优先于远程 / MCP（MCP 名字有前缀，本不会撞）
  const seen = new Set();
  return out.filter((t) => (seen.has(t.schema.function.name) ? false : seen.add(t.schema.function.name)));
}

export function systemText(ctx) {
  const env = environmentBlock({
    root: ctx.local.root, workspaceName: path.basename(ctx.local.root), mode: ctx.mode, commands: ctx.local.commands,
    today: today(),
  });
  // 目标、用户这次的原话、任务清单置顶：在系统内容之后、其它一切之前 —— 每一轮都在，压缩也压不掉
  const pinned = [goalBlock(ctx.goal), requestBlock(ctx), todoBlock(ctx.todos)].filter(Boolean).join('\n\n');
  return buildSystemMessage({ systemText: pinned ? `${ctx.system.text.trim()}\n\n${pinned}` : ctx.system.text, env, instructions: ctx.instructionsText, skills: ctx.skillsText });
}

const REQUEST_PIN_CHARS = 6000;

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
  const md = render ? ui.markdown() : null;
  let done = null;
  let text = '';
  const toolNames = new Map();
  // 第一个字到来之前显示在等多久（只在终端里）：用户分得清「在等模型」和「卡死了」
  const started = Date.now();
  let waiting = render ? setInterval(() => ui.status.set(ui.paint.dim(`… 等待模型回复 ${Math.round((Date.now() - started) / 1000)}s`)), 1000) : null;
  const stopWaiting = () => { if (waiting) { clearInterval(waiting); waiting = null; ui.status.clear(); } };
  const body = {
    modelId: ctx.model ? ctx.model.id : null,
    messages: messages || [{ role: 'system', content: systemText(ctx) }, ...ctx.messages],
    tools: tools.map((t) => t.schema),
    maxTokens,
  };
  try {
  await ctx.api.stream('/api/harness/model/stream', body, (name, data) => {
    if (name !== 'start') stopWaiting();
    if (name === 'start') {
      if (data.droppedMessages > 0 || data.elidedToolOutputs > 0) {
        ui.note(`· 服务器按上下文窗口（${data.contextWindow} token）裁掉了最早的 ${data.droppedMessages} 条消息`
          + `${data.elidedToolOutputs ? `、省略了 ${data.elidedToolOutputs} 段旧的工具输出` : ''}`);
      }
    } else if (name === 'delta') {
      text += data.text;
      if (md) md.feed(data.text);
    } else if (name === 'tool_call') {
      toolNames.set(data.index, data.name);
      if (md && md.wroteAnything) md.finish();     // 正文说完了才轮到工具：先把这段收尾换行
      if (render) ui.status.set(ui.paint.dim(`✎ 正在准备 ${data.name} …`));
    } else if (name === 'tool_progress') {
      const tool = toolNames.get(data.index) || '工具';
      if (render) ui.status.set(ui.paint.dim(`✎ 正在生成 ${tool} 的内容 … ${formatBytes(data.chars)}`));
    } else if (name === 'done') {
      done = data;
    }
  }, { signal });
  } finally {
    stopWaiting();
  }
  ui.status.clear();
  if (md) md.finish();
  if (!done) throw new Error('模型的回复没有正常结束（连接中途断开了）');
  if (ctx.usage) {
    ctx.usage.prompt += done.usage ? done.usage.promptTokens || 0 : 0;
    ctx.usage.completion += done.usage ? done.usage.completionTokens || 0 : 0;
  }
  return { ...done, text, maxTokens: done.maxTokens || maxTokens };
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
    case 'write_file': return `${args.old_string != null ? '修改' : args.append ? '追加到' : '写入'} ${args.path}`;
    case 'delete_file': return `删除 ${args.path}`;
    case 'run_command': return `运行 ${[args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ')}`;
    case 'load_skill': return `读取 skill ${args.name}${args.file ? ` / ${args.file}` : ''}`;
    case 'exit_plan_mode': return '提交计划';
    case TODO_TOOL: return '更新任务清单';
    case GOAL_TOOL: return `目标状态：${args.status}`;
    case 'search_wiki': return `查知识库「${args.query}」`;
    case 'read_wiki_page': return `读知识库「${args.title}」`;
    case 'create_wiki_patch': return `生成知识库草稿「${args.title}」`;
    case 'create_study_plan': return '生成学习计划草稿';
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
  [/^(replace|str_replace|str_replace_editor|str_replace_based_edit_tool|search_replace|edit|edit_file|multi_edit|multiedit|apply_patch|apply_diff|patch|modify_file|update_file)$/i,
    'write_file', '改文件里的一段用 write_file 的替换用法：传 path、old_string（原文，一字不差、只出现一次）、new_string。'],
  [/^(create_file|write|write_to_file|save_file|new_file|create)$/i,
    'write_file', '新建或整份写文件用 write_file（path + content），追加用 append: true。'],
  [/^(delete|remove|remove_file|rm|unlink|delete_path|trash)$/i,
    'delete_file', '删除文件用 delete_file（传 path；读过或写过的才能删，删掉的挪进 .zhiqu/trash/，能恢复）。'],
  [/^(bash|shell|sh|exec|execute|execute_command|run|run_shell|run_terminal_cmd|terminal)$/i,
    'run_command', '跑命令用 run_command：command 是命令名，args 是参数数组（不接受整行 shell 字符串）。'],
  [/^(ls|list_dir|list_directory|glob|find_files)$/i, 'list_files', '列目录用 list_files。'],
  [/^(cat|view|view_file|open_file|read|read_text_file)$/i, 'read_file', '读文件用 read_file。'],
  [/^(grep|find|search_files|search_code|ripgrep|codebase_search)$/i, 'search', '搜内容用 search。'],
];

function aliasFor(name) {
  const hit = TOOL_ALIASES.find(([re]) => re.test(String(name || '')));
  return hit ? { tool: hit[1], hint: hit[2] } : null;
}

/** 任何档位下存在的工具名 —— 用来区分「这一档不给」和「根本没有」。 */
function existingToolNames(ctx) {
  const all = toolset({ ...ctx, mode: 'auto', goal: { status: 'active' } }).map((t) => t.schema.function.name);
  return new Set([...all, 'exit_plan_mode']);
}

function refuseUnoffered(ctx, name, offered) {
  const ui = ctx.ui;
  const available = [...offered.keys()].join('、');
  if (existingToolNames(ctx).has(name)) {
    ui.step(`${name}（${ctx.mode} 档不给这个工具）`);
    ui.result('已拒绝', false);
    return `${name} 在当前的 ${ctx.mode} 档没有下发，没有执行。`
      + (ctx.mode === 'plan' ? '现在是只读的 plan 档：想好之后用 exit_plan_mode 提交计划，用户批准后才能写、才能跑。' : '')
      + `这一档能用的：${available}。`;
  }
  const alias = aliasFor(name);
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

const writeReminder = (file) => (n) => `你已经连续 ${n} 次没能改成 ${file}。停下来：先 read_file 重新读它现在的内容，`
  + '照原文一字不差地拼 old_string（或者挑一段更短、只出现一次的原文）；不要凭记忆再试。如果是方案本身有问题，先想清楚再动手。';
const runReminder = (line) => (n) => `同一条命令 ${line} 已经连续 ${n} 次失败。先把上面的错误信息完整读一遍，找出根因（不是症状）、`
  + '想清楚要改哪里再改，一次改对；如果是环境问题或者需要用户决定，就停下来说明，不要换着花样重跑。';

async function executeTool(ctx, call, offered, signal) {
  const ui = ctx.ui;
  const name = call.function && call.function.name;
  const kind = offered.get(name);
  if (!kind) return refuseUnoffered(ctx, name, offered);
  const parsed = parseArgs(call.function.arguments);
  if (!parsed.ok) {
    ui.step(`${name}（参数不对）`);
    ui.result(parsed.error, false);
    return `参数不是合法的 JSON（${parsed.error}），没有执行。请重新调用。`;
  }
  const args = parsed.value;
  ui.step(describeCall(name, args));
  ctx.steps.push(describeCall(name, args));

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
    if (name === 'write_file') {
      const spinKey = `write:${String(args.path || '')}`;
      const prep = local.prepareWrite(args);
      if (prep.error) { ui.result(prep.error, false); return failed(ctx, spinKey, prep.error, writeReminder(args.path)); }
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
      const lastLines = r.output.split('\n').filter((l) => l.trim()).slice(-8);
      for (const l of lastLines) ui.line(`    ${ui.paint.dim(l.length > 200 ? `${l.slice(0, 200)}…` : l)}`);
      ui.result(r.summary, r.exitCode === 0);
      if (r.exitCode === 0) { succeeded(ctx, spinKey); return r.content; }
      return failed(ctx, spinKey, r.content, runReminder(line));
    }
  }
  if (kind === 'remote') {
    try {
      const pre = ctx.prefetched && ctx.prefetched.get(call.id);
      const r = pre ? await pre.then((v) => { if (v.error) throw v.error; return v.value; })
        : await ctx.api.post('/api/harness/tools/call', { sessionId: ctx.session.id, name, arguments: args }, { signal, timeoutMs: 60_000 });
      const drafts = r.drafts || [];
      ui.result(drafts.length ? `草稿：${drafts.map((d) => d.title).join('、')} → 到网页里确认` : '完成');
      return r.content;
    } catch (e) {
      ui.result(e.message, false);
      return `远程工具调用失败：${e.message}`;
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
  if (kind === 'plan') {
    return approvePlan(ctx, String(args.plan || ''));
  }
  if (kind === 'todo') {
    const r = parseTodos(args);
    if (r.error) { ui.result(r.error, false); return r.error; }
    ctx.todos = r.todos;
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
    if (!manual) ui.step(`对话快到上下文上限（窗口 ${window} token 的 80%），把较早的部分压成摘要`);
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
  let continuations = 0;
  let nudged = false;
  const maxRounds = ctx.maxRounds || 60;
  for (let round = 0; round < maxRounds; round++) {
    if (signal && signal.aborted) break;
    const window = ctx.model ? ctx.model.effectiveContextWindow || 64_000 : 64_000;
    if (needsCompaction(systemText(ctx), ctx.messages, window)) await compactNow(ctx, signal);
    const tools = toolset(ctx);
    const offered = new Map(tools.map((t) => [t.schema.function.name, t.kind]));
    const res = await callModel(ctx, tools, signal);
    const message = res.message || { role: 'assistant', content: res.text };
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

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
      if (continuations++ < MAX_CONTINUATIONS) {
        record(ctx, { role: 'user', content: '（你的回答被输出上限截断了，请从断开的地方接着说，不要重复前面的内容）' }, 'system');
        continue;
      }
      finalText = message.content || '';
      break;
    }

    record(ctx, message);
    if (!calls.length) {
      finalText = message.content || '';
      // 清单没做完就收尾：推一次。在问用户问题、plan 档、已经推过一次，都不推
      if (!nudged && ctx.mode !== 'plan' && unfinished(ctx.todos).length && !/[？?]\s*$/.test(finalText.trim())) {
        nudged = true;
        record(ctx, { role: 'user', content: todoNudge(ctx.todos) }, 'system');
        continue;
      }
      break;
    }
    prefetchRemoteReads(ctx, calls, offered, signal);
    for (const call of calls) {
      if (signal && signal.aborted) break;
      const content = await executeTool(ctx, call, offered, signal);
      record(ctx, { role: 'tool', tool_call_id: call.id, content: capToolOutput(content, window) });
    }
    if (round === maxRounds - 1) {
      ctx.ui.warn(`已经连续调用了 ${maxRounds} 轮工具，先停在这里。说「继续」可以接着做。`);
    }
  }
  if (signal && signal.aborted) ctx.messages = dropDanglingToolCalls(ctx.messages);
  if (ctx.store && ctx.session) ctx.store.touch(ctx.session.id, { messages: ctx.messages.length, model: ctx.model ? ctx.model.label : null });
  return { finalText, steps: ctx.steps.slice(), changedFiles: [...ctx.changedFiles] };
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
