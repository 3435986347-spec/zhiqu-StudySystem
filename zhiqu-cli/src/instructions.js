// P3 项目说明文件：自动加载当前目录到仓库根的 ZHIQU.md（兼容 CLAUDE.md），外加用户级 ~/.zhiqu/ZHIQU.md。
//
// 不读 AGENTS.md（用户 2026-09-24 定的）：那是 Codex 的约定文件，读进来会和别的工具的说明重复、打架。
// 同一个目录里有 ZHIQU.md 就只读它；没有才退回读 CLAUDE.md —— 两份都在时内容多半重复，不塞两遍。
//
// 顺序从外到里：用户级 → 仓库根 → … → 当前目录。
// 越靠里越具体，排在后面（模型读到的后文优先）。不在 git 仓库里时只看当前目录 ——
// 否则会一路爬到家目录，把不相干的说明文件也塞进来。
// 单个文件上限 20K 字、总共 60K 字：超了就截断或跳过，并且说出来（启动时显示「已加载 N 份」）。
import fs from 'node:fs';
import path from 'node:path';

/** 每个目录按这个顺序找，只取第一个存在的。 */
export const INSTRUCTION_FILES = ['ZHIQU.md', 'CLAUDE.md'];
export const MAX_FILE_CHARS = 20_000;
export const MAX_TOTAL_CHARS = 60_000;

export function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isFile(f) {
  try { return fs.statSync(f).isFile(); } catch { return false; }
}

export function instructionCandidates(cwd, userDir) {
  const out = [path.join(userDir, 'ZHIQU.md')];
  const repo = findRepoRoot(cwd);
  const dirs = [];
  if (repo) {
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      dirs.unshift(d);
      if (d === repo || path.dirname(d) === d) break;
    }
  } else {
    dirs.push(path.resolve(cwd));
  }
  for (const d of dirs) {
    const first = INSTRUCTION_FILES.map((name) => path.join(d, name)).find((f) => isFile(f));
    if (first) out.push(first);
  }
  return out;
}

export function loadInstructions(cwd, userDir) {
  const files = [];
  const skipped = [];
  let total = 0;
  for (const file of instructionCandidates(cwd, userDir)) {
    let text;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    let truncated = false;
    if (text.length > MAX_FILE_CHARS) { text = text.slice(0, MAX_FILE_CHARS); truncated = true; }
    if (total + text.length > MAX_TOTAL_CHARS) { skipped.push(file); continue; }
    total += text.length;
    files.push({ file, text, truncated });
  }
  return { files, skipped, total };
}

export function displayPath(file, cwd, userDir) {
  if (file.startsWith(userDir + path.sep)) return `~/.zhiqu/${path.relative(userDir, file)}`;
  const rel = path.relative(cwd, file);
  return rel.split(path.sep).join('/');
}

export function instructionsBlock(loaded, cwd, userDir) {
  if (!loaded.files.length) return '';
  const parts = ['## 项目说明', '以下内容来自用户和项目的说明文件，从外到里排列，越靠后越具体、越优先。它们是用户写给你的工作约定。'];
  for (const f of loaded.files) {
    parts.push(`### ${displayPath(f.file, cwd, userDir)}${f.truncated ? `（超过 ${MAX_FILE_CHARS} 字，只放了前面部分）` : ''}`);
    parts.push(f.text.trim());
  }
  if (loaded.skipped.length) {
    parts.push(`（还有 ${loaded.skipped.length} 份说明文件因为总长度超过 ${MAX_TOTAL_CHARS} 字没有放进来：`
      + `${loaded.skipped.map((f) => displayPath(f, cwd, userDir)).join('、')}；需要时可以 read_file）`);
  }
  return parts.join('\n\n');
}

/** /init：让 agent 读项目、写一份 ZHIQU.md 初稿。 */
export function initPrompt(exists) {
  return [
    exists ? '工作区里已经有 ZHIQU.md 了。请先读它，再结合项目现状把它更新得更准确（用替换用法改，不要丢掉已有的约定）。'
      : '请为这个项目写一份 ZHIQU.md 初稿，放在工作区根目录。',
    '先用 list_files、read_file 看清项目：用途、目录结构、怎么构建、怎么跑测试、代码约定、容易踩的坑。',
    'ZHIQU.md 是写给以后的 coding agent（包括你自己）看的工作说明：只写从代码里不容易一眼看出来、但做事时必须知道的东西，',
    '比如「改了 X 要同步改 Y」「测试要这样跑」「不要动某某目录」。不要复述显而易见的内容，不要编造没看到的命令。',
    '写完之后告诉我写了哪几块。',
  ].join('\n');
}
