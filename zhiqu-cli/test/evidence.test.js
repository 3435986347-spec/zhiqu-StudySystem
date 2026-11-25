import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidencePlan } from '../src/evidence.js';

test('只跑这一轮改过的 *.test.js，多了不猜整仓；验收标准里写了 node --test 才认', () => {
  assert.equal(evidencePlan(['src/a.js']), null);
  assert.deepEqual(evidencePlan(['src/a.js', 'test/a.test.js']), { text: 'node --test test/a.test.js' });
  assert.equal(evidencePlan(['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js']), null);
  assert.equal(evidencePlan([], 'npm test'), null);
  assert.equal(evidencePlan([], 'mvn -Dtest=Foo test'), null);
  assert.deepEqual(evidencePlan([], '先这样\nnode --test test/a.test.js\n'), { text: 'node --test test/a.test.js' });
  assert.equal(evidencePlan([], 'node --test ../x.test.js'), null);
});
