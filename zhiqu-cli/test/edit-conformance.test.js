// 「按原文替换一段」的一致性用例 —— 命令行这一侧。网页 code agent 的 TextEditConformanceTest（Java）跑的是同一份
// conformance/text-edit.json：两份实现各自绿不算数，对同一份输入给出同样的结论才算数（与 workspace-rules.json 同一个做法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdit, describeEditError } from '../src/tools/edit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'conformance', 'text-edit.json'), 'utf8'));

test('用例文件没扫空', () => {
  assert.ok(fixture.cases.length >= 15, `只读到 ${fixture.cases.length} 条`);
  assert.ok(fixture.cases.some((c) => c.expect.text !== undefined) && fixture.cases.some((c) => c.expect.error), '成功与拒绝两类都要有');
});

for (const c of fixture.cases) {
  test(`替换：${c.name}`, () => {
    const r = applyEdit(c.text, c.old, c.new, { replaceAll: Boolean(c.replaceAll) });
    const e = c.expect;
    if (e.text !== undefined) {
      assert.ok(!r.error, r.error && describeEditError(r.error, 'f'));
      assert.equal(r.text, e.text);
      assert.equal(r.replaced, e.replaced ?? r.replaced);
      return;
    }
    assert.ok(r.error, `应当拒绝，却换成了：${JSON.stringify(r.text)}`);
    assert.equal(r.error.kind, e.error);
    if (e.error === 'ambiguous') {
      assert.equal(r.error.count, e.count);
      assert.deepEqual(r.error.lines, e.lines);
    }
    if (e.error === 'not_found') {
      assert.equal(r.error.hint ? r.error.hint.kind : null, e.hint);
      if (e.hint === 'whitespace') assert.deepEqual([r.error.hint.from, r.error.hint.to], [e.from, e.to]);
      if (e.hint === 'first_line') assert.equal(r.error.hint.at, e.at);
    }
    assert.ok(describeEditError(r.error, 'f').length > 0);
  });
}
