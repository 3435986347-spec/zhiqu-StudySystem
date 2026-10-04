// 设置 / 成就弹窗的地址（第三十轮）—— 直接 import 发布的 assets/settings.js，不从源码里抠。
//
//   用法：node src/test/resources/js/settings-check.js <settings.js 的路径> <服务器给命令行的 verifyPath，设备码换成 ABCD-EFGH>
//   第二个参数是 DeviceLoginService 里真写着的那个地址 —— 判的是「服务器给命令行的链接」和「页面认得的地址」这一对，
//   不是两边各写死一份样本各自为绿。由 SettingsDialogTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const path = require('path');
const { pathToFileURL } = require('url');
const verifyPath = process.argv[3];
if (!verifyPath) throw new Error('缺第二个参数：服务器给命令行的 verifyPath');

(async () => {
  const m = await import(pathToFileURL(path.resolve(process.argv[2])).href);
  let fail = 0;
  function judge(name, cond, detail) {
    if (cond) console.log('  PASS  ' + name);
    else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); fail++; }
  }
  const p = m.parseZqHash;

  // 分栏
  const tabs = m.SETTINGS_TABS.map((t) => t[0]);
  judge('五栏：个人资料、AI 模型、提醒、命令行、账号与安全', JSON.stringify(tabs) === JSON.stringify(['profile', 'models', 'reminders', 'cli', 'security']), tabs);
  for (const t of tabs) judge('#settings/' + t + ' 打开那一栏', p('#settings/' + t).kind === 'settings' && p('#settings/' + t).tab === t, p('#settings/' + t));
  judge('#settings 没写哪一栏 → 第一栏', p('#settings').tab === 'profile', p('#settings'));
  judge('认不出的栏 → 第一栏（不是什么都不开）', p('#settings/nope').tab === 'profile', p('#settings/nope'));
  judge('#achievements 是成就', p('#achievements').kind === 'achievements', p('#achievements'));

  // 带参数（命令行那一栏的设备码）
  const cli = p('#settings/cli?harness=ABCD-EFGH');
  judge('#settings/cli?harness=… 带出设备码', cli.tab === 'cli' && cli.params.harness === 'ABCD-EFGH', cli);
  judge('参数解码', p('#settings/cli?harness=AB%2DCD').params.harness === 'AB-CD', p('#settings/cli?harness=AB%2DCD'));
  let threw = null;
  try { p('#settings/cli?harness=%E0%A4%A'); } catch (e) { threw = e; }
  judge('坏的百分号编码不抛（那一项不要）', threw === null && p('#settings/cli?harness=%E0%A4%A').tab === 'cli', threw && threw.message);

  // 不归它管的 hash
  for (const h of ['', '#', '#x', '#settingsx', '#achievements/x', '#Settings/models', 'settings', 'xsettings/models', '/achievements', '#wiki-page-3']) {
    judge('「' + h + '」不是弹窗的地址', p(h) === null, p(h));
  }

  // 旧地址
  judge('profile.html → 设置的第一栏', m.legacyHash('profile.html', '') === '#settings/profile', m.legacyHash('profile.html', ''));
  judge('profile.html#harness=… → 命令行那一栏并带上码（小写的转大写）',
    m.legacyHash('profile.html', '#harness=abcd-efgh') === '#settings/cli?harness=ABCD-EFGH', m.legacyHash('profile.html', '#harness=abcd-efgh'));
  judge('profile.html#harness=<别的东西> 不带过去', m.legacyHash('profile.html', '#harness=<b>x</b>') === '#settings/profile', m.legacyHash('profile.html', '#harness=<b>x</b>'));
  judge('achievement.html → 成就', m.legacyHash('achievement.html', '#whatever') === '#achievements', m.legacyHash('achievement.html', '#whatever'));
  const back = p(m.legacyHash('profile.html', '#harness=abcd-efgh'));
  judge('换过去的地址自己认得', back && back.tab === 'cli' && back.params.harness === 'ABCD-EFGH', back);

  // 服务器给命令行的链接
  const at = verifyPath.indexOf('#');
  const page = verifyPath.slice(0, at);
  const fromServer = p(verifyPath.slice(at));
  judge('verifyPath 指向首页（' + page + '）', /^\/[a-z-]+\.html$/.test(page), page);
  judge('verifyPath 打开命令行那一栏并带上设备码', fromServer && fromServer.tab === 'cli' && fromServer.params.harness === 'ABCD-EFGH', fromServer);

  // 探测状态的说法（模型卡片上那几格）：先判 UNSUPPORT，否则被 SUPPORT 误吞
  judge('UNSUPPORTED → 不支持', m.probeText('UNSUPPORTED') === '不支持', m.probeText('UNSUPPORTED'));
  judge('VERIFIED → 通过', m.probeText('VERIFIED') === '通过', m.probeText('VERIFIED'));
  judge('UNTESTED / 空 → 未测试', m.probeText('UNTESTED') === '未测试' && m.probeText('') === '未测试');
  judge('FAILED → 失败', m.probeText('FAILED') === '失败', m.probeText('FAILED'));

  console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
