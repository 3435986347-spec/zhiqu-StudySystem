// 尺子的对照组（第九十轮）：不调模型。原始代码过不了隐藏测试、参考答案过得了 —— 对照组不死，这把尺子量出来的「过」「没过」就不作数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTasks, prepareWorkspace, runHidden, runVisible } from './ruler/ruler.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const tasks = listTasks();

test('尺子有 10 道题，每题都有问题描述、公开 / 隐藏测试的跑法', () => {
  assert.equal(tasks.length, 10, tasks.map((t) => t.name).join(','));
  for (const t of tasks) {
    assert.ok(t.issue.length > 40, `${t.name} 的问题描述太短`);
    assert.ok(Array.isArray(t.run) && Array.isArray(t.visible), t.name);
  }
});

for (const t of tasks) {
  test(`${t.name}：原始代码公开测试过、隐藏测试不过；参考答案两个都过；仓库里没有隐藏测试`, () => {
    const hiddenNames = fs.readdirSync(path.join(t.root, 'hidden'));
    const repoNames = fs.readdirSync(path.join(t.root, 'repo'));
    assert.ok(hiddenNames.length > 0);
    for (const n of hiddenNames) assert.ok(!repoNames.includes(n), `${t.name}：隐藏测试 ${n} 在模型能看到的仓库里`);
    const base = prepareWorkspace(t, tmp(`ruler-base-${t.name}-`));
    assert.ok(runVisible(t, base).pass, `${t.name}：原始代码的公开测试就挂了`);
    const hb = runHidden(t, base);
    assert.ok(!hb.pass, `${t.name}：原始代码就过了隐藏测试（这题量不出东西）`);
    const gold = prepareWorkspace(t, tmp(`ruler-gold-${t.name}-`), { overlay: 'gold' });
    assert.ok(runVisible(t, gold).pass, `${t.name}：参考答案的公开测试挂了`);
    const hg = runHidden(t, gold);
    assert.ok(hg.pass, `${t.name}：参考答案过不了隐藏测试：\n${hg.output}`);
  });
}
