// 第九十四轮：网页 / 桌面应用的代码模式跑命令行这一份循环 —— 草稿层（DraftTools）、和后端之间一行一个 JSON 的协议（host/code-host.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DraftTools, ABSENT } from '../src/tools/drafts.js';
import { createBridge, runHosted } from '../src/host/code-host.js';
import { tmpdir, write } from './helpers.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'code-host.js');

test('草稿层：改动不落盘；之后读、改、搜看到的是草稿，同一个文件改几处叠在一份草稿上；新建的文件也搜得到；指纹是第一次改时磁盘上的', () => {
  const root = tmpdir();
  write(root, 'calc.py', 'def add(a, b):\n    return a - b\n');
  const t = new DraftTools({ root, canWrite: true });
  t.readFile({ path: 'calc.py' });
  const first = t.prepareEdit({ path: 'calc.py', old_string: 'return a - b', new_string: 'return a + b' });
  assert.ok(!first.error, first.error);
  assert.match(t.commitWrite(first).content, /已生成草稿（修改，磁盘上的文件没有改动）：calc\.py/);
  assert.equal(fs.readFileSync(path.join(root, 'calc.py'), 'utf8'), 'def add(a, b):\n    return a - b\n', '磁盘一个字都不能动');
  assert.match(t.readFile({ path: 'calc.py' }).content, /return a \+ b/, '再读看到的是草稿');
  // 接着在草稿上改第二处：不要求重新读、不报「读过之后被改过」
  const second = t.prepareWrite({ path: 'calc.py', content: '\ndef sub(a, b):\n    return a - b\n', append: true });
  assert.ok(!second.error, second.error);
  t.commitWrite(second);
  const created = t.prepareWrite({ path: 'tests/test_calc.py', content: 'from calc import add\nassert add(2, 3) == 5\n' });
  t.commitWrite(created);
  assert.ok(!fs.existsSync(path.join(root, 'tests')), '新建的文件和目录也不落盘');
  assert.match(t.search({ query: 'a + b' }).content, /calc\.py:2:/, '搜的是草稿');
  assert.match(t.search({ query: 'assert add' }).content, /tests\/test_calc\.py:2:/, '新建的草稿磁盘上没有，也要搜得到');
  assert.match(t.readFile({ path: 'tests/test_calc.py' }).content, /assert add/);
  const drafts = t.draftList();
  assert.deepEqual(drafts.map((d) => d.path), ['calc.py', 'tests/test_calc.py']);
  assert.equal(drafts[0].content, 'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n');
  assert.equal(drafts[0].baseline, sha('def add(a, b):\n    return a - b\n'), '指纹是第一次改时磁盘上的内容（和后端 baselineOf 同一个算法）');
  assert.equal(drafts[0].creating, false);
  assert.equal(drafts[1].baseline, ABSENT);
  assert.equal(drafts[1].creating, true);
  assert.deepEqual(drafts[1].newDirectories, ['tests']);
});

test('草稿层：没给的工具不下发（没有写意图不给写、不能执行不给跑、从来不给删）；删除拒绝；磁盘在读过之后被改过照样拒', () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  assert.deepEqual([...new DraftTools({ root }).allowedTools].sort(), ['list_files', 'read_file', 'search']);
  assert.deepEqual([...new DraftTools({ root, canWrite: true, canExec: true }).allowedTools].sort(),
    ['edit_file', 'list_files', 'read_file', 'run_command', 'search', 'write_file']);
  const t = new DraftTools({ root, canWrite: true });
  assert.match(t.prepareDelete({ path: 'a.js' }).error, /不能删除文件/);
  t.readFile({ path: 'a.js' });
  write(root, 'a.js', 'changed by the user\n');
  assert.match(t.prepareWrite({ path: 'a.js', content: 'y\n' }).error, /读过之后被改过了/);
});

/** 假后端：按脚本回模型调用，记下收到的每一条 */
function fakeBackend({ replies, exec = () => ({ exitCode: 0, output: 'ok', millis: 5 }) }) {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const seen = [];
  let n = 0;
  readline.createInterface({ input: fromHost }).on('line', (line) => {
    const msg = JSON.parse(line);
    seen.push(msg);
    const reply = (m) => toHost.write(`${JSON.stringify(m)}\n`);
    if (msg.type === 'model') {
      const r = replies[Math.min(n++, replies.length - 1)];
      if (r.error) { reply({ type: 'error', id: msg.id, message: r.error, retryable: false }); return; }
      reply({ type: 'event', id: msg.id, name: 'start', data: { contextWindow: 1_000_000 } });
      const calls = (r.calls || []).map((c, i) => ({ id: `c${n}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      const message = { role: 'assistant', content: r.text || '', ...(calls.length ? { tool_calls: calls } : {}) };
      reply({ type: 'event', id: msg.id, name: 'done', data: { message, finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16384,
        usage: { promptTokens: 1000, completionTokens: 10, cachedTokens: 900, estimated: false } } });
    }
    if (msg.type === 'exec') reply({ type: 'exec_result', id: msg.id, ...exec(msg) });
  });
  return { bridge: createBridge({ input: toHost, output: fromHost }), seen };
}

const MODEL = { id: 6, label: '测试模型', modelName: 'fake', effectiveContextWindow: 1_000_000 };

test('协议：模型调用、跑命令都回到后端；轨迹一步一步交出去；结论、草稿、用量收尾交回；下发的工具只有后端允许的那几个', async () => {
  const root = tmpdir();
  write(root, 'calc.py', 'def add(a, b):\n    return a - b\n');
  const { bridge, seen } = fakeBackend({
    replies: [
      { calls: [{ name: 'read_file', args: { path: 'calc.py' } }] },
      { calls: [{ name: 'edit_file', args: { path: 'calc.py', old_string: 'return a - b', new_string: 'return a + b' } }] },
      { calls: [{ name: 'run_command', args: { command: 'python3', args: ['test_calc.py'] } }] },
      { text: '改动已生成草稿，确认后生效。' },
    ],
    exec: (m) => ({ exitCode: 1, output: `ran ${m.command} ${m.args.join(' ')}`, millis: 12 }),
  });
  const result = await runHosted(bridge, { type: 'run', root, message: '修好 add', canWrite: true, canExec: true, commands: ['python3'], maxRounds: 10, model: MODEL,
    history: [{ role: 'user', content: '前一句' }, { role: 'assistant', content: '前一句的回答' }] });
  assert.equal(result.type, 'result');
  assert.equal(result.text, '改动已生成草稿，确认后生效。');
  assert.equal(result.error, null);
  assert.deepEqual(result.drafts.map((d) => [d.path, d.content]), [['calc.py', 'def add(a, b):\n    return a + b\n']]);
  assert.equal(result.usage.cached, 3600, '四次调用的缓存命中数加起来');
  assert.equal(result.writeCalls, 1, '调过一次 edit_file：后端据此决定最终回答能不能说「没写成」');
  assert.equal(fs.readFileSync(path.join(root, 'calc.py'), 'utf8'), 'def add(a, b):\n    return a - b\n');

  const models = seen.filter((m) => m.type === 'model');
  assert.equal(models.length, 4);
  const offered = models[0].body.tools.map((t) => t.function.name);
  assert.ok(offered.includes('edit_file') && offered.includes('run_command') && !offered.includes('delete_file'), offered.join(','));
  const system = models[0].body.messages[0].content;
  assert.match(system, /网页 \/ 桌面应用的代码模式/);
  assert.match(system, /不接受 python3 -c \/ node -e/);
  assert.ok(!/一两行的小检查直接用 python3 -c/.test(system), '命令行那句「行内代码可以用」不能出现在草稿模式里');
  assert.deepEqual(models[0].body.messages.slice(1, 3).map((m) => m.content), ['前一句', '前一句的回答'], '最近的对话在这句话之前');
  const execs = seen.filter((m) => m.type === 'exec');
  assert.deepEqual(execs.map((m) => [m.command, m.args]), [['python3', ['test_calc.py']]]);
  const ran = models[3].body.messages.filter((m) => m.role === 'tool').at(-1).content;
  assert.match(ran, /ran python3 test_calc\.py/);
  assert.match(ran, /calc\.py 有没确认的草稿，这条命令跑的是磁盘上的旧版本/);
  const steps = seen.filter((m) => m.type === 'step').map((m) => m.text);
  assert.ok(steps.some((s) => /修改 calc\.py/.test(s)), steps.join(' | '));
});

test('协议：没有写意图时不下发写工具；模型硬调 write_file 不执行、不出草稿', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const { bridge, seen } = fakeBackend({ replies: [
    { calls: [{ name: 'write_file', args: { path: 'a.js', content: 'y\n' } }] }, { text: '好' }] });
  const result = await runHosted(bridge, { type: 'run', root, message: '这段代码什么意思', canWrite: false, canExec: false, model: MODEL });
  assert.deepEqual(result.drafts, []);
  const offered = seen.find((m) => m.type === 'model').body.tools.map((t) => t.function.name);
  assert.ok(!offered.includes('write_file') && !offered.includes('edit_file') && !offered.includes('run_command'), offered.join(','));
  assert.match(seen.filter((m) => m.type === 'model')[1].body.messages.filter((m) => m.role === 'tool')[0].content, /write_file/);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'x\n');
});

test('真起一个进程：stdin 进 run、stdout 出 model … result；最后一行写完才退出（管道上的 stdout 是异步的）', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'hello\n');
  const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: process.env.PATH } });
  const lines = [];
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    lines.push(msg);
    if (msg.type === 'model') {
      const calls = lines.filter((l) => l.type === 'model').length === 1
        ? [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] : [];
      send({ type: 'event', id: msg.id, name: 'done', data: { message: { role: 'assistant', content: calls.length ? '' : '里面是 hello', ...(calls.length ? { tool_calls: calls } : {}) },
        finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16384, usage: { promptTokens: 10, completionTokens: 2, estimated: false } } });
    }
  });
  send({ type: 'run', root, message: 'a.txt 里是什么', model: MODEL });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  const result = lines.at(-1);
  assert.equal(result.type, 'result', JSON.stringify(lines.map((l) => l.type)));
  assert.equal(result.text, '里面是 hello');
});

test('协议：认不出的消息就停（fatal），不猜', async () => {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const out = [];
  readline.createInterface({ input: fromHost }).on('line', (l) => out.push(JSON.parse(l)));
  createBridge({ input: toHost, output: fromHost });
  toHost.write('{"type":"surprise","id":"m1"}\n');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(out.map((m) => m.type), ['fatal']);
  assert.match(out[0].message, /认不出的消息/);
});
