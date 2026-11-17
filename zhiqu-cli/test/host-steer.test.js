// 宿主收中途补充（第一百五十二轮，docs/steer-plan.md 第 3 步）：后端 / 外壳发一行 say，宿主回 say_ack；
// 交给这一轮的收件箱，模型读到时记一步 steer、发一行 steered（原话）；收尾没读到的放进 result.leftover。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { createBridge, runHosted } from '../src/host/code-host.js';
import { STEER_LEAD } from '../src/steer.js';
import { tmpdir, write } from './helpers.js';

const MODEL = { id: 6, label: '测试模型', modelName: 'fake', effectiveContextWindow: 1_000_000 };

/** 假后端。during[n]：第 n 次（从 0 数）模型调用到了、还没回的时候往宿主发的 say */
function backend({ replies, during = {} }) {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const seen = [];
  let n = 0;
  let sayId = 0;
  const send = (m) => toHost.write(`${JSON.stringify(m)}\n`);
  const acks = new Map();
  readline.createInterface({ input: fromHost }).on('line', (line) => {
    const msg = JSON.parse(line);
    seen.push(msg);
    if (msg.type === 'say_ack') { acks.get(msg.id)(msg.accepted); return; }
    if (msg.type !== 'model') return;
    const k = n++;
    const r = replies[Math.min(k, replies.length - 1)];
    const answer = () => {
      send({ type: 'event', id: msg.id, name: 'start', data: { contextWindow: 1_000_000 } });
      const calls = (r.calls || []).map((c, i) => ({ id: `c${k}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      const message = { role: 'assistant', content: r.text || '', ...(calls.length ? { tool_calls: calls } : {}) };
      send({ type: 'event', id: msg.id, name: 'done', data: { message, finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16384, usage: { promptTokens: 10, completionTokens: 1, cachedTokens: 0, estimated: false } } });
    };
    if (!during[k]) { answer(); return; }
    // 先说一句、等它回 say_ack，再回模型 —— 「模型正在想的时候用户补了一句」
    say(during[k]).then(answer);
  });
  function say(text) {
    const id = `say${++sayId}`;
    return new Promise((resolve) => { acks.set(id, resolve); send({ type: 'say', id, text }); });
  }
  return { bridge: createBridge({ input: toHost, output: fromHost }), seen, say };
}

test('干活中途 say：宿主回 accepted、下一次问模型就带着它；回答里多一步「你补充」，另发一行 steered（原话）', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'A');
  const { bridge, seen } = backend({ replies: [{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '按你说的做了' }], during: { 0: '别改测试' } });
  const result = await runHosted(bridge, { type: 'run', root, message: '看看', maxRounds: 10, model: MODEL });
  assert.deepEqual(seen.filter((m) => m.type === 'say_ack').map((m) => m.accepted), [true]);
  const models = seen.filter((m) => m.type === 'model');
  assert.equal(models.length, 2);
  const last = models[1].body.messages.at(-1);
  assert.ok(last.role === 'user' && last.content.startsWith(STEER_LEAD) && last.content.includes('别改测试'));
  const steer = seen.filter((m) => m.type === 'trace' && m.step.kind === 'steer');
  assert.deepEqual(steer.map((m) => [m.step.title, m.step.target]), [['你补充', '别改测试']]);
  // 顺序：读文件那一步在前，补充在它后面（读到它的位置）
  const order = seen.filter((m) => m.type === 'trace' && m.step.status !== 'running').map((m) => m.step.kind);
  assert.ok(order.indexOf('read') < order.indexOf('steer'), order.join(','));
  assert.deepEqual(seen.filter((m) => m.type === 'steered').map((m) => m.texts), [['别改测试']]);
  assert.equal(result.text, '按你说的做了');
  assert.deepEqual(result.leftover, []);
});

test('run 里带来的（循环起来之前就补了的）：第一次问模型就在，排在这一句之后', async () => {
  const { bridge, seen } = backend({ replies: [{ text: '好' }] });
  await runHosted(bridge, { type: 'run', root: tmpdir(), message: '写个脚本', steer: ['用 Python'], maxRounds: 10, model: MODEL });
  const msgs = seen.find((m) => m.type === 'model').body.messages;
  assert.equal(msgs.at(-2).content, '写个脚本');
  assert.match(msgs.at(-1).content, /用 Python/);
});

test('最后一步才补、没赶上：交回 result.leftover；收尾之后再 say 回 accepted:false', async () => {
  const { bridge, seen, say } = backend({ replies: [{ text: '收尾了' }], during: { 0: '再加个测试' } });
  const result = await runHosted(bridge, { type: 'run', root: tmpdir(), message: '做', maxRounds: 1, model: MODEL });
  assert.deepEqual(result.leftover, ['再加个测试']);
  assert.equal(seen.filter((m) => m.type === 'steered').length, 0);
  assert.equal(await say('晚了'), false);
});

test('/review、/init 要文件夹却没有（不跑循环）：带来的补充原样交回，不丢', async () => {
  const { bridge } = backend({ replies: [{ text: '不该调到' }] });
  const result = await runHosted(bridge, { type: 'run', root: tmpdir(), artifact: true, command: 'review', message: '/review', steer: ['只看 src'], model: MODEL });
  assert.deepEqual(result.leftover, ['只看 src']);
});

test('真起一个进程：stdin 上的 say 不被当成「认不出的消息」停掉整轮', async () => {
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const root = tmpdir();
  const child = spawn(process.execPath, [path.resolve('src/host/code-host.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  const rl = readline.createInterface({ input: child.stdout });
  const done = new Promise((resolve) => child.on('close', resolve));
  let answered = 0;
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    lines.push(msg);
    if (msg.type === 'model') {
      const k = answered++;
      if (k === 0) child.stdin.write(`${JSON.stringify({ type: 'say', id: 'x1', text: '顺便说一句' })}\n`);
      const message = { role: 'assistant', content: k === 0 ? '先回一句' : '读到了' };
      child.stdin.write(`${JSON.stringify({ type: 'event', id: msg.id, name: 'done', data: { message, finishReason: 'stop', maxTokens: 100, usage: { promptTokens: 1, completionTokens: 1 } } })}\n`);
    }
  });
  child.stdin.write(`${JSON.stringify({ type: 'run', root, message: '做', maxRounds: 5, model: MODEL })}\n`);
  await done;
  assert.ok(!lines.some((m) => m.type === 'fatal'), JSON.stringify(lines.filter((m) => m.type === 'fatal')));
  assert.deepEqual(lines.filter((m) => m.type === 'say_ack').map((m) => m.accepted), [true]);
  const result = lines.find((m) => m.type === 'result');
  assert.equal(result.text, '读到了', '要收尾时箱子里有话：不收尾，带着它再问一次');
  assert.deepEqual(result.leftover, []);
});

test('run 和 say 落在同一块数据里（收件箱还没挂上）：照样收下，第一次问模型就在', async () => {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const seen = [];
  readline.createInterface({ input: fromHost }).on('line', (line) => {
    const msg = JSON.parse(line);
    seen.push(msg);
    if (msg.type === 'model') {
      const message = { role: 'assistant', content: '好' };
      toHost.write(`${JSON.stringify({ type: 'event', id: msg.id, name: 'done', data: { message, finishReason: 'stop', maxTokens: 100, usage: { promptTokens: 1, completionTokens: 1 } } })}\n`);
    }
  });
  const bridge = createBridge({ input: toHost, output: fromHost });
  const next = bridge.nextRun();   // 和 main() 一样：先等 run，再 runHosted
  toHost.write(`${JSON.stringify({ type: 'run', root: tmpdir(), message: '做', maxRounds: 5, model: MODEL })}\n${JSON.stringify({ type: 'say', id: 'e1', text: '紧跟着的一句' })}\n`);
  const result = await runHosted(bridge, await next);
  assert.deepEqual(seen.filter((m) => m.type === 'say_ack').map((m) => m.accepted), [true]);
  assert.match(seen.find((m) => m.type === 'model').body.messages.at(-1).content, /紧跟着的一句/);
  assert.deepEqual(result.leftover, []);
});
