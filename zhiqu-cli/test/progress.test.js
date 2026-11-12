// 上一轮没做完的进度（第一百三十六轮）：用户「每次做到一半就暂停，下一次又建临时脚本、从头开始看」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runTurn } from '../src/agent.js';
import { clearProgress, progressBlock, progressPath, readProgress, writeProgress } from '../src/progress.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

test('没做完的进度写得进、读得回；说的都是真发生了的（改过的文件、做过的步骤）', () => {
  const root = tmpdir();
  writeProgress(root, { done: false, files: ['src/app.js', 'test/app.test.js'], steps: ['读取 src/app.js', '修改 src/app.js'], lastStep: '运行 node --test' });
  const p = readProgress(root);
  assert.ok(p, '写进去的进度读不回来');
  assert.match(p.text, /src\/app\.js/);
  assert.match(p.text, /node --test/);
  assert.match(progressBlock(p), /不要重建已经有的临时脚本/);
});

test('做完了就把笔记删掉：下一轮不该再提上一轮', () => {
  const root = tmpdir();
  writeProgress(root, { done: false, files: ['a.js'], steps: ['修改 a.js'] });
  assert.ok(readProgress(root));
  writeProgress(root, { done: true });
  assert.equal(readProgress(root), null);
  assert.equal(fs.existsSync(progressPath(root)), false);
});

test('超过一天的进度不认：那是上一次的活，不是接着做', () => {
  const root = tmpdir();
  writeProgress(root, { done: false, files: ['a.js'], steps: ['修改 a.js'] });
  assert.ok(readProgress(root, Date.now() + 25 * 3600 * 1000) === null);
});

test('这一轮什么都没做：不动已有的笔记（上一轮没做完的还等着接上）', () => {
  const root = tmpdir();
  writeProgress(root, { done: false, files: ['a.js'], steps: ['修改 a.js'] });
  writeProgress(root, { done: false, files: [], steps: [] });
  const p = readProgress(root);
  assert.ok(p, '什么都没做时把上一轮的笔记删掉了');
  assert.match(p.text, /a\.js/);
});

test('真的 runTurn：改了文件就停下（轮数用完）→ 写下进度；下一轮新进程开工 → 自动接上', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'const a = 1;\n');
  const mk = (replies) => {
    const ctx = {
      ui: fakeUi(), api: fakeApi(replies), root, mode: 'auto', maxRounds: 1,
      local: new LocalTools({ root }), store: null, session: { id: 't' }, messages: [],
      allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() },
      usage: { prompt: 0, completion: 0, cached: 0 }, changedFiles: new Set(),
      system: { text: '系统' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
      model: { id: 1, label: 'm', effectiveContextWindow: 64_000 },
    };
    return ctx;
  };
  const first = mk([{ calls: [{ name: 'edit_file', args: { path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' } }] }]);
  const result = await runTurn(first, '把 a 改成 2');
  assert.ok(result.exhausted, '这一轮应当是「没做完就停下」');
  const p = readProgress(root);
  assert.ok(p, '没做完却没留进度');
  assert.match(p.text, /a\.js/);

  // 下一轮：全新的 ctx（桌面版每一轮都是新进程），历史是空的
  const second = mk([{ text: '接着做完了' }]);
  await runTurn(second, '接着做');
  assert.ok(second.messages.some((m) => m.role === 'user' && /上一轮在这个项目里没做完/.test(String(m.content))),
    '下一轮开工没有把上一轮的进度接上：' + JSON.stringify(second.messages.map((m) => m.content)));
  assert.match(String(second.messages[0].content), /a\.js/);
  // 做完了：笔记清掉
  assert.equal(readProgress(root), null, '正常收尾之后还留着进度');
  clearProgress(root);
});
