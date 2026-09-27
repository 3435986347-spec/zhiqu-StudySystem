// 上下文窗口（第十二轮，用户：1M 的模型被按 64000 算）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindow, setWindow, windowLine } from '../src/window.js';

test('/window 的写法：数字、k、m', () => {
  assert.equal(parseWindow('1000000'), 1_000_000);
  assert.equal(parseWindow('1m'), 1_000_000);
  assert.equal(parseWindow('1M'), 1_000_000);
  assert.equal(parseWindow('128k'), 128_000);
  assert.equal(parseWindow('1.5m'), 1_500_000);
  assert.equal(parseWindow('很大'), null);
  assert.equal(parseWindow(''), null);
});

test('没填窗口：启动时就说按默认算、怎么设；填了只说多少', () => {
  assert.match(windowLine({ contextWindowTokens: null, effectiveContextWindow: 64_000 }), /按默认 64K.*没填窗口.*\/window 1m/);
  assert.equal(windowLine({ contextWindowTokens: 1_000_000, effectiveContextWindow: 1_000_000 }), '上下文 1M token');
});

test('/window 1m：调服务器设这个模型的窗口，本地跟着更新；超范围不调服务器', async () => {
  const posts = [];
  const ctx = { model: { id: 7, label: 'DeepseekV4pro（我的）', contextWindowTokens: null, effectiveContextWindow: 64_000 },
    api: { async post(p, body) { posts.push([p, body]); return { contextWindowTokens: body.tokens, effectiveContextWindow: body.tokens }; } } };
  const msg = await setWindow(ctx, '1m');
  assert.deepEqual(posts, [['/api/harness/models/7/context-window', { tokens: 1_000_000 }]]);
  assert.equal(ctx.model.effectiveContextWindow, 1_000_000);
  assert.match(msg, /设为 1M token/);
  assert.match(await setWindow(ctx, '2m'), /之间/);
  assert.match(await setWindow(ctx, '100'), /之间/);
  assert.equal(posts.length, 1, '超范围不该调服务器');
  assert.match(await setWindow(ctx, ''), /上下文 1M token/);
});
