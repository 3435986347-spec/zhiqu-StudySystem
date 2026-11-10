// 内置 skill 库的体检（第一百二十轮）：随包发的 skills/ 是给模型看的指令，写错了不会报错、只会让它做错事。
// 这里把「会静默失效」的几类问题钉住：目录名和 name 不一致（load_skill 找不到）、描述太长（第一层被截断）、
// 抄了 Claude Code 的工具名（zhiqu 没有 Read / Bash / Task，模型会照着调不存在的工具）、目录里有没被提到的文件（永远取不到）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_SKILLS_DIR, discoverSkills, loadSkill, parseFrontmatter, skillsBlock } from '../src/skills.js';
import { tmpdir } from './helpers.js';

const skills = () => discoverSkills(tmpdir(), tmpdir(), { builtin: BUILTIN_SKILLS_DIR });

// Claude Code / 其它 agent 的工具名。zhiqu 的工具叫 read_file / search / shell / spawn_agent，写成别的就是空指。
const FOREIGN_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'Task', 'Agent', 'TodoWrite',
  'NotebookEdit', 'NotebookRead', 'WebFetch', 'WebSearch', 'Skill', 'SlashCommand', 'ask_user', 'todo_write'];

test('内置 skill 都在、名字和目录一致、描述够短', () => {
  const list = skills();
  assert.ok(list.length >= 6, `内置 skill 至少 6 个，现在 ${list.length} 个`);
  for (const s of list) {
    assert.equal(s.source, 'builtin');
    assert.equal(path.basename(s.dir), s.name, `${s.dir}：目录名要和 frontmatter 的 name 一致，否则 load_skill 按名字找不到`);
    assert.ok(s.description && s.description.length >= 8, `${s.name}：description 太短，模型判断不了什么时候用它`);
    assert.ok(s.description.length <= 120, `${s.name}：description ${s.description.length} 字，第一层每一轮都在，压到 120 字以内`);
    assert.ok(!s.description.includes('\n'), `${s.name}：description 只能一行`);
  }
});

test('内置 skill 的正文：长度合理、不夹 CRLF / Tab、不以空文结束', () => {
  for (const s of skills()) {
    const raw = fs.readFileSync(s.file, 'utf8');
    const { body } = parseFrontmatter(raw);
    assert.ok(body.trim().length >= 300, `${s.name}：正文太短，多半是没写完`);
    assert.ok(body.length <= 12_000, `${s.name}：正文 ${body.length} 字，长的部分拆到同目录的参考文件里`);
    assert.ok(raw.endsWith('\n'), `${s.name}：文件要以换行结尾`);
    assert.ok(!raw.includes('\r'), `${s.name}：不要 CRLF`);
    assert.ok(!raw.includes('\t'), `${s.name}：缩进用空格，Tab 在终端和 diff 里都会走样`);
  }
});

test('内置 skill 不引用 zhiqu 里不存在的工具', () => {
  for (const s of skills()) {
    const text = fs.readFileSync(s.file, 'utf8');
    for (const name of FOREIGN_TOOLS) {
      // 只看反引号里的：正文里正常提到英文单词（Read-only 之类）不算
      assert.ok(!text.includes(`\`${name}\``), `${s.name}：\`${name}\` 不是 zhiqu 的工具 —— 工具名见 CLAUDE.md，别照抄 Claude Code`);
    }
  }
});

test('内置 skill 目录里没有取不到的文件', () => {
  for (const s of skills()) {
    const text = fs.readFileSync(s.file, 'utf8');
    const files = fs.readdirSync(s.dir, { recursive: true }).map(String)
      .filter((f) => fs.statSync(path.join(s.dir, f)).isFile());
    for (const f of files) {
      if (f === 'SKILL.md') continue;
      assert.ok(text.includes(f), `${s.name}：${f} 没在 SKILL.md 里被提到，模型不知道它存在（load_skill 的 file 参数取不到没人知道的东西）`);
    }
  }
});

test('内置 skill 的第一层（每一轮都在的那段）够便宜', () => {
  const block = skillsBlock(skills());
  assert.ok(block.length <= 2_500, `常驻的 skill 清单 ${block.length} 字，太长了 —— 精简 description 或者少放几个`);
});

test('每个内置 skill 都能被 load_skill 取到', () => {
  const list = skills();
  for (const s of list) {
    const r = loadSkill(list, { name: s.name });
    assert.ok(!r.error, `${s.name} 取不到：${r.error}`);
    assert.match(r.content, new RegExp(`【skill：${s.name}】`));
  }
  assert.match(loadSkill(list, { name: list[0].name, file: 'SKILL.md' }).content, /【skill：/);
});
