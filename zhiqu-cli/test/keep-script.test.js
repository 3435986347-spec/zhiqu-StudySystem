// 验证脚本默认留下：.tmp-*.js 收成 tests/*.test.js（里面要有断言）之前删不掉。预览页可以删。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LocalTools } from '../src/tools/local.js';
import { BUILTIN_SYSTEM_PROMPT } from '../src/prompt.js';
import { tmpdir, write } from './helpers.js';

const REAL = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("多轮", () => assert.equal(1, 1));\n';

function tools() {
  const root = tmpdir();
  return { root, t: new LocalTools({ root }) };
}

test('系统提示不再叫人把校验脚本删掉', () => {
  assert.match(BUILTIN_SYSTEM_PROMPT, /验证脚本要留下/);
  assert.match(BUILTIN_SYSTEM_PROMPT, /\.tmp-\*\.js/);
  assert.ok(!BUILTIN_SYSTEM_PROMPT.includes('校验脚本、草稿）用完用 delete_file 删掉'));
});

test('.tmp-*.js 没收成测试之前删不掉；只有 node --check、空文件、太短都不算收成', () => {
  const { root, t } = tools();
  write(root, '.tmp-multiturn.js', 'console.log("ran")\n');
  t.readFile({ path: '.tmp-multiturn.js' });
  assert.match(t.prepareDelete({ path: '.tmp-multiturn.js' }).error, /tests\/multiturn\.test\.js/);
  assert.ok(fs.existsSync(path.join(root, '.tmp-multiturn.js')));

  write(root, 'tests/multiturn.test.js', '');
  assert.match(t.prepareDelete({ path: '.tmp-multiturn.js' }).error, /不能直接删/);
  write(root, 'tests/multiturn.test.js', 'node --check server.js\n'.repeat(4));
  assert.match(t.prepareDelete({ path: '.tmp-multiturn.js' }).error, /不能直接删/);
  write(root, 'tests/multiturn.test.js', 'assert(1)\n');
  assert.match(t.prepareDelete({ path: '.tmp-multiturn.js' }).error, /不能直接删/, '太短的断言文件不算');
  write(root, 'tests/multiturn.test.js', 'assert.equal(1, 1);\n'.repeat(8));
  assert.match(t.prepareDelete({ path: '.tmp-multiturn.js' }).error, /不能直接删/, '没有引用 node:test / node:assert 不算');
  write(root, 'tests/multiturn.test.js', `${'// from "node:test"\n'.repeat(4)}console.log(1)\n`);
  assert.match(t.prepareDelete({ path: '.tmp-multiturn.js' }).error, /不能直接删/, '注释里写 node:test 不算');
  write(root, 'tests/multiturn.test.js', `${'/* from "node:test" */\n'.repeat(3)}console.log(1)\n`);
  assert.match(t.prepareDelete({ path: '.tmp-multiturn.js' }).error, /不能直接删/, '块注释里写 node:test 不算');

  write(root, 'tests/multiturn.test.js', REAL);
  const prep = t.prepareDelete({ path: '.tmp-multiturn.js' });
  assert.equal(prep.error, undefined, prep.error);
  t.commitDelete(prep);
  assert.equal(fs.existsSync(path.join(root, '.tmp-multiturn.js')), false);
  assert.equal(fs.readFileSync(path.join(root, 'tests/multiturn.test.js'), 'utf8'), REAL);
});

test('项目用 test/ 目录也认；补丁里的删除同一道；预览页和普通文件照旧能删', () => {
  const { root, t } = tools();
  write(root, 'scripts/.tmp-flow.mjs', 'console.log(1)\n');
  write(root, '.tmp-shot.html', '<p>preview</p>\n');
  write(root, 'check.js', 'x\n');
  t.readFile({ path: 'scripts/.tmp-flow.mjs' });
  t.readFile({ path: '.tmp-shot.html' });
  t.readFile({ path: 'check.js' });

  const patch = ['*** Begin Patch', '*** Delete File: scripts/.tmp-flow.mjs', '*** End Patch'].join('\n');
  assert.match(t.preparePatch({ patch }).error, /tests\/flow\.test\.js/);
  assert.ok(fs.existsSync(path.join(root, 'scripts/.tmp-flow.mjs')));

  write(root, 'test/flow.test.js', REAL);
  const prep = t.prepareDelete({ path: 'scripts/.tmp-flow.mjs' });
  assert.equal(prep.error, undefined, prep.error);

  const html = t.prepareDelete({ path: '.tmp-shot.html' });
  assert.equal(html.error, undefined, html.error);
  t.commitDelete(html);
  assert.equal(fs.existsSync(path.join(root, '.tmp-shot.html')), false);

  const plain = t.prepareDelete({ path: 'check.js' });
  assert.equal(plain.error, undefined, plain.error);
});
