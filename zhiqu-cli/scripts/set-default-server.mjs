#!/usr/bin/env node
// 设置发布版默认连哪台服务器：npm run set-server -- https://你的域名
// 写进 package.json 的 zhiqu.defaultServer。仓库里平时是本机桌面应用（http://127.0.0.1:47615），方便测试。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../package.json', import.meta.url));
const url = String(process.argv[2] || '').trim().replace(/\/+$/, '');
if (!/^https?:\/\/[^/\s]+$/i.test(url)) {
  console.error('用法：npm run set-server -- https://你的服务器地址（只写协议和主机，可以带端口，不要带路径）');
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.zhiqu = { ...(pkg.zhiqu || {}), defaultServer: url };
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`默认服务器已设为 ${url}`);
