// 第一百四十八轮（应用的会话在命令行里接着做第 4 步的暴力测试里撞到的）：600MB 的记录（几百段 2MB 的读文件结果），
// 命令行续接时占了 609MB —— 给人看的记录（transcript）把每段工具输出全文攒在内存里，回放其实只画第一行。
// 只截开头还不够：slice 切出来的是引用原串的一段（V8 的 SlicedString），原串照样留着，要真拷一份。
// 量法：子进程带 --expose-gc，造 80 段 2MB 的工具输出（160MB），transcript() 之后 GC，看堆还留多少。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore, TRANSCRIPT_TOOL_CHARS } from '../src/session.js';
import { tmpdir } from './helpers.js';

const SESSION = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'session.js');

test('给人看的记录：工具输出只留开头，原来那一大段不留在内存里（160MB 的记录，读完堆只多几 MB）', () => {
  const script = `
    import fs from 'node:fs'; import path from 'node:path';
    const { SessionStore } = await import(${JSON.stringify(`file://${SESSION}`)});
    const root = fs.mkdtempSync(path.join(${JSON.stringify(tmpdir())}, 'm-'));
    const store = new SessionStore(root); store.adopt('app-1');
    const big = 'y'.repeat(2 << 20);
    const fd = fs.openSync(store.file('app-1'), 'a');
    for (let i = 0; i < 80; i++) {
      fs.writeSync(fd, JSON.stringify({ type: 'message', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }) + '\\n');
      fs.writeSync(fd, JSON.stringify({ type: 'message', message: { role: 'tool', tool_call_id: 'c' + i, content: big } }) + '\\n');
    }
    fs.closeSync(fd);
    gc(); const before = process.memoryUsage().heapUsed;
    const kept = store.transcript('app-1');
    gc(); const after = process.memoryUsage().heapUsed;
    console.log(JSON.stringify({ grew: after - before, entries: kept.length }));
    fs.rmSync(root, { recursive: true, force: true });`;
  const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8', maxBuffer: 1 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const { grew, entries } = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(entries, 160);
  assert.ok(grew < 20 * 1024 * 1024, `读完 160MB 的记录，堆多了 ${(grew / 1048576).toFixed(0)}MB（工具输出全文留在内存里了）`);
});

test('给人看的记录：截了的工具输出说清楚共多少字；短的、人说的、助手答的原样', () => {
  const root = tmpdir();
  const store = new SessionStore(root);
  store.adopt('app-2');
  const long = 'z'.repeat(TRANSCRIPT_TOOL_CHARS + 10);
  const said = '人'.repeat(TRANSCRIPT_TOOL_CHARS + 10);
  store.append('app-2', { type: 'message', message: { role: 'user', content: said } });
  store.append('app-2', { type: 'message', message: { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } });
  store.append('app-2', { type: 'message', message: { role: 'tool', tool_call_id: 'a', content: long } });
  store.append('app-2', { type: 'message', message: { role: 'tool', tool_call_id: 'b', content: '短的' } });
  const t = store.transcript('app-2').map((e) => e.message.content);
  assert.equal(t[0], said, '人说的话被截了');
  assert.ok(t[2].startsWith('z'.repeat(TRANSCRIPT_TOOL_CHARS)) && t[2].includes(`共 ${long.length} 字`), t[2].slice(-60));
  assert.equal(t[3], '短的');
  assert.equal(store.load('app-2').messages[2].content, long, '发给模型的那一份也被截了');
});
