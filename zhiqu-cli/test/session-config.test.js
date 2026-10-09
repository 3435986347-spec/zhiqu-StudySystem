// 会话记录（/resume）与配置（~/.zhiqu、项目 .zhiqu、系统内容 system.md）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SessionStore, dropDanglingToolCalls } from '../src/session.js';
import { loadProjectSettings, normalizeMode, resolveSettings, systemContent, resetSystemContent } from '../src/config.js';
import { BUILTIN_SYSTEM_PROMPT } from '../src/prompt.js';
import { tmpdir, write } from './helpers.js';

test('会话：建索引、逐行记录、重放；.gitignore 忽略聊天记录但不忽略 skills / mcp.json', () => {
  const root = tmpdir();
  const store = new SessionStore(root);
  const s = store.create({ title: '做个游戏' });
  store.append(s.id, { type: 'message', message: { role: 'user', content: '你好' } });
  store.append(s.id, { type: 'message', message: { role: 'assistant', content: '好' } });
  store.append(s.id, { type: 'mode', mode: 'auto' });
  fs.appendFileSync(store.file(s.id), '{坏掉的一行\n');
  const loaded = store.load(s.id);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.mode, 'auto');
  assert.equal(loaded.broken, 1);
  const gi = fs.readFileSync(path.join(root, '.zhiqu/.gitignore'), 'utf8');
  assert.match(gi, /^sessions\/$/m);
  assert.match(gi, /^setup\.json$/m);
  assert.ok(!/^skills/m.test(gi) && !/^mcp\.json/m.test(gi), 'skills/ 与 mcp.json 要能提交共享');
  assert.equal(store.last().id, s.id);
});

test('会话：压缩记录会替换掉之前的消息；续接时没有结果的工具调用补一条「被中断」', () => {
  const root = tmpdir();
  const store = new SessionStore(root);
  const s = store.create();
  store.append(s.id, { type: 'message', message: { role: 'user', content: '旧' } });
  store.append(s.id, { type: 'compact', messages: [{ role: 'user', content: '【摘要】' }, { role: 'assistant', content: '好的' }] });
  store.append(s.id, { type: 'message', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] } });
  const loaded = store.load(s.id);
  assert.equal(loaded.messages[0].content, '【摘要】');
  assert.deepEqual(loaded.messages.at(-1), { role: 'tool', tool_call_id: 'c1', content: '（这次调用被中断了，没有结果）' });
  assert.throws(() => store.file('../x'), /会话 id 不对/);
});

test('dropDanglingToolCalls：已经有结果的不重复补', () => {
  const msgs = [
    { role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
  ];
  const out = dropDanglingToolCalls(msgs);
  assert.deepEqual(out.map((m) => m.tool_call_id || 'asst'), ['asst', 'a', 'b']);
});

test('档位：plan / ask / auto，旧叫法 read / write / exec 也认；认不出来是 null（不就近取一档）', () => {
  assert.equal(normalizeMode('read'), 'plan');
  assert.equal(normalizeMode('write'), 'ask');
  assert.equal(normalizeMode('exec'), 'auto');
  assert.equal(normalizeMode('AUTO'), 'auto');
  assert.equal(normalizeMode('on'), null);
});

test('项目 settings.json 里的 token 一律忽略并提示（这个文件可能被提交）；层级：参数 > 项目 > 用户', () => {
  process.env.ZHIQU_HOME = tmpdir();
  delete process.env.ZHIQU_TOKEN;
  delete process.env.ZHIQU_SERVER;
  write(process.env.ZHIQU_HOME, 'config.json', JSON.stringify({ server: 'http://user', token: 'zqp_user', mode: 'auto' }));
  const root = tmpdir();
  write(root, '.zhiqu/settings.json', JSON.stringify({ server: 'http://project', token: 'zqp_leaked' }));
  const { settings, warnings } = loadProjectSettings(root);
  assert.equal(settings.token, undefined);
  assert.match(warnings[0], /token 已忽略/);
  const r = resolveSettings(root, {});
  assert.equal(r.token, 'zqp_user', '令牌只从用户级来');
  assert.equal(r.server, 'http://project');
  assert.equal(r.mode, 'auto');
  assert.equal(resolveSettings(root, { server: 'http://flag/' }).server, 'http://flag');
});

test('系统内容：第一次写一份；没改过的副本跟着内置更新；改过的一个字不动并提示；工作区的优先', () => {
  process.env.ZHIQU_HOME = tmpdir();
  const root = tmpdir();
  const first = systemContent(root);
  const file = path.join(process.env.ZHIQU_HOME, 'system.md');
  assert.equal(fs.readFileSync(file, 'utf8'), BUILTIN_SYSTEM_PROMPT);
  assert.match(first.notice, /已把系统内容写到/);
  assert.equal(systemContent(root).notice, null, '第二次不该再提示');

  // 模拟「内置版本更新了」：把记下的内置指纹改掉
  const cfgFile = path.join(process.env.ZHIQU_HOME, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, systemBuiltinHash: 'old' }));
  assert.match(systemContent(root).notice, /你没改过那一份，已跟着更新/);

  fs.writeFileSync(file, '我自己的系统内容');
  const cfg2 = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg2, systemBuiltinHash: 'old' }));
  const custom = systemContent(root);
  assert.equal(custom.text, '我自己的系统内容');
  assert.match(custom.notice, /改过，所以没动它/);
  assert.equal(fs.readFileSync(file, 'utf8'), '我自己的系统内容');

  write(root, '.zhiqu/system.md', '项目的系统内容');
  assert.equal(systemContent(root).source, 'project');
  resetSystemContent();
  assert.equal(fs.readFileSync(file, 'utf8'), BUILTIN_SYSTEM_PROMPT);
});
