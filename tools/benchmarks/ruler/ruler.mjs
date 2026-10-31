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
export async function runEpisode(task, { cliDir, server, token, modelId, maxRounds = 30, timeoutMs = 480_000 }) {
  const imp = (p) => import(path.join(cliDir, 'src', p));
  const { Api } = await imp('api.js'); const { runTurn } = await imp('agent.js'); const { BUILTIN_SYSTEM_PROMPT } = await imp('prompt.js');
  const { LocalTools } = await imp('tools/local.js'); const { SessionStore } = await imp('session.js'); const { Ui } = await imp('ui.js');
  const ws = prepareWorkspace(task, tmp(`ruler-${task.name}-`));
  const api = new Api({ server, token });
  const models = await api.get('/api/harness/models');
  const model = (Array.isArray(models) ? models : models.models || models).find((m) => m.id === modelId);
  if (!model) throw new Error(`网关上没有模型 ${modelId}`);
  let out = '';
  const ui = new Ui({ input: new PassThrough(), output: new Writable({ write(c, e, cb) { out += c; cb(); } }), interactive: false, color: false });
  const store = new SessionStore(ws);
  const ctx = { api, ui, root: ws, mode: 'auto', maxRounds, local: new LocalTools({ root: ws }), store, session: store.create({ model: model.label }),
    messages: [], allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 },
    changedFiles: new Set(), todos: [], system: { text: BUILTIN_SYSTEM_PROMPT }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    verbose: false, archiveDisabled: true, model };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  let error = null;
  try { await runTurn(ctx, task.issue, { signal: controller.signal }); } catch (e) { error = String(e && e.message || e); } finally { clearTimeout(timer); }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const toolRounds = ctx.messages.filter((m) => m.role === 'assistant' && (m.tool_calls || []).length).length;
  const nudges = ctx.messages.filter((m) => m.role === 'user' && /交活之前核对一遍/.test(m.content || '')).length;
  const visible = runVisible(task, ws);
  const hidden = runHidden(task, ws);
  return { task: task.name, pass: hidden.pass, visiblePass: visible.pass, seconds, toolRounds, nudges, usage: ctx.usage, aborted: controller.signal.aborted,
    error, changed: [...ctx.changedFiles], hiddenTail: hidden.pass ? '' : hidden.output.slice(-600), workspace: ws };
}

function parseArgs(argv) {
  const opts = { runs: 3, maxRounds: 30 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--cli': 'cli', '--server': 'server', '--setup': 'setup', '--runs': 'runs', '--label': 'label', '--out': 'out', '--tasks': 'tasks', '--max-rounds': 'maxRounds' }[argv[i]];
    if (!key || argv[i + 1] == null) throw new Error(`不认识的参数：${argv[i]}`);
    opts[key] = ['runs', 'maxRounds'].includes(key) ? Number(argv[i + 1]) : argv[i + 1];
  }
  for (const k of ['cli', 'server', 'setup', 'label', 'out']) if (!opts[k]) throw new Error(`缺 --${k}`);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const setup = JSON.parse(fs.readFileSync(opts.setup, 'utf8'));
  const tasks = listTasks().filter((t) => !opts.tasks || opts.tasks.split(',').includes(t.name));
  // 一遍一遍轮着跑（第 1 遍各题、第 2 遍各题……），不是一题连跑几遍：网关那一侧的波动摊到各题上
  for (let r = 1; r <= opts.runs; r++) {
    for (const task of tasks) {
      const res = await runEpisode(task, { cliDir: path.resolve(opts.cli), server: opts.server, token: setup.token, modelId: setup.modelId, maxRounds: opts.maxRounds })
        .catch((e) => ({ task: task.name, pass: false, error: String(e && e.message || e) }));
      const row = { label: opts.label, run: r, at: new Date().toISOString(), ...res };
      fs.appendFileSync(opts.out, `${JSON.stringify(row)}\n`);
      process.stderr.write(`${opts.label} #${r} ${task.name}: ${res.pass ? '过' : '没过'}  ${res.toolRounds ?? '-'} 轮  ${res.usage ? res.usage.prompt : '-'} 输入${res.error ? `  错：${res.error.slice(0, 80)}` : ''}\n`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`ruler: ${e.message}\n`); process.exit(1); });
}
