// 起子进程的那一层：不继承环境变量、超时杀进程组、输出上限（正好等于不算截断；超了继续排空）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { childEnv, childHome, resolveOnPath, runProcess } from '../src/tools/exec.js';
import { tmpdir, write } from './helpers.js';

const node = resolveOnPath('node');

test('子进程拿不到父进程的环境变量（ZHIQU_TOKEN、云凭据），PATH 是现拼的', async () => {
  process.env.ZHIQU_TOKEN = 'zqp_should_not_leak';
  process.env.AWS_SECRET_ACCESS_KEY = 'nope';
  const root = tmpdir();
  write(root, 'env.js', 'console.log(JSON.stringify(process.env))');
  const r = await runProcess({ binary: node, args: ['env.js'], cwd: root, timeoutMs: 10_000 });
  const env = JSON.parse(r.output);
  assert.equal(env.ZHIQU_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.PATH, childEnv(node, root).PATH);
  assert.notEqual(env.HOME, root, '第九十轮：HOME 不再是工作区（仓库里带的配置会被当成用户自己的）');
  assert.equal(env.HOME, childHome());
  assert.equal(fs.readdirSync(env.HOME).length, 0, 'HOME 是个空目录');
  if (process.platform !== 'win32') assert.equal(fs.statSync(env.HOME).mode & 0o777, 0o700, '只有自己能进');
  delete process.env.ZHIQU_TOKEN;
  delete process.env.AWS_SECRET_ACCESS_KEY;
});

// 自带时限：只杀父进程的话，孙子进程攥着管道，close 永远等不到 —— 那样该是红，而不是一直挂着
test('超时：连同它起的子进程一起杀掉，并说出来', { timeout: 15_000 }, async () => {
  const root = tmpdir();
  write(root, 'hang.js', "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'}); setInterval(()=>{}, 1000);");
  const started = Date.now();
  const r = await runProcess({ binary: node, args: ['hang.js'], cwd: root, timeoutMs: 800 });
  assert.ok(Date.now() - started < 5000, '超时没生效');
  assert.equal(r.timedOut, true);
  assert.match(r.output, /超时/);
});

test('输出正好等于上限：不算截断；多一个字节：截断、标注，而且照样拿到真实的退出码（继续排空）', async () => {
  const root = tmpdir();
  write(root, 'out.js', 'process.stdout.write("x".repeat(Number(process.argv[2]))); process.exitCode = 3;');
  const exact = await runProcess({ binary: node, args: ['out.js', '1000'], cwd: root, timeoutMs: 10_000, outputLimit: 1000 });
  assert.equal(exact.truncated, false);
  assert.ok(!exact.output.includes('已截断'));
  const over = await runProcess({ binary: node, args: ['out.js', '2000000'], cwd: root, timeoutMs: 10_000, outputLimit: 1000 });
  assert.equal(over.truncated, true);
  assert.match(over.output, /已截断/);
  assert.equal(over.exitCode, 3, '到上限就不读的话，子进程卡在 write 上，会被报成超时');
  assert.equal(over.timedOut, false);
});

// 第九十轮（这台机器上试出来的）：HOME 是工作区时，仓库里带的 sitecustomize.py 放在 Python 的用户 site 下，任何一句 python3 都会先执行它
test('子进程的 HOME 不是工作区：仓库里带的 Python 用户 site（sitecustomize.py）叫不起来', async (ctx) => {
  const python = resolveOnPath('python3');
  if (!python) return ctx.skip('这台机器上没有 python3');
  const root = tmpdir();
  // 用户 site 的位置按「HOME 是工作区」算（原来的样子），把 sitecustomize.py 放进工作区里那个位置
  const userSite = execFileSync(python, ['-m', 'site', '--user-site'], { env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8' }).trim();
  assert.ok(userSite.startsWith(root), userSite);
  fs.mkdirSync(userSite, { recursive: true });
  const mark = path.join(root, 'MARK');
  fs.writeFileSync(path.join(userSite, 'sitecustomize.py'), `open(${JSON.stringify(mark)}, 'a').write('x')\n`);
  const r = await runProcess({ binary: python, args: ['-c', 'print(1)'], cwd: root, timeoutMs: 20_000 });
  assert.equal(r.exitCode, 0, r.output);
  assert.ok(!fs.existsSync(mark), '仓库里带的 sitecustomize.py 被执行了');
});
