// 第九十四轮：网页 / 桌面应用的代码模式跑命令行这一份循环 —— 草稿层（DraftTools）、和后端之间一行一个 JSON 的协议（host/code-host.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DraftTools, ABSENT } from '../src/tools/drafts.js';
import { createBridge, runHosted, unfinishedReport } from '../src/host/code-host.js';
import { detectSandbox } from '../src/tools/sandbox.js';
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
    ['apply_patch', 'edit_file', 'list_files', 'read_file', 'run_command', 'search', 'write_file']);
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
      if (r.hang) return;   // 不回：看到点被打断
      reply({ type: 'event', id: msg.id, name: 'start', data: { contextWindow: 1_000_000 } });
      const calls = (r.calls || []).map((c, i) => ({ id: `c${n}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      const message = { role: 'assistant', content: r.text || '', ...(calls.length ? { tool_calls: calls } : {}) };
      reply({ type: 'event', id: msg.id, name: 'done', data: { message, finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16384,
        usage: { promptTokens: 1000, completionTokens: 10, cachedTokens: 900, estimated: false } } });
    }
    if (msg.type === 'exec') { const r = exec(msg); if (r) reply({ type: 'exec_result', id: msg.id, ...r }); }   // exec 回 null：命令卡住
    if (msg.type === 'tool') reply({ type: 'tool_result', id: msg.id, content: `后端执行了 ${msg.name}：${JSON.stringify(msg.arguments)}` });
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
  // 第九十五轮（真浏览器里「再跑一下」时它拿上一次的结果回答、0 轮）：命令行和网页同一份提示
  assert.match(system, /再跑一次、再看一次.*就真的再调工具做一次.*不要拿对话里上一次的结果回答/);
  const prior = models[0].body.messages[1];
  assert.equal(prior.role, 'user');
  assert.match(prior.content, /【前面的对话，供参考.*这一次要的结果用工具重新查、重新跑[\s\S]*用户：前一句[\s\S]*助手：前一句的回答/,
    '最近的对话在这句话之前，而且是带标注的参考，不是一问一答的示范（第九十五轮）');
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

test('经软链的路径起也能跑（第九十六轮：macOS 的临时目录 /var 是软链，原来 main() 不跑、进程一声不响就退了）', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'hello\n');
  const link = path.join(tmpdir(), 'linked-cli');
  fs.symlinkSync(path.resolve(path.dirname(HOST), '..', '..'), link);
  const child = spawn(process.execPath, [path.join(link, 'src', 'host', 'code-host.js')], { stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: process.env.PATH } });
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    lines.push(msg);
    if (msg.type === 'model') child.stdin.write(`${JSON.stringify({ type: 'event', id: msg.id, name: 'done', data: { message: { role: 'assistant', content: '好' },
      finishReason: 'stop', maxTokens: 16384, usage: { promptTokens: 1, completionTokens: 1, estimated: false } } })}\n`);
  });
  child.stdin.write(`${JSON.stringify({ type: 'run', root, message: '看看', model: MODEL })}\n`);
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(lines.at(-1) && lines.at(-1).type, 'result', `经软链起的进程没有跑：${JSON.stringify(lines)}`);
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

const wikiTool = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });

test('远程工具（第九十五轮）：Wiki / 里程碑工具经桥交给后端执行；记薄弱点的工具真的跑过一次命令才下发（判过题才许记）', async () => {
  const root = tmpdir();
  write(root, 'test_two_sum.py', 'print("FAIL")\n');
  const { bridge, seen } = fakeBackend({
    replies: [
      { calls: [{ name: 'search_wiki', args: { query: '薄弱点' } }] },
      { calls: [{ name: 'create_wiki_patch', args: { title: '薄弱点：两数之和' } }] },
      { calls: [{ name: 'run_command', args: { command: 'python3', args: ['test_two_sum.py'] } }] },
      { calls: [{ name: 'create_wiki_patch', args: { title: '薄弱点：两数之和' } }] },
      { text: '记下来了，等你确认。' },
    ],
    exec: () => ({ exitCode: 1, output: 'FAIL', millis: 5 }),
  });
  const result = await runHosted(bridge, { type: 'run', root, message: '出一道题考我', canWrite: true, canExec: true, commands: ['python3'], model: MODEL,
    remoteTools: [wikiTool('search_wiki'), wikiTool('read_wiki_page')], remoteToolsAfterRun: [wikiTool('create_wiki_patch')] });
  assert.equal(result.text, '记下来了，等你确认。');
  const models = seen.filter((m) => m.type === 'model');
  const offered = (i) => models[i].body.tools.map((x) => x.function.name);
  assert.ok(offered(0).includes('search_wiki') && !offered(0).includes('create_wiki_patch'), offered(0).join(','));
  assert.ok(!offered(2).includes('create_wiki_patch'), '跑命令之前不给记薄弱点');
  assert.ok(offered(3).includes('create_wiki_patch'), `跑过命令之后给：${offered(3).join(',')}`);
  const tools = seen.filter((m) => m.type === 'tool');
  assert.deepEqual(tools.map((m) => m.name), ['search_wiki', 'create_wiki_patch'], '没下发时硬调的那次不该到后端');
  assert.deepEqual(tools[0].arguments, { query: '薄弱点' });
  const toolMessages = models[4].body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(toolMessages[0], /后端执行了 search_wiki/);
  assert.match(toolMessages[1], /没有叫 create_wiki_patch 的工具|create_wiki_patch/);
  assert.match(toolMessages[3], /后端执行了 create_wiki_patch/);
});

test('说生成了草稿、这一次却一份都没有：推一次让它照实做（第九十五轮：真浏览器里 0 轮就说「已生成三个文件的草稿」）；真生成了就不推', async () => {
  const root = tmpdir();
  const { bridge, seen } = fakeBackend({ replies: [
    { text: '已生成三个文件的草稿，等你确认后才会写进磁盘。' },
    { calls: [{ name: 'write_file', args: { path: 'two_sum.py', content: 'def two_sum(nums, target):\n    return []\n' } }] },
    { text: '已生成 two_sum.py 的草稿，等你确认。' },
  ] });
  const result = await runHosted(bridge, { type: 'run', root, message: '出一道题', canWrite: true, model: MODEL });
  const models = seen.filter((m) => m.type === 'model');
  assert.equal(models.length, 3, '应当推了一次、然后真写了');
  const pushed = models[1].body.messages.at(-1);
  assert.equal(pushed.role, 'user');
  assert.match(pushed.content, /并没有生成任何草稿/);
  assert.deepEqual(result.drafts.map((d) => d.path), ['two_sum.py']);
  assert.equal(result.text, '已生成 two_sum.py 的草稿，等你确认。', '真有草稿时同样的说法不再推');
});

test('草稿说法的判定：生成了 / 写好了 / 草稿已经生成算，问句、「没有草稿」不算', async () => {
  const { CLAIMS_DRAFT } = await import('../src/host/code-host.js');
  for (const s of ['已生成三个文件的草稿', '改动草稿已经生成好了', '我写好了 calc.py 的草稿']) assert.ok(CLAIMS_DRAFT.test(s), s);
  for (const s of ['这一轮没有改文件。', '测试过了，退出码 0。']) assert.ok(!CLAIMS_DRAFT.test(s), s);
});

test('说跑过了、这一次却没跑过任何命令：推一次让它真跑（第九十五轮：0 轮就说「跑了 test_two_sum.py，输出 ok」，解法其实是 return []）', async () => {
  const root = tmpdir();
  write(root, 'test_two_sum.py', 'assert False\n');
  const { bridge, seen } = fakeBackend({
    replies: [
      { text: '我跑了 test_two_sum.py，输出：ok，退出码 0，三组断言全过。' },
      { calls: [{ name: 'run_command', args: { command: 'python3', args: ['test_two_sum.py'] } }] },
      { text: '跑了 test_two_sum.py：退出码 1，AssertionError —— 没过。' },
    ],
    exec: () => ({ exitCode: 1, output: 'AssertionError', millis: 5 }),
  });
  const result = await runHosted(bridge, { type: 'run', root, message: '帮我判一下', canExec: true, commands: ['python3'], model: MODEL,
    history: [{ role: 'user', content: '跑一下' }, { role: 'assistant', content: '跑了，输出：ok，退出码 0' }] });
  const models = seen.filter((m) => m.type === 'model');
  assert.equal(models.length, 3);
  assert.match(models[1].body.messages.at(-1).content, /没有调用 run_command，什么命令都没跑过/);
  assert.equal(seen.filter((m) => m.type === 'exec').length, 1, '推了以后真的跑了');
  assert.match(result.text, /退出码 1/);
  const { CLAIMS_RUN } = await import('../src/host/code-host.js');
  for (const s of ['退出码 0，全过', '我跑了 test_calc.py', '输出：ok']) assert.ok(CLAIMS_RUN.test(s), s);
  for (const s of ['写进去后你可以运行 python3 test.py 验证', '改好了 calc.py 的草稿', '写入后跑一下，预期输出：ok', '应该输出：3']) assert.ok(!CLAIMS_RUN.test(s), s);
});

test('中断以后后端在半路的回音（第九十九轮 review）：认得、丢掉，不当成「认不出的消息」停下 —— 不然 fatal 抢在 result 前面，结论就丢了', async () => {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const out = [];
  readline.createInterface({ input: fromHost }).on('line', (l) => out.push(JSON.parse(l)));
  const bridge = createBridge({ input: toHost, output: fromHost });
  const controller = new AbortController();
  const streaming = bridge.stream('/api/harness/model/stream', { messages: [] }, () => {}, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 10));
  const id = out.find((m) => m.type === 'model').id;
  controller.abort();
  await assert.rejects(streaming, /aborted/);
  toHost.write(`${JSON.stringify({ type: 'event', id, name: 'delta', data: { text: '迟到的' } })}\n`);
  toHost.write(`${JSON.stringify({ type: 'event', id, name: 'done', data: {} })}\n`);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(out.map((m) => m.type), ['model'], '迟到的回音不该让宿主停下');
  toHost.write('{"type":"event","id":"m999","name":"done","data":{}}\n');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(out.map((m) => m.type), ['model', 'fatal'], '从没发过的 ID 照旧认不出、照旧停');
});

test('apply_patch 经宿主进草稿：算写过（最终回答在没草稿时才据此说「没写成」）、草稿交给后端、磁盘不动', async () => {
  const root = tmpdir();
  write(root, 'a.py', 'one\n');
  const patch = ['*** Begin Patch', '*** Update File: a.py', '-one', '+ONE', '*** Add File: n.py', '+x', '*** End Patch'].join('\n');
  const { bridge } = fakeBackend({ replies: [
    { calls: [{ name: 'read_file', args: { path: 'a.py' } }] },
    { calls: [{ name: 'apply_patch', args: { patch } }] },
    { text: '改动已生成草稿，确认后生效。' }] });
  const result = await runHosted(bridge, { type: 'run', root, message: '修好', canWrite: true, model: MODEL });
  assert.equal(result.writeCalls, 1);
  assert.deepEqual(result.drafts.map((d) => d.path).sort(), ['a.py', 'n.py']);
  assert.equal(fs.readFileSync(path.join(root, 'a.py'), 'utf8'), 'one\n');
});

// ── 生成到产物（第一百一十六轮）───────────────────────────

test('生成到产物：写工具直接写进临时空间，不走草稿；什么类型都能写；命令看得到刚写的文件；提示说的是产物', async () => {
  const root = tmpdir();
  const { bridge, seen } = fakeBackend({
    replies: [
      { calls: [{ name: 'write_file', args: { path: 'chart.svg', content: '<svg>one</svg>\n' } }] },
      { calls: [{ name: 'edit_file', args: { path: 'chart.svg', old_string: 'one', new_string: 'two' } }] },
      { calls: [{ name: 'write_file', args: { path: 'dir/data.custom', content: 'x\n' } }] },
      { calls: [{ name: 'apply_patch', args: { patch: '*** Begin Patch\n*** Add File: patched.txt\n+补丁写的\n*** End Patch' } }] },
      { calls: [{ name: 'read_file', args: { path: 'chart.svg' } }] },
      { calls: [{ name: 'shell', args: { command: 'cat chart.svg' } }] },
      { text: '生成了 chart.svg。' },
    ],
    exec: () => ({ exitCode: 0, output: 'ok', millis: 1 }),
  });
  const result = await runHosted(bridge, { type: 'run', root, artifact: true, message: '画一张图', canWrite: true, canShell: true, shellWrite: true, canExec: true, maxRounds: 10, model: MODEL });
  assert.equal(result.error, null);
  assert.equal(fs.readFileSync(path.join(root, 'chart.svg'), 'utf8'), '<svg>two</svg>\n', '落在临时空间里，不是草稿');
  assert.equal(fs.readFileSync(path.join(root, 'dir/data.custom'), 'utf8'), 'x\n', '不认识的类型也能写');
  assert.equal(fs.readFileSync(path.join(root, 'patched.txt'), 'utf8'), '补丁写的\n');
  assert.deepEqual(result.drafts, [], '没有草稿要用户确认');
  assert.equal(result.writeCalls, 4);
  const models = seen.filter((m) => m.type === 'model');
  const system = models[0].body.messages[0].content;
  assert.match(system, /生成到产物/);
  assert.match(system, /不是用户电脑上的文件夹/);
  assert.ok(!/点了确认才写进磁盘/.test(system), '草稿那段不该出现');
  const toolTexts = models.at(-1).body.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  assert.ok(!/有没确认的草稿/.test(toolTexts), '没有草稿，不该说命令跑的是旧版本');
  assert.ok(!/已生成草稿/.test(toolTexts), toolTexts);
  const offered = models[0].body.tools.map((t) => t.function.name);
  assert.ok(!offered.includes('delete_file'), offered.join(','));
  assert.equal(seen.filter((m) => m.type === 'exec' && m.shell).length, 1);
});

test('生成到产物：临时空间也出不去：../、绝对路径、软链、.git、.zhiqu 都写不了', async () => {
  const root = tmpdir();
  const outside = tmpdir();
  fs.symlinkSync(outside, path.join(root, 'link'));
  const tries = ['../escape.txt', path.join(outside, 'abs.txt'), 'link/through.txt', '.git/hooks/pre-commit', '.zhiqu/settings.json'];
  const { bridge } = fakeBackend({ replies: [...tries.map((p) => ({ calls: [{ name: 'write_file', args: { path: p, content: 'x' } }] })), { text: '好' }] });
  const result = await runHosted(bridge, { type: 'run', root, artifact: true, message: '写', canWrite: true, maxRounds: 10, model: MODEL });
  assert.equal(result.error, null);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(!fs.existsSync(path.join(path.dirname(root), 'escape.txt')));
  assert.ok(!fs.existsSync(path.join(root, '.git')) && !fs.existsSync(path.join(root, '.zhiqu')));
});

test('生成到产物：这一轮不能写就不给写工具；不能跑命令就照实说；能跑时说跑一下', async () => {
  const read = fakeBackend({ replies: [{ text: '好' }] });
  await runHosted(read.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '看看', maxRounds: 5, model: MODEL });
  const first = read.seen.find((m) => m.type === 'model').body;
  const names = first.tools.map((t) => t.function.name);
  assert.ok(!names.includes('write_file') && !names.includes('shell'), names.join(','));
  assert.match(first.messages[0].content, /这里不能跑命令/);
  const shell = fakeBackend({ replies: [{ text: '好' }] });
  await runHosted(shell.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '写', canWrite: true, canShell: true, shellWrite: false, maxRounds: 5, model: MODEL });
  const system = shell.seen.find((m) => m.type === 'model').body.messages[0].content;
  assert.match(system, /这一档 shell 写不了临时空间/);
  assert.match(system, /能运行的就运行一下/);
  assert.ok(!/这里不能跑命令/.test(system));
});

test('生成到产物：先写再说「生成了」：真写了，不推', async () => {
  const honest = fakeBackend({ replies: [{ calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] }, { text: '已生成草稿。' }] });
  await runHosted(honest.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '写', canWrite: true, maxRounds: 5, model: MODEL });
  assert.equal(honest.seen.filter((m) => m.type === 'model').length, 2, '写过了就不该再推它');
  const patched = fakeBackend({ replies: [{ calls: [{ name: 'apply_patch', args: { patch: '*** Begin Patch\n*** Add File: b.txt\n+x\n*** End Patch' } }] }, { text: '已生成草稿。' }] });
  await runHosted(patched.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '写', canWrite: true, maxRounds: 5, model: MODEL });
  assert.equal(patched.seen.filter((m) => m.type === 'model').length, 2, '补丁写的也算写过');
  // 第一百二十一轮的说法（「已写入 a.md」）同样：真写了就不推
  const wrote = fakeBackend({ replies: [{ calls: [{ name: 'write_file', args: { path: 'a.md', content: '# 计划' } }] }, { text: '已写入 a.md。' }] });
  await runHosted(wrote.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '写', canWrite: true, maxRounds: 5, model: MODEL });
  assert.equal(wrote.seen.filter((m) => m.type === 'model').length, 2, '写过了说「已写入」不该推');
});

test('生成到产物：说写了却一个都没写，推一次；真写了不推', async () => {
  const lied = fakeBackend({ replies: [{ text: '已生成草稿，确认后生效。' }, { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] }, { text: '已生成草稿。' }] });
  const r = await runHosted(lied.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '写', canWrite: true, maxRounds: 5, model: MODEL });
  const asked = lied.seen.filter((m) => m.type === 'model');
  assert.equal(asked.length, 3, '第一次没写就说写了：推一次；写了之后那句不再推');
  assert.match(JSON.stringify(asked[1].body.messages), /并没有生成任何草稿/);
  assert.equal(r.writeCalls, 1);
});

// 第一百二十一轮（线上）：生成到产物、一个文件都没写，回答是「## 已写入文件 文件路径：./四象限周计划.md」——「……草稿」那条对不上这种说法
test('生成到产物：说「已写入文件 / 新建了 x.md」却一个都没写，推一次；推回去之后照实问，结论就是那句问话', async () => {
  const lied = fakeBackend({ replies: [{ calls: [{ name: 'list_files', args: {} }] },
    { text: '## 已写入文件\n\n文件路径：`./四象限周计划.md`\n\n我新建了 `./四象限周计划.md`。' },
    { text: '你想写哪个文件？文件名、格式、内容主题告诉我。' }] });
  const r = await runHosted(lied.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '写一个文件', canWrite: true, maxRounds: 5, model: MODEL });
  const asked = lied.seen.filter((m) => m.type === 'model');
  assert.equal(asked.length, 3, '说写了却没写：推一次');
  assert.match(JSON.stringify(asked[2].body.messages), /一个文件都没有写/);
  assert.equal(r.writeCalls, 0);
  assert.equal(r.conclusion, '你想写哪个文件？文件名、格式、内容主题告诉我。', '交给后端当回答的，是推回去之后照实说的那句');
});

test('写文件的说法：已写入 / 新建了 x.md / 文件已保存算；问句、将来时、「已经生成了计划」、「文件已经存在」不算', async () => {
  const { CLAIMS_FILE } = await import('../src/host/code-host.js');
  for (const s of ['## 已写入文件\n\n文件路径：`./四象限周计划.md`', '我新建了 `./四象限周计划.md`。', '已经生成了 report.csv', '文件已保存', '成功写入 notes.txt', '已创建文件 a.py', '三个文件都已经生成']) {
    assert.ok(CLAIMS_FILE.test(s), s);
  }
  for (const s of ['你想写哪个文件，我还缺少关键信息：文件名、格式', '可以新建一个 a.md 吗？', '我会生成 x.py', '已经生成了计划', '写入之前先读一下', '下一步：新建 game/ 目录', '文件还没有生成', '这个文件已经存在']) {
    assert.ok(!CLAIMS_FILE.test(s), s);
  }
});

test('跑过命令的不按「说写了文件」推：auto 档的 shell 可能真写了，看不出来就不推', { skip: detectSandbox() ? false : '这台机器没有系统沙箱' }, async () => {
  const b = fakeBackend({ replies: [{ calls: [{ name: 'shell', args: { command: 'echo x > a.md' } }] }, { text: '已写入 a.md。' }] });
  await runHosted(b.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '写', canWrite: true, canShell: true, shellWrite: true, canExec: true, maxRounds: 5, model: MODEL });
  assert.equal(b.seen.filter((m) => m.type === 'model').length, 2, '跑过命令就不推');
});

test('交给后端当回答的结论：只认这一次新说的；出错、被打断、用完轮数时是一段照实说「做到哪了」的话（第一百二十八轮：原来交空的，后端另调模型照「这一轮没有改文件」编了一段），不拿历史那句、被推回去的那句顶上', async () => {
  const history = [{ role: 'user', content: '上一轮的问题' }, { role: 'assistant', content: '上一轮的回答' }];
  const stopped = (r, why) => {
    assert.match(r.conclusion, why, r.conclusion);
    assert.ok(!r.conclusion.includes('上一轮的回答') && !r.conclusion.includes('好的，前面的对话我当参考') && !r.conclusion.includes('先说到这'), `拿了不该拿的那句当结论：${r.conclusion}`);
    assert.match(r.conclusion, /说「继续」我接着做/);
  };
  const ok = fakeBackend({ replies: [{ text: '这一次的结论' }] });
  const r1 = await runHosted(ok.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '看看', canWrite: true, maxRounds: 5, model: MODEL, history });
  assert.equal(r1.conclusion, '这一次的结论');
  const broken = fakeBackend({ replies: [{ error: '模型那边断了' }] });
  const r2 = await runHosted(broken.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '看看', canWrite: true, maxRounds: 5, model: MODEL, history });
  stopped(r2, /半路出错停下了：.*模型那边断了/);
  assert.ok(r2.error, '出错要交回');
  // 用完轮数、没有新的结论：不拿历史后面那句固定的「好的……」顶上
  const used = fakeBackend({ replies: [{ calls: [{ name: 'list_files', args: {} }] }] });
  const r3 = await runHosted(used.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '看看', canWrite: true, maxRounds: 1, model: MODEL, history });
  stopped(r3, /还没写结论/);
  assert.doesNotMatch(r3.conclusion, /：null/, '用完轮数时不能写成「出错停下了：null」');
  assert.match(r3.conclusion, /用完了 1 轮/, '用完轮数要说清楚是用完了轮数');
  assert.match(r3.conclusion, /最后一步是：`列出 工作区根`/, '做到哪一步要照实说（放进代码段，别让命令原文变成 Markdown）');
  // 说了一句、清单没做完被推回去，接着那一次出错 / 到点被打断：被推回去的那句不是结论
  const todo = { calls: [{ name: 'update_todos', args: { todos: [{ content: '写文件', status: 'pending' }] } }] };
  const errored = fakeBackend({ replies: [todo, { text: '先说到这' }, { error: '模型那边断了' }] });
  const r4 = await runHosted(errored.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '看看', canWrite: true, maxRounds: 5, model: MODEL });
  stopped(r4, /半路出错停下了/);
  const hung = fakeBackend({ replies: [todo, { text: '先说到这' }, { hang: true }] });
  const r5 = await runHosted(hung.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '看看', canWrite: true, maxRounds: 5, model: MODEL, timeoutMs: 400 });
  stopped(r5, /到了时间上限/);
  assert.ok(r5.aborted);
  // 跑命令时到点：exec 回「已中断」、不抛错，循环在下一轮开头退出 —— 这时 error 是空的，只有「被打断」挡得住
  const stuck = fakeBackend({ replies: [todo, { text: '先说到这' }, { calls: [{ name: 'shell', args: { command: 'sleep 100' } }] }], exec: () => null });
  const r6 = await runHosted(stuck.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '看看', canWrite: true, canShell: true, shellWrite: true, canExec: true, maxRounds: 5, model: MODEL, timeoutMs: 400 });
  assert.equal(r6.error, null, '这条要的是不抛错的打断');
  stopped(r6, /到了时间上限/);
  // 写过的文件照实列出来（生成到产物：写的是真的）
  const wrote = fakeBackend({ replies: [{ calls: [{ name: 'write_file', args: { path: 'core.js', content: 'x\n' } }] }, { hang: true }] });
  const r7 = await runHosted(wrote.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '做个游戏', canWrite: true, maxRounds: 5, model: MODEL, timeoutMs: 600 });
  stopped(r7, /已经生成的文件：`core\.js`/);
  // 说「已写入」被推回去，接着一直调工具到用完轮数：那句没做的说法不是结论（第一百二十八轮 review：原来取的是「最后一句不调工具的」，正好是它）
  const claimed = fakeBackend({ replies: [{ text: '已写入 a.md。' }, { calls: [{ name: 'list_files', args: { path: '.' } }] }, { calls: [{ name: 'read_file', args: { path: 'x.md' } }] }] });
  const r8 = await runHosted(claimed.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '写', canWrite: true, maxRounds: 3, model: MODEL });
  assert.equal(claimed.seen.filter((m) => m.type === 'model').length, 3, '前提：说了没做的那句被推回去，之后又调了两轮工具');
  stopped(r8, /用完了 3 轮/);
  assert.ok(!r8.conclusion.includes('已写入 a.md'), r8.conclusion);
  assert.ok(!r8.context.includes('【代码 agent 的结论】\n已写入'), '给后端的上下文里也不能把它当结论');
  // 连着重复同一个调用被停下：说清楚是怎么停的
  const loop = fakeBackend({ replies: [{ calls: [{ name: 'list_files', args: { path: '.' } }] }] });
  const r9 = await runHosted(loop.bridge, { type: 'run', root: tmpdir(), artifact: true, message: '看看', canWrite: true, maxRounds: 20, model: MODEL });
  stopped(r9, /连着发同一个调用/);
});

test('没做完的报告：run 过的命令不拿来断言「没有改文件」；最后一步只取第一行，heredoc 不进 Markdown', () => {
  const ran = unfinishedReport({ local: { drafts: new Map(), ranCommand: true }, steps: [], timedOut: true, error: null, budgetMs: 1000 });
  assert.match(ran, /跑过命令，改没改文件看不出来/);
  assert.doesNotMatch(ran, /还没有改任何文件/);

  const heredoc = unfinishedReport({
    local: { drafts: new Map(), ranCommand: false }, steps: ['运行 cat <<\'EOF\'\n$x$\nEOF'], timedOut: false, error: '模型那边断了', budgetMs: 0,
  });
  assert.match(heredoc, /最后一步是：`运行 cat <<'EOF'`/, heredoc);
  assert.ok(!heredoc.includes('$x$'), 'heredoc 的正文被塞进了回答（网页会当 Markdown / 公式渲染）');
});

// ─────────── 网页输入框里的 /init、/review（第一百一十八轮）：用命令行那一份，门在后端
function gitRepo() {
  const root = tmpdir();
  write(root, 'calc.py', 'def add(a, b):\n    return a + b\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', '第一版');
  return { root, git };
}
const REVIEW_JSON = JSON.stringify({ summary: '加法写成了减法。', findings: [{ priority: 'P1', file: 'calc.py', line: 2, title: '符号反了', why: 'add 现在在减', fix: '改回 +' }] });
const lastUser = (m) => m.body.messages.filter((x) => x.role === 'user').at(-1).content;

test('/init：发给模型的是命令行那份提示，不是「/init」这四个字；已经有 ZHIQU.md 时说的是更新', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const first = fakeBackend({ replies: [{ text: '写好了' }] });
  await runHosted(first.bridge, { type: 'run', root, command: 'init', message: '/init', canWrite: true, model: MODEL });
  const prompt = lastUser(first.seen.find((m) => m.type === 'model'));
  assert.match(prompt, /请为这个项目写一份 ZHIQU\.md 初稿/);
  assert.ok(!/^\/init/.test(prompt));
  write(root, 'ZHIQU.md', '# 已有\n');
  const again = fakeBackend({ replies: [{ text: '更新了' }] });
  await runHosted(again.bridge, { type: 'run', root, command: 'init', message: '/init', canWrite: true, model: MODEL });
  assert.match(lastUser(again.seen.find((m) => m.type === 'model')), /工作区里已经有 ZHIQU\.md 了/);
});

test('/review：diff 替模型取好（真 git）；下发的工具没有写的；模型硬调写工具不落地；结论按格式核过、照命令行的样子写回', async () => {
  const { root } = gitRepo();
  write(root, 'calc.py', 'def add(a, b):\n    return a - b\n');
  const { bridge, seen } = fakeBackend({ replies: [
    { calls: [{ name: 'write_file', args: { path: 'calc.py', content: 'hacked\n' } }] },
    { text: REVIEW_JSON },
  ] });
  const result = await runHosted(bridge, { type: 'run', root, command: 'review', message: '/review --uncommitted 看看符号', canWrite: false, canExec: true, canShell: true, shellWrite: false, commands: [], model: MODEL });
  const models = seen.filter((m) => m.type === 'model');
  assert.equal(models.length, 2);
  const prompt = lastUser(models[0]);
  assert.match(prompt, /你在审查一段代码改动/);
  assert.match(prompt, /-    return a \+ b\n\+    return a - b/, '真的 diff 放进了提示');
  assert.match(prompt, /用户另外的要求.*看看符号/);
  const offered = models[0].body.tools.map((t) => t.function.name);
  for (const name of ['write_file', 'edit_file', 'apply_patch', 'delete_file', 'exit_plan_mode']) assert.ok(!offered.includes(name), offered.join(','));
  assert.equal(fs.readFileSync(path.join(root, 'calc.py'), 'utf8'), 'def add(a, b):\n    return a - b\n');
  assert.deepEqual(result.drafts, []);
  assert.equal(result.writeCalls, 0);
  assert.match(result.text, /发现 1 个问题（P1 1 个）/);
  assert.match(result.text, /\[P1\] calc\.py:2 符号反了/);
  assert.match(result.context, /【代码 agent 的结论】\n发现 1 个问题/);
  assert.ok(seen.some((m) => m.type === 'step' && /在看.*只读/.test(m.text)), '轨迹里要说在看什么');
  assert.ok(result.usage.prompt > 0, '审查花的用量要算进来：单独的上下文，用量还是这一轮的');
});

test('/review：结论不是要的格式就推回去重写，模型说的话不拿来当「说了没做」核对', async () => {
  const { root } = gitRepo();
  write(root, 'calc.py', 'def add(a, b):\n    return a - b\n');
  const { bridge, seen } = fakeBackend({ replies: [{ text: '已生成三个文件的草稿，跑了 test.py，退出码 0' }, { text: REVIEW_JSON }] });
  const result = await runHosted(bridge, { type: 'run', root, command: 'review', message: '/review', canExec: true, canShell: true, commands: [], model: MODEL });
  const models = seen.filter((m) => m.type === 'model');
  assert.equal(models.length, 2);
  assert.match(lastUser(models[1]), /不符合要求的格式/);
  assert.ok(!models[1].body.messages.some((m) => /你还没有成功调用|什么命令都没跑过/.test(String(m.content))));
  assert.match(result.text, /符号反了/);
});

test('/review：git 关在沙箱里，挡的是真的家目录（宿主自己的 HOME 只是个临时目录）：工作区就是家目录时 ~/.ssh 也读不到', { skip: detectSandbox() ? false : '这台机器没有系统沙箱' }, async () => {
  const { root } = gitRepo();
  // 工作区盖住了家目录是唯一看得出差别的情况：工作区是放开读的，~/.ssh 这些靠后面再挡一遍。家目录要是还是那个临时目录，就没挡
  const home = path.join(root, 'myhome');
  write(root, 'myhome/.ssh/ignore-me', '*.py\nmyhome/\n');   // 读得到的话，下面这个新文件就从审查里消失了
  fs.appendFileSync(path.join(root, '.git', 'config'), `[core]\n\texcludesFile = ${path.join(home, '.ssh', 'ignore-me')}\n`);
  write(root, 'new.py', 'x = 1\n');
  const run = async (extra) => {
    const { bridge, seen } = fakeBackend({ replies: [{ text: REVIEW_JSON }] });
    await runHosted(bridge, { type: 'run', root, command: 'review', message: '/review', model: MODEL, ...extra });
    return seen.filter((m) => m.type === 'model').length;
  };
  assert.equal(await run({ home }), 1, '沙箱挡住了：看得到 new.py，要叫模型');
  assert.equal(await run({}), 0, '对照：家目录没指对就读到了，没有改动可看');
});

test('/review：没有改动、不是仓库、参数不对、提交不存在：不叫模型，把原因写回去', async () => {
  const { root } = gitRepo();
  const cases = [
    [root, '/review', /没有改动/],
    [root, '/review --base', /--base 后面要跟一个值/],
    [root, '/review --base a --commit b', /只能给一个/],
    [root, '/review --base 没有这个分支', /没有这个分支/],
    [tmpdir(), '/review', /仓库/],
  ];
  for (const [dir, message, expected] of cases) {
    const { bridge, seen } = fakeBackend({ replies: [{ text: '不该走到这' }] });
    const result = await runHosted(bridge, { type: 'run', root: dir, command: 'review', message, model: MODEL });
    assert.match(result.text, expected, message);
    assert.equal(seen.filter((m) => m.type === 'model').length, 0, message);
  }
});

test('/review：模型调用失败、审查被中断：写一句「没做完」，不留空（留空的话最终回答只能照空的编）', async () => {
  const { root } = gitRepo();
  write(root, 'calc.py', 'x\n');
  const failed = fakeBackend({ replies: [{ error: '模型不在' }] });
  const a = await runHosted(failed.bridge, { type: 'run', root, command: 'review', message: '/review', model: MODEL });
  assert.match(a.text, /审查没做完：.*模型不在/);
  assert.match(a.context, /审查没做完/);
  const never = createBridge({ input: new PassThrough(), output: new PassThrough() });
  const b = await runHosted(never, { type: 'run', root, command: 'review', message: '/review', model: MODEL, timeoutMs: 50 });
  assert.match(b.text, /审查没做完/);
});

test('/init、/review 在生成到产物时不跑：根目录是临时空间，没有项目可看（页面拦过，这是最后一道）', async () => {
  for (const command of ['init', 'review']) {
    const root = tmpdir();
    const { bridge, seen } = fakeBackend({ replies: [{ text: '不该走到这' }] });
    const result = await runHosted(bridge, { type: 'run', root, artifact: true, command, message: `/${command}`, canWrite: true, model: MODEL });
    assert.match(result.text, new RegExp(`/${command} 要先选一个项目文件夹`));
    assert.equal(seen.filter((m) => m.type === 'model').length, 0);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test('认不出的 command 当普通的一句话', async () => {
  const root = tmpdir();
  const { bridge, seen } = fakeBackend({ replies: [{ text: '好' }] });
  const result = await runHosted(bridge, { type: 'run', root, command: 'rm -rf', message: '普通的一句', model: MODEL });
  assert.equal(lastUser(seen.find((m) => m.type === 'model')), '普通的一句');
  assert.equal(result.text, '好');
  const artifact = fakeBackend({ replies: [{ text: '好' }] });
  const inArtifact = await runHosted(artifact.bridge, { type: 'run', root: tmpdir(), artifact: true, command: 'rm -rf', message: '普通的一句', model: MODEL });
  assert.equal(inArtifact.text, '好', '生成到产物时也一样，不说要选文件夹');
});

// 第一百二十三轮：子 agent 这一轮只给命令行。网页的代码模式（这个宿主）下发的工具里没有，下发的和能执行的同一份
test('网页的代码模式没有派子 agent 的工具', async () => {
  const { bridge, seen } = fakeBackend({ replies: [{ text: '好' }] });
  await runHosted(bridge, { type: 'run', root: tmpdir(), message: '看看', canWrite: true, canExec: true, maxRounds: 3, model: MODEL });
  const tools = seen.find((m) => m.type === 'model').body.tools.map((x) => x.function.name);
  assert.ok(tools.includes('read_file'), '扫空了：' + tools.join());
  for (const n of ['spawn_agent', 'wait_agent', 'send_input', 'close_agent']) assert.ok(!tools.includes(n), n);
});
