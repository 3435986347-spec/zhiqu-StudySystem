import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { slash } from '../src/cli.js';
import { SLASH_COMMANDS, slashHelp } from '../src/commands.js';
import { ProjectMemory } from '../src/memory.js';
import { SessionStore } from '../src/session.js';
import { fakeUi, tmpdir } from './helpers.js';

const MODELS = [
  { id: 1, label: '模型甲', modelName: 'a', toolCalling: true },
  { id: 2, label: '模型乙', modelName: 'b', toolCalling: false },
];
function base() {
  const root = tmpdir(), ui = fakeUi();
  ui.interactive = true;
  const store = new SessionStore(root);
  return {
    root, ui, store, session: store.create({ title: '当前会话' }), models: MODELS.slice(), model: MODELS[0], effort: 'medium', mode: 'plan',
    api: { get: async (url) => url === '/api/harness/models' ? { models: MODELS, defaultModelId: 1 } : [] },
    allow: { write: true, run: true }, messages: [], todos: [], agents: null,
    local: { jobs: { running: () => [], list: () => [] } },
  };
}

test('/model 打开双轴面板：选第二个模型、右移思考档，Enter 后才一起应用并保存', async () => {
  const ctx = base(); let offered;
  ctx.ui.pick = async (options) => { offered = options; options.horizontal(1); return options.items[1].value; };
  const home = tmpdir(), old = process.env.ZHIQU_HOME; process.env.ZHIQU_HOME = home;
  try {
    assert.equal(ctx.model.id, 1); assert.equal(ctx.effort, 'medium');
    await slash(ctx, '/model');
    assert.ok(offered, '无参数 /model 仍只打印文字，没有打开选择器');
    assert.equal(offered.items.length, 2);
    assert.equal(ctx.model.id, 2);
    assert.equal(ctx.effort, 'high');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).effort, 'high');
  } finally { if (old === undefined) delete process.env.ZHIQU_HOME; else process.env.ZHIQU_HOME = old; }
});

test('/mode 无参数选择 ask；Enter 后复用原档位切换和权限清理', async () => {
  const ctx = base(); let offered;
  ctx.ui.pick = async (options) => { offered = options; return options.items[1].value; };
  await slash(ctx, '/mode');
  assert.ok(offered, '/mode 没有打开三档选择器');
  assert.equal(ctx.mode, 'ask');
  assert.equal(ctx.allow.write, false); assert.equal(ctx.allow.run, false);
});

test('/resume 把本地会话放进选择器，Enter 直接恢复，不再询问数字', async () => {
  const ctx = base();
  const target = ctx.store.create({ title: '要恢复的会话' });
  ctx.session = ctx.store.create({ title: '当前另一段' });
  let offered; ctx.ui.pick = async (options) => {
    offered = options;
    const entry = options.items.find((item) => item.value.row && item.value.row.id === target.id);
    assert.ok(entry, '目标会话没有出现在选择器里');
    return entry.value;
  };
  await slash(ctx, '/resume');
  assert.ok(offered, '/resume 仍在使用数字输入');
  assert.equal(ctx.session.id, target.id);
});

test('/agents 无参数选中子 agent 后显示原结论报告', async () => {
  const ctx = base(); const agent = { id: 'explorer-1' }; let offered;
  ctx.agents = { list: () => [agent], row: (a) => a.id, report: (a) => `报告：${a.id}` };
  ctx.ui.pick = async (options) => { offered = options; return options.items[0].value; };
  await slash(ctx, '/agents');
  assert.ok(offered, '/agents 仍要求再输编号');
  assert.match(ctx.ui.text(), /报告：explorer-1/);
});

test('/stop 无参数选择任务，确认后才停止；取消没有副作用', async () => {
  const ctx = base(); const stopped = []; let offered;
  const job = { id: 'job-1', command: 'sleep 60' };
  ctx.local.jobs.running = () => [job];
  ctx.local.stopJob = async ({ id }) => { stopped.push(id); return {}; };
  ctx.ui.pick = async (options) => { offered = options; return options.items[0].value; };
  ctx.ui.ask = async () => 'n';
  await slash(ctx, '/stop');
  assert.ok(offered, '/stop 没有列出运行中任务');
  assert.deepEqual(stopped, [], '取消确认仍停止了任务');
  ctx.ui.ask = async () => 'y';
  await slash(ctx, '/stop');
  assert.deepEqual(stopped, ['job-1']);
});

test('/memory 选择笔记看全文；/memory rm 无编号选择并确认删除', async () => {
  const ctx = base();
  const mem = new ProjectMemory(path.join(ctx.root, '.zhiqu', 'memory'), ctx.root);
  mem.ensure(); mem.write({ type: 'pitfall', title: '缓存令牌', text: '改了静态资源必须同步缓存令牌。' });
  let offered; ctx.ui.pick = async (options) => { offered = options; return options.items[0].value; };
  await slash(ctx, '/memory');
  assert.ok(offered, '/memory 没有打开笔记选择器');
  assert.match(ctx.ui.text(), /改了静态资源必须同步缓存令牌/);
  ctx.ui.ask = async () => 'y';
  await slash(ctx, '/memory rm');
  assert.equal(mem.list().length, 0, '确认后没有删除选中的笔记');
});

test('/model Esc 与模型清单失败都不改当前模型/思考档；/effort 不再出现在公开菜单', async () => {
  assert.ok(!SLASH_COMMANDS.some((c) => c.name === '/effort'), '/effort 仍在公开命令菜单');
  assert.ok(!slashHelp().includes('/effort '), '/help 仍展示冗余的 /effort');
  const ctx = base(); ctx.ui.pick = async () => null;
  await slash(ctx, '/model');
  assert.equal(ctx.model.id, 1); assert.equal(ctx.effort, 'medium');
  let opened = false; ctx.ui.pick = async () => { opened = true; return null; };
  ctx.api.get = async () => { throw new Error('offline'); };
  await slash(ctx, '/model');
  assert.equal(opened, false, '清单失败仍打开了旧数据面板');
  assert.equal(ctx.model.id, 1); assert.equal(ctx.effort, 'medium');
  assert.match(ctx.ui.text(), /模型清单没取到/);
});
