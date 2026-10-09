// 工作区安全规则的一致性用例 —— JS 这一侧。服务器端的 WorkspaceRulesConformanceTest（Java）跑同一份 JSON。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceGuard } from '../src/tools/guard.js';
import { checkCommand } from '../src/tools/execrules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'conformance', 'workspace-rules.json'), 'utf8'));

function build(tmp, layout) {
  for (const [rel, content] of Object.entries(layout.files || {})) {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'object' ? Buffer.alloc(content.bytes) : content);
  }
  for (const dir of layout.dirs || []) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  try {
    for (const [rel, target] of Object.entries(layout.symlinks || {})) fs.symlinkSync(target, path.join(tmp, rel));
    return true;
  } catch {
    return false;   // Windows 没有权限时跳过需要软链的用例
  }
}

test('读 / 写路径：结论与共用用例一致（新建目录也一致）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-conf-'));
  const symlinks = build(tmp, fixture.layout);
  const guard = new WorkspaceGuard(path.join(tmp, 'root'), { extensions: fixture.extensions, maxFileBytes: fixture.limits.maxFileBytes });
  const mismatches = [];
  let checked = 0;
  for (const c of fixture.read) {
    if (c.needsSymlink && !symlinks) continue;
    checked++;
    const got = guard.resolveReadable(c.path).reason;
    if (got !== c.expect) mismatches.push(`read ${JSON.stringify(c.path)} 期望 ${c.expect} 实际 ${got}`);
  }
  for (const c of fixture.write) {
    if (c.needsSymlink && !symlinks) continue;
    checked++;
    const got = guard.resolveWritable(c.path).reason;
    if (got !== c.expect) mismatches.push(`write ${JSON.stringify(c.path)} 期望 ${c.expect} 实际 ${got}`);
    if (c.newDirectories) {
      const dirs = guard.missingParents(c.path);
      if (JSON.stringify(dirs) !== JSON.stringify(c.newDirectories)) mismatches.push(`write ${c.path} 新建目录 期望 ${c.newDirectories} 实际 ${dirs}`);
    }
  }
  assert.ok(checked >= 25, `用例几乎没跑（${checked} 条）—— 空扫描和全绿长得一样`);
  assert.deepEqual(mismatches, []);
});

test('执行：命令名与参数的结论与共用用例一致', () => {
  const mismatches = [];
  for (const c of fixture.exec) {
    const got = checkCommand(fixture.commands, c.command, c.args).refusal;
    if (got !== c.expect) mismatches.push(`${c.command} ${JSON.stringify(c.args)} 期望 ${c.expect} 实际 ${got}`);
  }
  assert.ok(fixture.exec.length >= 25);
  assert.deepEqual(mismatches, []);
});
