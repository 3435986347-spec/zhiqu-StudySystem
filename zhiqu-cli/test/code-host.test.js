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
