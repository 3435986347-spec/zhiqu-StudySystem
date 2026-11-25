// shell 改了哪些文件（第一百六十九轮，docs/agent-efficiency-plan.md 第 4 步）。
//
// 用户那段会话里 shell 201 次有 158 次在写文件，127 次是 shell 里的 Python `s.replace(old, new)`：
// - str.replace 找不到原文不报错、什么都不做 —— edit_file 当初要挡的就是这种静默失败（第八十六轮）；
// - 这些写入不进「改过的文件」，先清的「读过之后又改过」也看不到。
// 做法：同步的 shell 命令前后各给工作区拍一次修改时间的快照（有数量和时间上限，超了就不比，照实当不知道），
// 比出改了哪些；命令看着是内联脚本在改已有的源码时提醒改用编辑工具（用户 2026-11-24 定的：提醒，不拒绝）。
import fs from 'node:fs';
import path from 'node:path';

/** 快照最多看这么多个文件、花这么久；超了返回 null（不比，不猜） */
export const SNAPSHOT_MAX_FILES = 5_000;
export const SNAPSHOT_BUDGET_MS = 300;
/** 不进快照的目录：依赖、版本库、命令行自己的东西、虚拟环境 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.zhiqu', '__pycache__', '.venv', 'venv', '.hg', '.svn', '.next', '.cache']);

/** 工作区的修改时间快照：Map<相对路径, "mtime:size">；太大 / 太慢返回 null */
export function snapshot(root, { maxFiles = SNAPSHOT_MAX_FILES, budgetMs = SNAPSHOT_BUDGET_MS, now = Date.now } = {}) {
  const out = new Map();
  const start = now();
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(r); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(path.join(root, r)); } catch { continue; }
      out.set(r, `${st.mtimeMs}:${st.size}`);
      if (out.size > maxFiles || now() - start > budgetMs) return null;
    }
  }
  return out;
}

/** 两次快照之间：改了的、新建的、删掉的（各自排好序） */
export function diffSnapshots(before, after) {
  if (!before || !after) return null;
  const modified = [];
  const created = [];
  const deleted = [];
  for (const [p, v] of after) {
    if (!before.has(p)) created.push(p);
    else if (before.get(p) !== v) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  return { modified: modified.sort(), created: created.sort(), deleted: deleted.sort() };
}

const LIST_MAX = 20;
const MARK = '（这条命令改动了文件：';
/** 写进工具结果的那一行；清理时 writtenByShell 从这里认（占位里也带着它） */
export function changeLine(diff) {
  if (!diff) return '';
  const part = (label, xs) => (xs.length ? `${label} ${xs.slice(0, LIST_MAX).join('、')}${xs.length > LIST_MAX ? ` 等 ${xs.length} 个` : ''}` : '');
  const parts = [part('修改', diff.modified), part('新建', diff.created), part('删除', diff.deleted)].filter(Boolean);
  return parts.length ? `${MARK}${parts.join('；')}）` : '';
}

/** 从工具结果（或清理后的占位）里认出 shell 写过的文件 */
export function writtenByShell(text) {
  const s = String(text || '');
  const at = s.indexOf(MARK);
  if (at < 0) return [];
  const end = s.indexOf('）', at + MARK.length);
  const body = s.slice(at + MARK.length, end < 0 ? undefined : end);
  return body.split('；').flatMap((seg) => seg.replace(/^(修改|新建|删除)\s+/, '').replace(/\s+等 \d+ 个$/, '').split('、')).map((x) => x.trim()).filter(Boolean);
}

// 内联脚本改文件的样子：python / node / perl / ruby 的 -c / -e / heredoc 里打开文件写、sed -i、perl -pi、cat > x <<
const INLINE_RUNNER = /\b(python3?|node|perl|ruby)\b[^|;&]*?(\s-[ce]\b|\s-\s*<<|<<-?\s*['"]?\w+)|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\bcat\s*>>?\s*\S+\s*<</;
const WRITES = /open\([^)]*['"][wa]\+?b?['"]|write_text\(|writeFileSync\(|\.write\(|File\.write|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\bcat\s*>>?\s*\S+\s*<</;
/** 这条命令像不像「在 shell 里用脚本改文件」 */
export function inlineEdit(command) {
  const c = String(command || '');
  return INLINE_RUNNER.test(c) && WRITES.test(c);
}
/** 用的是字符串替换（找不到原文时什么都不做的那种） */
export function usesReplace(command) {
  return /\.replace\(|\bre\.sub\(|\bsed\s+(-[a-zA-Z]*i|--in-place)/.test(String(command || ''));
}

/** 提醒的话：第 1 次说，之后每 NUDGE_EVERY 次再说一次（不刷屏） */
export const NUDGE_EVERY = 5;
export function editNudge(files) {
  return `你在用 shell 里的脚本改已有的源码（${files.slice(0, 5).join('、')}${files.length > 5 ? ' 等' : ''}）。改源码请用 apply_patch（一次改多处、多个文件）或 edit_file：`
    + '原文对不上会直接报错，不会像 str.replace 那样一声不响什么都不做；改动也会记进改过的文件、出现在 diff 里。批量生成文件、格式化这类确实要脚本的，照旧用 shell。';
}
export const NOOP_REPLACE = '这条命令用字符串替换改文件，跑完了却一个文件都没改动 —— str.replace / re.sub / sed 找不到原文时不报错，原文多半没对上（空白、缩进、引号、换行）。先 read_file 看清楚现在的内容，再用 edit_file / apply_patch 改。';

// ── 内容没变的不算改了（第一百六十九轮真跑时撞到的）──
// 替换没对上时脚本照样 open('a.js','w').write(s)：把一模一样的内容写回去，修改时间变了，只看快照就当成「改了」，
// 「一个文件都没改动」的提醒永远出不来。所以内联脚本改文件的命令，前后再给它提到的文件算一次内容哈希。
const HASH_MAX_BYTES = 2_000_000;
const MENTION_MAX = 20;
/** 命令里提到的、工作区里真有的文件（相对工作区根）。认 `cd 某目录 &&` 之后的相对路径 */
export function mentionedFiles(root, cwdRel, command) {
  const c = String(command || '');
  const base = cwdRel && cwdRel !== '.' ? cwdRel : '';
  const dirs = [base, ...[...c.matchAll(/\bcd\s+([^\s&;|]+)/g)].map((m) => path.posix.normalize(path.posix.join(base, m[1].replace(/^['"]|['"]$/g, ''))))];
  const out = new Set();
  for (const m of c.matchAll(/[\w./-]*[\w-]\.[A-Za-z0-9]{1,8}\b/g)) {
    for (const d of dirs) {
      const rel = path.posix.normalize(path.posix.join(d, m[0]));
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      try {
        const st = fs.statSync(path.join(root, rel));
        if (st.isFile() && st.size <= HASH_MAX_BYTES) out.add(rel);
      } catch { /* 不是文件 */ }
    }
    if (out.size >= MENTION_MAX) break;
  }
  return [...out];
}
/** 两次正文的第一处不同在第几行（1 起）。一样就 null。不是字符串就当第 1 行。 */
export function firstDiffLine(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return 1;
  const a = before.split('\n');
  const b = after.split('\n');
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i + 1;
  return null;
}

/** 这几个文件的正文（含空字节的跳过）。给 shell 改动算落在第几行。 */
export function readTexts(root, rels) {
  const out = new Map();
  for (const rel of rels || []) {
    try {
      const buf = fs.readFileSync(path.join(root, rel));
      if (buf.includes(0)) continue;
      out.set(rel, buf.toString('utf8'));
    } catch { /* 没了 */ }
  }
  return out;
}

/** 这几个文件的内容哈希：Map<相对路径, sha1>（读不了的不放） */
export async function hashFiles(root, rels) {
  const crypto = (await import('node:crypto')).default;
  const out = new Map();
  for (const rel of rels) {
    try { out.set(rel, crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex')); } catch { /* 没了 */ }
  }
  return out;
}
/** 修改时间变了、内容一字没变的那些从「修改」里拿掉 */
export async function dropUnchanged(root, diff, hashesBefore) {
  if (!diff || !hashesBefore || !hashesBefore.size) return diff;
  const after = await hashFiles(root, diff.modified.filter((p) => hashesBefore.has(p)));
  return { ...diff, modified: diff.modified.filter((p) => !(after.has(p) && after.get(p) === hashesBefore.get(p))) };
}
