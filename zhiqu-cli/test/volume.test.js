// 命令行的数据量极端（第十八轮）：几万条记录的会话、几万个文件的工作区、几百个 MCP 工具。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Writable, PassThrough } from 'node:stream';
import { replayTranscript, REPLAY_TURNS } from '../src/replay.js';
import { Ui } from '../src/ui.js';
import { LocalTools } from '../src/tools/local.js';
import { toolset, findMcpTools, mcpOverBudget } from '../src/agent.js';
import { startFakeHarness } from './fixtures/fake-harness.js';
import { tmpdir, write } from './helpers.js';

function captureUi() {
  let out = '';
  const output = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
  const ui = new Ui({ input: new PassThrough(), output, color: false, interactive: false });
  return { ui, text: () => out };
}

function turns(n) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({ kind: 'message', message: { role: 'user', content: `第 ${i} 个问题` } });
    entries.push({ kind: 'message', message: { role: 'assistant', content: `第 ${i} 个回答` } });
  }
  return entries;
}

test('/resume 回放只显示最后 20 轮，并说前面还有几轮、完整记录在哪（原来一段几万条的会话往终端灌三万行）', () => {
  const { ui, text } = captureUi();
  replayTranscript(ui, turns(100), { fullLog: '.zhiqu/sessions/x.jsonl' });
  const out = text();
  assert.match(out, /前面还有 80 轮没显示，这里只显示最后 20 轮（完整记录在 \.zhiqu\/sessions\/x\.jsonl）/);
  assert.ok(!out.includes('第 79 个问题') && out.includes('第 80 个问题') && out.includes('第 99 个回答'), out.slice(0, 300));
  assert.equal(REPLAY_TURNS, 20);
});

test('轮数不多：全部显示，不说「前面还有」；goal 推的那种不算一轮', () => {
  const { ui, text } = captureUi();
  const entries = turns(5);
  entries.splice(2, 0, { kind: 'message', origin: 'goal', message: { role: 'user', content: '（继续追目标）' } });
  replayTranscript(ui, entries, { lastTurns: 5 });
  assert.ok(!/前面还有/.test(text()));
  assert.match(text(), /第 0 个问题/);
});

test('几千个文件的工作区：搜索搜到最后一个目录里的那一处（原来只看前 3000 个文件就停，报「0 处」）', () => {
  const root = tmpdir();
  for (let d = 0; d < 60; d++) {
    const dir = path.join(root, 'src', `m${String(d).padStart(2, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `f${f}.js`), `export const v${f} = ${f};\n`);
  }
  write(root, 'src/zz/last.js', 'const needle = 1;\n');
  const r = new LocalTools({ root }).search({ query: 'needle' });
  assert.match(r.content, /src\/zz\/last\.js:1: const needle = 1;/);
  assert.ok(!/已截断|不是全部/.test(`${r.summary}${r.content}`), r.content);
});

test('配了 MCP 服务器的 zhiqu -p：回答完马上退出（原来连接超时的定时器不清，每次都多等 15 秒）', async () => {
  const s = await startFakeHarness({ model: [{ text: '好的。' }] });
  const home = tmpdir('zq-home-');
  const ws = tmpdir('zq-ws-');
  write(ws, '.zhiqu/mcp.json', JSON.stringify({ mcpServers: { mock: { command: process.execPath, args: [path.resolve('test/fixtures/mock-mcp.cjs')] } } }));
  const env = { ...process.env, ZHIQU_HOME: home, ZHIQU_SERVER: s.url, ZHIQU_TOKEN: 'zqp_test' };
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.resolve('bin/zhiqu.js'), '-p', '你好'], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
    c.on('close', resolve);
  });
  const ms = Date.now() - t0;
  await s.close();
  assert.equal(code, 0);
  assert.ok(ms < 8000, `用了 ${ms}ms 才退出`);
});

function fakeMcp(n, { descChars = 400 } = {}) {
  const schemas = [];
  for (let i = 0; i < n; i++) {
    schemas.push({ type: 'function', function: { name: `mcp__many__tool_${i}`, description: `【MCP 服务器 many】工具 ${i}：${'查询记录'.repeat(descChars / 4)}`,
      parameters: { type: 'object', properties: { query: { type: 'string' } } } } });
  }
  if (schemas[42]) schemas[42].function.description = '【MCP 服务器 many】创建 issue：在工单系统里新建一个 issue';
  return { schemas: () => schemas };
}

test('几百个 MCP 工具、64K 窗口：不一次全发，只给 find_mcp_tool；找到的那几个下一步起连定义一起给', () => {
  const ctx = { mode: 'auto', model: { effectiveContextWindow: 64000 }, mcp: fakeMcp(300), ui: captureUi().ui };
  const first = toolset(ctx).map((t) => t.schema.function.name);
  assert.ok(first.includes('find_mcp_tool'));
  assert.ok(!first.some((n) => n.startsWith('mcp__')), '不该把几百个 MCP 工具全发出去');
  const r = findMcpTools(ctx, ctx.mcp.schemas(), '创建 issue');
  assert.match(r.content, /mcp__many__tool_42/);
  const next = toolset(ctx).map((t) => t.schema.function.name);
  assert.ok(next.includes('mcp__many__tool_42'), '找到的工具下一步要能直接调用');
  assert.ok(next.filter((n) => n.startsWith('mcp__')).length <= 8);
});

test('窗口够大（1M）或者工具不多：照旧全发，不用找', () => {
  const big = { mode: 'auto', model: { effectiveContextWindow: 1_000_000 }, mcp: fakeMcp(300), ui: captureUi().ui };
  assert.ok(!mcpOverBudget(big, big.mcp.schemas()));
  assert.equal(toolset(big).filter((t) => t.schema.function.name.startsWith('mcp__')).length, 300);
  const few = { mode: 'auto', model: { effectiveContextWindow: 64000 }, mcp: fakeMcp(5, { descChars: 40 }), ui: captureUi().ui };
  assert.equal(toolset(few).filter((t) => t.schema.function.name.startsWith('mcp__')).length, 5);
  assert.ok(!toolset(few).some((t) => t.schema.function.name === 'find_mcp_tool'));
});
