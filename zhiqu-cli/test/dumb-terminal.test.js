// TERM=dumb（第六十九轮）：终端说自己不认光标控制。Node 的 readline 这时不重画、不认方向键 ——
// 命令菜单、活动区、改窗口大小都靠不上。命令行不假装没事：一开头说清楚，并且不往这种终端里写颜色。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorEnabled, dumbTerminal, terminalWarnings } from '../src/render/term.js';

const tty = { isTTY: true };

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('TERM=dumb 认得出来；别的 TERM、没设 TERM 都不算', () => {
  assert.equal(dumbTerminal({ TERM: 'dumb' }), true);
  for (const t of ['xterm-256color', 'screen', 'vt100', undefined]) assert.equal(dumbTerminal({ TERM: t }), false, String(t));
});

test('交互的 TERM=dumb：一开头说清楚哪些会乱、换什么终端；管道、正常终端都不说', () => {
  const w = terminalWarnings({ interactive: true, env: { TERM: 'dumb' } });
  assert.equal(w.length, 1);
  assert.match(w[0], /TERM=dumb/);
  assert.match(w[0], /命令菜单/);
  assert.match(w[0], /Ctrl\+C/);
  assert.match(w[0], /换一个终端/);
  assert.deepEqual(terminalWarnings({ interactive: false, env: { TERM: 'dumb' } }), [], '管道里没有菜单、状态行');
  assert.deepEqual(terminalWarnings({ interactive: true, env: { TERM: 'xterm-256color' } }), []);
});

test('TERM=dumb 不上色（这种终端不认颜色转义，会把它原样印出来）；FORCE_COLOR 照样能强开、NO_COLOR 照样能关', () => {
  withEnv({ TERM: 'dumb', NO_COLOR: null, FORCE_COLOR: null }, () => assert.equal(colorEnabled(tty), false));
  withEnv({ TERM: 'dumb', NO_COLOR: null, FORCE_COLOR: '1' }, () => assert.equal(colorEnabled(tty), true));
  withEnv({ TERM: 'xterm-256color', NO_COLOR: null, FORCE_COLOR: null }, () => assert.equal(colorEnabled(tty), true));
  withEnv({ TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: null }, () => assert.equal(colorEnabled(tty), false));
});

test('一开头的警告接在启动里：runAgent 把 terminalWarnings 的每一条都说出来', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const run = src.slice(src.indexOf('async function runAgent('));
  assert.ok(run.length > 200, '找不到 runAgent');
  assert.ok(run.slice(0, 2000).includes('for (const w of terminalWarnings({ interactive: ui.interactive })) ui.warn(w);'), '启动时没说 TERM=dumb 的问题');
});
