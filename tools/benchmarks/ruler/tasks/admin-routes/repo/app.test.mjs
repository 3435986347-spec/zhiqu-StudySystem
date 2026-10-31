import assert from 'node:assert/strict';
import { buildApp } from './src/app.mjs';

const app = buildApp({ users: [{ name: 'a' }] });
assert.equal(app.handle({ method: 'GET', path: '/health' }).status, 200);
assert.equal(app.handle({ method: 'GET', path: '/me' }).status, 401);
console.log('ok');
