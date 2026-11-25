// 找文件名（harness 下一阶段第 5 步）：list_files 只展开三层、最多 500 项，模型叫 glob 原来被指去它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolset } from '../src/agent.js';
import { LocalTools } from '../src/tools/local.js';
import { tmpdir, write } from './helpers.js';

test('glob 只返回路径：深层文件找得到，gitignore 和略过的目录不进；写错了照实说', () => {
  const root = tmpdir();
  write(root, 'src/a/b/c/WidgetTest.java', 'class T {}');
  write(root, 'src/a/b/c/Widget.java', 'class W {}');
  write(root, 'notes/readme.md', 'x');
  write(root, 'node_modules/pkg/SkipTest.java', 'class S {}');
  write(root, '.gitignore', 'secret/\n');
  write(root, 'secret/HiddenTest.java', 'class H {}');
  const local = new LocalTools({ root });
  const found = local.glob({ pattern: '**/*Test.java' });
  assert.equal(found.content, 'src/a/b/c/WidgetTest.java');
  assert.equal(found.summary, '1 个');
  const any = local.glob({ pattern: '*.java' });
  assert.deepEqual(any.content.split('\n'), ['src/a/b/c/Widget.java', 'src/a/b/c/WidgetTest.java']);
  const ignored = local.glob({ pattern: '**/*Test.java', include_ignored: true });
  assert.ok(ignored.content.includes('secret/HiddenTest.java'));
  assert.ok(!ignored.content.includes('node_modules'), ignored.content);
  assert.match(local.glob({ pattern: '' }).error, /pattern/);
  assert.match(local.glob({ pattern: 'src/**/*.{java' }).error, /写错了/);
  const names = toolset({ mode: 'plan', local, remoteTools: [], skills: [] }).map((t) => t.schema.function.name);
  assert.ok(names.includes('glob'), 'plan 档也要能找文件');
});

test('超过 200 个就停，并说这不是全部', () => {
  const root = tmpdir();
  for (let i = 0; i < 205; i++) write(root, `f${String(i).padStart(3, '0')}.txt`, 'x');
  const r = new LocalTools({ root }).glob({ pattern: '*.txt' });
  assert.equal(r.content.split('\n').filter((l) => l.endsWith('.txt')).length, 200);
  assert.match(r.content, /只列出了前 200 个/);
  assert.match(r.summary, /已截断/);
});
