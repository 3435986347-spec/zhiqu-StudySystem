// 通配符和 .gitignore（第一百一十轮，Codex 同级第 3 步）：search 用。
// .gitignore 的规矩不是照理解写的：判据拿真的 git ls-files 当对照（test/search.test.js）。
import fs from 'node:fs';
import path from 'node:path';

const MAX_IGNORE_BYTES = 256 * 1024;
const regexEscape = (ch) => ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** 通配符翻成正则的正文。braces：{a,b} 算不算选择（.gitignore 里不算）。 */
function globSource(glob, { braces = false } = {}) {
  let out = '';
  let open = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '\\' && i + 1 < glob.length) { out += regexEscape(glob[++i]); continue; }
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const after = glob[i + 2];
        if (atStart && after === '/') { out += '(?:.*/)?'; i += 2; continue; }   // **/x、a/**/b：可以是零层
        if (atStart && after === undefined) { out += '.*'; i += 1; continue; }   // a/**：里面的一切
        while (glob[i + 1] === '*') i += 1;                                       // 别的地方的 ** 就是 *
      }
      out += '[^/]*';
      continue;
    }
    if (ch === '?') { out += '[^/]'; continue; }
    if (ch === '[') {
      const end = glob.indexOf(']', glob[i + 1] === '!' || glob[i + 1] === '^' ? i + 3 : i + 2);
      if (end > 0) {
        let body = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (body[0] === '!') body = `^${body.slice(1)}`;
        out += `[${body}]`;
        i = end;
        continue;
      }
    }
    if (braces && ch === '{') { open += 1; out += '(?:'; continue; }
    if (braces && ch === '}') { open -= 1; out += ')'; continue; }
    if (braces && ch === ',' && open > 0) { out += '|'; continue; }
    out += regexEscape(ch);
  }
  return out;   // 括号不配对的话 new RegExp 会抛，调用方接着
}

/**
 * search 的 glob 参数：*.py 不带斜杠，哪一层的都算；src/**\/*.js 带斜杠，从工作区根开始算。
 * 返回 (相对路径) => 是否命中；写错了（括号不配对）返回 null。
 */
export function compileGlob(glob) {
  const text = String(glob).trim().replace(/^\.?\//, '');
  const source = globSource(text, { braces: true });
  let re;
  try { re = new RegExp(text.includes('/') ? `^${source}$` : `(?:^|/)${source}$`); } catch { return null; }
  return (rel) => re.test(rel);
}

/** 一份 .gitignore 里的规则。base 是它所在的目录，规则相对它算。 */
export function parseIgnore(text, base) {
  const rules = [];
  for (const raw of String(text).split('\n')) {
    // 和 git 一样：去掉行尾的 CR 和没转义的空格（tab 不去）
    let line = raw.replace(/\r$/, '').replace(/(?<!\\) +$/, '');
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    let re;
    try { re = new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${globSource(line)}$`); } catch { continue; }   // 坏的一条不连累别的
    rules.push({ negated, dirOnly, re, base });
  }
  return rules;
}

function readRules(file, base) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IGNORE_BYTES) return [];
    return parseIgnore(fs.readFileSync(file, 'utf8'), base);
  } catch { return []; }
}

/** 一个目录自己的 .gitignore */
export function rulesIn(dir) {
  return readRules(path.join(dir, '.gitignore'), dir);
}

/**
 * 走到 start 这个目录时已经生效的规则：从 git 仓库的顶走下来（工作区可以是仓库的子目录），.git/info/exclude 优先级最低。
 * 不在仓库里也认工作区里的 .gitignore。
 */
export function rulesAt(start) {
  const chain = [];
  let top = null;
  for (let dir = start; ; dir = path.dirname(dir)) {
    chain.unshift(dir);
    if (fs.existsSync(path.join(dir, '.git'))) { top = dir; break; }
    if (dir === path.dirname(dir)) break;
  }
  const levels = top ? chain : [start];
  const rules = top ? readRules(path.join(top, '.git', 'info', 'exclude'), top) : [];
  for (const dir of levels) rules.push(...rulesIn(dir));
  return rules;
}

/** 后面的规则盖前面的，和 git 一样。父目录被忽略了就走不进去，所以子目录里的 ! 救不回来，也和 git 一样。 */
export function isIgnored(rules, abs, isDir) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const rel = path.relative(rule.base, abs).split(path.sep).join('/');
    if (rule.re.test(rel)) ignored = !rule.negated;
  }
  return ignored;
}
