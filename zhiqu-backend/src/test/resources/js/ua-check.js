// 登录设备列表的 User-Agent 解析（shortUA）—— 直接跑 assets/zhiqu-api.js 里发布的那份实现。
//
//   用法：node src/test/resources/js/ua-check.js <zhiqu-api.js 的路径> <CLI 真实发出的 UA>
//   第二个参数由 LoginDeviceLabelTest 从 ZhiquCli.userAgent() 取来 —— 判的是
//   「命令行发什么」和「前端认什么」这一对，不是两边各写死一份样本各自为绿。
//
// 由来：桌面应用那一支（ZhiquDesktop）上线时没有任何判据；它内嵌的是系统 WebView，
// UA 与 Safari 一模一样，顺序一错就显示成「Safari · macOS」—— 用户报过一次。
// 命令行那一支同理：UA 里没有任何浏览器标记，不认就落到「浏览器」。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const cliUa = process.argv[3];
if (!cliUa) throw new Error('缺第二个参数：CLI 真实发出的 User-Agent');

const a = src.indexOf('function shortUA(ua) {');
const b = src.indexOf('var MODEL_PROVIDERS', a);
if (a < 0 || b < 0) throw new Error('抠不到 shortUA');
const shortUA = new Function(src.slice(a, b) + '\nreturn shortUA;')();

let fail = 0;
function judge(name, got, want) {
  if (got === want) console.log('  PASS  ' + name + '  →  ' + got);
  else { console.log('  FAIL  ' + name + '  →  得到「' + got + '」，应为「' + want + '」'); fail++; }
}

const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

judge('命令行（ZhiquCli.userAgent 的真实值）', shortUA(cliUa), '命令行 · macOS');
judge('桌面应用（WKWebView + ZhiquDesktop 标记）', shortUA(SAFARI_MAC + ' ZhiquDesktop/1.0'), '桌面应用 · macOS');
judge('普通 Safari 仍是 Safari', shortUA(SAFARI_MAC), 'Safari · macOS');
judge('Windows 上的 Chrome', shortUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'), 'Chrome · Windows');

console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
