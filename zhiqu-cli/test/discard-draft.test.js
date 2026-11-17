// 撤回这一轮生成的草稿（第一百五十六轮，用户要的）：真 DeepSeek 那一遍里，用户写完测试草稿后说「不要了」，模型没办法撤 ——
// 一遍让用户自己去页面上拒绝，一遍把它改成空内容的草稿、还说确认后磁盘上不会有这个文件（确认空的新建草稿会写出一个空文件）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { ArtifactTools, DesktopTools, DraftTools } from '../src/tools/drafts.js';
import { LocalTools } from '../src/tools/local.js';
import { describeCall, toolset } from '../src/agent.js';
import { environmentBlock } from '../src/prompt.js';
import { createBridge, runHosted } from '../src/host/code-host.js';
import { tmpdir, write } from './helpers.js';

const names = (local, mode = 'auto') => toolset({ local, mode }).map((t) => t.schema.function.name);

test('新建的草稿撤回：草稿单里没了、再读说不存在、磁盘上没有；改过的撤回：读到的是磁盘上的样子、要改先重新读', () => {
  const root = tmpdir();
  write(root, 'calc.py', 'def add(a, b):\n    return a + b\n');
  const t = new DraftTools({ root, canWrite: true });
  t.commitWrite(t.prepareWrite({ path: 'tests/test_calc.py', content: 'assert True\n' }));
  t.readFile({ path: 'calc.py' });
  t.commitWrite(t.prepareEdit({ path: 'calc.py', old_string: 'a + b', new_string: 'a - b' }));
  assert.deepEqual(t.draftList().map((d) => d.path), ['tests/test_calc.py', 'calc.py']);

  const gone = t.discardDraft({ path: 'tests/test_calc.py' });
  assert.ok(!gone.error, gone.error);
  assert.equal(gone.creating, true);
  assert.match(gone.content, /当没建过/);
  assert.deepEqual(t.draftList().map((d) => d.path), ['calc.py'], '撤回的那份还在草稿单里：用户确认时照样会写出来');
  const reread = t.readFile({ path: 'tests/test_calc.py' });
  assert.match(String(reread.error || reread.content), /不存在|没有/, '撤回之后草稿层里还读得到它');
  assert.match(t.search({ query: 'assert True' }).content, /没有找到/, '撤回之后搜索还搜得到那份草稿');
  assert.equal(fs.existsSync(path.join(root, 'tests')), false);

  const back = t.discardDraft({ path: './calc.py' });
  assert.ok(!back.error, back.error);
  assert.equal(back.creating, false);
  assert.deepEqual(t.draftList(), []);
  // 必须是「还没读过」那种拒绝。只匹配 read_file 不够：不清掉读过的记录时，哈希对不上，
  // 报的是「被改过了，请重新 read_file」—— 模型会以为用户在编辑器里改了文件
  assert.match(t.prepareEdit({ path: 'calc.py', old_string: 'a + b', new_string: 'a * b' }).error || '', /必须先 read_file/);
  assert.match(t.readFile({ path: 'calc.py' }).content, /a \+ b/, '撤回之后读到的不是磁盘上的样子');
  assert.doesNotMatch(t.search({ query: 'a - b' }).content, /calc\.py/, '撤回之后还搜得到草稿里的那一行');
  assert.match(t.search({ query: 'a + b' }).content, /calc\.py/);
  assert.equal(fs.readFileSync(path.join(root, 'calc.py'), 'utf8'), 'def add(a, b):\n    return a + b\n');

  // 这一轮没写过的、之前几轮的：说清楚撤不了、去页面上拒绝；空路径、跳出工作区、目录、软链都拒。
  // 放在「重新生成一份」之前：重新生成之后 calc.py 又有草稿了
  assert.match(t.discardDraft({ path: 'calc.py' }).error, /没有给 calc\.py 生成过草稿.*页面上/);
  assert.match(t.discardDraft({}).error, /path/);
  assert.match(t.discardDraft({ path: '   ' }).error, /path/);
  assert.match(t.discardDraft({ path: 1 }).error, /path/);
  assert.ok(t.discardDraft({ path: '../x.py' }).error);
  assert.ok(t.discardDraft({ path: '/etc/passwd' }).error);
  fs.mkdirSync(path.join(root, 'sub'));
  assert.match(t.discardDraft({ path: 'sub' }).error, /目录|普通文件/);
  fs.symlinkSync('calc.py', path.join(root, 'link.py'));
  assert.match(t.discardDraft({ path: 'link.py' }).error, /符号链接|软链/);
  // 重新读过磁盘上的样子之后可以再生成草稿，而且仍然不落盘
  const again = t.commitWrite(t.prepareEdit({ path: 'calc.py', old_string: 'a + b', new_string: 'a * b' }));
  assert.ok(!again.error, again.error);
  assert.match(t.readFile({ path: 'calc.py' }).content, /a \* b/);
  assert.equal(fs.readFileSync(path.join(root, 'calc.py'), 'utf8'), 'def add(a, b):\n    return a + b\n');
  const abs = t.discardDraft({ path: path.join(root, 'calc.py') });
  assert.ok(!abs.error, abs.error);
  assert.equal(abs.rel, 'calc.py', '工作区里的绝对路径也撤得掉');
  assert.deepEqual(t.draftList(), []);
});

test('下发：草稿模式给了写才有 discard_draft；只读、plan 档、命令行（直接写盘、没有草稿）、生成到产物（写的是真文件）都没有；没下发的照样执行不了', async () => {
  const root = tmpdir();
  assert.ok(names(new DraftTools({ root, canWrite: true })).includes('discard_draft'));
  assert.ok(names(new DesktopTools({ root, canWrite: true })).includes('discard_draft'));
  assert.ok(!names(new DraftTools({ root })).includes('discard_draft'), '只读的也给了撤回');
  assert.ok(!names(new DraftTools({ root, canWrite: true }), 'plan').includes('discard_draft'), 'plan 档给了撤回');
  assert.ok(!names(new LocalTools({ root })).includes('discard_draft'), '命令行没有草稿，不该有撤回');
  assert.ok(!names(new ArtifactTools({ root, canWrite: true })).includes('discard_draft'), '生成到产物没有草稿，不该有撤回');
  const env = { root: '/r', workspaceName: 'r', mode: 'auto', commands: ['node'], today: '2026-11-18' };
  const draftEnv = environmentBlock({ ...env, draft: true });
  assert.match(draftEnv, /discard_draft/);
  assert.match(draftEnv, /不要把内容改成空/);
  assert.doesNotMatch(environmentBlock(env), /discard_draft/, '命令行直接写盘，不该教它撤回草稿');
  assert.doesNotMatch(environmentBlock({ ...env, artifact: true }), /discard_draft/, '生成到产物不该教它撤回草稿');
  assert.equal(describeCall('discard_draft', { path: 'test_calc.py' }), '撤回 test_calc.py 的草稿');
});

/** 假后端：按脚本回模型调用 */
function fakeBackend(replies) {
  const toHost = new PassThrough(), fromHost = new PassThrough();
  const seen = []; let n = 0;
  readline.createInterface({ input: fromHost }).on('line', (line) => {
    const msg = JSON.parse(line); seen.push(msg);
    if (msg.type !== 'model') return;
    const r = replies[Math.min(n++, replies.length - 1)];
    const send = (m) => toHost.write(`${JSON.stringify(m)}\n`);
    send({ type: 'event', id: msg.id, name: 'start', data: { contextWindow: 1_000_000 } });
    const calls = (r.calls || []).map((c, i) => ({ id: `c${n}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    send({ type: 'event', id: msg.id, name: 'done', data: { message: { role: 'assistant', content: r.text || '', ...(calls.length ? { tool_calls: calls } : {}) },
      finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16384, usage: { promptTokens: 10, completionTokens: 1, cachedTokens: 0, estimated: false } } });
  });
  return { bridge: createBridge({ input: toHost, output: fromHost }), seen };
}
const MODEL = { id: 6, label: '测试模型', modelName: 'fake', effectiveContextWindow: 1_000_000 };

test('宿主一轮：写两份草稿、撤回一份 —— 交给后端的草稿只剩一份，回答里一步「撤回草稿」，下发的工具里有它', async () => {
  const root = tmpdir();
  const { bridge, seen } = fakeBackend([
    { calls: [{ name: 'write_file', args: { path: 'calc.py', content: 'def add(a, b):\n    return a + b\n' } }, { name: 'write_file', args: { path: 'test_calc.py', content: 'from calc import add\n' } }] },
    { calls: [{ name: 'discard_draft', args: { path: 'test_calc.py' } }] },
    { text: '只留了 calc.py 的草稿，确认后生效。' },
  ]);
  const result = await runHosted(bridge, { type: 'run', root, message: '写 calc.py，不要测试', canWrite: true, maxRounds: 10, model: MODEL });
  assert.deepEqual(result.drafts.map((d) => d.path), ['calc.py'], '撤回的草稿还交给了后端');
  const tools = seen.find((m) => m.type === 'model').body.tools.map((t) => t.function.name);
  assert.ok(tools.includes('discard_draft'), '下发的工具里没有 discard_draft');
  const step = seen.filter((m) => m.type === 'trace' && m.step.title === '撤回草稿' && m.step.status !== 'running');
  assert.equal(step.length, 1, '回答里没有「撤回草稿」那一步');
  assert.equal(step[0].step.target, 'test_calc.py');
  assert.equal(step[0].step.kind, 'delete');
  assert.match(seen.filter((m) => m.type === 'model').at(-1).body.messages.find((m) => m.role === 'tool' && /撤回/.test(m.content)).content, /当没建过/);
  assert.match(seen.find((m) => m.type === 'model').body.messages.find((m) => m.role === 'system').content, /discard_draft/);
});

test('生成到产物时模型硬调 discard_draft：文件还在磁盘上，回的是「没有这个工具」，不是「已撤回」', async () => {
  const root = tmpdir();
  const { bridge, seen } = fakeBackend([
    { calls: [{ name: 'write_file', args: { path: 'a.py', content: 'x = 1\n' } }] },
    { calls: [{ name: 'discard_draft', args: { path: 'a.py' } }] },
    { text: '写好了。' },
  ]);
  const result = await runHosted(bridge, { type: 'run', root, message: '写一个 a.py', canWrite: true, artifact: true, maxRounds: 6, model: MODEL });
  assert.equal(fs.readFileSync(path.join(root, 'a.py'), 'utf8'), 'x = 1\n', '没下发的撤回把真文件删了或清空了');
  assert.equal(result.drafts.length, 0);
  const said = seen.filter((m) => m.type === 'model').at(-1).body.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  assert.match(said, /没有叫 discard_draft 的工具/);
  assert.doesNotMatch(said, /已撤回/);
});

test('暴力：四十份草稿撤一半、空内容、名字里有空格、同一份撤两次；撤一个不影响另一个，磁盘不动', () => {
  const root = tmpdir();
  write(root, 'keep.py', 'keep = 1\n');
  const t = new DraftTools({ root, canWrite: true });
  const made = [];
  for (let i = 0; i < 40; i++) {
    const p = i % 2 ? `batch/n${i}.py` : `my file ${i}.py`;
    made.push(p);
    const r = t.commitWrite(t.prepareWrite({ path: p, content: `MARK_${i} = ${i}\n` }));
    assert.ok(!r.error, `${p} ${r.error}`);
  }
  assert.ok(!t.commitWrite(t.prepareWrite({ path: 'empty.py', content: '' })).error);
  t.readFile({ path: 'keep.py' });
  assert.ok(!t.commitWrite(t.prepareEdit({ path: 'keep.py', old_string: 'keep = 1', new_string: 'keep = 2' })).error);
  for (let i = 0; i < made.length; i += 2) {
    const r = t.discardDraft({ path: made[i] });
    assert.ok(!r.error, `${made[i]} ${r.error}`);
    assert.match(t.discardDraft({ path: made[i] }).error, /没有给/, '撤两次还当成功');
    assert.equal(fs.existsSync(path.join(root, made[i])), false);
  }
  assert.equal(t.discardDraft({ path: 'empty.py' }).creating, true);
  assert.equal(t.draftList().length, 21, '奇数那 20 份加 keep.py');
  assert.match(t.search({ query: 'MARK_0' }).content, /没有找到/);
  assert.match(t.search({ query: 'MARK_1' }).content, /n1\.py/);
  assert.match(t.search({ query: 'keep = 2' }).content, /keep\.py/);
  assert.equal(t.discardDraft({ path: 'keep.py' }).creating, false);
  assert.match(t.readFile({ path: 'keep.py' }).content, /keep = 1/);
  assert.equal(fs.readFileSync(path.join(root, 'keep.py'), 'utf8'), 'keep = 1\n');
  assert.equal(t.draftList().length, 20);
});

test('状态卡：撤回之后「改过的文件」「新建的文件」里都没有它 —— 不然压缩之后模型照着卡以为还写着它', async () => {
  const { WorkState } = await import('../src/state.js');
  const w = new WorkState(null);
  w.edited('test_calc.py', { creating: true, added: 3 });
  w.edited('calc.py', { added: 1, removed: 1, line: 2 });
  w.data.churn['test_calc.py:1'] = 6;
  w.data.churn['calc.py:1'] = 8;
  w.focus('test_calc.py', 1, 40);
  w.focus('calc.py', 10, 20);
  assert.match(w.card(), /test_calc\.py/);
  assert.match(w.card(), /同一处改得多/);
  w.discarded('test_calc.py');
  const card = w.card();
  assert.ok(!card.includes('test_calc.py'), card);
  assert.match(card, /calc\.py/, '没撤回的那个不能一起拿掉');
  assert.equal(w.data.churn['test_calc.py:1'], undefined, '撤回之后「同一处改得多」还记着它');
  assert.equal(w.data.churn['calc.py:1'], 8, '没撤回的那个的次数不能一起清掉');
  assert.deepEqual(w.data.focus.map((x) => x.path), ['calc.py'], '撤回之后压缩还会把它的内容塞回去');
});
