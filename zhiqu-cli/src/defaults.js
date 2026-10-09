// 默认连哪台服务器：来自 package.json 的 zhiqu.defaultServer。
//
// 仓库里是本机桌面应用（http://127.0.0.1:47615），测试方便；发布的那一版要改成服务器地址
// （npm run set-server -- https://…），scripts/check-release.mjs 在 npm publish 之前挡住没改的版本。
// 实际使用时的优先级仍然是：--server > ZHIQU_SERVER > 项目 .zhiqu/settings.json > ~/.zhiqu/config.json > 这里。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LOCAL_DESKTOP_SERVER = 'http://127.0.0.1:47615';

let cached = null;
export function packageDefaultServer() {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    cached = String((pkg.zhiqu && pkg.zhiqu.defaultServer) || LOCAL_DESKTOP_SERVER).replace(/\/+$/, '');
  } catch {
    cached = LOCAL_DESKTOP_SERVER;
  }
  return cached;
}

export function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/** 发布前要满足的条件；返回问题清单（空 = 可以发）。 */
export function releaseProblems(pkg) {
  const problems = [];
  const url = pkg && pkg.zhiqu && pkg.zhiqu.defaultServer;
  if (!url) problems.push('package.json 里没有 zhiqu.defaultServer');
  else {
    if (isLoopbackUrl(url)) problems.push(`默认服务器还是本机（${url}）—— 发布版要指向你的服务器：npm run set-server -- https://你的地址`);
    if (!/^https:\/\//i.test(url)) problems.push(`默认服务器不是 https（${url}）—— 令牌走明文 HTTP 过公网，等于交给路上的任何人`);
  }
  if (pkg && pkg.private) problems.push('package.json 里还有 "private": true（防误发的那道闸）—— 确认要发布时再删掉');
  return problems;
}
