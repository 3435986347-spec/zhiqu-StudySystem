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
import { archiveTurn, compactNow, hostName, runTurn, setMode } from './agent.js';
import { loadUserConfig, normalizeMode, resetSystemContent, resolveSettings, saveUserConfig, stripSlash, systemContent, userDir, MODES } from './config.js';
import { displayPath, initPrompt, instructionsBlock, loadInstructions } from './instructions.js';
import { McpManager } from './mcp.js';
import { BUILTIN_SYSTEM_PROMPT } from './prompt.js';
import { hunks } from './render/diff.js';
import { SessionStore } from './session.js';
import { discoverSkills, skillsBlock } from './skills.js';
import { LocalTools } from './tools/local.js';
import { Ui } from './ui.js';
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
    else if (a === '--resume') flags.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    else if (a === '--mode') flags.mode = next();
    else if (a === '--model') flags.model = next();
    else if (a === '--server') flags.server = next();
    else if (a === '--token') flags.token = next();
    else if (a === '--no-browser') flags.noBrowser = true;
    else if (a === '--allow-broad-root') flags.allowBroadRoot = true;
    else if (a === '--no-mcp') flags.noMcp = true;
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
  zhiqu login [--server URL]  登录（浏览器里确认，命令行不接触密码）
  zhiqu login --token zqp_…   用个人中心签的令牌登录
  zhiqu logout | whoami | models | help | --version

选项
  --mode plan|ask|auto        档位：只读出计划 / 逐个确认 / 全自动（默认 ask，或 ~/.zhiqu/config.json 里的 mode）
  --model <id>                这次用哪个模型（zhiqu models 列出可用的）
  --server <url>              服务器地址（默认 ${'http://127.0.0.1:47615'}，即本机的桌面应用）
  --no-mcp                    这次不连 MCP 服务器
  --allow-broad-root          允许在家目录或根目录下运行

配置
  ~/.zhiqu/config.json        服务器、令牌、默认模型、默认档位
  <工作区>/.zhiqu/            settings.json、system.md、skills/、mcp.json、会话记录`;

const SLASH_HELP = `/mode [plan|ask|auto]   切换档位（只读出计划 / 逐个确认 / 全自动）
/model [id|default]     查看 / 切换模型
/resume                 列出这个工作区的会话，挑一段接着做
/new                    开一段新会话
/compact                现在就把较早的对话压成摘要
/init                   读项目，写一份 ZHIQU.md 初稿
/skills                 列出可用的 skills
/mcp                    MCP 服务器与工具
/system [path|diff|reset]  系统内容（~/.zhiqu/system.md）
/usage                  这次会话与今天的用量
/exit                   退出（也可以 Ctrl+D）
行尾加 \\ 可以换行接着输入。Ctrl+C 打断正在做的事。`;

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
}

function resumeInto(ctx, id) {
  const loaded = ctx.store.load(id);
  ctx.session = loaded.meta;
  ctx.messages = loaded.messages;
  ctx.archiveOpened = false;
  if (loaded.mode && MODES.includes(loaded.mode)) ctx.mode = loaded.mode;
  ctx.store.touch(id);
  ctx.ui.note(`· 接着「${loaded.meta.title || '（无标题）'}」这段会话（${loaded.messages.length} 条记录${loaded.broken ? `，${loaded.broken} 行坏了已跳过` : ''}）`);
}

function banner(ctx) {
  const { ui } = ctx;
  ui.line(`${ui.paint.bold(`zhiqu ${VERSION}`)} · ${ctx.settings.server}`);
  ui.line(`📁 ${path.basename(ctx.root)}/  ${ui.paint.dim(ctx.root)}`);
  const bits = [`档位：${MODE_LABEL[ctx.mode]}`, `模型：${ctx.model.label}`];
  const n = ctx.instructions.files.length;
  if (n) bits.push(`已加载 ${n} 份说明（${ctx.instructions.files.map((f) => displayPath(f.file, ctx.root, userDir())).join('、')}）`);
  if (ctx.skills.length) bits.push(`${ctx.skills.length} 个 skill`);
  ui.line(ui.paint.dim(`${bits.join(' · ')} · /help`));
  if (ctx.system.notice) ui.note(`· ${ctx.system.notice}`);
  for (const w of ctx.settings.warnings) ui.warn(w);
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
  const ui = new Ui();
  const root = path.resolve(cwd);
  if (broadRoot(root) && !flags.allowBroadRoot) {
    ui.error(`不在 ${root} 下运行：这里是家目录或根目录，工作区会大到把不相干的东西都卷进来。请 cd 到项目目录（确实要的话加 --allow-broad-root）`);
    return 1;
  }
  const settings = resolveSettings(root, flags);
  const modeFlag = flags.mode ? normalizeMode(flags.mode) : null;
  if (flags.mode && !modeFlag) throw new Error(`--mode 只接受 plan / ask / auto，收到 ${flags.mode}`);
  if (!settings.token) {
    if (!process.stdin.isTTY || flags.print) {
      ui.error('还没登录：先运行 zhiqu login（或者设置环境变量 ZHIQU_TOKEN）');
      return 1;
    }
    ui.line('还没登录，先登录一下。');
    if (await login(root, flags, ui) !== 0) return 1;
    Object.assign(settings, resolveSettings(root, flags));
  }
  const api = new Api({ server: settings.server, token: settings.token });
  const ctx = {
    ui, api, root, settings, mode: modeFlag || settings.mode, maxRounds: settings.maxRounds,
    local: new LocalTools({ root, extensions: settings.extensions, commands: settings.allowedCommands, execTimeoutMs: settings.execTimeoutMs }),
    store: new SessionStore(root), allow: { write: false, run: false, mcp: new Set() },
    usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
  };
  try {
    await api.get('/api/harness/me');
    await pickModel(ctx, flags.model ?? settings.model);
    ctx.remoteTools = await api.get('/api/harness/tools').catch((e) => { ui.warn(`远程工具（Wiki / 计划 / 记忆）拿不到：${e.message}`); return []; });
  } catch (e) {
    if (e instanceof ApiError && e.auth) { ui.error(e.message); return 1; }
    throw e;
  }
  loadContext(ctx);
  openSession(ctx, flags);
  if (modeFlag) ctx.mode = modeFlag;
  const updateCheck = checkForUpdate(api).then((v) => updateMessage(v)).catch(() => null);

  if (flags.print != null) {
    await startMcp(ctx, flags);
    const code = await oneShot(ctx, flags.print);
    ctx.mcp && ctx.mcp.close();
    ui.close();
    return code;
  }

  banner(ctx);
  const updateNote = await Promise.race([updateCheck, new Promise((r) => setTimeout(() => r(null), 1500))]);
  if (updateNote) ui.warn(updateNote);
  await startMcp(ctx, flags);
  const code = await repl(ctx);
  ctx.mcp && ctx.mcp.close();
  ui.close();
  return code;
}

async function oneShot(ctx, prompt) {
  const controller = new AbortController();
  ctx.ui.onInterrupt = () => controller.abort();
  process.once('SIGINT', () => controller.abort());
  try {
    const result = await runTurn(ctx, prompt, { signal: controller.signal });
    await archiveTurn(ctx, prompt, result);
    return 0;
  } catch (e) {
    ctx.ui.error(e.message);
    return 1;
  }
}

// ── 交互循环 ────────────────────────────────────────────────────────────

async function readInput(ui) {
  let text = await ui.ask(`${ui.paint.bold('›')} `);
  if (text == null) return null;
  while (text.endsWith('\\')) {
    const more = await ui.ask('  ');
    if (more == null) break;
    text = `${text.slice(0, -1)}\n${more}`;
  }
  return text;
}

async function repl(ctx) {
  const { ui } = ctx;
  let running = null;
  let lastInterrupt = 0;
  ui.onInterrupt = () => {
    if (running) {
      running.abort();
      ui.line(ui.paint.yellow('\n（已中断）'));
      return;
    }
    if (Date.now() - lastInterrupt < 2000) { ui.close(); return; }
    lastInterrupt = Date.now();
    ui.line(ui.paint.dim('\n（再按一次 Ctrl+C 退出，或者输入 /exit）'));
  };
  for (;;) {
    ui.line();
    const input = await readInput(ui);
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
      continue;
    }
    await turn(ctx, text, (c) => { running = c; });
    running = null;
  }
  return 0;
}

async function turn(ctx, text, setRunning) {
  const controller = new AbortController();
  setRunning(controller);
  try {
    const result = await runTurn(ctx, text, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (result.changedFiles.length) ctx.ui.note(`· 这一轮改动的文件：${result.changedFiles.join('、')}`);
    ctx.changedFiles = new Set();
    await archiveTurn(ctx, text, result);
  } catch (e) {
    if (controller.signal.aborted || (e && e.name === 'AbortError')) return;
    ctx.ui.error(e.message);
    if (e instanceof ApiError && e.auth) ctx.ui.note('（令牌失效了：退出后运行 zhiqu login）');
  }
}

async function slash(ctx, text) {
  const { ui } = ctx;
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/exit': case '/quit': return 'exit';
    case '/help': ui.line(SLASH_HELP); return null;
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
      ctx.archiveOpened = false;
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
