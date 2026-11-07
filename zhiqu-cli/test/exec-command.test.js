// zhiqu exec（第一百一十三轮，Codex 同级第 6 步）：起真的 bin/zhiqu.js，接假服务器。看 stdout、stderr、退出码、磁盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { extractJson, validate } from '../src/tools/jsonschema.js';
import { detectSandbox } from '../src/tools/sandbox.js';
import { readStdin } from '../src/execmode.js';
import { PassThrough } from 'node:stream';
import { tmpdir, write } from './helpers.js';

const box = detectSandbox();
const sandboxSkip = box ? false : '这台机器没有系统沙箱';

/** 假服务器：replies 依次是模型的回答 */
async function server(t, replies) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (v) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: v })); };
      if (req.url.startsWith('/api/harness/models')) return json({ models: [{ id: 1, label: 'm', modelName: 'm', toolCalling: true, effectiveContextWindow: 100000 }], defaultModelId: 1 });
      if (req.url.startsWith('/api/harness/tools')) return json([]);
      if (req.url.startsWith('/api/harness/model/stream')) {
        const body = JSON.parse(raw);
        seen.push(body);
        const r = replies[Math.min(seen.length - 1, replies.length - 1)];
        res.setHeader('Content-Type', 'text/event-stream');
        const send = (name, data) => res.write(`event:${name}\ndata:${JSON.stringify(data)}\n\n`);
        if (r.hang) return undefined;   // 不回：看中断
        send('start', { contextWindow: 100000, droppedMessages: 0, elidedToolOutputs: 0 });
        const calls = (r.calls || []).map((c, i) => ({ id: `c${seen.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
        const message = { role: 'assistant', content: r.text || '' };
        if (calls.length) message.tool_calls = calls;
        send('done', { message, finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16000, usage: { promptTokens: 100, completionTokens: 7, cachedTokens: 40, estimated: false } });
        return res.end();
      }
      return json({});
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { url: `http://127.0.0.1:${srv.address().port}`, seen };
}

function zhiqu(args, { url, root = tmpdir(), home = tmpdir(), stdin = null, onSpawn } = {}) {
  const env = { PATH: process.env.PATH, HOME: home, ZHIQU_HOME: path.join(home, '.zhiqu'), ZHIQU_TOKEN: 'zqp_x', ZHIQU_SERVER: url || 'http://127.0.0.1:1' };
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.resolve('bin/zhiqu.js'), 'exec', ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ code, stdout, stderr, root, home }));
    if (stdin != null) c.stdin.end(stdin);
    else if (!onSpawn) c.stdin.end();
    if (onSpawn) onSpawn(c);
  });
}
const toolsOf = (body) => body.tools.map((x) => x.function.name);
const lastUser = (body) => body.messages.filter((m) => m.role === 'user').at(-1).content;

test('stdout 只有结论；进度走 stderr，结论不在 stderr 里再打一遍；退出码 0', async (t) => {
  const { url } = await server(t, [{ calls: [{ name: 'list_files' }] }, { text: '结论：一切正常' }]);
  const r = await zhiqu(['看看这个项目'], { url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '结论：一切正常\n');
  assert.match(r.stderr, /会话 /);
  assert.doesNotMatch(r.stderr, /结论：一切正常/);
});

test('默认只读：改文件的工具不给，也不用提交计划（没人批准）；模型硬调被拒；提示里说清楚', async (t) => {
  const { url, seen } = await server(t, [{ calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] }, { text: '好' }]);
  const r = await zhiqu(['改一下'], { url });
  assert.equal(r.code, 0, r.stderr);
  const tools = toolsOf(seen[0]);
  for (const name of ['write_file', 'edit_file', 'apply_patch', 'delete_file', 'exit_plan_mode', 'run_command']) assert.ok(!tools.includes(name), `不该给 ${name}`);
  assert.ok(tools.includes('read_file'));
  assert.equal(fs.existsSync(path.join(r.root, 'a.txt')), false);
  assert.match(seen[0].messages[0].content, /exec（只读，没有人在看）/);
  assert.doesNotMatch(seen[0].messages[0].content, /exit_plan_mode 把计划/);
  assert.match(seen[1].messages.at(-1).content, /--mode auto/, '告诉模型要写得用 --mode auto');
});

test('项目里的 settings.json 不能替用户开写权限；--mode auto 才能写；ask 拒绝（退出码 2，模型一次都不调）', async (t) => {
  const root = tmpdir();
  write(root, '.zhiqu/settings.json', JSON.stringify({ mode: 'auto' }));
  const a = await server(t, [{ text: '好' }]);
  await zhiqu(['看'], { url: a.url, root });
  assert.ok(!toolsOf(a.seen[0]).includes('write_file'), '克隆下来的仓库给自己开了写权限');

  const b = await server(t, [{ calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x\n' } }] }, { text: '写好了' }]);
  const r = await zhiqu(['写', '--mode', 'auto'], { url: b.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(r.root, 'a.txt'), 'utf8'), 'x\n');
  assert.ok(toolsOf(b.seen[0]).includes('apply_patch'));

  const c = await server(t, [{ text: '好' }]);
  const ask = await zhiqu(['写', '--mode', 'ask'], { url: c.url });
  assert.equal(ask.code, 2);
  assert.match(ask.stderr, /没有人能回答确认/);
  assert.equal(c.seen.length, 0);
  assert.equal((await zhiqu(['写', '--mode', 'nonsense'], { url: c.url })).code, 2);
});

test('系统沙箱：默认只读时 shell 写不了工作区；auto 写得了', { skip: sandboxSkip }, async (t) => {
  const a = await server(t, [{ calls: [{ name: 'shell', args: { command: 'echo x > a.txt; echo ran' } }] }, { text: '好' }]);
  const ro = await zhiqu(['跑'], { url: a.url });
  assert.equal(fs.existsSync(path.join(ro.root, 'a.txt')), false, '只读档写进工作区了');
  assert.match(a.seen[1].messages.at(-1).content, /ran/);
  const b = await server(t, [{ calls: [{ name: 'shell', args: { command: 'echo x > a.txt' } }] }, { text: '好' }]);
  const rw = await zhiqu(['跑', '--mode', 'auto'], { url: b.url });
  assert.equal(fs.readFileSync(path.join(rw.root, 'a.txt'), 'utf8'), 'x\n');
});

test('提示：参数；stdin；- 强制读 stdin；都有时 stdin 当材料；都没有退出码 2；stdin 开着没人写不卡', async (t) => {
  const { url, seen } = await server(t, [{ text: '好' }]);
  await zhiqu(['只有参数'], { url });
  assert.equal(lastUser(seen.at(-1)), '只有参数');
  await zhiqu([], { url, stdin: '从管道来的\n' });
  assert.equal(lastUser(seen.at(-1)), '从管道来的');
  await zhiqu(['-'], { url, stdin: '横杠也读管道' });
  assert.equal(lastUser(seen.at(-1)), '横杠也读管道');
  await zhiqu(['总结一下'], { url, stdin: '一段日志' });
  assert.equal(lastUser(seen.at(-1)), '总结一下\n\n<stdin>\n一段日志\n</stdin>');
  const none = await zhiqu([], { url, stdin: '' });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /没有提示/);
  const late = await zhiqu([], { url, onSpawn: (c) => setTimeout(() => c.stdin.end('管道来得慢'), 700) });
  assert.equal(late.code, 0, late.stderr);
  assert.equal(lastUser(seen.at(-1)), '管道来得慢', '没给参数时要等到管道结束');
  const t0 = Date.now();
  const open = await zhiqu(['管子开着没人写'], { url, onSpawn: () => {} });
  assert.equal(open.code, 0, open.stderr);
  assert.ok(Date.now() - t0 < 10_000, '被开着的 stdin 卡住了');
  assert.equal(lastUser(seen.at(-1)), '管子开着没人写');
});

test('readStdin：有提示时等一小会儿就算了；没提示时等到结束；来了数据就读完', async () => {
  const quiet = new PassThrough();
  const t0 = Date.now();
  assert.equal(await readStdin(quiet, { firstByteMs: 50 }), '');
  assert.ok(Date.now() - t0 < 1000);
  const slow = new PassThrough();
  const pending = readStdin(slow);
  setTimeout(() => { slow.write('晚'); slow.end('来的'); }, 100);
  assert.equal(await pending, '晚来的');
  const partial = new PassThrough();
  const p2 = readStdin(partial, { firstByteMs: 30 });
  partial.write('先到');
  setTimeout(() => partial.end('后到'), 80);
  assert.equal(await p2, '先到后到', '开始写了就不算超时');
});

test('--json：stdout 全是一行一个 JSON；事件和顺序；工具的参数和结果；用量；结论', async (t) => {
  const { url } = await server(t, [{ text: '先看看', calls: [{ name: 'list_files' }] }, { text: '结论' }]);
  const r = await zhiqu(['看', '--json'], { url });
  assert.equal(r.code, 0, r.stderr);
  const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ['thread.started', 'turn.started', 'item.completed', 'item.started', 'item.completed', 'item.completed', 'turn.completed']);
  assert.ok(events[0].thread_id);
  assert.deepEqual([events[2].item.type, events[2].item.text], ['agent_message', '先看看']);
  assert.deepEqual([events[3].item.type, events[3].item.name], ['tool_call', 'list_files']);
  assert.equal(events[4].item.id, events[3].item.id, '开始和完成是同一个 id');
  assert.ok('output' in events[4].item);
  assert.deepEqual([events[5].item.type, events[5].item.text], ['agent_message', '结论']);
  assert.deepEqual(events[6].usage, { input_tokens: 200, cached_input_tokens: 80, output_tokens: 14 });
  assert.equal(events[6].final_message, '结论');
  assert.equal(new Set([events[2].item.id, events[3].item.id, events[5].item.id]).size, 3);
  assert.doesNotMatch(r.stderr, /结论/);
});

test('--json：失败也是事件；退出码 1；stdout 没有不是 JSON 的东西', async () => {
  const r = await zhiqu(['看', '--json'], { url: 'http://127.0.0.1:1' });
  assert.notEqual(r.code, 0);
  for (const l of r.stdout.trim().split('\n').filter(Boolean)) JSON.parse(l);
});

test('--output-schema：符合就输出紧凑的 JSON；代码块也认；提示里带着 schema；-o 写文件', async (t) => {
  const root = tmpdir();
  write(root, 'schema.json', JSON.stringify({ type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false }));
  const { url, seen } = await server(t, [{ text: '```json\n{ "ok": true }\n```' }]);
  const r = await zhiqu(['判一下', '--output-schema', 'schema.json', '-o', 'out/result.json'], { url, root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '{"ok":true}\n');
  assert.equal(fs.readFileSync(path.join(root, 'out/result.json'), 'utf8'), '{"ok":true}\n');
  assert.match(lastUser(seen[0]), /JSON Schema/);
  assert.match(lastUser(seen[0]), /"required":\["ok"\]/);
  assert.equal(seen.length, 1);
});

test('--output-schema：不符合就推回去重写，说清哪里不对；改对了照常；一直不对退出码 1、stdout 和 -o 都没有半截', async (t) => {
  const root = tmpdir();
  write(root, 'schema.json', JSON.stringify({ type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }));
  const fixed = await server(t, [{ text: '这是结论' }, { text: '{"n":"一"}' }, { text: '{"n":1}' }]);
  const good = await zhiqu(['数', '--output-schema', 'schema.json'], { url: fixed.url, root });
  assert.equal(good.code, 0, good.stderr);
  assert.equal(good.stdout, '{"n":1}\n');
  assert.equal(fixed.seen.length, 3);
  assert.match(lastUser(fixed.seen[1]), /不是合法的 JSON/);
  assert.match(lastUser(fixed.seen[2]), /\$\.n：应当是 integer/);

  const never = await server(t, [{ text: '就不' }]);
  const bad = await zhiqu(['数', '--output-schema', 'schema.json', '-o', 'never.json'], { url: never.url, root });
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, '');
  assert.equal(never.seen.length, 3, '最多重写两次');
  assert.match(bad.stderr, /不符合 --output-schema（试了 3 次）/);
  assert.equal(fs.existsSync(path.join(root, 'never.json')), false);

  const events = await zhiqu(['数', '--output-schema', 'schema.json', '--json'], { url: never.url, root });
  assert.equal(events.code, 1);
  assert.equal(JSON.parse(events.stdout.trim().split('\n').at(-1)).type, 'turn.failed');
  for (const [args, why] of [[['--output-schema', 'missing.json'], /读不了/], [['--output-schema', 'not-json.txt'], /读不了/]]) {
    write(root, 'not-json.txt', 'nope');
    const u = await zhiqu(['数', ...args], { url: never.url, root });
    assert.equal(u.code, 2);
    assert.match(u.stderr, why);
  }
  write(root, 'array.json', '[1]');
  assert.equal((await zhiqu(['数', '--output-schema', 'array.json'], { url: never.url, root })).code, 2);
});

test('resume：接着上一段（模型看得到前面的）；不继承上次的 auto；接不上就说，不悄悄开新的；--ephemeral 不留会话', async (t) => {
  const root = tmpdir();
  const home = tmpdir();
  const a = await server(t, [{ text: '第一次的结论' }]);
  const first = await zhiqu(['第一句', '--mode', 'auto'], { url: a.url, root, home });
  // 上一段记着「现在是 auto」（交互模式里切过档位就会记）：续接时不能跟着变成能写
  const firstId = /会话 ([\w-]+)/.exec(first.stderr)[1];
  fs.appendFileSync(path.join(root, '.zhiqu', 'sessions', `${firstId}.jsonl`), `${JSON.stringify({ type: 'mode', mode: 'auto' })}\n`);
  const b = await server(t, [{ text: '第二次的结论' }]);
  const r = await zhiqu(['resume', '--last', '接着问'], { url: b.url, root, home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '第二次的结论\n', '不把前面的对话打到 stdout');
  assert.doesNotMatch(r.stderr, /第一次的结论/, '也不打到 stderr：脚本要的是这一次的');
  const said = b.seen[0].messages.map((m) => m.content).join('\n');
  assert.match(said, /第一句/);
  assert.match(said, /第一次的结论/);
  assert.ok(!toolsOf(b.seen[0]).includes('write_file'), '上次是 auto，这次没说，不能继承写权限');
  const id = /会话 ([\w-]+)/.exec(r.stderr)[1];
  const c = await server(t, [{ text: '第三次' }]);
  const byId = await zhiqu(['resume', id, '再问', '--mode', 'auto'], { url: c.url, root, home });
  assert.equal(byId.code, 0, byId.stderr);
  assert.match(c.seen[0].messages.map((m) => m.content).join('\n'), /接着问/);
  assert.ok(toolsOf(c.seen[0]).includes('write_file'), '明说了 auto 就给');

  const empty = tmpdir();
  const none = await zhiqu(['resume', '--last', '接着'], { url: c.url, root: empty, home });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /没有可以接着的/);
  const noId = await zhiqu(['resume', 'nope', '接着'], { url: c.url, root, home });
  assert.equal(noId.code, 1);
  assert.match(noId.stderr, /没有 nope 这段会话/);
  const noTarget = await zhiqu(['resume'], { url: c.url, root, home, stdin: '接着' });
  assert.equal(noTarget.code, 2, '没说接哪段，不能悄悄开新的');
  assert.match(noTarget.stderr, /要说接哪一段/);
  assert.equal((await zhiqu(['--last', '接着'], { url: c.url, root, home })).code, 2, '--last 要和 resume 一起');
  assert.equal((await zhiqu(['resume', '--last', '接着', '--ephemeral'], { url: c.url, root, home })).code, 2);

  const eph = tmpdir();
  const e = await zhiqu(['不留', '--ephemeral'], { url: c.url, root: eph, home });
  assert.equal(e.code, 0, e.stderr);
  assert.equal(fs.existsSync(path.join(eph, '.zhiqu', 'sessions')), false, '--ephemeral 留了会话');
});

test('被中断：退出码 130，stdout 没有东西', async (t) => {
  const { url, seen } = await server(t, [{ hang: true }]);
  const r = await zhiqu(['等'], { url, onSpawn: (c) => {
    c.stdin.end();
    const timer = setInterval(() => { if (seen.length) { clearInterval(timer); c.kill('SIGINT'); } }, 20);
  } });
  assert.equal(r.code, 130, r.stderr);
  assert.equal(r.stdout, '');
});

test('模型什么都没说：算失败，不输出一个空行当结论；连着发同一个调用被停下：退出码 1', async (t) => {
  const empty = await server(t, [{ text: '' }]);
  const r = await zhiqu(['说'], { url: empty.url });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /没有给出结论/);
  const loop = await server(t, [{ calls: [{ name: 'list_files' }] }]);
  const l = await zhiqu(['说'], { url: loop.url });
  assert.equal(l.code, 1, l.stderr);
  assert.equal(l.stdout, '');
  assert.match(l.stderr, /已经停下/);
});

test('JSON Schema 校验：类型、必填、多余字段、枚举、范围、长度、数组、嵌套路径、组合、$ref', () => {
  const v = (schema, value) => validate(schema, value);
  assert.deepEqual(v({ type: 'string' }, 'x'), []);
  assert.match(v({ type: 'string' }, 1)[0], /\$：应当是 string，实际是 number/);
  assert.deepEqual(v({ type: ['string', 'null'] }, null), []);
  assert.deepEqual(v({ type: 'integer' }, 2), []);
  assert.equal(v({ type: 'integer' }, 2.5).length, 1);
  assert.equal(v({ type: 'object' }, []).length, 1, '数组不是对象');
  assert.equal(v({ type: 'array' }, {}).length, 1);
  assert.equal(v({ type: 'object' }, null).length, 1, 'null 不是对象');
  assert.equal(v({ type: 'string', enum: ['a'] }, 1).length, 1, '类型都不对就只说类型');
  assert.match(v({ required: ['a'] }, {})[0], /缺少 a/);
  assert.deepEqual(v({ required: ['a'] }, 'not-object'), [], 'required 只管对象');
  assert.match(v({ properties: { a: { type: 'number' } } }, { a: 'x' })[0], /\$\.a：应当是 number/);
  assert.match(v({ additionalProperties: false, properties: { a: {} } }, { a: 1, b: 2 })[0], /不该有 b/);
  assert.equal(v({ additionalProperties: { type: 'number' } }, { b: 'x' }).length, 1);
  assert.deepEqual(v({ additionalProperties: { type: 'number' } }, { b: 1 }), []);
  assert.equal(v({ enum: ['a', 1] }, 'b').length, 1);
  assert.deepEqual(v({ enum: ['a', 1] }, 1), []);
  assert.equal(v({ const: { a: 1 } }, { a: 2 }).length, 1);
  assert.deepEqual(v({ const: null }, null), []);
  assert.equal(v({ minimum: 1 }, 0).length, 1);
  assert.equal(v({ maximum: 1 }, 2).length, 1);
  assert.equal(v({ exclusiveMinimum: 1 }, 1).length, 1);
  assert.equal(v({ exclusiveMaximum: 1 }, 1).length, 1);
  assert.deepEqual(v({ minimum: 1, maximum: 1 }, 1), []);
  assert.equal(v({ minLength: 2 }, '汉').length, 1, '按字符算');
  assert.deepEqual(v({ maxLength: 1 }, '汉'), [], '一个汉字是一个字符');
  assert.equal(v({ pattern: '^a' }, 'b').length, 1);
  assert.equal(v({ minItems: 1 }, []).length, 1);
  assert.equal(v({ maxItems: 0 }, [1]).length, 1);
  assert.equal(v({ uniqueItems: true }, [1, 1]).length, 1);
  assert.match(v({ items: { type: 'string' } }, ['a', 1])[0], /\$\[1\]：应当是 string/);
  assert.match(v({ properties: { a: { items: { properties: { b: { type: 'string' } } } } } }, { a: [{ b: 1 }] })[0], /\$\.a\[0\]\.b/);
  assert.deepEqual(v({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 1), []);
  assert.equal(v({ anyOf: [{ type: 'string' }] }, 1).length, 1);
  assert.equal(v({ oneOf: [{ type: 'number' }, { minimum: 0 }] }, 1).length, 1, '符合了两个');
  assert.deepEqual(v({ oneOf: [{ type: 'number' }, { type: 'string' }] }, 1), []);
  assert.equal(v({ allOf: [{ type: 'number' }, { minimum: 5 }] }, 1).length, 1);
  assert.equal(v({ not: { type: 'string' } }, 'x').length, 1);
  const refs = { $defs: { n: { type: 'number' } }, properties: { a: { $ref: '#/$defs/n' } } };
  assert.equal(v(refs, { a: 'x' }).length, 1);
  assert.deepEqual(v(refs, { a: 1 }), []);
  assert.match(v({ $ref: '#/nope' }, 1)[0], /找不到/);
  assert.match(v({ $ref: 'http://x' }, 1)[0], /找不到/);
  assert.deepEqual(v(true, 1), []);
  assert.equal(v(false, 1).length, 1);
  assert.deepEqual(v({ format: 'email', title: 'x' }, 1), [], '不认的关键字不管');
  const loop = { $ref: '#' };
  assert.match(v(loop, 1)[0], /嵌套太深/, '自己引用自己不能卡死');
  assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepEqual(extractJson('```\n[1]\n```').value, [1]);
  assert.match(extractJson('这是结论 {"a":1}').error, /不是合法的 JSON/);
  assert.match(extractJson('').error, /不是合法的 JSON/);
});
