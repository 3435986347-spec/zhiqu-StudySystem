// zhiqu update（第一百二十六轮，用户要的）与登录后提示有没有新版本。npm 换成桩：不连网、不真装。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isGlobalInstall, npmEnv, selfUpdate } from '../src/selfupdate.js';
import { updateMessage } from '../src/update.js';
import { tmpdir } from './helpers.js';

/** 一个假的全局目录：<root>/zhiqu/package.json 是装上去的那一份 */
function globalRoot(version, { link = false } = {}) {
  const root = tmpdir();
  const pkg = path.join(root, 'zhiqu');
  if (link) {
    const src = tmpdir();
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'zhiqu', version }));
    fs.symlinkSync(src, pkg);
    return { root, pkg: src };
  }
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'zhiqu', version }));
  return { root, pkg };
}

function fakeNpm({ latest, root, installs = 'ok', onInstall }) {
  const calls = [];
  const npm = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'view') return latest == null ? { code: 1, out: '', err: 'npm error code ENOTFOUND' } : { code: 0, out: `${latest}\n`, err: '' };
    if (args[0] === 'root') return { code: 0, out: `${root}\n`, err: '' };
    if (args[0] === 'install') {
      if (installs === 'eacces') return { code: 243, out: '', err: 'npm error code EACCES' };
      if (installs === 'fail') return { code: 1, out: '', err: 'npm error network' };
      if (onInstall) onInstall(args);
      return { code: 0, out: '', err: '' };
    }
    return { code: 1, out: '', err: '' };
  };
  return { npm, calls };
}

const run = async (opts) => {
  let out = '';
  const code = await selfUpdate({ write: (s) => { out += s; }, ...opts });
  return { code, out };
};

test('有新版本、是 npm 全局装的：npm i -g zhiqu@<最新版>，装完读装上去的 package.json 核对', async () => {
  const g = globalRoot('0.1.0');
  const { npm, calls } = fakeNpm({ latest: '0.2.0', root: g.root,
    onInstall: () => fs.writeFileSync(path.join(g.pkg, 'package.json'), JSON.stringify({ name: 'zhiqu', version: '0.2.0' })) });
  const r = await run({ npm, current: '0.1.0', packageRoot: g.pkg });
  assert.equal(r.code, 0, r.out);
  assert.ok(calls.includes('install -g zhiqu@0.2.0'), calls.join(' | '));
  assert.match(r.out, /已更新：0\.1\.0 → 0\.2\.0/);
});

test('npm 说装好了、装上去的却不是那个版本：照实说没成', async () => {
  const g = globalRoot('0.1.0');
  const { npm } = fakeNpm({ latest: '0.2.0', root: g.root });   // 装的时候什么都没变
  const r = await run({ npm, current: '0.1.0', packageRoot: g.pkg });
  assert.equal(r.code, 1);
  assert.match(r.out, /装上去的是 0\.1\.0，不是 0\.2\.0/);
});

test('已经是最新版：不装', async () => {
  const g = globalRoot('0.2.0');
  const { npm, calls } = fakeNpm({ latest: '0.2.0', root: g.root });
  const r = await run({ npm, current: '0.2.0', packageRoot: g.pkg });
  assert.equal(r.code, 0);
  assert.match(r.out, /已经是最新版/);
  assert.ok(!calls.some((c) => c.startsWith('install')), calls.join(' | '));
});

test('不是 npm 全局装的（源码目录、npm link 的软链）：不替人装，说怎么更新', async () => {
  for (const [name, g] of [['源码目录', { root: globalRoot('0.1.0').root, pkg: tmpdir() }], ['npm link', globalRoot('0.1.0', { link: true })]]) {
    const { npm, calls } = fakeNpm({ latest: '0.2.0', root: g.root });
    const r = await run({ npm, current: '0.1.0', packageRoot: g.pkg });
    assert.equal(r.code, 1, name);
    assert.ok(!calls.some((c) => c.startsWith('install')), `${name}：替一个不是 npm 装的检出跑了 npm i -g`);
    assert.match(r.out, /不是 npm 全局装的/, name);
    assert.match(r.out, /npm i -g zhiqu@0\.2\.0/, name);
  }
});

test('没权限：不替人 sudo，说清楚；问不到 npm：照实说', async () => {
  const g = globalRoot('0.1.0');
  const denied = await run({ npm: fakeNpm({ latest: '0.2.0', root: g.root, installs: 'eacces' }).npm, current: '0.1.0', packageRoot: g.pkg });
  assert.equal(denied.code, 1);
  assert.match(denied.out, /没有写权限：不替你用 sudo/);
  const offline = await run({ npm: fakeNpm({ latest: null, root: g.root }).npm, current: '0.1.0', packageRoot: g.pkg });
  assert.equal(offline.code, 1);
  assert.match(offline.out, /问不到 npm 上的版本/);
});

test('npm 的环境不带令牌和别的凭据（只带 npm 用得到的）', () => {
  const env = npmEnv({ PATH: '/usr/bin', HOME: '/h', ZHIQU_TOKEN: 'zqp_secret', AWS_SECRET_ACCESS_KEY: 'x', npm_config_registry: 'https://r', HTTPS_PROXY: 'http://p' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HTTPS_PROXY', 'PATH', 'npm_config_registry']);
  assert.equal(isGlobalInstall('', tmpdir()), false);
});

test('有新版本的提示让人运行 zhiqu update', () => {
  assert.match(updateMessage({ level: 'available', latest: '0.2.0' }), /运行 zhiqu update 更新/);
  assert.match(updateMessage({ level: 'required', minimum: '0.2.0' }), /zhiqu update/);
});

test('zhiqu login 成功后看一次有没有新版本（不看一天的缓存）；问到了就说一句「zhiqu update」，问不到不影响登录', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { VERSION } = await import('../src/version.js');
  const [maj, min] = VERSION.split('.').map(Number);
  const newer = `${maj}.${min + 1}.0`;
  for (const meta of [{ cliLatest: newer, cliMinimum: '0.0.1' }, { cliLatest: VERSION, cliMinimum: '0.0.1' }, null]) {
    const metaCalls = [];
    const srv = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      // 照路径整段比（'/api/harness/meta' 也是以 '/api/harness/me' 开头的）
      const route = req.url.split('?')[0];
      if (route === '/api/harness/me') return res.end(JSON.stringify({ code: 200, data: { username: 'u', nickname: '测试' } }));
      if (route === '/api/harness/meta') {
        metaCalls.push(req.url);
        if (!meta) { res.statusCode = 500; return res.end('{}'); }
        return res.end(JSON.stringify({ code: 200, data: meta }));
      }
      res.statusCode = 404; return res.end('{}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const home = tmpdir();
    // 一天之内问过、缓存里说没有新版本：登录时也要重新问
    fs.mkdirSync(path.join(home, '.zhiqu'), { recursive: true });
    fs.writeFileSync(path.join(home, '.zhiqu', 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), meta: { cliLatest: VERSION, cliMinimum: '0.0.1' } }));
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.resolve('bin/zhiqu.js'), 'login', '--token', 'zqp_test', '--server', url],
        { env: { PATH: process.env.PATH, HOME: home, ZHIQU_HOME: path.join(home, '.zhiqu') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      c.on('close', (code) => resolve({ code, out }));
    });
    srv.close();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /已登录/);
    assert.ok(metaCalls.length >= 1, '登录时没去问有没有新版本（用了一天的缓存）');
    if (meta && meta.cliLatest === newer) assert.match(r.out, new RegExp(`有新版本 ${newer.replace(/\./g, '\\.')}.*zhiqu update`), r.out);
    else assert.doesNotMatch(r.out, /有新版本/, r.out);
  }
});
