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

test('默认服务器：来自 package.json 的 zhiqu.defaultServer；发布前检查挡住本机地址、http、还挂着 private 的版本', async () => {
  const { packageDefaultServer, releaseProblems, isLoopbackUrl } = await import('../src/defaults.js');
  const fs = await import('node:fs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageDefaultServer(), pkg.zhiqu.defaultServer.replace(/\/+$/, ''));
  assert.equal(isLoopbackUrl('http://127.0.0.1:47615'), true);
  assert.equal(isLoopbackUrl('http://localhost:8080'), true);
  assert.equal(isLoopbackUrl('https://zhiqu.example.com'), false);
  assert.equal(releaseProblems({ zhiqu: { defaultServer: 'https://zhiqu.example.com' } }).length, 0);
  assert.match(releaseProblems({ zhiqu: { defaultServer: 'http://127.0.0.1:47615' } }).join('\n'), /还是本机/);
  assert.match(releaseProblems({ zhiqu: { defaultServer: 'http://1.2.3.4:8080' } }).join('\n'), /不是 https/);
  assert.match(releaseProblems({ private: true, zhiqu: { defaultServer: 'https://a.b' } }).join('\n'), /private/);
  // 原来仓库里是本机地址 + private（不能发）；用户 2026-11-08 定了默认连网站、发布到 npm：仓库里的就是发布的那一版
  assert.equal(pkg.zhiqu.defaultServer, 'https://zhiqustudy.com', '默认连的服务器');
  assert.deepEqual(releaseProblems(pkg), [], '仓库里的这一版要能发布');
});
