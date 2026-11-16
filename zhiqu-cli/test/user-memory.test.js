// 用户的长期记忆开工时带上（第一百四十三轮，docs/memory-plan.md 第 7 步；用户 2026-11-15 定的「自动带上」，开关在网页设置里）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_MEMORY_CHARS, userMemoryBlock } from '../src/memory.js';
import { fakeServer, runZhiqu } from './helpers.js';

const systemOf = (body) => body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

test('userMemoryBlock：开关关着、没有条目、拿不到 → 没有这一段；没放进来的说条数；说清是资料、冲突听这次的', () => {
  assert.equal(userMemoryBlock(null), '');
  assert.equal(userMemoryBlock({ enabled: false, text: '- 不该出现' }), '');
  assert.equal(userMemoryBlock({ enabled: true, text: '  ', included: 0, total: 0 }), '');
  const b = userMemoryBlock({ enabled: true, text: '- 周三上午不开会\n- 用 Python 刷题', included: 2, total: 5 });
  assert.match(b, /^## 用户的长期记忆/);
  assert.ok(b.includes('- 周三上午不开会\n- 用 Python 刷题'));
  assert.ok(b.includes('还有 3 条没放进来') && b.includes('read_memory'), b);
  assert.ok(b.includes('冲突时听这次的') && b.includes('propose_memory'), b);
  assert.ok(!userMemoryBlock({ enabled: true, text: '- a', included: 1, total: 1 }).includes('还有'), '全放进来了不说');
  // 服务器给多了：按整行截在上限以内
  const long = Array.from({ length: 200 }, (_, i) => `- 第 ${i} 条：${'记'.repeat(20)}`).join('\n');
  assert.ok(long.length > USER_MEMORY_CHARS * 2, '前置：样本比上限长');
  const cut = userMemoryBlock({ enabled: true, text: long, included: 200, total: 200 });
  assert.ok(cut.length < USER_MEMORY_CHARS + 300, String(cut.length));
  assert.ok(/- 第 \d+ 条：记{20}$/.test(cut.trim()), '截在整行上');
});

test('开工：服务器给的那一段进系统提示，这段会话里不再变；开关关着 / 老服务器（404）没有这一段，照样开工', async (t) => {
  const brief = { enabled: true, text: '- 周三上午不开会', included: 1, total: 1 };
  const srv = await fakeServer(t, [{ text: '好' }], { memoryBrief: brief });
  const r = await runZhiqu('exec', ['--ephemeral', '你好'], { url: srv.url });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(systemOf(srv.seen[0]).includes('## 用户的长期记忆') && systemOf(srv.seen[0]).includes('- 周三上午不开会'), '开工就带上');

  const off = await fakeServer(t, [{ text: '好' }], { memoryBrief: { enabled: false } });
  const r2 = await runZhiqu('exec', ['--ephemeral', '你好'], { url: off.url });
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(!systemOf(off.seen[0]).includes('用户的长期记忆'), '开关关着没有这一段');

  const old = await fakeServer(t, [{ text: '好' }]);
  const r3 = await runZhiqu('exec', ['--ephemeral', '你好'], { url: old.url });
  assert.equal(r3.code, 0, r3.stderr);
  assert.ok(!systemOf(old.seen[0]).includes('用户的长期记忆'), '老服务器没有这个接口：没有这一段，也不报错');
});
