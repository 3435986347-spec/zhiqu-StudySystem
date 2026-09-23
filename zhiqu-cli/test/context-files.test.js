// P3 项目说明文件与 P4 Skills（渐进式披露）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { instructionsBlock, loadInstructions, MAX_FILE_CHARS } from '../src/instructions.js';
import { discoverSkills, loadSkill, skillsBlock } from '../src/skills.js';
import { tmpdir, write } from './helpers.js';

test('说明文件：从外到里（用户级 → 仓库根 → 当前目录），不读 AGENTS.md，同目录有 ZHIQU.md 就不读 CLAUDE.md', () => {
  const home = tmpdir();
  const repo = tmpdir();
  fs.mkdirSync(path.join(repo, '.git'));
  write(home, 'ZHIQU.md', '用户级');
  write(repo, 'ZHIQU.md', '仓库根');
  write(repo, 'CLAUDE.md', '仓库根的 CLAUDE（有 ZHIQU.md 时不读）');
  write(repo, 'AGENTS.md', 'Codex 的（不读）');
  write(repo, 'pkg/CLAUDE.md', '子目录只有 CLAUDE.md（退回读它）');
  const cwd = path.join(repo, 'pkg');
  const loaded = loadInstructions(cwd, home);
  assert.deepEqual(loaded.files.map((f) => f.text), ['用户级', '仓库根', '子目录只有 CLAUDE.md（退回读它）']);
  const block = instructionsBlock(loaded, cwd, home);
  assert.ok(block.indexOf('用户级') < block.indexOf('仓库根') && block.indexOf('仓库根') < block.indexOf('子目录'));
  assert.ok(!block.includes('Codex'));
});

test('说明文件：不在 git 仓库里只看当前目录（不一路爬到家目录）；超长截断并说出来', () => {
  const home = tmpdir();
  const outer = tmpdir();
  write(outer, 'ZHIQU.md', '外层的，不该读');
  const cwd = path.join(outer, 'proj');
  write(cwd, 'ZHIQU.md', '长'.repeat(MAX_FILE_CHARS + 10));
  const loaded = loadInstructions(cwd, home);
  assert.equal(loaded.files.length, 1);
  assert.equal(loaded.files[0].truncated, true);
  assert.match(instructionsBlock(loaded, cwd, home), /只放了前面部分/);
});

test('Skills 渐进式披露：常驻的只有名字和描述；正文按需取；目录里的其它文件再按需取', () => {
  const home = tmpdir();
  const root = tmpdir();
  write(home, 'skills/snake/SKILL.md', '---\nname: snake\ndescription: 用户级的贪吃蛇\n---\n用户级正文');
  write(root, '.zhiqu/skills/snake/SKILL.md', '---\nname: snake\ndescription: 项目级的贪吃蛇\n---\n# 正文\n细节见 ref.md');
  write(root, '.zhiqu/skills/snake/ref.md', '参考：方向键');
  write(root, '.zhiqu/skills/nofront/SKILL.md', '# 没有 frontmatter 的 skill\n正文');
  const skills = discoverSkills(root, home);
  assert.deepEqual(skills.map((s) => [s.name, s.source]), [['nofront', 'project'], ['snake', 'project']], '同名时项目级优先');
  const block = skillsBlock(skills);
  assert.match(block, /snake：项目级的贪吃蛇/);
  assert.match(block, /nofront：没有 frontmatter 的 skill/);
  assert.ok(!block.includes('细节见 ref.md'), '第一层不该带正文');
  const body = loadSkill(skills, { name: 'snake' });
  assert.match(body.content, /细节见 ref\.md/);
  assert.match(body.content, /还有：ref\.md/);
  assert.ok(!body.content.includes('参考：方向键'), '第二层不该把参考文件一起带进来');
  assert.match(loadSkill(skills, { name: 'snake', file: 'ref.md' }).content, /参考：方向键/);
  assert.match(loadSkill(skills, { name: 'snake', file: '../../../etc/passwd' }).error, /只能是 skill 目录里的文件/);
  assert.match(loadSkill(skills, { name: 'nope' }).error, /没有叫/);
});
