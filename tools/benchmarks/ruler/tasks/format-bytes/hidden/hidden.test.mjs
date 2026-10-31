import assert from 'node:assert/strict';
import { formatBytes } from './format.mjs';

const cases = [
  [0, '0 B'], [512, '512 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1.5 KB'], [1100, '1.1 KB'],
  [1024 ** 2, '1 MB'], [1.5 * 1024 ** 3, '1.5 GB'], [1024 ** 4, '1 TB'], [1024 ** 5, '1024 TB'],
  [-1536, '-1.5 KB'], [-512, '-512 B'],
];
let failed = 0;
for (const [n, want] of cases) {
  const got = formatBytes(n);
  if (got !== want) { failed++; console.log(`FAIL formatBytes(${n}) = ${JSON.stringify(got)}，应当是 ${JSON.stringify(want)}`); }
}
assert.equal(failed, 0, `${failed} 个不对`);
console.log('ok');
