// zhiqu 命令行入口。
//
//   zhiqu                     在当前目录开一段会话（交互）
//   zhiqu -p "…"              只跑这一句，打印回答后退出（脚本、测试用）
//   zhiqu -c / --continue     接着上一段会话
//   zhiqu --resume [id]       挑一段会话接着做
//   zhiqu login [--server u]  设备码登录（不在网络上传密码）；--token zqp_… 直接用一张令牌
//   zhiqu logout | whoami | models | --version | help
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api, ApiError } from './api.js';
import { archiveTurn, compactNow, flushArchive, hostName, recordGoal, runGoal, runTurn, setMode, statsNote } from './agent.js';
import { newGoal } from './goal.js';
import { generatedOrigin } from './origins.js';
import { unfinished } from './todos.js';
import { SLASH_COMMANDS, slashHelp } from './commands.js';
import { replayTranscript } from './replay.js';
import { DEFAULT_SERVER, loadUserConfig, normalizeMode, resetSystemContent, resolveSettings, saveUserConfig, stripSlash, systemContent, userDir, MODES } from './config.js';
import { isLoopbackUrl } from './defaults.js';
import { displayPath, initPrompt, instructionsBlock, loadInstructions } from './instructions.js';
import { McpManager } from './mcp.js';
import { BUILTIN_SYSTEM_PROMPT } from './prompt.js';
import { hunks } from './render/diff.js';
import { SessionStore } from './session.js';
import { discoverSkills, skillsBlock } from './skills.js';
import { LocalTools } from './tools/local.js';
import { Ui, briefInput } from './ui.js';
import { ensureLocalServer } from './desktop.js';
import { setWindow, windowLine } from './window.js';
import { checkForUpdate, updateMessage } from './update.js';
import { VERSION } from './version.js';

const MODE_LABEL = {
  plan: 'plan（只读，先出计划）',
  ask: 'ask（写文件、跑命令逐个确认）',
  auto: 'auto（写文件、跑命令不再问，做完再告诉你）',
};

export function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} 后面要跟一个值`); return argv[++i]; };
    if (a === '-p' || a === '--print') flags.print = next();
    else if (a === '-c' || a === '--continue') flags.continue = true;
    else if (a === '--verbose') flags.verbose = true;
    else if (a === '--resume') flags.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    else if (a === '--mode') flags.mode = next();
    else if (a === '--model') flags.model = next();
    else if (a === '--server') flags.server = next();
    else if (a === '--token') flags.token = next();
    else if (a === '--no-browser') flags.noBrowser = true;
    else if (a === '--allow-broad-root') flags.allowBroadRoot = true;
    else if (a === '--no-mcp') flags.noMcp = true;
    else if (a === '--goal') flags.goal = next();
    else if (a === '-v' || a === '--version') flags.version = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a.startsWith('-')) throw new Error(`不认识的参数：${a}（zhiqu help 查看用法）`);
    else flags._.push(a);
  }
  return flags;
}

const HELP = `zhiqu ${VERSION} —— 知趣·象限的命令行 coding agent

用法
  zhiqu                       在当前目录开一段会话
  zhiqu -p "帮我写个贪吃蛇"    只跑这一句，打印回答后退出
  zhiqu -c                    接着上一段会话
  zhiqu --resume [id]         挑一段会话接着做
  zhiqu --goal "目标"          goal 模式：一直做到目标达成并核对通过（配 -p 可以无人值守；退出码 0 达成 / 2 卡住 / 3 轮数用完）
  zhiqu login [--server URL]  登录（浏览器里确认，命令行不接触密码）
  zhiqu login --token zqp_…   用个人中心签的令牌登录
  zhiqu logout | whoami | models | help | --version

选项
  --mode plan|ask|auto        档位：只读出计划 / 逐个确认 / 全自动（默认 ask，或 ~/.zhiqu/config.json 里的 mode）
  --model <id>                这次用哪个模型（zhiqu models 列出可用的）
  --server <url>              服务器地址（默认 ${DEFAULT_SERVER}${isLoopbackUrl(DEFAULT_SERVER) ? '，即本机的桌面应用' : ''}；也可以设 ZHIQU_SERVER）
  --no-mcp                    这次不连 MCP 服务器
  --allow-broad-root          允许在家目录或根目录下运行

配置
  ~/.zhiqu/config.json        服务器、令牌、默认模型、默认档位
  <工作区>/.zhiqu/            settings.json、system.md、skills/、mcp.json、会话记录`;

const SLASH_HELP = slashHelp();

export async function main(argv) {
  const flags = parseArgs(argv);
  if (flags.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  const cmd = flags._[0];
  if (flags.help || cmd === 'help') { process.stdout.write(`${HELP}\n`); return 0; }
  const cwd = process.cwd();
  if (cmd === 'login') return login(cwd, flags);
  if (cmd === 'logout') {
    saveUserConfig({ token: null });
    process.stdout.write('已删除本机保存的令牌。要让它彻底失效，请在网页「个人中心 → 命令行登录」里撤销。\n');
    return 0;
  }
  if (cmd === 'whoami' || cmd === 'models') {
    const settings = resolveSettings(cwd, flags);
    for (const w of settings.warnings) process.stderr.write(`! ${w}\n`);
    const api = new Api({ server: settings.server, token: settings.token });
    if (cmd === 'whoami') {
      const me = await api.get('/api/harness/me');
      process.stdout.write(`${me.nickname || me.username}（${me.username}）· ${settings.server}\n`);
    } else {
      const { models } = await api.get('/api/harness/models');
      for (const m of models) process.stdout.write(`${m.isDefault ? '*' : ' '} ${m.id}  ${m.label}  ${m.modelName}${m.toolCalling ? '' : '  （不支持工具调用）'}\n`);
    }
    return 0;
  }
  if (cmd) throw new Error(`不认识的命令：${cmd}（zhiqu help 查看用法）`);
  return runAgent(cwd, flags);
}

// ── 登录 ────────────────────────────────────────────────────────────────

function openBrowser(url) {
  const [bin, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(bin, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* 打不开就让用户自己点 */ }
}

export async function login(cwd, flags, ui = new Ui()) {
  const settings = resolveSettings(cwd, flags);
  if (!flags.quietWarnings) for (const w of settings.warnings) ui.warn(w);
  const server = stripSlash(flags.server || settings.server);
  if (flags.token) {
    const api = new Api({ server, token: flags.token });
    const me = await api.get('/api/harness/me');
    saveUserConfig({ server, token: flags.token });
    ui.line(`✓ 已登录：${me.nickname || me.username} · ${server}`);
    return 0;
  }
  const api = new Api({ server });
  const start = await api.post('/api/harness/device/start', { clientName: `命令行 · ${hostName()}` });
  const url = server + start.verifyPath;
  ui.line(`在浏览器里打开下面的地址，确认是你本人之后点「允许」：\n\n  ${ui.paint.bold(url)}\n\n设备码：${ui.paint.bold(start.userCode)}（${Math.round(start.expiresIn / 60)} 分钟内有效；也可以在「个人中心 → 命令行登录」里手动输入）`);
  if (!flags.noBrowser && process.stdout.isTTY) openBrowser(url);
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(1, start.interval) * 1000));
    const r = await api.post('/api/harness/device/poll', { deviceCode: start.deviceCode });
    if (r.status === 'APPROVED') {
      saveUserConfig({ server, token: r.token });
      const me = await new Api({ server, token: r.token }).get('/api/harness/me');
      ui.line(`✓ 已登录：${me.nickname || me.username} · ${server}（令牌存在 ${path.join(userDir(), 'config.json')}，600 权限）`);
      return 0;
    }
    if (r.status === 'DENIED') { ui.error('网页上拒绝了这次登录'); return 1; }
    if (r.status === 'EXPIRED') break;
  }
  ui.error('设备码过期了，请重新运行 zhiqu login');
  return 1;
}

// ── 启动 ────────────────────────────────────────────────────────────────

function broadRoot(dir) {
  const d = path.resolve(dir);
  return d === path.parse(d).root || d === os.homedir();
}

async function pickModel(ctx, wanted) {
  const { models, defaultModelId } = await ctx.api.get('/api/harness/models');
  ctx.models = models;
  if (!models.length) throw new Error('这个账号还没有可用的模型：请先在网页「个人中心 → AI 模型配置」里配一个');
  let model = null;
  if (wanted != null && wanted !== 'default') {
    model = models.find((m) => String(m.id) === String(wanted));
    if (!model) ctx.ui.warn(`没有 id 为 ${wanted} 的模型，用默认模型`);
  }
  ctx.model = model || models.find((m) => m.id === defaultModelId) || models[0];
  if (!ctx.model.toolCalling) {
    ctx.ui.warn(`模型「${ctx.model.label}」不支持工具调用 —— 读写文件、跑命令都靠它。用 /model 换一个 OpenAI 兼容或 Anthropic 的模型`);
  }
}

function loadContext(ctx) {
  ctx.system = systemContent(ctx.root);
  const instructions = loadInstructions(ctx.root, userDir());
  ctx.instructions = instructions;
  ctx.instructionsText = instructionsBlock(instructions, ctx.root, userDir());
  ctx.skills = discoverSkills(ctx.root, userDir());
  ctx.skillsText = skillsBlock(ctx.skills);
}

function openSession(ctx, flags) {
  if (flags.continue || flags.resume) {
    const id = typeof flags.resume === 'string' ? flags.resume : (ctx.store.last() || {}).id;
    if (!id) {
      ctx.ui.note('这个工作区还没有会话，开一段新的');
    } else {
      resumeInto(ctx, id);
      return;
    }
  }
  ctx.session = ctx.store.create({ model: ctx.model ? ctx.model.label : null });
  ctx.messages = [];
  ctx.todos = [];
  ctx.request = null;
}

export function resumeInto(ctx, id) {
  const loaded = ctx.store.load(id);
  ctx.session = loaded.meta;
  ctx.messages = loaded.messages;
  if (loaded.mode && MODES.includes(loaded.mode)) ctx.mode = loaded.mode;
  ctx.goal = loaded.goal || null;
  ctx.todos = loaded.todos || [];
  const said = ctx.store.transcript(id);
  // 用户最后一次自己说的话：对话压缩过的话它不在 messages 里了，但仍要置顶（见 agent.js requestBlock）
  const last = said.filter((e) => e.kind === 'message' && e.message.role === 'user' && !e.origin
    && typeof e.message.content === 'string' && !generatedOrigin(e.message.content)).at(-1);
  ctx.request = last ? { text: last.message.content } : null;
  if (ctx.goal && ctx.goal.status === 'active') ctx.ui.note(`· 这段会话有一个还没完成的目标：${ctx.goal.text}（/goal continue 接着追）`);
  const left = unfinished(ctx.todos);
  if (left.length) ctx.ui.note(`· 任务清单还有 ${left.length} 项没做完：${left.map((t) => t.content).join('；')}`);
  ctx.store.touch(id);
  replayTranscript(ctx.ui, said, { verbose: ctx.verbose });
  ctx.ui.note(`· 接着「${loaded.meta.title || '（无标题）'}」这段会话（${loaded.messages.length} 条记录${loaded.broken ? `，${loaded.broken} 行坏了已跳过` : ''}）`);
}

function banner(ctx) {
  const { ui } = ctx;
  ui.line(`${ui.paint.bold(`zhiqu ${VERSION}`)} · ${ctx.settings.server}`);
  ui.line(`📁 ${path.basename(ctx.root)}/  ${ui.paint.dim(ctx.root)}`);
  if (ctx.goal && ctx.goal.status === 'active') ui.line(ui.paint.bold(`🎯 目标：${ctx.goal.text}`));
  const bits = [`档位：${MODE_LABEL[ctx.mode]}`, `模型：${ctx.model.label}`];
  if (ctx.model.contextWindowTokens) bits.push(windowLine(ctx.model));
  const n = ctx.instructions.files.length;
  if (n) bits.push(`已加载 ${n} 份说明（${ctx.instructions.files.map((f) => displayPath(f.file, ctx.root, userDir())).join('、')}）`);
  if (ctx.skills.length) bits.push(`${ctx.skills.length} 个 skill`);
  ui.line(ui.paint.dim(`${bits.join(' · ')} · /help`));
  if (!ctx.model.contextWindowTokens) ui.note(`· ${windowLine(ctx.model)}`);
  if (ctx.system.notice) ui.note(`· ${ctx.system.notice}`);
}

async function startMcp(ctx, flags) {
  if (flags.noMcp) return;
  const mcp = new McpManager({ root: ctx.root, userDir: userDir() });
  ctx.mcp = mcp;
  await mcp.start();
  for (const e of mcp.errors) ctx.ui.warn(e);
  for (const s of mcp.status()) {
    if (s.status === 'ready') ctx.ui.note(`· MCP ${s.name}：${s.tools.length} 个工具`);
    else ctx.ui.warn(`MCP ${s.name} 没连上：${s.error}`);
  }
}

async function runAgent(cwd, flags) {
  const ui = new Ui({ commands: SLASH_COMMANDS });
  const root = path.resolve(cwd);
  if (broadRoot(root) && !flags.allowBroadRoot) {
    ui.error(`不在 ${root} 下运行：这里是家目录或根目录，工作区会大到把不相干的东西都卷进来。请 cd 到项目目录（确实要的话加 --allow-broad-root）`);
    return 1;
  }
  const settings = resolveSettings(root, flags);
  // 配置上的问题（坏掉的配置文件、项目设置里的令牌）一开头就说 —— 原来只在交互横幅的末尾说，-p 单发时一句都不说；
  // 而 config.json 坏了的话下一句就是「还没登录」，不先说清原因，用户只会去重新登录
  for (const w of settings.warnings) ui.warn(w);
  const modeFlag = flags.mode ? normalizeMode(flags.mode) : null;
  if (flags.mode && !modeFlag) throw new Error(`--mode 只接受 plan / ask / auto，收到 ${flags.mode}`);
  if (!settings.token) {
    if (!process.stdin.isTTY || flags.print) {
      ui.error('还没登录：先运行 zhiqu login（或者设置环境变量 ZHIQU_TOKEN）');
      return 1;
    }
    ui.line('还没登录，先登录一下。');
    if (await login(root, { ...flags, quietWarnings: true }, ui) !== 0) return 1;
    Object.assign(settings, resolveSettings(root, flags));
  }
  const api = new Api({ server: settings.server, token: settings.token });
  // 默认连的本机桌面应用没开：macOS 上替用户打开、等它起来（见 desktop.js）
  if (await ensureLocalServer({ api, server: settings.server, ui }) === 'failed') return 1;
  const ctx = {
    ui, api, root, settings, mode: modeFlag || settings.mode, maxRounds: settings.maxRounds, verbose: settings.showThinking,
    local: new LocalTools({ root, extensions: settings.extensions, commands: settings.allowedCommands, execTimeoutMs: settings.execTimeoutMs }),
    store: new SessionStore(root), allow: { write: false, run: false, delete: false, mcp: new Set() },
    usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
  };
  try {
    // 三个请求互不依赖，一起发（原来一个等一个，服务器远的时候启动慢一倍多）
    const [, , remote] = await Promise.all([
      api.get('/api/harness/me'),
      pickModel(ctx, flags.model ?? settings.model),
      // 连不上服务器时下一行会报，这里就不再叠一句（原来同一个「连不上」报两遍）
      api.get('/api/harness/tools').catch((e) => { if (e.status) ui.warn(`远程工具（Wiki / 计划 / 记忆）拿不到：${e.message}`); return []; }),
    ]);
    ctx.remoteTools = remote;
  } catch (e) {
    if (e instanceof ApiError && e.auth) { ui.error(e.message); return 1; }
    throw e;
  }
  loadContext(ctx);
  openSession(ctx, flags);
  if (modeFlag) ctx.mode = modeFlag;
  if (flags.goal) {
    ctx.goal = newGoal(flags.goal);
    recordGoal(ctx);
  }
  const updateCheck = checkForUpdate(api).then((v) => updateMessage(v)).catch(() => null);

  if (flags.print != null || (flags.goal && !process.stdin.isTTY)) {
    await startMcp(ctx, flags);
    const code = flags.goal ? await goalShot(ctx) : await oneShot(ctx, flags.print);
    await flushArchive(ctx);
    ctx.mcp && ctx.mcp.close();
    ui.close();
    return code;
  }

  banner(ctx);
  // MCP 在后台连：用户打第一句话的这段时间里它就连好了；第一轮开始前再等它（见 turn）
  ctx.mcpReady = startMcp(ctx, flags).catch((e) => ui.warn(`MCP 启动失败：${e.message}`));
  const updateNote = await Promise.race([updateCheck, new Promise((r) => setTimeout(() => r(null), 1500).unref())]);
  if (updateNote) ui.warn(updateNote);
  const onUnhandled = (e) => ui.error(`内部错误（会话没有受影响）：${e && e.message ? e.message : e}`);
  process.on('unhandledRejection', onUnhandled);
  const code = await repl(ctx, flags);
  process.off('unhandledRejection', onUnhandled);
  await flushArchive(ctx);
  ctx.mcp && ctx.mcp.close();
  ui.close();
  return code;
}

/** 无人值守地追一个目标（--goal 配 -p，或者输入不是终端）。退出码：0 达成、2 卡住、3 轮数用完、1 出错 / 被打断。 */
async function goalShot(ctx) {
  const controller = new AbortController();
  ctx.ui.onInterrupt = () => controller.abort();
  process.once('SIGINT', () => controller.abort());
  try {
    const outcome = await runGoal(ctx, { signal: controller.signal, onTurn: (text, result) => { turnNote(ctx, result); archiveTurn(ctx, text, result); } });
    return { achieved: 0, blocked: 2, exhausted: 3 }[outcome] ?? 1;
  } catch (e) {
    ctx.ui.error(e.message);
    return 1;
  }
}

async function oneShot(ctx, prompt) {
  const controller = new AbortController();
  ctx.ui.onInterrupt = () => controller.abort();
  process.once('SIGINT', () => controller.abort());
  try {
    const result = await runTurn(ctx, prompt, { signal: controller.signal });
    archiveTurn(ctx, prompt, result);
    return 0;
  } catch (e) {
    ctx.ui.error(e.message);
    return 1;
  }
}

// ── 交互循环 ────────────────────────────────────────────────────────────

async function readInput(ui) {
  // 干活时排队的消息：这一轮结束后按顺序发出，并把它作为「› 消息」留在记录里 —— 回头看得出这是用户说的
  const queued = ui.interactive ? ui.takeQueued() : undefined;
  if (queued !== undefined) {
    ui.line(`${ui.paint.bold('›')} ${briefInput(queued)}`);   // 粘贴的一大段只留一行摘要
    return queued;
  }
  let text = await ui.ask(`${ui.paint.bold('›')} `);
  if (text == null) return null;
  while (text.endsWith('\\')) {
    const more = await ui.ask('  ');
    if (more == null) break;
    text = `${text.slice(0, -1)}\n${more}`;
  }
  return text;
}

/** 打断之后这么久之内的 Ctrl+C 算同一次「停下」，不算「退出」。 */
export const STOP_GRACE_MS = 800;

/**
 * 交互时的 Ctrl+C（第十三轮真终端暴力测试定的）：
 * - 干活时：停下这一轮；正在问的确认一并作废（按不同意算）—— 否则问题还挂着，下一句话被当成回答吃掉；
 *   排队的消息放回输入框、不发 —— 否则停下之后它们接着被发出去，又干起来了。
 *   已经在停了（命令还在收尾）再按，不再每下打一行「已中断」。
 * - 刚停下的那一小会儿（STOP_GRACE_MS）：不算数。想让它停下的人会连按好几下，原来第三下就把程序退了。
 * - 空闲时：按一下提示，两秒内再按一下退出。
 */
export function interruptHandler(ui, running, clock = Date.now) {
  let lastAbort = -Infinity;
  let lastHint = -Infinity;
  return () => {
    const controller = running();
    if (controller) {
      if (controller.signal.aborted) return;
      ui.cancelQuestion();
      controller.abort();
      ui.unqueue();
      lastAbort = clock();
      ui.line(ui.paint.yellow('\n（已中断）'));
      return;
    }
    const now = clock();
    if (now - lastAbort < STOP_GRACE_MS) return;
    if (now - lastHint < 2000) { ui.close(); return; }
    lastHint = now;
    ui.line(ui.paint.dim('\n（再按一次 Ctrl+C 退出，或者输入 /exit）'));
  };
}

async function repl(ctx, flags = {}) {
  const { ui } = ctx;
  let running = null;
  ui.onInterrupt = interruptHandler(ui, () => running);
  if (flags.goal) {
    await pursue(ctx, (c) => { running = c; });
    running = null;
  }
  for (;;) {
    // 收起上一轮的活动区、空一行、画出下一个提示符 —— 一帧写完。turn / pursue 结束时不自己收：
    // 分开写的话，「收起」和「画提示符」之间那一刻输入框不见（2026-09-27 真终端实录里每轮结尾一次）
    const input = await ui.frame(() => {
      ui.endLive();
      ui.line();
      return readInput(ui);
    });
    if (input == null) break;
    const text = input.trim();
    if (!text) continue;
    if (text.startsWith('/')) {
      const r = await slash(ctx, text);
      if (r === 'exit') break;
      if (typeof r === 'object' && r && r.turn) {
        await turn(ctx, r.turn, (c) => { running = c; });
        running = null;
      }
      if (r === 'goal') {
        await pursue(ctx, (c) => { running = c; });
        running = null;
      }
      continue;
    }
    await turn(ctx, text, (c) => { running = c; });
    running = null;
  }
  return 0;
}

/** 第一轮要等 MCP 服务器起来（工具表里要有它们）；等的时候状态行说在等什么，输入框照常在。 */
async function mcpStarted(ctx) {
  if (!ctx.mcpReady) return;
  ctx.ui.status.set(ctx.ui.paint.dim('… 等 MCP 服务器启动'));
  try {
    await ctx.mcpReady;
  } finally {
    ctx.mcpReady = null;
    ctx.ui.status.clear();
  }
}

async function pursue(ctx, setRunning) {
  const controller = new AbortController();
  setRunning(controller);
  ctx.ui.beginLive();      // 干活时输入框一直在（见 ui.js）—— 等 MCP 启动的那一段也在
  await mcpStarted(ctx);
  try {
    await runGoal(ctx, { signal: controller.signal, onTurn: (text, result) => { turnNote(ctx, result); archiveTurn(ctx, text, result); } });
  } catch (e) {
    if (controller.signal.aborted || (e && e.name === 'AbortError')) {
      ctx.ui.note('（已停下；/goal continue 接着追）');
      return;
    }
    ctx.ui.error(e.message);
  }
}

async function turn(ctx, text, setRunning) {
  const controller = new AbortController();
  setRunning(controller);
  ctx.ui.beginLive();      // 干活时输入框一直在（见 ui.js）—— 等 MCP 启动的那一段也在
  await mcpStarted(ctx);
  try {
    const result = await runTurn(ctx, text, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (result.changedFiles.length) ctx.ui.note(`· 这一轮改动的文件：${result.changedFiles.join('、')}`);
    ctx.changedFiles = new Set();
    turnNote(ctx, result);
    archiveTurn(ctx, text, result);   // 后台发，不挡下一句话
  } catch (e) {
    if (controller.signal.aborted || (e && e.name === 'AbortError')) return;
    ctx.ui.error(e.message);
    if (e instanceof ApiError && e.auth) ctx.ui.note('（令牌失效了：退出后运行 zhiqu login）');
  }
}

/** 一轮结束：安静模式下读 / 搜没有留成行，说一句个数。 */
function turnNote(ctx, result) {
  const note = !ctx.verbose && result ? statsNote(result.stats) : '';
  if (note) ctx.ui.note(note);
}

async function slash(ctx, text) {
  const { ui } = ctx;
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/exit': case '/quit': return 'exit';
    case '/help': ui.line(SLASH_HELP); return null;
    case '/goal': {
      if (!arg) {
        if (!ctx.goal) { ui.line('没有目标。/goal <目标> 设一个：它会一直做到目标达成并核对通过'); return null; }
        const st = { active: '进行中', achieved: '已达成', blocked: '卡住了' }[ctx.goal.status];
        ui.line(`🎯 ${ctx.goal.text}\n状态：${st} · 已推进 ${ctx.goal.turns} 轮${ctx.goal.blocker ? `\n卡在：${ctx.goal.blocker}` : ''}${ctx.goal.evidence ? `\n证据：${ctx.goal.evidence}` : ''}`);
        return null;
      }
      if (arg === 'clear') { ctx.goal = null; recordGoal(ctx); ui.line('已放下目标'); return null; }
      if (arg === 'continue') {
        if (!ctx.goal) { ui.error('没有目标可以接着追'); return null; }
        ctx.goal.status = 'active';
        recordGoal(ctx);
        return 'goal';
      }
      ctx.goal = newGoal(arg);
      recordGoal(ctx);
      ui.line(ui.paint.bold(`🎯 目标：${ctx.goal.text}`));
      if (ctx.mode !== 'auto') ui.note(`（现在是 ${ctx.mode} 档：写文件、跑命令还会逐个问你。想让它自己一路做完，/mode auto）`);
      return 'goal';
    }
    case '/mode': {
      if (!arg) { ui.line(`当前档位：${MODE_LABEL[ctx.mode]}\n可选：${MODES.map((m) => `${m} = ${MODE_LABEL[m]}`).join('；')}`); return null; }
      const m = normalizeMode(arg);
      if (!m) { ui.error('只有 plan / ask / auto 三档（read / write / exec 也认）'); return null; }
      setMode(ctx, m);
      ctx.allow.write = false;
      ctx.allow.run = false;
      ui.line(`档位：${MODE_LABEL[m]}`);
      return null;
    }
    case '/model': {
      if (!arg) {
        for (const m of ctx.models) ui.line(`${m.id === ctx.model.id ? '*' : ' '} ${m.id}  ${m.label}  ${ui.paint.dim(m.modelName)}${m.toolCalling ? '' : ui.paint.yellow('  不支持工具调用')}`);
        ui.note('/model <id> 切换（只对这次会话有效）；/model default 回到默认');
        return null;
      }
      await pickModel(ctx, arg);
      ui.line(`模型：${ctx.model.label}`);
      return null;
    }
    case '/new':
      ctx.session = ctx.store.create({ model: ctx.model.label });
      ctx.messages = [];
      ctx.todos = [];
      ctx.request = null;
      ui.line('已开一段新会话');
      return null;
    case '/resume': case '/sessions': {
      const list = ctx.store.list().filter((s) => s.id !== ctx.session.id);
      if (!list.length) { ui.line('这个工作区没有别的会话'); return null; }
      if (arg) {
        const hit = /^\d+$/.test(arg) && Number(arg) <= list.length ? list[Number(arg) - 1] : list.find((s) => s.id === arg);
        if (!hit) { ui.error(`没有 ${arg} 这段会话`); return null; }
        resumeInto(ctx, hit.id);
        return null;
      }
      list.slice(0, 20).forEach((s, i) => ui.line(`${String(i + 1).padStart(2)}. ${s.title || '（无标题）'}  ${ui.paint.dim(`${localTime(s.updatedAt)} · ${s.messages || 0} 条`)}`));
      const pick = await ui.ask('接着哪一段？输入编号（回车取消）› ');
      const n = Number((pick || '').trim());
      if (n >= 1 && n <= list.length) resumeInto(ctx, list[n - 1].id);
      return null;
    }
    case '/compact':
      try { await compactNow(ctx, undefined, { manual: true }); } catch (e) { ui.error(e.message); }
      return null;
    case '/init':
      return { turn: initPrompt(fs.existsSync(path.join(ctx.root, 'ZHIQU.md'))) };
    case '/skills':
      if (!ctx.skills.length) { ui.line('没有 skill。把 SKILL.md 放进 .zhiqu/skills/<名字>/（项目级）或 ~/.zhiqu/skills/<名字>/（用户级）'); return null; }
      for (const s of ctx.skills) ui.line(`${s.name}  ${ui.paint.dim(`（${s.source === 'project' ? '项目' : '用户'}）`)} ${s.description}`);
      return null;
    case '/mcp': {
      const status = ctx.mcp ? ctx.mcp.status() : [];
      if (!status.length) { ui.line('没有配置 MCP 服务器。配置写在 .zhiqu/mcp.json（或 ~/.zhiqu/mcp.json）的 mcpServers 里'); return null; }
      for (const s of status) {
        ui.line(`${s.name}（${s.transport}，${s.source === 'project' ? '项目' : '用户'}）：${s.status === 'ready' ? `${s.tools.length} 个工具` : `没连上 —— ${s.error}`}`);
        if (s.tools.length) ui.note(`    ${s.tools.join('、')}`);
      }
      return null;
    }
    case '/system': {
      if (arg === 'reset') { const f = resetSystemContent(); ctx.system = systemContent(ctx.root); ui.line(`已把 ${f} 换成内置版本`); return null; }
      if (arg === 'diff') { ui.diff(hunks(ctx.system.text, BUILTIN_SYSTEM_PROMPT, 2)); return null; }
      ui.line(`正在用的系统内容：${ctx.system.file}（${ctx.system.source === 'project' ? '工作区' : '用户级'}）\n/system diff 看它和内置版本的差别，/system reset 换回内置版本`);
      return null;
    }
    case '/window': {
      try {
        ui.line(await setWindow(ctx, arg));
      } catch (e) {
        ui.error(`没设成：${e.message}`);
      }
      return null;
    }
    case '/verbose': {
      ctx.verbose = !ctx.verbose;
      saveUserConfig({ showThinking: ctx.verbose });
      ui.line(ctx.verbose ? '显示思考过程：模型的每一段分析、每一次读文件都打印出来（再输一次 /verbose 关掉）'
        : '隐藏思考过程：只显示结论和改了什么，思考时状态行是一个动的小图案（再输一次 /verbose 打开）');
      return null;
    }
    case '/usage': {
      ui.line(`这次会话：输入约 ${ctx.usage.prompt} token，输出约 ${ctx.usage.completion} token`);
      try {
        const u = await ctx.api.get('/api/harness/usage');
        ui.line(`今天（命令行）：${u.today.calls} 次调用，输入 ${u.today.promptTokens}、输出 ${u.today.completionTokens} token`);
      } catch (e) { ui.note(`（服务器上的用量拿不到：${e.message}）`); }
      return null;
    }
    default:
      ui.error(`不认识的命令 ${cmd}，/help 查看`);
      return null;
  }
}

/** 记录里存的是 UTC（ISO）；给人看的换成本地时间。 */
export function localTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export { loadUserConfig };
