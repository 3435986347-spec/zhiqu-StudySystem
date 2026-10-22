import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const VERSION = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
// 「ZhiquCLI」开头：网页的登录设备列表认这个前缀，显示成「命令行」（LoginDeviceLabelTest 钉着前端那一侧）
export const USER_AGENT = `ZhiquCLI/${VERSION} (npm; ${process.platform}; node ${process.versions.node})`;
