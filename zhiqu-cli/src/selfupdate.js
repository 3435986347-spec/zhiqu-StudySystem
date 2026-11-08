// zhiqu update（第一百二十六轮，用户要的）：问 npm 最新版、是 npm 全局装的就替人 npm i -g zhiqu@<版本>，装完核对版本。
//
// 不做静默自动更新：全局安装常要权限，换掉正在跑的程序可能半路坏掉。这里只在用户明确敲了 zhiqu update 时才装。
//   - 只认 npm 全局装的那一份（npm root -g 下的 zhiqu）：npm link 的源码目录、别处拷来的，不动，照实说怎么更新
//     —— 替一个 git 检出跑 npm i -g 会把它换成 npm 上的包，改了一半的代码就不在 PATH 上了。
//   - 没权限（EACCES）不替人 sudo：说清楚、给出命令，让人自己决定。
//   - 子进程不继承环境变量（tools/exec.js 那条规矩的例外：npm 要 HOME、PATH、代理、npm 的配置才能装）——
//     这里只带 npm 用得到的那几个，令牌（ZHIQU_TOKEN）不带。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOnPath, planLaunch } from './tools/exec.js';
import { compareVersions } from './update.js';
import { VERSION } from './version.js';

export const PACKAGE = 'zhiqu';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** npm 要的环境：HOME / PATH / 代理 / npm 自己的配置；别的（令牌、云凭据）不带 */
export function npmEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (/^(PATH|Path|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|ComSpec|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL|SHELL|USER|LOGNAME)$/.test(k)
      || /^(npm_config_|NPM_CONFIG_)/.test(k) || /^(HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/.test(k)
      || k === 'NODE_EXTRA_CA_CERTS') out[k] = v;
  }
  return out;
}

/** 跑一次 npm，拿回 { code, out, err }。run 可以换成桩（测试用） */
export function runNpm(args, { env = process.env, platform = process.platform, timeoutMs = 300_000, inherit = false } = {}) {
  const binary = resolveOnPath('npm', env, platform);
  if (!binary) return Promise.resolve({ code: -1, out: '', err: '找不到 npm（装 Node.js 时会一起装上）' });
  const plan = planLaunch({ command: 'npm', binary, args, platform });
  if (plan.error) return Promise.resolve({ code: -1, out: '', err: plan.error });
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(plan.binary, plan.args, { env: npmEnv(env), stdio: ['ignore', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'], windowsHide: true, shell: false });
    } catch (e) {
      resolve({ code: -1, out: '', err: e.message });
      return;
    }
    if (!inherit) {
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, out, err }); });
  });
}

/** 这一份是不是 npm 全局装的：<npm root -g>/zhiqu 就是这个包所在的目录（软链解开再比） */
export function isGlobalInstall(globalRoot, packageRoot = PACKAGE_ROOT) {
  if (!globalRoot) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const installed = path.join(globalRoot.trim(), PACKAGE);
  // npm link 出来的是一个指到源码目录的软链：那不是装上去的包
  try { if (fs.lstatSync(installed).isSymbolicLink()) return false; } catch { return false; }
  return real(installed) === real(packageRoot);
}

const tail = (s, n = 1200) => { const t = String(s || '').trim(); return t.length > n ? `…${t.slice(-n)}` : t; };

/**
 * zhiqu update。返回退出码：0 已是最新 / 更新好了；1 没更新成（说了为什么、怎么办）。
 * npm：跑 npm 的函数（测试换成桩），签名同 runNpm。
 */
export async function selfUpdate({ write = (s) => process.stdout.write(s), npm = runNpm, current = VERSION, packageRoot = PACKAGE_ROOT } = {}) {
  write(`现在是 ${current}，去 npm 上看最新版…\n`);
  const view = await npm(['view', PACKAGE, 'version']);
  const latest = String(view.out || '').trim().split('\n').pop().trim();
  if (view.code !== 0 || !/^\d+\.\d+\.\d+/.test(latest)) {
    write(`问不到 npm 上的版本：${tail(view.err || view.out) || `npm 退出码 ${view.code}`}\n网络不通或者 npm 的源配错了；也可以自己跑：npm i -g ${PACKAGE}\n`);
    return 1;
  }
  if (compareVersions(current, latest) >= 0) {
    write(compareVersions(current, latest) === 0 ? `已经是最新版（${current}）。\n` : `npm 上最新的是 ${latest}，你这一份（${current}）不比它旧，不用更新。\n`);
    return 0;
  }
  const root = await npm(['root', '-g']);
  if (!isGlobalInstall(root.code === 0 ? root.out : '', packageRoot)) {
    write(`npm 上有 ${latest}，但这一份 zhiqu 不是 npm 全局装的（在 ${packageRoot}），不替你动它。\n`
      + `是源码目录（npm link）就 git pull；要换成 npm 上的版本：npm i -g ${PACKAGE}@${latest}\n`);
    return 1;
  }
  write(`更新到 ${latest}：npm i -g ${PACKAGE}@${latest}\n`);
  const install = await npm(['install', '-g', `${PACKAGE}@${latest}`], { inherit: true });
  if (install.code !== 0) {
    const denied = /EACCES|EPERM|permission denied/i.test(`${install.err}${install.out}`);
    write(`没装上（npm 退出码 ${install.code}）。${denied
      ? `全局目录没有写权限：不替你用 sudo。可以自己跑 sudo npm i -g ${PACKAGE}@${latest}，或者把 npm 的全局目录换到自己能写的地方（npm config set prefix ~/.npm-global）`
      : `可以再试一次，或者自己跑：npm i -g ${PACKAGE}@${latest}`}\n`);
    return 1;
  }
  // 核对：装上去的那一份的 package.json（不靠 npm 的输出）
  let now = null;
  try { now = JSON.parse(fs.readFileSync(path.join(root.out.trim(), PACKAGE, 'package.json'), 'utf8')).version; } catch { /* 读不到 */ }
  if (now !== latest) {
    write(`npm 说装好了，可装上去的是 ${now || '（读不到）'}，不是 ${latest}。再跑一次 zhiqu update，或者 npm i -g ${PACKAGE}@${latest}\n`);
    return 1;
  }
  write(`✓ 已更新：${current} → ${latest}\n`);
  return 0;
}
