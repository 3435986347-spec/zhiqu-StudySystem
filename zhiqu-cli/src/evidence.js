// 这一轮改了测试文件时，由 harness 跑那一个文件（harness 下一阶段第 4 步）。
// 不猜整仓的 npm test / mvn test。只认 node --test 加工作区里的 *.test.js。

const TEST_FILE = /^(?:[\w.-]+\/)*[\w.-]+\.test\.js$/;

/** @param {Iterable<string>} changed @param {string} [criteria] */
export function evidencePlan(changed, criteria) {
  const files = [];
  for (const raw of changed || []) {
    const rel = String(raw).replace(/（已删除）$/, '');
    if (TEST_FILE.test(rel) && !files.includes(rel)) files.push(rel);
  }
  if (files.length > 3) return null;
  if (files.length) return { text: `node --test ${files.join(' ')}` };
  const line = String(criteria || '').split('\n').map((s) => s.trim()).find((s) => /^node --test (?:[\w.-]+\/)*[\w.-]+\.test\.js$/.test(s));
  if (!line || line.includes('..')) return null;
  return { text: line };
}
