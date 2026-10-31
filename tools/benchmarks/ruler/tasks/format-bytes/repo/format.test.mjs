import assert from 'node:assert/strict';
import { formatBytes } from './format.mjs';

assert.equal(formatBytes(512), '512 B');
console.log('ok');
