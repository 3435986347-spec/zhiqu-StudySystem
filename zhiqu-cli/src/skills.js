// P4 Skills：.zhiqu/skills/<名字>/SKILL.md（项目级）与 ~/.zhiqu/skills/<名字>/SKILL.md（用户级）。同名时项目级优先。
//
// 渐进式披露，三层（用户 2026-09-24 明确要的）：
//   第一层  名字 + 一句描述（frontmatter 的 name / description）—— 每一轮都在系统提示里，很便宜；
//   第二层  SKILL.md 正文 —— 任务对得上时模型调 load_skill 取；
//   第三层  skill 目录里的其它文件（参考文档、模板、脚本）—— SKILL.md 里提到、真用到时才用 load_skill 的 file 取。
// 一次性全塞进去的话，十几个 skill 就把上下文吃掉一大块，而一轮里通常只用得上一两个、每个也只用得上一部分。
// 写 skill 的人因此可以把 SKILL.md 写短（怎么做 + 什么时候去看哪个文件），把大段细节放进同目录的别的文件。
import fs from 'node:fs';
import path from 'node:path';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SKILL_CHARS = 60_000;

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function scan(base, source) {
  const out = [];
  let names;
  try { names = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    if (!d.isDirectory() || !NAME.test(d.name)) continue;
    const file = path.join(base, d.name, 'SKILL.md');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(text);
    const name = meta.name && NAME.test(meta.name) ? meta.name : d.name;
    const description = (meta.description || body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '').slice(0, 200);
    out.push({ name, description, dir: path.join(base, d.name), file, source });
  }
  return out;
}

export function discoverSkills(root, userDir) {
  const byName = new Map();
  for (const s of scan(path.join(userDir, 'skills'), 'user')) byName.set(s.name, s);
  for (const s of scan(path.join(root, '.zhiqu', 'skills'), 'project')) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsBlock(skills) {
  if (!skills.length) return '';
  return ['## Skills', '下面这些是用户准备好的做事方法（这里只有名字和一句描述）。任务和某个 skill 对得上时，先调用 load_skill 取它的正文，再按它做；'
    + '正文里提到的其它文件，真用到时再用 load_skill 的 file 参数取，不要一次全取。',
    ...skills.map((s) => `- ${s.name}：${s.description}`)].join('\n');
}

export function loadSkillSchema() {
  return {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '取一个 skill 的正文（SKILL.md）。正文里提到 skill 目录里的其它文件（参考、模板、脚本）时，真要用到再用 file 参数单独取。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'skill 的名字' },
          file: { type: 'string', description: '可选：skill 目录里的另一个文件（相对路径）' },
        },
        required: ['name'],
      },
    },
  };
}

export function loadSkill(skills, args = {}) {
  const skill = skills.find((s) => s.name === args.name);
  if (!skill) return { error: `没有叫「${args.name}」的 skill。可用的：${skills.map((s) => s.name).join('、') || '（没有）'}` };
  let target = skill.file;
  if (args.file) {
    target = path.resolve(skill.dir, String(args.file));
    const rel = path.relative(skill.dir, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'file 只能是 skill 目录里的文件' };
    try {
      if (fs.lstatSync(target).isSymbolicLink()) return { error: 'skill 目录里的软链不跟随' };
    } catch { return { error: `skill「${skill.name}」里没有 ${args.file}` }; }
  }
  let text;
  try { text = fs.readFileSync(target, 'utf8'); } catch { return { error: `读不了 ${args.file || 'SKILL.md'}` }; }
  if (text.length > MAX_SKILL_CHARS) text = `${text.slice(0, MAX_SKILL_CHARS)}\n…（超过 ${MAX_SKILL_CHARS} 字，已截断）`;
  let others = [];
  try {
    others = fs.readdirSync(skill.dir, { recursive: true }).map(String)
      .filter((f) => f !== 'SKILL.md' && fs.statSync(path.join(skill.dir, f)).isFile()).slice(0, 50);
  } catch { /* 列不出来就不列 */ }
  const extra = !args.file && others.length ? `\n\n（这个 skill 目录里还有：${others.join('、')} —— 需要时用 load_skill 的 file 参数取）` : '';
  return { content: `【skill：${skill.name}${args.file ? ` / ${args.file}` : ''}】\n${text}${extra}`, summary: skill.name };
}
