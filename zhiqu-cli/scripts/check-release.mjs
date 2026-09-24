#!/usr/bin/env node
// 发布前的检查（npm publish 会先跑 prepublishOnly）。用户 2026-09-24 定的：
//   测试时默认连本机桌面应用，发布的那一版要改成指向服务器 —— 桌面应用没开的时候命令行也得能用。
// 所以默认地址还是本机时，发不出去。不是 https 也发不出去：个人访问令牌走明文 HTTP 过公网，等于交给路上的任何人。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseProblems } from '../src/defaults.js';

const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const problems = releaseProblems(pkg);
if (problems.length) {
  console.error('不能发布：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`发布检查通过：默认服务器 ${pkg.zhiqu.defaultServer}`);
