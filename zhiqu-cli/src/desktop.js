// 连的是本机桌面应用的地址（127.0.0.1:47615）、却连不上。
//
// 第十二轮起：macOS 上替用户把应用打开、等它起来（用户 2026-09-28 贴的记录里，第一次敲 zhiqu 直接「连不上服务器
// http://127.0.0.1:47615」，还报了两遍）。第一百二十五轮起 macOS 桌面版不再带后端：窗口里打开的就是网站
// （docs/desktop-remote-plan.md），本机 47615 上什么都没有 —— 再替用户打开应用只会白等 40 秒、最后说「还没起来」。
// 现在直接说清楚、给出换过去的命令。Windows 版还带着后端，这里从来不管它（照原样报「连不上」）。
import { isLoopbackUrl, LOCAL_DESKTOP_SERVER, packageDefaultServer } from './defaults.js';

const DESKTOP_PORT = new URL(LOCAL_DESKTOP_SERVER).port;

function isDesktopServer(server) {
  try {
    return isLoopbackUrl(server) && new URL(server).port === DESKTOP_PORT;
  } catch {
    return false;
  }
}

const isRefused = (e) => Boolean(e && e.code === 'ECONNREFUSED');

/**
 * 返回 'ok'（连得上：比如旧版桌面应用还开着）、'skip'（不归这里管，交给后面照常报错）、'failed'（已经说过原因）。
 */
export async function ensureLocalServer({ api, server, ui, platform = process.platform, website = packageDefaultServer() }) {
  if (!isDesktopServer(server) || platform !== 'darwin') return 'skip';
  try {
    await api.get('/api/harness/meta', { retry: false, timeoutMs: 3000 });
    return 'ok';
  } catch (e) {
    if (!isRefused(e)) return 'skip';
  }
  ui.error(`连不上本机的 ${server}：Mac 上的知趣象限桌面应用现在打开的就是网站、不在本机跑后端了。`
    + (isLoopbackUrl(website) ? '' : `换到网站：zhiqu login --server ${website}`));
  return 'failed';
}
