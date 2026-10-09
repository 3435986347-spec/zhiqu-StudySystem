// P7 新版本提示：问服务器 /api/harness/meta 要命令行的最新版本与最低版本。一天最多问一次（结果缓存在
// ~/.zhiqu/update-check.json）；低于最低版本时每次都说。问不到就当没有 —— 这一步绝不能挡住正常使用。
import fs from 'node:fs';
import path from 'node:path';
import { userDir, writeFileAtomic } from './config.js';
import { VERSION } from './version.js';

const DAY = 24 * 3600_000;

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? 0 : Number(x)));
  const pb = String(b).split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? 0 : Number(x)));
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function verdict(current, meta) {
  if (!meta) return { level: 'none' };
  if (meta.cliMinimum && compareVersions(current, meta.cliMinimum) < 0) {
    return { level: 'required', latest: meta.cliLatest, minimum: meta.cliMinimum };
  }
  if (meta.cliLatest && compareVersions(current, meta.cliLatest) < 0) return { level: 'available', latest: meta.cliLatest };
  return { level: 'none' };
}

export async function checkForUpdate(api, { force = false, now = Date.now() } = {}) {
  const file = path.join(userDir(), 'update-check.json');
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 没有缓存 */ }
  let meta = cache && cache.meta;
  if (force || !cache || now - (cache.checkedAt || 0) > DAY) {
    try {
      meta = await api.get('/api/harness/meta', { timeoutMs: 3000 });
      writeFileAtomic(file, JSON.stringify({ checkedAt: now, meta }));
    } catch {
      return { level: 'none' };
    }
  }
  return verdict(VERSION, meta);
}

export function updateMessage(v) {
  if (v.level === 'required') {
    return `这个版本（${VERSION}）太旧了，服务器要求至少 ${v.minimum}。请运行 npm i -g zhiqu 更新。`;
  }
  if (v.level === 'available') return `有新版本 ${v.latest}（你现在是 ${VERSION}）：npm i -g zhiqu`;
  return null;
}
