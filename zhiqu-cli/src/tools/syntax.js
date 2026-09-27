// 写完立刻知道语法错了（第十轮，用户要的「最好一次就成功」）。
//
// 模型写坏一个 JSON / JS，原来要等到它自己去跑、或者用户去跑才发现 —— 那时它已经接着写了别的文件，
// 回头找是哪一步写坏的又是一轮。现在 write_file 落盘后立刻检查，有问题就写在工具结果里。
//
// 只做两种、而且只做「确定不会误报、不会有副作用」的：
//   - JSON：JSON.parse。tsconfig / jsconfig / .vscode 里的是 JSONC（允许注释），不查；
//   - JS（.js / .mjs / .cjs）：node --check —— 只解析、不执行，用的是跑着命令行的这个 node，不经过 shell，不带环境变量。
//     <b>不能原地查 .js</b>：实测 node 22 原地 --check 一个带 export 的 .js，连真的语法错误也放行（退出码 0，
//     模块类型自动判定那条路吞掉了报错）—— 现在的前端代码大多是这种。所以按内容定类型（有 import / export 语句就是 ES 模块），
//     拷一份到临时目录、用确定的扩展名（.mjs / .cjs）查。
//     JSX 之类要编译的语法 node 解析不了，报的是「Unexpected token '<'」—— 那不是错，不报。
// 不做 Python：没装命令行工具的 Mac 上，/usr/bin/python3 一调用就会弹出安装对话框。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const JS = new Set(['.js', '.mjs', '.cjs']);
const JSONC = /^(tsconfig|jsconfig)(\..*)?\.json$|^devcontainer\.json$/i;

/** 有问题返回一句说明（给模型看），没问题（或者这类文件不查）返回 null。 */
export function syntaxProblem(abs, rel, text) {
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.json') return jsonProblem(abs, rel, text);
  if (JS.has(ext)) return jsProblem(ext, rel, text);
  if (ext === '.html' || ext === '.htm') return htmlProblem(rel, text);
  return null;
}

/**
 * HTML 里内联的 <script>（第十二轮：单文件的小游戏、小页面最常见 —— 用户贴的记录里模型自己写 check.js 用 new Function 查）。
 * 外链脚本（src=）、非 JS 的数据块（type="application/json"、模板）不查；type="module" 按 ES 模块查。报错的行号对到 HTML 里。
 */
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

function htmlProblem(rel, text) {
  for (const m of text.matchAll(SCRIPT)) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [, ''])[1].toLowerCase();
    if (!JS_TYPES.has(type) || !m[2].trim()) continue;
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    const firstLine = text.slice(0, bodyStart).split('\n').length;   // 脚本第 1 行在 HTML 的第几行
    const problem = jsProblem(type === 'module' ? '.mjs' : '.cjs', rel, m[2]);
    if (problem) {
      // jsProblem 报的是「rel:脚本里的行号」，换成 HTML 里的行号
      return problem.replace(new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`), (_, n) => `${rel}:${firstLine + Number(n) - 1}`);
    }
  }
  return null;
}

function jsonProblem(abs, rel, text) {
  if (JSONC.test(path.basename(abs)) || rel.split('/').includes('.vscode') || !text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    let where = '';
    const lc = /line (\d+) column (\d+)/.exec(e.message);
    const pos = /position (\d+)/.exec(e.message);
    if (lc) where = `第 ${lc[1]} 行第 ${lc[2]} 列`;
    else if (pos) {
      const before = text.slice(0, Number(pos[1]));
      where = `第 ${before.split('\n').length} 行第 ${Number(pos[1]) - before.lastIndexOf('\n')} 列`;
    }
    return `${rel} 不是合法的 JSON${where ? `（${where}）` : ''}：${e.message}`;
  }
}

const ESM_SYNTAX = /^\s*(import\s*[\w{*'"]|export\s)/m;

function jsProblem(ext, rel, text) {
  const esm = ext === '.mjs' || (ext === '.js' && ESM_SYNTAX.test(text));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-check-'));
  const file = path.join(dir, esm ? 'check.mjs' : 'check.cjs');
  let r;
  try {
    fs.writeFileSync(file, text);
    r = spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
      // 不带命令行自己的环境（那里有 ZHIQU_TOKEN）；Windows 上没有 SystemRoot 连 node 都起不来
      env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (r.error || r.status === 0) return null;
  const err = String(r.stderr || '').split(file).join(rel).trim();
  if (/Unexpected token '<'/.test(err)) return null;   // JSX：要编译的语法，不是写错了
  const lines = err.split('\n');
  const end = lines.findIndex((l) => /^\w*Error:/.test(l));
  return (end >= 0 ? lines.slice(0, end + 1) : lines.slice(0, 6)).join('\n');
}
