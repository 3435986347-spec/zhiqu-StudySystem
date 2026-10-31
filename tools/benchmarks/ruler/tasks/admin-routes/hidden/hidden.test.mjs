import assert from 'node:assert/strict';
import { buildApp } from './src/app.mjs';

const db = { users: [{ name: 'a' }, { name: 'b' }] };
const app = buildApp(db);
const admin = { name: 'root', role: 'admin' };
const member = { name: 'm', role: 'member' };
const results = [];
const check = (label, got, want) => { if (got !== want) results.push(`${label}: ${got}，应当是 ${want}`); };

check('没登录看 /admin/users', app.handle({ method: 'GET', path: '/admin/users' }).status, 401);
check('普通用户看 /admin/users', app.handle({ method: 'GET', path: '/admin/users', user: member }).status, 403);
check('普通用户删人', app.handle({ method: 'POST', path: '/admin/users/delete', user: member, body: { name: 'a' } }).status, 403);
check('普通用户删人以后 a 还在', db.users.some((u) => u.name === 'a'), true);
check('管理员看 /admin/users', app.handle({ method: 'GET', path: '/admin/users', user: admin }).status, 200);
check('管理员删人', app.handle({ method: 'POST', path: '/admin/users/delete', user: admin, body: { name: 'b' } }).status, 200);
check('管理员删人以后 b 没了', db.users.some((u) => u.name === 'b'), false);
check('普通用户看 /me（不受影响）', app.handle({ method: 'GET', path: '/me', user: member }).status, 200);
check('/health 不用登录（不受影响）', app.handle({ method: 'GET', path: '/health' }).status, 200);
check('普通用户 403 的说法和项目里一样', JSON.stringify(app.handle({ method: 'GET', path: '/admin/users', user: member }).body), JSON.stringify({ error: '没有权限' }));
for (const r of results) console.log('FAIL', r);
assert.equal(results.length, 0, `${results.length} 条不对`);
console.log('ok');
