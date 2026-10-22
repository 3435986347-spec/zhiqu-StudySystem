// 默认连的是本机桌面应用、而它没开：macOS 上替用户把应用打开、等它起来（第十二轮）。
//
// 用户 2026-09-28 贴的记录里，第一次敲 zhiqu 直接「连不上服务器 http://127.0.0.1:47615（连接被拒绝…）」，还报了两遍，
// 然后用户去试「知趣」这个命令（没有）、再回来重敲。桌面应用就在这台机器上，命令行完全可以自己把它打开。
// 只在三件事都成立时这么做：连的是本机桌面应用的地址（回环 + 47615）、连接被拒（没在跑，不是别的错）、是 macOS。
import { spawn } from 'node:child_process';
import { isLoopbackUrl, LOCAL_DESKTOP_SERVER } from './defaults.js';
import { sleep } from './http.js';
import { monotonic } from './clock.js';

export const BUNDLE_ID = 'com.zhiqu.quadrant';
const DESKTOP_PORT = new URL(LOCAL_DESKTOP_SERVER).port;

function isDesktopServer(server) {
  try {
    return isLoopbackUrl(server) && new URL(server).port === DESKTOP_PORT;
  } catch {
    return false;
  }
}

const isRefused = (e) => Boolean(e && e.code === 'ECONNREFUSED');

/** `open -g -b`：按 bundle id 打开，-g 不抢终端的焦点。装了返回 true。 */
export function launchApp() {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/open', ['-g', '-b', BUNDLE_ID], { stdio: 'ignore' });
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

/**
 * 返回 'ok'（连得上 / 打开之后连上了）、'skip'（不归这里管，交给后面照常报错）、'failed'（打开不了或等不到，已经说过原因）。
 */
export async function ensureLocalServer({ api, server, ui, platform = process.platform, launch = launchApp, wait = sleep, timeoutMs = 40_000 }) {
  if (!isDesktopServer(server) || platform !== 'darwin') return 'skip';
  const probe = async () => {
    try {
      await api.get('/api/harness/meta', { retry: false, timeoutMs: 3000 });
      return 'up';
    } catch (e) {
      return isRefused(e) ? 'down' : 'other';
    }
  };
  const first = await probe();
  if (first === 'up') return 'ok';
  if (first === 'other') return 'skip';
  ui.note('· 知趣象限桌面应用没开，正在打开它（第一次打开要几秒）…');
  if (!(await launch())) {
    ui.error('没找到知趣象限应用：先安装它（打开 dmg、拖进「应用程序」），或者用 --server 连你自己的服务器');
    return 'failed';
  }
  const deadline = monotonic() + timeoutMs;
  while (monotonic() < deadline) {
    await wait(500);
    const now = await probe();
    if (now === 'up') {
      ui.note('· 桌面应用起来了');
      return 'ok';
    }
    if (now === 'other') return 'skip';
  }
  ui.error(`等了 ${Math.round(timeoutMs / 1000)} 秒桌面应用还没起来：看一眼它的窗口有没有报错（比如连不上数据库），好了再运行 zhiqu`);
  return 'failed';
}
