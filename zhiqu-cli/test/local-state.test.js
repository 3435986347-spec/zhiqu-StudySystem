// 本地状态坏了（第十六轮）：强杀 / 手改坏的配置文件、会话索引。坏了要说出来，不能悄悄当成「没有」，更不能悄悄覆盖掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSettings, saveUserConfig, systemContent } from '../src/config.js';
import { SessionStore } from '../src/session.js';
import { tmpdir, write } from './helpers.js';

const BROKEN = '{"server": "https://my.server", "token": "zqp_real_one", "mode": "auto",}';

function freshHome() {
  process.env.ZHIQU_HOME = tmpdir('zq-home-');
  return process.env.ZHIQU_HOME;
}

test('config.json 坏了：说出是哪个文件、错在哪、为什么读不到登录信息 —— 不再只说「还没登录」', () => {
  const home = freshHome();
  write(home, 'config.json', BROKEN);
  const s = resolveSettings(tmpdir());
  assert.equal(s.token, '');
  const w = s.warnings.join('\n');
  assert.match(w, /config\.json 不是合法的 JSON/);
  assert.match(w, /登录信息和个人设置都读不到/);
  assert.match(w, /文件没动/);
});

test('没有 config.json：正常，不报', () => {
  freshHome();
  assert.deepEqual(resolveSettings(tmpdir()).warnings, []);
});

test('.zhiqu/settings.json 坏了：说出来（原来允许的命令悄悄不生效）', () => {
  freshHome();
  const root = tmpdir();
  write(root, '.zhiqu/settings.json', '{"allowedCommands": ["npm test",]');
  const s = resolveSettings(root);
  assert.equal(s.allowedCommands, null);
  assert.match(s.warnings.join('\n'), /\.zhiqu\/settings\.json 不是合法的 JSON.*允许的命令/);
});

test('改好了：不再报', () => {
  const home = freshHome();
  write(home, 'config.json', BROKEN);
  resolveSettings(tmpdir());
  write(home, 'config.json', JSON.stringify({ token: 'zqp_x' }));
  const s = resolveSettings(tmpdir());
  assert.equal(s.token, 'zqp_x');
  assert.deepEqual(s.warnings, []);
});

test('config.json 坏了：启动时的记账不去写它（原来每次启动都把它换成两个指纹，令牌、服务器地址全丢，一句话都没有）', () => {
  const home = freshHome();
  write(home, 'config.json', BROKEN);
  resolveSettings(tmpdir());
  const sys = systemContent(tmpdir());
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), BROKEN, 'config.json 被改了');
  assert.equal(sys.notice, null, '读不到指纹时不该误报「你的 system.md 改过」');
  assert.ok(sys.text.length > 0);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith('config.json.broken-')), []);
});

test('config.json 坏了还要写（登录、/verbose）：先把坏的另存一份，原样保留，再写新的', () => {
  const home = freshHome();
  write(home, 'config.json', BROKEN);
  const errWrite = process.stderr.write;
  let said = '';
  process.stderr.write = (chunk) => { said += chunk; return true; };
  try {
    saveUserConfig({ showThinking: true });
  } finally {
    process.stderr.write = errWrite;
  }
  const backups = fs.readdirSync(home).filter((f) => f.startsWith('config.json.broken-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(home, backups[0]), 'utf8'), BROKEN, '另存的那份要和原来一字不差');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')), { showThinking: true });
  assert.match(said, /不是合法的 JSON，已另存为 config\.json\.broken-/);
});

test('会话索引坏了：会话从记录文件里找回来，/resume 还能用；之后新建会话也不会把它们冲掉', () => {
  const root = tmpdir();
  const store = new SessionStore(root);
  const a = store.create({ title: '做个游戏' });
  store.append(a.id, { type: 'message', message: { role: 'user', content: '帮我做一个贪吃蛇' } });
  store.append(a.id, { type: 'message', message: { role: 'assistant', content: '好' } });
  fs.writeFileSync(store.index, '{"sessions": [{"id": "');          // 强杀在写索引的那一刻
  const found = store.list().find((s) => s.id === a.id);
  assert.ok(found, '坏掉的索引里的会话找不回来了');
  assert.equal(found.title, '帮我做一个贪吃蛇');
  assert.equal(found.messages, 2);
  assert.equal(store.load(a.id).messages.length, 2);
  const b = store.create({ title: '第二段' });
  const ids = store.list().map((s) => s.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id), `新建之后找回来的那段又没了：${ids}`);
  assert.ok(JSON.parse(fs.readFileSync(store.index, 'utf8')).sessions.some((s) => s.id === a.id), '找回来的要存进索引');
});

test('索引是好的、但少了几段（以前被覆盖过）：一样找回来；goal 推的那种不是用户打的消息不当标题', () => {
  const root = tmpdir();
  const store = new SessionStore(root);
  const a = store.create({ title: '' });
  store.append(a.id, { type: 'message', origin: 'goal', message: { role: 'user', content: '（继续追目标）' } });
  store.append(a.id, { type: 'message', message: { role: 'user', content: '真正的第一句' } });
  fs.writeFileSync(store.index, JSON.stringify({ version: 1, sessions: [], lastSessionId: null }));
  const found = store.list().find((s) => s.id === a.id);
  assert.ok(found);
  assert.equal(found.title, '真正的第一句');
});

test('真跑 zhiqu -p：config.json 坏了 —— 先说是哪个文件坏了，再说还没登录（原来只有后半句）', async () => {
  const { spawn } = await import('node:child_process');
  const home = tmpdir('zq-home-');
  write(home, 'config.json', BROKEN);
  const env = { ...process.env, ZHIQU_HOME: home };
  delete env.ZHIQU_TOKEN;
  delete env.ZHIQU_SERVER;
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.resolve('bin/zhiqu.js'), '-p', '你好'], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (d) => { o += d; });
    c.stderr.on('data', (d) => { o += d; });
    c.on('close', (code) => resolve({ code, o }));
  });
  assert.equal(out.code, 1);
  const warnAt = out.o.indexOf('不是合法的 JSON');
  const loginAt = out.o.indexOf('还没登录');
  assert.ok(warnAt >= 0 && loginAt > warnAt, out.o);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), BROKEN);
});
