import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, verdict } from '../src/update.js';
import { parseArgs, localTime } from '../src/cli.js';

test('新版本提示：低于最低版本是 required，低于最新是 available', () => {
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(verdict('0.1.0', { cliLatest: '0.2.0', cliMinimum: '0.1.0' }).level, 'available');
  assert.equal(verdict('0.1.0', { cliLatest: '0.3.0', cliMinimum: '0.2.0' }).level, 'required');
  assert.equal(verdict('0.3.0', { cliLatest: '0.3.0', cliMinimum: '0.1.0' }).level, 'none');
  assert.equal(verdict('0.1.0', null).level, 'none');
});

test('命令行参数', () => {
  const f = parseArgs(['--mode', 'auto', '-p', '写个游戏', '--resume']);
  assert.equal(f.mode, 'auto');
  assert.equal(f.print, '写个游戏');
  assert.equal(f.resume, true);
  assert.equal(parseArgs(['--resume', 'abc']).resume, 'abc');
  assert.throws(() => parseArgs(['--nope']), /不认识的参数/);
  assert.throws(() => parseArgs(['--mode']), /后面要跟一个值/);
  assert.match(localTime('2026-09-23T17:32:33.075Z'), /^\d\d-\d\d \d\d:\d\d$/);
});
