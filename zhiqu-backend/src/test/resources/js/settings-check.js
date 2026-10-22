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

  // ── 第七十五轮：样子交给样式表，这里钉画出来的东西 ──────────────────────
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // 壳给模块的那几样（zqShared）：转义、日期、图标
  const fake = { esc, fmtDate: (d) => d, icon: (n) => '<svg data-i="' + n + '"></svg>' };
  // 探测状态的颜色只给 data-state（通过 ok、失败 bad、其余淡色），先判 UNSUPPORT
  judge('探测状态的颜色：通过 ok、失败 bad、不支持 / 未测试 muted',
    m.probeState('VERIFIED') === 'ok' && m.probeState('FAILED') === 'bad' && m.probeState('UNSUPPORTED') === 'muted' && m.probeState('UNTESTED') === 'muted' && m.probeState('') === 'muted',
    ['VERIFIED', 'FAILED', 'UNSUPPORTED', 'UNTESTED', ''].map(m.probeState));

  // 开关只设 aria-checked（原来 JS 改滑块的 left 和底色；深色下打开时白底白钮）
  const sw = { attrs: {}, style: {}, firstElementChild: { style: {} }, dataset: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } };
  m.setToggle(sw, true);
  judge('开关打开：aria-checked="true"，不碰 style', sw.attrs['aria-checked'] === 'true' && !Object.keys(sw.style).length && !Object.keys(sw.firstElementChild.style).length, sw);
  m.setToggle(sw, false);
  judge('开关关上：aria-checked="false"', sw.attrs['aria-checked'] === 'false', sw.attrs);

  // 分栏的键盘：← ↑ 上一栏、→ ↓ 下一栏、到头绕回、Home / End，别的键不管
  judge('→ / ↓ 下一栏', m.tabAfterKey('ArrowRight', 'profile') === 'models' && m.tabAfterKey('ArrowDown', 'models') === 'reminders');
  judge('← / ↑ 上一栏', m.tabAfterKey('ArrowLeft', 'models') === 'profile' && m.tabAfterKey('ArrowUp', 'reminders') === 'models');
  judge('到头绕回去', m.tabAfterKey('ArrowRight', 'security') === 'profile' && m.tabAfterKey('ArrowLeft', 'profile') === 'security',
    [m.tabAfterKey('ArrowRight', 'security'), m.tabAfterKey('ArrowLeft', 'profile')]);
  judge('Home / End', m.tabAfterKey('Home', 'cli') === 'profile' && m.tabAfterKey('End', 'models') === 'security');
  judge('别的键（回车、Tab、字母）不归分栏管', m.tabAfterKey('Enter', 'models') === null && m.tabAfterKey('Tab', 'models') === null && m.tabAfterKey('a', 'models') === null);

  // 模型卡片
  const mine = m.modelCard(fake, { id: 7, ownerType: 'USER', displayName: '本地 Ollama', label: '本地 Ollama（我的）', modelName: 'qwen2.5:7b', providerType: 'OLLAMA',
    capabilityProbeStatus: 'VERIFIED', visionStatus: 'UNSUPPORTED', reasoningStatus: 'FAILED' });
  judge('卡片标题是名字本身（label 带着「（我的）」，右边的徽章已经说了）', mine.includes('>本地 Ollama</div>') && !mine.includes('（我的）') && mine.includes('<span class="zq-badge">我的</span>'), mine);
  judge('Provider 写人话（和表单下拉同一份表），不写代码 OLLAMA', mine.includes('>Ollama 本地模型</strong>') && !mine.includes('>OLLAMA<'), mine);
  judge('四格的颜色是 data-state，不是内联颜色', mine.includes('data-state="ok">通过') && mine.includes('data-state="muted">不支持') && mine.includes('data-state="bad">失败') && !mine.includes('style='), mine);
  judge('没存 Key 写「没有保存 Key」（原来「Key：—」）', mine.includes('没有保存 Key') && !mine.includes('Key：—'), mine);
  judge('我的模型：编辑、测试连通、能力测试、删除', ['data-model-edit="7"', 'data-model-test="7"', 'data-model-probe="7"', 'data-model-del="7"'].every((x) => mine.includes(x)), mine);
  const sys = m.modelCard(fake, { id: 3, ownerType: 'SYSTEM', displayName: '系统默认', modelName: 'x', providerType: 'OPENAI_COMPATIBLE', apiKeyMasked: '****1234' });
  judge('系统模型：没有编辑和删除，徽章写「系统」，Key 照写', !sys.includes('data-model-edit') && !sys.includes('data-model-del') && sys.includes('>系统</span>') && sys.includes('Key：****1234'), sys);
  judge('名字里的尖括号被转义', m.modelCard(fake, { id: 1, displayName: '<img src=x>', modelName: 'y' }).includes('&lt;img src=x&gt;'));
  judge('认不出的 Provider 照原样写，没有写 —', m.providerName('FOO') === 'FOO' && m.providerName('') === '—' && m.providerName('anthropic') === 'Anthropic Claude');

  // 模型表单在添加还是在改哪一个
  const form = { title: { textContent: '' }, save: { textContent: '' }, cancel: { hidden: false } };
  m.paintFormMode(form, { displayName: 'DeepSeek', label: 'DeepSeek（我的）' });
  judge('编辑时：标题「编辑：名字」、保存按钮「保存修改」、露出「取消编辑」', form.title.textContent === '编辑：DeepSeek' && form.save.textContent === '保存修改' && form.cancel.hidden === false, form);
  m.paintFormMode(form, null);
  judge('不编辑时：「添加模型」「保存模型」、藏起「取消编辑」', form.title.textContent === '添加模型' && form.save.textContent === '保存模型' && form.cancel.hidden === true, form);

  // 成就卡片
  const got = m.achievementCard(fake, { name: '初次登录', description: '首次登录系统', points: 10, unlockedAt: '2026-10-19T06:00:00' });
  const todo = m.achievementCard(fake, { name: '第一颗番茄', description: '完成 1 次专注', points: 15 });
  judge('解锁了的：is-on、写「已解锁」、点数', got.includes('class="zq-ach is-on"') && got.includes('<span>已解锁</span>') && got.includes('+10 点'), got);
  judge('没解锁的：写「未解锁」（和筛选的说法一样，原来是「进行中」），没有 is-on', todo.includes('<span>未解锁</span>') && !todo.includes('is-on') && !todo.includes('进行中'), todo);
  judge('成就卡片没有内联样式', !got.includes('style=') && !todo.includes('style='));

  console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
