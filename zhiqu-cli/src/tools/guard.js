// 工作区路径规则 —— 与服务器端 WorkspaceGuard（Java）是同一套，共用 conformance/workspace-rules.json。
//
// 每条拒绝都有自己的理由，因为用户要做的事不一样：
//   OUTSIDE_ROOT          路径跳出了工作区（../、绝对路径、中间某一段是指向外面的软链）
//   SYMLINK               最后一段本身是软链（指向里面的也不跟随）
//   NOT_REGULAR_FILE      不存在、或者是目录
//   EXTENSION_NOT_ALLOWED 不在扩展名白名单里 —— 不是为了安全（包含性才是），是别把 .env / .pem / id_rsa 读进模型上下文
//   TOO_LARGE             超过单文件上限（按字节算，不是按字符）
//   PARENT_NOT_FOUND      写入时上级路径被一个文件占着，目录建不出来
import fs from 'node:fs';
import path from 'node:path';

export const Reason = Object.freeze({
  OK: 'OK', EMPTY: 'EMPTY', OUTSIDE_ROOT: 'OUTSIDE_ROOT', SYMLINK: 'SYMLINK', NOT_REGULAR_FILE: 'NOT_REGULAR_FILE',
  EXTENSION_NOT_ALLOWED: 'EXTENSION_NOT_ALLOWED', TOO_LARGE: 'TOO_LARGE', PARENT_NOT_FOUND: 'PARENT_NOT_FOUND',
});

export const DEFAULT_EXTENSIONS = ['java', 'kt', 'py', 'js', 'ts', 'jsx', 'tsx', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp',
  'hpp', 'cc', 'cs', 'swift', 'm', 'scala', 'sql', 'sh', 'bat', 'ps1', 'html', 'css', 'scss', 'less', 'vue', 'svelte',
  'json', 'yml', 'yaml', 'toml', 'xml', 'properties', 'md', 'txt', 'csv', 'gradle', 'makefile', 'dockerfile',
  // 以下几种服务器端没有：命令行面对的是真实项目，这几种很常见且不含密钥
  'mjs', 'cjs', 'gitignore', 'lock', 'env.example', 'svg', 'ini', 'cfg', 'kts', 'dart', 'lua', 'r', 'ipynb'];
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

function lexists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}
function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}
function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}
function realOrNormal(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}
/** 逐段比较的「在里面」：/root2 不在 /root 里面（字符串前缀会说在）。 */
export function within(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function isAbsoluteAnywhere(p) {
  // Windows 的 C:\x、\\server\x 在 posix 上 path.isAbsolute 认不出来 —— 两边都按绝对路径拒
  return path.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p);
}

export class WorkspaceGuard {
  constructor(root, { extensions = DEFAULT_EXTENSIONS, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
    // root 存 realpath：包含性检查要在「软链都解开之后」的世界里做。
    // macOS 上 /tmp 其实是 /private/tmp —— 只解候选路径不解 root 的话，正常文件全会被判成「超出工作区」。
    this.root = realOrNormal(path.resolve(root));
    this.extensions = new Set(extensions.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
    this.maxFileBytes = maxFileBytes;
  }

  candidate(rel) {
    if (rel == null || String(rel).trim() === '') return { reason: Reason.EMPTY };
    const given = String(rel).trim();
    // 绝对路径不接受：path.resolve 遇到绝对路径会直接丢掉 root，前缀检查随后当然通过
    if (isAbsoluteAnywhere(given)) return { reason: Reason.OUTSIDE_ROOT };
    return { path: path.resolve(this.root, given) };
  }

  /** normalize 是纯字符串运算，看不出中间某一段是软链；这里从最近一个真实存在的祖先解开再比。 */
  containedAfterSymlinks(candidate) {
    let existing = candidate;
    const tail = [];
    while (!lexists(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
    const real = realOrNormal(existing);
    return within(this.root, tail.length ? path.resolve(real, ...tail) : real);
  }

  extensionAllowed(file) {
    const name = path.basename(file).toLowerCase();
    const dot = name.lastIndexOf('.');
    const key = dot >= 0 && dot < name.length - 1 ? name.slice(dot + 1) : name;
    return this.extensions.has(key);
  }

  resolveReadable(rel) {
    const c = this.candidate(rel);
    if (!c.path) return c;
    // 软链排在包含性之前：最后一段本身是软链时，理由该说「这是软链」而不是含混的「超出工作区」
    if (isSymlink(c.path)) return { reason: Reason.SYMLINK };
    if (!this.containedAfterSymlinks(c.path)) return { reason: Reason.OUTSIDE_ROOT };
    const st = statOrNull(c.path);
    if (!st || !st.isFile()) return { reason: Reason.NOT_REGULAR_FILE };
    if (!this.extensionAllowed(c.path)) return { reason: Reason.EXTENSION_NOT_ALLOWED };
    // 太大的也带上路径和大小：判定不变（还是 TOO_LARGE），但命令行可以流式读其中一段（local.js 的 readLarge）
    if (st.size > this.maxFileBytes) return { reason: Reason.TOO_LARGE, path: c.path, size: st.size };
    return { path: c.path, reason: Reason.OK };
  }

  resolveWritable(rel) {
    const c = this.candidate(rel);
    if (!c.path) return c;
    if (isSymlink(c.path)) return { reason: Reason.SYMLINK };
    if (!this.containedAfterSymlinks(c.path)) return { reason: Reason.OUTSIDE_ROOT };
    if (c.path === this.root) return { reason: Reason.NOT_REGULAR_FILE };
    const st = statOrNull(c.path);
    if (st && !st.isFile()) return { reason: Reason.NOT_REGULAR_FILE };
    if (!this.extensionAllowed(c.path)) return { reason: Reason.EXTENSION_NOT_ALLOWED };
    // 上级目录不存在可以建；最近一个存在的祖先必须是目录（被文件占着就建不出来）
    let existing = path.dirname(c.path);
    while (!lexists(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return { reason: Reason.PARENT_NOT_FOUND };
      existing = parent;
    }
    const pst = statOrNull(existing);
    if (!pst || !pst.isDirectory()) return { reason: Reason.PARENT_NOT_FOUND };
    return { path: c.path, reason: Reason.OK };
  }

  resolveDirectory(rel) {
    const given = rel == null ? '' : String(rel).trim();
    let p;
    if (given === '' || given === '.') {
      p = this.root;
    } else {
      if (isAbsoluteAnywhere(given)) return { reason: Reason.OUTSIDE_ROOT };
      p = path.resolve(this.root, given);
    }
    if (!this.containedAfterSymlinks(p)) return { reason: Reason.OUTSIDE_ROOT };
    if (isSymlink(p)) return { reason: Reason.SYMLINK };
    const st = statOrNull(p);
    if (!st || !st.isDirectory()) return { reason: Reason.NOT_REGULAR_FILE };
    return { path: p, reason: Reason.OK };
  }

  /** 写这个文件要新建的目录（相对工作区根，从外到里，用 / 分隔）。 */
  missingParents(rel) {
    const w = this.resolveWritable(rel);
    if (w.reason !== Reason.OK) return [];
    const out = [];
    for (let dir = path.dirname(w.path); dir !== this.root && !lexists(dir); dir = path.dirname(dir)) {
      out.unshift(path.relative(this.root, dir).split(path.sep).join('/'));
    }
    return out;
  }

  /** 相对工作区根、用 / 分隔 —— 给模型和用户看的路径。 */
  display(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/') || '.';
  }
}

/** 拒绝理由翻译成人话。 */
export function describe(reason, p, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
  switch (reason) {
    case Reason.EMPTY: return '没有给出路径';
    case Reason.OUTSIDE_ROOT: return `路径超出了工作区范围（只接受相对路径，且不能用 ../ 或软链跳出去）：${p}`;
    case Reason.SYMLINK: return `这是一个符号链接，工作区不跟随链接：${p}`;
    case Reason.NOT_REGULAR_FILE: return `不是一个普通文件（可能不存在，或者是目录）：${p}`;
    case Reason.EXTENSION_NOT_ALLOWED: return `这个类型的文件不在允许清单里（避免把密钥、证书这类内容读进上下文）：${p}`;
    case Reason.TOO_LARGE: return `文件超过了 ${maxFileBytes} 字节的上限：${p}`;
    case Reason.PARENT_NOT_FOUND: return `上级路径被一个文件占着，没法在它下面建文件：${p}`;
    default: return '';
  }
}
