// 配置。npm 版 zhiqu 有自己的一套，放在 .zhiqu/ 下（用户 2026-09-24 定的）：
//
//   ~/.zhiqu/config.json          用户级：服务器、令牌、默认模型、默认档位（600 权限）
//   <工作区>/.zhiqu/settings.json  项目级：同样的键，覆盖用户级 —— 但**不收令牌**（这个文件可能被提交）
//   ~/.zhiqu/system.md            系统内容：第一次运行时写一份内置系统提示，之后以它为准，用户可以改
//   <工作区>/.zhiqu/system.md      项目级系统内容，优先
//
// 环境变量 ZHIQU_HOME 可以把用户级目录挪走（测试用）；ZHIQU_SERVER / ZHIQU_TOKEN 覆盖对应的配置。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_SYSTEM_PROMPT } from './prompt.js';

export const DEFAULT_SERVER = 'http://127.0.0.1:47615';   // 桌面应用固定监听的端口
export const MODES = ['plan', 'ask', 'auto'];
const MODE_ALIASES = { read: 'plan', readonly: 'plan', write: 'ask', exec: 'auto', confirm: 'ask', default: 'ask' };

export function normalizeMode(value) {
  const v = String(value || '').trim().toLowerCase();
  if (MODES.includes(v)) return v;
  return MODE_ALIASES[v] || null;
}

export function userDir() {
  return process.env.ZHIQU_HOME ? path.resolve(process.env.ZHIQU_HOME) : path.join(os.homedir(), '.zhiqu');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 原子写：先写临时文件再改名 —— 写到一半被打断不会留下半个 JSON。 */
export function writeFileAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 临时文件名带上进程号和一个随机数：同一个进程里两次写同一个文件也不会撞在同一个临时文件上
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode) { try { fs.chmodSync(file, mode); } catch { /* Windows */ } }
}

export function loadUserConfig() {
  return readJson(path.join(userDir(), 'config.json'), {});
}

export function saveUserConfig(patch) {
  const dir = userDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = { ...loadUserConfig(), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined || v === null) delete next[k];
  writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
}

export function loadProjectSettings(root) {
  const settings = readJson(path.join(root, '.zhiqu', 'settings.json'), {});
  const warnings = [];
  if (settings && Object.prototype.hasOwnProperty.call(settings, 'token')) {
    delete settings.token;
    warnings.push('.zhiqu/settings.json 里的 token 已忽略 —— 这个文件可能被提交进仓库，令牌只放在 ~/.zhiqu/config.json');
  }
  return { settings: settings || {}, warnings };
}

/** 各层合在一起：命令行参数 > 环境变量 > 项目 > 用户 > 默认。 */
export function resolveSettings(root, flags = {}) {
  const user = loadUserConfig();
  const { settings: project, warnings } = loadProjectSettings(root);
  const pick = (key, envName) => flags[key] ?? (envName ? process.env[envName] : undefined) ?? project[key] ?? user[key];
  const mode = normalizeMode(pick('mode')) || 'ask';
  return {
    server: stripSlash(pick('server', 'ZHIQU_SERVER') || DEFAULT_SERVER),
    token: process.env.ZHIQU_TOKEN || user.token || '',
    model: pick('model') ?? null,
    mode,
    maxRounds: Number(project.maxRounds ?? user.maxRounds ?? 60),
    execTimeoutMs: Number(project.execTimeoutMs ?? user.execTimeoutMs ?? 120_000),
    allowedCommands: project.allowedCommands ?? user.allowedCommands ?? null,
    extensions: project.extensions ?? user.extensions ?? null,
    warnings,
  };
}

export function stripSlash(url) {
  let s = String(url || '').trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * 系统内容（用户说的「里面可以保留一次系统内容」）：
 *   - ~/.zhiqu/system.md 不存在 → 写一份内置版本（只这一次），记下它的指纹；
 *   - 存在且没被改过（指纹对得上）、而内置版本更新了 → 跟着更新 —— 没改过的副本不该把人困在旧提示里；
 *   - 用户改过 → 一个字都不动；内置版本有更新时提示一次，/system diff 可以看差别。
 * 工作区的 .zhiqu/system.md 存在时优先。
 */
export function systemContent(root) {
  const projectFile = path.join(root, '.zhiqu', 'system.md');
  if (fs.existsSync(projectFile)) {
    return { text: fs.readFileSync(projectFile, 'utf8'), source: 'project', file: projectFile, notice: null };
  }
  const file = path.join(userDir(), 'system.md');
  const cfg = loadUserConfig();
  const builtinHash = sha(BUILTIN_SYSTEM_PROMPT);
  let notice = null;
  if (!fs.existsSync(file)) {
    writeFileAtomic(file, BUILTIN_SYSTEM_PROMPT);
    saveUserConfig({ systemFileHash: builtinHash, systemBuiltinHash: builtinHash });
    return { text: BUILTIN_SYSTEM_PROMPT, source: 'user', file, notice: `已把系统内容写到 ${file}（之后以它为准，可以改）` };
  }
  const text = fs.readFileSync(file, 'utf8');
  const fileHash = sha(text);
  if (cfg.systemBuiltinHash !== builtinHash) {
    if (fileHash === cfg.systemFileHash) {
      writeFileAtomic(file, BUILTIN_SYSTEM_PROMPT);
      saveUserConfig({ systemFileHash: builtinHash, systemBuiltinHash: builtinHash });
      return { text: BUILTIN_SYSTEM_PROMPT, source: 'user', file, notice: '内置系统内容有更新，你没改过那一份，已跟着更新' };
    }
    notice = '内置系统内容有更新；你的 ~/.zhiqu/system.md 改过，所以没动它。/system diff 可以看差别，/system reset 换成新版';
    saveUserConfig({ systemBuiltinHash: builtinHash });
  }
  return { text, source: 'user', file, notice };
}

export function resetSystemContent() {
  const file = path.join(userDir(), 'system.md');
  writeFileAtomic(file, BUILTIN_SYSTEM_PROMPT);
  const h = sha(BUILTIN_SYSTEM_PROMPT);
  saveUserConfig({ systemFileHash: h, systemBuiltinHash: h });
  return file;
}
