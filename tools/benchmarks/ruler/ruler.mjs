#!/usr/bin/env node
// 尺子（第九十轮）：一组本机就能跑的小题，用来量 coding agent 的改动有没有用。
// 每题：repo/（带毛病的小仓库，模型在这里干活）、issue.md（照真实 issue 写的问题，带例子和边界）、
// hidden/（模型看不到的测试，干完以后才放进去跑）、gold/（参考答案，只给对照组用）、task.json（隐藏 / 公开测试怎么跑）。
// 过没过只看隐藏测试的退出码。同一题跑几遍，算通过率和波动 —— 第八十八轮一题一遍下结论吃过亏。
//
//   node tools/benchmarks/ruler/ruler.mjs --cli <命令行目录> --server <网关> --setup <setup.json> --runs 3 --label new --out results.jsonl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { sessionMetrics } from './memory-metrics.mjs';

export const TASKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tasks');

export function listTasks(dir = TASKS_DIR) {
  return fs.readdirSync(dir).filter((name) => fs.existsSync(path.join(dir, name, 'task.json'))).sort().map((name) => {
    const root = path.join(dir, name);
    return { name, root, issue: fs.readFileSync(path.join(root, 'issue.md'), 'utf8').trim(), ...JSON.parse(fs.readFileSync(path.join(root, 'task.json'), 'utf8')) };
  });
}

/** 拷一份题目仓库到 dest（overlay = 'gold' 时再盖上参考答案），做成一个只有一个提交的 git 仓库（git diff 能用） */
export function prepareWorkspace(task, dest, { overlay } = {}) {
  fs.cpSync(path.join(task.root, 'repo'), dest, { recursive: true });
  if (overlay) fs.cpSync(path.join(task.root, overlay), dest, { recursive: true });
  const git = (...args) => spawnSync('git', ['-c', 'user.email=ruler@local', '-c', 'user.name=ruler', ...args], { cwd: dest, encoding: 'utf8' });
  git('init', '-q', '.'); git('add', '-A'); git('commit', '-qm', 'base');
  return dest;
}

const run = (argv, cwd, timeoutMs = 60_000) => {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: timeoutMs, env: { PATH: process.env.PATH, HOME: cwd, PYTHONDONTWRITEBYTECODE: '1' } });
  return { pass: r.status === 0, status: r.status, output: `${r.stdout || ''}${r.stderr || ''}`.slice(-3000) };
};

/** 隐藏测试：拷进工作区（同名就盖掉模型写的）再跑 */
export function runHidden(task, ws) {
  fs.cpSync(path.join(task.root, 'hidden'), ws, { recursive: true });
  return run(task.run, ws);
}

export const runVisible = (task, ws) => run(task.visible, ws);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** 一题跑一遍：用 cliDir 那一版命令行的 runTurn 在一份新的工作区里干活，干完跑隐藏测试 */
/**
 * window：把模型的上下文窗口改小（第一百四十四轮，记忆第 8 步：3.2 万下的长活题量压缩之后的表现）。
 * direct：{ url, model, key, protocol } —— 不经网关直连（量 DeepSeek 时用；key 由调用方从临时文件读，不进结果）。
 * price：每百万 token 的价（{ hit, miss, output }，元），给了就算花费。
 */
export async function runEpisode(task, { cliDir, server, token, modelId, maxRounds = 30, timeoutMs = 480_000, window = null, direct = null, price = null }) {
  const imp = (p) => import(path.join(cliDir, 'src', p));
  const { Api } = await imp('api.js'); const { runTurn } = await imp('agent.js'); const { BUILTIN_SYSTEM_PROMPT } = await imp('prompt.js');
  const { LocalTools } = await imp('tools/local.js'); const { SessionStore } = await imp('session.js'); const { Ui } = await imp('ui.js');
  const ws = prepareWorkspace(task, tmp(`ruler-${task.name}-`));
  let api = null;
  let modelClient = null;
  let model;
  if (direct) {
    const { DirectModel } = await imp('direct.js');
    modelClient = new DirectModel(direct);
    // 直连 OpenAI 兼容接口时命令行没要用量、DeepSeek 不说就默认思考（第一百四十轮记下的，没改）。尺子在发出去的那一刻补上
    // 要用量、温度 0、不思考 —— 在 JSON 那一层补，新旧两版命令行（老版没有 payload 这个口子）补得一样，对照才公平
    if (modelClient.protocol === 'openai') {
      const original = modelClient.stream.bind(modelClient);
      const extra = { stream_options: { include_usage: true }, temperature: 0, ...(/deepseek/i.test(direct.model) ? { thinking: { type: 'disabled' } } : {}) };
      modelClient.stream = async (...args) => {
        const stringify = JSON.stringify;
        JSON.stringify = (v, ...rest) => stringify(v && typeof v === 'object' && v.model === direct.model && Array.isArray(v.messages) ? { ...v, ...extra } : v, ...rest);
        try { return await original(...args); } finally { JSON.stringify = stringify; }
      };
    }
    model = { id: null, label: direct.model, modelName: direct.model, toolCalling: true, effectiveContextWindow: direct.contextWindow || 64_000 };
  } else {
    api = new Api({ server, token });
    const models = await api.get('/api/harness/models');
    model = (Array.isArray(models) ? models : models.models || models).find((m) => m.id === modelId);
    if (!model) throw new Error(`网关上没有模型 ${modelId}`);
  }
  if (window) model = { ...model, effectiveContextWindow: window };
  let out = '';
  const ui = new Ui({ input: new PassThrough(), output: new Writable({ write(c, e, cb) { out += c; cb(); } }), interactive: false, color: false });
  const store = new SessionStore(ws);
  const ctx = { api, modelClient, settings: direct ? { direct } : {}, ui, root: ws, mode: 'auto', maxRounds, local: new LocalTools({ root: ws }), store, session: store.create({ model: model.label }),
    messages: [], allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() }, usage: { prompt: 0, completion: 0, cached: 0 },
    changedFiles: new Set(), todos: [], system: { text: BUILTIN_SYSTEM_PROMPT }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    verbose: false, archiveDisabled: true, model };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  let error = null;
  try { await runTurn(ctx, task.issue, { signal: controller.signal }); } catch (e) { error = String(e && e.message || e); } finally { clearTimeout(timer); }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const toolRounds = ctx.messages.filter((m) => m.role === 'assistant' && (m.tool_calls || []).length).length;
  // 各工具调了几次、写 / 改文件因为参数给错了工具被拒几次（第九十二轮拆开 write_file / edit_file 之后看模型会不会用）
  const calls = {};
  for (const m of ctx.messages) for (const c of m.role === 'assistant' ? m.tool_calls || [] : []) calls[c.function.name] = (calls[c.function.name] || 0) + 1;
  const wrongTool = ctx.messages.filter((m) => m.role === 'tool' && /write_file 只管整份写入和追加|edit_file 没有 content 这个参数/.test(m.content || '')).length;
  // 记忆第 8 步的几个数：从这段会话的记录里算（压缩后几步才动手、重复读取、清单倒退、命中率、花费）
  const events = [];
  try {
    for (const line of fs.readFileSync(store.file(ctx.session.id), 'utf8').split('\n')) {
      if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* 坏行跳过 */ } }
    }
  } catch { /* 没有记录 */ }
  const metrics = sessionMetrics(events, { price });
  // 老版本（第一百四十轮之前）不往记录里写用量：用这一遍在内存里累计的（总数一样，只是没有逐次的）
  if (!metrics.calls && ctx.usage && ctx.usage.prompt) {
    const u = ctx.usage;
    metrics.prompt = u.prompt; metrics.completion = u.completion || 0; metrics.cached = u.cached || 0;
    metrics.hitRate = u.cached != null ? (u.cached || 0) / u.prompt : null;
    metrics.cost = price ? ((u.cached || 0) * price.hit + (u.prompt - (u.cached || 0)) * price.miss + (u.completion || 0) * price.output) / 1e6 : null;
    metrics.usageFrom = 'memory';
  }
  const visible = runVisible(task, ws);
  const hidden = runHidden(task, ws);
  return { task: task.name, pass: hidden.pass, visiblePass: visible.pass, seconds, toolRounds, calls, wrongTool, usage: ctx.usage, aborted: controller.signal.aborted,
    error, changed: [...ctx.changedFiles], metrics, window: model.effectiveContextWindow, hiddenTail: hidden.pass ? '' : hidden.output.slice(-600), workspace: ws };
}

function parseArgs(argv) {
  const opts = { runs: 3, maxRounds: 30 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--cli': 'cli', '--server': 'server', '--setup': 'setup', '--runs': 'runs', '--label': 'label', '--out': 'out', '--tasks': 'tasks', '--max-rounds': 'maxRounds', '--window': 'window' }[argv[i]];
    if (!key || argv[i + 1] == null) throw new Error(`不认识的参数：${argv[i]}`);
    opts[key] = ['runs', 'maxRounds', 'window'].includes(key) ? Number(argv[i + 1]) : argv[i + 1];
  }
  // setup.json 里有 direct 就不经网关（--server 可以不给）
  for (const k of ['cli', 'setup', 'label', 'out']) if (!opts[k]) throw new Error(`缺 --${k}`);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const setup = JSON.parse(fs.readFileSync(opts.setup, 'utf8'));
  const tasks = listTasks().filter((t) => !opts.tasks || opts.tasks.split(',').includes(t.name));
  // 一遍一遍轮着跑（第 1 遍各题、第 2 遍各题……），不是一题连跑几遍：网关那一侧的波动摊到各题上
  for (let r = 1; r <= opts.runs; r++) {
    for (const task of tasks) {
      if (!setup.direct && !opts.server) throw new Error('缺 --server（或者在 setup.json 里给 direct）');
      const direct = setup.direct ? { ...setup.direct, key: setup.direct.keyFile ? fs.readFileSync(setup.direct.keyFile, 'utf8').trim() : setup.direct.key } : null;
      const res = await runEpisode(task, { cliDir: path.resolve(opts.cli), server: opts.server, token: setup.token, modelId: setup.modelId, maxRounds: opts.maxRounds,
        window: opts.window || null, direct, price: setup.price || null })
        .catch((e) => ({ task: task.name, pass: false, error: String(e && e.message || e) }));
      const row = { label: opts.label, run: r, at: new Date().toISOString(), ...res };
      fs.appendFileSync(opts.out, `${JSON.stringify(row)}\n`);
      const m = res.metrics;
      process.stderr.write(`${opts.label} #${r} ${task.name}: ${res.pass ? '过' : '没过'}  ${res.toolRounds ?? '-'} 轮  ${res.usage ? res.usage.prompt : '-'} 输入`
        + (m ? `  压缩 ${m.compactions}（之后 ${m.stepsToAct.map((x) => x ?? '—').join('/') || '-'} 步动手）  重复读 ${Math.round(m.repeatedShare * 100)}%  清单倒退 ${m.todoRegressions}`
          + `  命中 ${m.hitRate == null ? '-' : `${Math.round(m.hitRate * 100)}%`}${m.cost == null ? '' : `  ¥${m.cost.toFixed(3)}`}` : '')
        + `${res.error ? `  错：${res.error.slice(0, 80)}` : ''}\n`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`ruler: ${e.message}\n`); process.exit(1); });
}
