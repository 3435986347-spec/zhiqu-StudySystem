// 设置弹窗与成就弹窗（第三十轮，用户 2026-10-04 定的：点左下角头像向上弹菜单，设置是 Claude 那样的弹窗）。
//
// 这是第一个从 zhiqu-api.js 拆出来的原生 ES 模块（docs/product-plan.md 第 4 步）：壳在第一次打开弹窗时 import() 它，平时不加载。
// 它不碰壳的内部，用到的共用功能都从 sh 来（壳的 zqShared：请求、提示、转义、弹窗、当前用户、提醒渠道的规矩……）。
// 查 DOM 一律限在弹窗里（root）—— 弹窗和底下的页面同时在。
//
// 这里的代码是从原来的个人中心页（bootProfile、wireCliLogin、模型配置、提醒渠道）和成就页**挪过来**的，不是重写：
// 原来的注释（为什么脱敏值不填进输入框、为什么令牌要刷几次……）都跟着，那些是踩过的坑。
// 原来按位置找元素（「第 2 个 input」「含『基本资料』的 section」）的地方改成了 id：模板现在就在这个文件里，不用再猜页面长什么样。
// 弹窗不在 .zq-main 里，正文那两条手机规则（按 style 属性认的）管不到这里：多栏的地方带 zq-phone-1col / zq-phone-2col，
// 手机上怎么排写在类名上（MobileLayoutTest 核对它和样式表一致）。第七十五轮起这里不写内联样式，样子都在 zhiqu-ui.css（SettingsLookTest）。

/** 设置的分栏：[地址里的名字, 显示的名字]。 */
export const SETTINGS_TABS = [
  ['profile', '个人资料'],
  ['models', 'AI 模型'],
  ['reminders', '提醒'],
  ['cli', '命令行'],
  ['security', '账号与安全']
];

/**
 * 地址里的弹窗：`#settings/models`、`#settings/cli?harness=ABCD-EFGH`、`#achievements`。
 * 认不出的分栏回落到第一栏；不是这两种就返回 null（不归这里管的 hash）。
 */
export function parseZqHash(hash) {
  hash = String(hash || '');
  if (hash.charAt(0) !== '#') return null;   // 和壳的 isDialogHash 同一个认法：location.hash 总带 #
  const raw = hash.slice(1);
  if (raw === 'achievements') return { kind: 'achievements' };
  const m = /^settings(?:\/([a-z]+))?(?:\?(.*))?$/.exec(raw);
  if (!m) return null;
  const tab = SETTINGS_TABS.some((t) => t[0] === m[1]) ? m[1] : SETTINGS_TABS[0][0];
  const params = {};
  for (const pair of String(m[2] || '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    try {
      params[decodeURIComponent(i < 0 ? pair : pair.slice(0, i))] = decodeURIComponent(i < 0 ? '' : pair.slice(i + 1));
    } catch (e) { /* 坏的百分号编码：这一项不要 */ }
  }
  return { kind: 'settings', tab, params };
}

/**
 * 旧地址换成新的（书签、历史记录、命令行打印过的链接）：
 * `profile.html#harness=X` → `#settings/cli?harness=X`；`profile.html` → `#settings/profile`；`achievement.html` → `#achievements`。
 */
export function legacyHash(page, hash) {
  if (page === 'achievement.html') return '#achievements';
  const m = /[#&]harness=([A-Za-z0-9-]{8,9})/.exec(String(hash || ''));
  return m ? '#settings/cli?harness=' + m[1].toUpperCase() : '#settings/profile';
}

/** 登录设备那一列：从 User-Agent 认出「桌面应用 · macOS」「Chrome · Windows」这样的说法。 */
export function shortUA(ua) {
  ua = String(ua || '');
  var os = /Windows/.test(ua) ? 'Windows' : /Mac OS|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  // 桌面应用要先判：它内嵌的是系统 WebView，UA 和 Safari 长得一模一样，
  // 先走下面的浏览器分支就会把「从应用登录」显示成「Safari · macOS」。
  // 标记由原生外壳用 applicationNameForUserAgent 追加（ZhiquShell.swift）。
  if (/ZhiquDesktop/.test(ua)) return '桌面应用' + (os ? ' · ' + os : '');
  // Java 版 zhiqu 命令行的 UA（2026-10-04 删除；历史登录记录里还有）：UA 里没有任何浏览器标记，不认的话落到「浏览器」
  if (/ZhiquCLI\//.test(ua)) return '命令行' + (os ? ' · ' + os : '');
  var br = /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '浏览器';
  return (br + (os ? ' · ' + os : '')) || ua.slice(0, 40);
}

// 后端实际取值：VERIFIED / FAILED / UNSUPPORTED / UNTESTED。注意先判 UNSUPPORT，否则会被 SUPPORT 误吞
export function probeText(s) { s = String(s || '').toUpperCase(); if (!s || s === 'UNTESTED') return '未测试'; if (/UNSUPPORT|NOT_SUPPORT|\bNO\b|FALSE/.test(s)) return '不支持'; if (/VERIFIED|PASS|OK|SUCCESS|SUPPORT|YES|TRUE/.test(s)) return '通过'; if (/FAIL|ERROR/.test(s)) return '失败'; if (/PROB|TESTING|RUNNING/.test(s)) return '测试中'; return s; }
/** 探测状态的颜色交给样式表（data-state）：通过 ok、失败 bad，其余（不支持、未测试、测试中）淡色 */
export function probeState(s) { s = String(s || '').toUpperCase(); if (/UNSUPPORT|NOT_SUPPORT/.test(s)) return 'muted'; if (/VERIFIED|PASS|OK|SUCCESS|SUPPORT|YES|TRUE/.test(s)) return 'ok'; if (/FAIL|ERROR/.test(s)) return 'bad'; return 'muted'; }

/**
 * 开关（原来叫 setMorningToggle：提醒推送、让 AI 读我的任务共用）。只设 aria-checked，样子在样式表（.zq-switch）——
 * 原来 JS 改滑块的 left 和底色，深色下打开时是白底配白钮，看不出开没开（第七十五轮）。
 */
export function setToggle(btn, on) {
  btn.setAttribute('aria-checked', on ? 'true' : 'false');
}
/** 开关现在是不是开着（点了之后要切到的是它的反面） */
function toggleOn(btn) { return btn.getAttribute('aria-checked') === 'true'; }

// ── 各栏的样子（原来个人中心页里的那几块，设计稿的示例值去掉了） ──────────────

// 第七十五轮起各栏的样子都在样式表（.zq-set-* / .zq-switch，zhiqu-ui.css 的「设置弹窗」那一段）：原来 76 处内联样式，开关和状态的颜色是 JS 改 style。
const TOGGLE = (id, label) => '<button id="' + id + '" type="button" role="switch" aria-checked="false" class="zq-switch"' + (label ? ' aria-label="' + label + '"' : '') + '><i></i></button>';
const H3 = (t) => '<h3 class="zq-set-h3">' + t + '</h3>';
/** 一个字段：标签用 for 指向输入框（从输入框的 id 取），wide 时占满一行 */
const FIELD = (label, input, wide) => {
  const id = /\bid="([^"]+)"/.exec(input);
  return '<div class="zq-field' + (wide ? ' is-wide' : '') + '"><label class="zq-label"' + (id ? ' for="' + id[1] + '"' : '') + '>' + label + '</label>' + input + '</div>';
};
/** 模型的 Provider：[接口里的代码, 给人看的名字]。表单的下拉和卡片上那一格用同一份（原来卡片上写的是代码 OPENAI_COMPATIBLE） */
export const MODEL_PROVIDERS = [['OPENAI_COMPATIBLE', 'OpenAI 兼容'], ['ANTHROPIC', 'Anthropic Claude'], ['OLLAMA', 'Ollama 本地模型'], ['VLLM', 'vLLM'], ['GEMINI', 'Google Gemini']];
export function providerName(code) {
  const hit = MODEL_PROVIDERS.find((p) => p[0] === String(code || '').toUpperCase());
  return hit ? hit[1] : (code || '—');
}

/** 一张模型卡片：名字本身（label 带着「（我的）」，右边的徽章已经说了）、Provider 写人话、四格探测状态、Key */
export function modelCard(sh, m) {
  const mine = m.ownerType !== 'SYSTEM';
  const tile = (k, v, state) => '<div class="zq-set-tile"><span>' + sh.esc(k) + '</span><strong' + (state ? ' data-state="' + state + '"' : '') + '>' + sh.esc(v) + '</strong></div>';
  const key = m.apiKeyMasked || m.maskedApiKey;
  const id = sh.esc(m.id);
  return '<article class="zq-set-model"><div class="zq-set-model-head"><div class="zq-set-model-who">'
    + '<div class="zq-set-model-name">' + sh.esc(m.displayName || m.label || m.name || m.modelName || '模型') + '</div>'
    + '<div class="zq-set-model-id zq-mono">' + sh.esc(m.modelName || '') + '</div></div>'
    + '<span class="zq-badge">' + (mine ? '我的' : '系统') + '</span></div>'
    + '<div class="zq-set-tiles zq-phone-2col">'
    + tile('Provider', providerName(m.providerType), '')
    + tile('连通性', probeText(m.capabilityProbeStatus), probeState(m.capabilityProbeStatus))
    + tile('视觉', probeText(m.visionStatus), probeState(m.visionStatus))
    + tile('深度思考', probeText(m.reasoningStatus), probeState(m.reasoningStatus))
    + '</div>'
    + '<div class="zq-set-model-meta">' + (key ? 'Key：' + sh.esc(key) : '没有保存 Key') + (m.lastProbeAt ? ' · 上次探测 ' + sh.esc(sh.fmtDate(m.lastProbeAt)) : '') + '</div>'
    + '<div class="zq-set-model-acts">' + (mine ? '<button type="button" class="zq-btn-ghost zq-sm" data-model-edit="' + id + '">编辑</button>' : '')
    + '<button type="button" class="zq-btn-ghost zq-sm" data-model-test="' + id + '">测试连通</button>'
    + '<button type="button" class="zq-btn-ghost zq-sm" data-model-probe="' + id + '">能力测试</button>'
    + (mine ? '<button type="button" class="zq-btn-ghost zq-sm" data-model-del="' + id + '">删除</button>' : '') + '</div></article>';
}

/** 模型表单在添加还是在改哪一个：标题、保存按钮的字、「取消编辑」出不出现（原来改的时候只弹一下提示，「新建模型」按钮其实是「不改了」） */
export function paintFormMode(els, m) {
  els.title.textContent = m ? '编辑：' + (m.displayName || m.label || m.modelName || '模型') : '添加模型';
  els.save.textContent = m ? '保存修改' : '保存模型';
  els.cancel.hidden = !m;
}

const PANES = {
  profile: () => ''
    + '<div class="zq-set-profile">'
    + '<button id="zq-set-avatar" type="button" class="zq-set-avatar" title="点击更换头像" aria-label="更换头像"></button>'
    + '<div class="zq-set-who"><h2 id="zq-set-name" class="zq-h2"></h2><span id="zq-set-role" class="zq-badge"></span></div>'
    + '<div class="zq-set-nums">'
    + '<div><strong id="zq-set-days" class="zq-num">—</strong><span>连续天数</span></div>'
    + '<div><strong id="zq-set-done" class="zq-num">—</strong><span>完成任务</span></div>'
    // 原来写着「本月时长」，显示的却是 totalStudyMinutes（全部的累计）
    + '<div><strong id="zq-set-hours" class="zq-num">—</strong><span>累计专注</span></div>'
    + '</div></div>'
    + '<div class="zq-set-grid zq-phone-1col">'
    + FIELD('用户名', '<input id="zq-set-username" class="zq-input" readonly>')
    + FIELD('昵称', '<input id="zq-set-nickname" class="zq-input">')
    + FIELD('单位 / 学校', '<input id="zq-set-school" class="zq-input">')
    + FIELD('部门 / 职位', '<input id="zq-set-major" class="zq-input">')
    + FIELD('邮箱', '<input id="zq-set-email" class="zq-input" type="email">', true)
    + '</div><div class="zq-set-actions"><button id="zq-set-save" class="zq-btn">保存资料</button></div>',

  models: () => ''
    + '<p class="zq-set-callout">API Key 加密存储；监管后台不会显示你的完整 Key、知识库正文或任务正文。</p>'
    // 第二十七轮：AI 读不读得到你的任务（用户定的「让它读，给一个开关」；默认开）。说清楚打开时什么会发给谁。
    + '<div class="zq-set-row"><span class="zq-set-row-text"><b>让 AI 读我的任务</b>：问到今天、这周怎么安排时，AI 先看一眼你没完成的任务（标题、时间、象限）再回答。打开时，这些内容会发给你配置的模型供应商。</span>'
    + TOGGLE('zq-ai-read-tasks', '让 AI 读我的任务') + '</div>'
    + '<div id="zq-models" class="zq-set-models"></div>'
    + '<div id="zq-model-form" class="zq-set-form">'
    // 表单在新建还是在改哪一个，写在标题上（原来只弹一下提示，表单本身看不出来）
    + '<h3 id="zq-model-form-title" class="zq-set-h3">添加模型</h3>'
    + FIELD('显示名称', '<input id="zq-model-display" class="zq-input" placeholder="例如 Claude Sonnet / DeepSeek / 本地 Ollama">')
    + '<div class="zq-set-grid zq-phone-1col">'
    + FIELD('Provider', '<select id="zq-model-provider" class="zq-select">' + MODEL_PROVIDERS.map((p) => '<option value="' + p[0] + '">' + p[1] + '</option>').join('') + '</select>')
    + FIELD('模型名称', '<input id="zq-model-name" class="zq-input" placeholder="gpt-4o-mini / claude-3-5-sonnet">')
    + '</div>'
    + FIELD('API 接口地址', '<input id="zq-model-url" class="zq-input" placeholder="https://api.openai.com/v1/chat/completions"><span class="zq-set-hint">Anthropic 用 /v1/messages；Ollama 默认 http://localhost:11434/v1/chat/completions。</span>')
    + FIELD('API Key', '<input id="zq-model-key" class="zq-input" type="password" placeholder="留空则不修改已保存 Key">')
    + FIELD('上下文窗口（token，可选）', '<input id="zq-model-context" class="zq-input" type="number" min="8000" max="1000000" step="1000" placeholder="按模型实际能力填，例如 128000；最多 1000000。留空用保守默认值"><span class="zq-set-hint">填了之后，对话历史、代码和 Wiki 资料都按它放大。填得越大，长对话每一轮带给模型的内容越多 —— 也越耗 token、越慢；超过模型真实上限，请求会被服务商拒绝。</span>')
    + '<div class="zq-set-box"><strong>模型能力由系统测试确认</strong><span>保存后可进行连通性、图像识别（多模态）、深度思考探测，会消耗少量 token。</span></div>'
    + '<div class="zq-set-btns"><button id="zq-model-save" class="zq-btn">保存模型</button><button id="zq-model-cancel" type="button" class="zq-btn-ghost" hidden>取消编辑</button></div>'
    + '</div>',

  reminders: () => ''
    + '<div class="zq-set-row"><span class="zq-set-row-text"><b>提醒推送</b>：打开后，任务的提醒时间、截止前提醒和每天 08:00 的待办汇总都推送到下面的渠道</span>'
    + TOGGLE('zq-morning', '提醒推送') + '</div>'
    // 渠道配置。原来这里写死着一行「渠道：PushPlus · 已绑定」，而用户没有任何途径填凭据（见 bindReminders 的注释）
    + '<div class="zq-set-channel">'
    + '<div class="zq-set-inline"><label class="zq-label" for="zq-rm-channel">推送渠道</label>'
    + '<select id="zq-rm-channel" class="zq-select"><option value="PUSHPLUS">PushPlus</option><option value="WECOM">企业微信机器人</option><option value="QQ">QQ 机器人</option></select></div>'
    // 只显示选中的那个渠道的字段：用 hidden（第七十五轮之前内联着 display，只能 JS 改 style.display）
    + '<div data-rm-group="PUSHPLUS" class="zq-set-group"><input id="zq-rm-pushplus" class="zq-input" type="password" autocomplete="off" placeholder="PushPlus token" aria-label="PushPlus token"></div>'
    + '<div data-rm-group="WECOM" class="zq-set-group" hidden><input id="zq-rm-webhook" class="zq-input" type="password" autocomplete="off" placeholder="企业微信机器人 Webhook 地址" aria-label="企业微信机器人 Webhook 地址"></div>'
    + '<div data-rm-group="QQ" class="zq-set-group" hidden><input id="zq-rm-qq-appid" class="zq-input" autocomplete="off" placeholder="QQ 机器人 AppID" aria-label="QQ 机器人 AppID">'
    + '<input id="zq-rm-qq-secret" class="zq-input" type="password" autocomplete="off" placeholder="AppSecret" aria-label="QQ 机器人 AppSecret">'
    + '<input id="zq-rm-qq-group" class="zq-input" autocomplete="off" placeholder="群 openid" aria-label="QQ 群 openid"></div>'
    + '<div class="zq-set-btns"><button id="zq-rm-save" class="zq-btn zq-sm">保存渠道</button>'
    + '<button id="zq-rm-test" class="zq-btn-ghost zq-sm">发送测试</button><span id="zq-rm-status" class="zq-set-status" role="status"></span></div>'
    + '</div>',

  cli: () => ''
    + H3('命令行登录')
    + '<p class="zq-set-note">在终端运行 <span class="zq-mono">zhiqu login</span>，把它显示的 8 位设备码填在这里。命令行不会拿到你的密码，只拿到一张可随时撤销的令牌。'
    + '登录之后，<span class="zq-mono">zhiqu mcp</span> 还能让 Claude Code、Cursor 这些 MCP 客户端读写你的知识 Wiki 和任务。</p>'
    + '<div class="zq-set-code"><input id="zq-cli-code" class="zq-input" autocomplete="off" placeholder="设备码，如 ABCD-EFGH" aria-label="设备码">'
    + '<button id="zq-cli-check" class="zq-btn-ghost zq-sm">查看</button></div>'
    + '<div id="zq-cli-device" class="zq-set-device"></div>'
    + '<section class="zq-set-section">' + H3('已登录的命令行') + '<div id="zq-cli-tokens" class="zq-set-list"></div></section>',

  security: () => ''
    + H3('修改密码')
    + '<div class="zq-set-stack">'
    + '<input id="zq-pw-old" class="zq-input" type="password" autocomplete="current-password" placeholder="当前密码" aria-label="当前密码">'
    + '<input id="zq-pw-new" class="zq-input" type="password" autocomplete="new-password" placeholder="新密码（至少 6 位）" aria-label="新密码">'
    + '<input id="zq-pw-again" class="zq-input" type="password" autocomplete="new-password" placeholder="确认新密码" aria-label="确认新密码">'
    + '<button id="zq-pw-save" class="zq-btn">更新密码</button></div>'
    + '<section class="zq-set-section">' + H3('最近登录') + '<div class="zq-set-kv">'
    + '<div><span>时间与地址</span><span id="zq-sec-latest">—</span></div>'
    + '<div><span>登录设备</span><span id="zq-sec-device">—</span></div>'
    + '<div><span>退出登录</span><button id="zq-sec-logout" type="button" class="zq-btn-ghost zq-btn-xs">退出</button></div>'
    + '</div></section>'
};

// ── 各栏接上数据 ──────────────────────────────────────────────

function bindProfile(sh, root) {
  var $ = (s) => root.querySelector(s);
  var u = sh.state.user || {};
  var av = $('#zq-set-avatar');
  var paintAvatar = function () {
    // 与侧边栏保持一致：有头像显示头像，否则显示昵称首字
    av.innerHTML = sh.state.user && sh.state.user.avatar
      ? '<img src="' + sh.esc(sh.state.user.avatar) + '" alt="">'
      : sh.esc((u.nickname || u.username || '知').slice(0, 1));
  };
  paintAvatar();
  av.onclick = function () {
    sh.pickFile(function (file) {
      sh.safe('上传头像', async function () {
        var r = await sh.api.upload('/user/avatar', file);
        sh.state.user.avatar = (r && r.avatar) || '';
        paintAvatar();
        sh.updateSidebarUser(sh.state.user);
        sh.toast('头像已更新');
      });
    });
  };
  $('#zq-set-name').textContent = u.nickname || u.username || '知趣用户';
  $('#zq-set-role').textContent = (u.role === 'ADMIN' ? '管理员' : '普通用户');
  $('#zq-set-days').textContent = u.consecutiveDays || 0;
  $('#zq-set-hours').textContent = Math.round((u.totalStudyMinutes || 0) / 60 * 10) / 10 + 'h';
  // 接口给的是 completedTaskCount —— 原来个人中心读 completedTasks，「完成任务」永远是 0（第十七轮修统计页时没看到这一处，第三十轮挪过来时才看到）
  sh.safe('专注统计', async function () { var stat = await sh.api.get('/record/statistics'); $('#zq-set-done').textContent = stat.completedTaskCount || 0; });
  var ins = { username: $('#zq-set-username'), nickname: $('#zq-set-nickname'), school: $('#zq-set-school'), major: $('#zq-set-major'), email: $('#zq-set-email') };
  Object.keys(ins).forEach(function (k) { ins[k].value = u[k] || ''; });
  $('#zq-set-save').onclick = function () {
    sh.safe('保存资料', async function () {
      var data = await sh.api.put('/user/profile', { nickname: ins.nickname.value.trim(), school: ins.school.value.trim(), major: ins.major.value.trim(), email: ins.email.value.trim() });
      Object.assign(sh.state.user, data);
      // 侧栏底部的名字也跟着换（原来个人中心是整页，保存后不刷新的话侧栏一直是旧昵称）
      sh.updateSidebarUser(sh.state.user);
      $('#zq-set-name').textContent = sh.state.user.nickname || sh.state.user.username || '知趣用户';
      sh.toast('资料已保存');
    });
  };
}

function bindModels(sh, root) {
  var $ = (s) => root.querySelector(s);
  var $all = (s) => Array.from(root.querySelectorAll(s));
  var u = sh.state.user || {};
  // 让 AI 读我的任务（第二十七轮）↔ PUT /user/ai-read-tasks；/auth/info 带着 aiReadTasks（服务端：空 = 开）
  var readTasks = $('#zq-ai-read-tasks');
  setToggle(readTasks, u.aiReadTasks !== false);
  readTasks.onclick = function () {
    var next = !toggleOn(readTasks);
    sh.safe('保存设置', async function () {
      await sh.api.put('/user/ai-read-tasks?enabled=' + next);
      sh.state.user.aiReadTasks = next;
      setToggle(readTasks, next);
      sh.toast(next ? '已打开：问到安排时 AI 会先看你的任务' : '已关闭：AI 不再读你的任务');
    });
  };

  var els = { display: $('#zq-model-display'), modelName: $('#zq-model-name'), apiUrl: $('#zq-model-url'), apiKey: $('#zq-model-key'),
    provider: $('#zq-model-provider'), contextWindow: $('#zq-model-context'), title: $('#zq-model-form-title'), save: $('#zq-model-save'), cancel: $('#zq-model-cancel') };
  var editingModelId = null;
  var models = [];
  async function loadModels() {
    var host = $('#zq-models');
    var modelData = await sh.api.get('/ai/models');
    models = sh.normalizeModelList(modelData);
    host.innerHTML = models.map(function (m) { return modelCard(sh, m); }).join('') || sh.empty('暂无模型配置');
    $all('[data-model-edit]').forEach(function (b) { b.onclick = function () { editModel(Number(b.dataset.modelEdit)); }; });
    $all('[data-model-test]').forEach(function (b) { b.onclick = async function () { var n = sh.notice('正在测试连通性…'); try { var r = await sh.api.post('/ai/models/' + b.dataset.modelTest + '/test', {}); n.update('连通性测试完成：' + (r && (r.message || r.status || (r.ok ? '通过' : '完成')) || '完成'), { done: true }); await loadModels(); } catch (e) { n.update('连通性测试失败：' + (e.message || '未知错误'), { error: true }); } }; });
    $all('[data-model-probe]').forEach(function (b) { b.onclick = async function () { var n = sh.notice('正在进行能力测试…'); try { await sh.api.post('/ai/models/' + b.dataset.modelProbe + '/probe', {}); n.update('能力测试完成', { done: true }); await loadModels(); } catch (e) { n.update('能力测试失败：' + (e.message || '未知错误'), { error: true }); } }; });
    $all('[data-model-del]').forEach(function (b) { b.onclick = async function () { if (await sh.askConfirm({ title: '删除模型', message: '删除该模型配置？已保存的 API Key 会一并移除。', okText: '删除', danger: true })) sh.safe('删除模型', async function () { await sh.api.del('/ai/models/' + b.dataset.modelDel); if (Number(b.dataset.modelDel) === editingModelId) stopEditing(); await loadModels(); }); }; });
  }
  /** 表单回到「添加模型」：清空、标题和按钮跟着换 */
  function stopEditing() {
    editingModelId = null;
    ['display', 'modelName', 'apiUrl', 'apiKey', 'contextWindow'].forEach(function (k) { els[k].value = ''; });
    els.provider.value = MODEL_PROVIDERS[0][0];
    paintFormMode(els, null);
  }
  function editModel(id) {
    var m = models.find(function (x) { return x.id === id; }); if (!m) return;
    editingModelId = id;
    // 名字框里是名字本身：label 是「名字（我的）」（模型选择器用的），原来编辑时整个填进来
    els.display.value = m.displayName || m.label || '';
    els.modelName.value = m.modelName || '';
    els.apiUrl.value = m.apiUrl || m.baseUrl || '';
    els.apiKey.value = '';
    els.contextWindow.value = m.contextWindowTokens || '';
    els.provider.value = MODEL_PROVIDERS.some(function (p) { return p[0] === m.providerType; }) ? m.providerType : MODEL_PROVIDERS[0][0];
    paintFormMode(els, m);
    $('#zq-model-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    try { els.display.focus({ preventScroll: true }); } catch (e) {}
  }
  els.cancel.onclick = stopEditing;
  els.save.onclick = function () {
    var body = {
      displayName: els.display.value.trim(),
      providerType: els.provider.value || MODEL_PROVIDERS[0][0],
      modelName: els.modelName.value.trim(),
      apiUrl: els.apiUrl.value.trim()
    };
    if (els.apiKey.value.trim()) body.apiKey = els.apiKey.value.trim();
    // 总是带上这个键：空串 = 清掉（回到保守默认）。后端只在请求体里有这个键时才改它
    body.contextWindowTokens = els.contextWindow.value.trim();
    if (!body.modelName) return sh.toast('请填写模型名称', 'error');
    var editing = editingModelId;
    sh.safe('保存模型', async function () {
      if (editing) await sh.api.put('/ai/models/' + editing, body);
      else await sh.api.post('/ai/models', body);
      sh.toast('模型已保存'); stopEditing(); await loadModels();
    });
  };
  return sh.safe('模型列表', loadModels);
}

/**
 * 提醒推送 ↔ /reminder/settings（开关 + 渠道凭据）。这个开关管的是全部提醒（到点的、截止前的、早八汇总）——
 * 后端 isEnabled 不开就一条都不发；原来卡片叫「早八提醒」、说明只写早八汇总，设了提醒时间的人不会想到要来开它。
 *
 * <p>渠道凭据这一块此前只存在于 js/profile.js —— 那个文件<b>零页面加载</b>，于是用户没有任何途径填凭据：开关只发
 * {channel:'PUSHPLUS', enabled:true}，而后端 hasRequiredChannelConfig 要求 pushplusToken 非空，早八时每条提醒都被标成
 * FAILED（「提醒渠道未启用或未配置」）。用户看到的是绿色的开关和一行写死的「渠道：PushPlus · 已绑定」，然后什么都收不到。
 *
 * <p>「这个渠道的凭据齐了没有」只有壳里那一份（sh.reminderChannelReady）：建任务的表单也拿它判断提醒发不发得出去。
 */
async function bindReminders(sh, root) {
  var $ = (s) => root.querySelector(s);
  var morning = $('#zq-morning');
  var sel = $('#zq-rm-channel');
  var settings = (await sh.safe('提醒设置', function () { return sh.api.get('/reminder/settings'); })) || {};
  var ready = function () { return sh.reminderChannelReady(settings, root); };
  setToggle(morning, settings.enabled);
  function paint() {
    var channel = sh.currentReminderChannel(settings, root);
    // 只露出选中的那个渠道的字段（第七十五轮起用 hidden：样子在样式表，全局那条 [hidden] 带 !important）
    root.querySelectorAll('[data-rm-group]').forEach(function (group) {
      group.hidden = group.dataset.rmGroup !== channel;
    });
    Object.keys(sh.REMINDER_FIELDS).forEach(function (key) {
      sh.REMINDER_FIELDS[key].forEach(function (pair) {
        var el = $('#' + pair[0]);
        var stored = settings[pair[1]];
        // 脱敏值只作为占位提示，绝不填进 value —— 填进去用户一保存就会把掩码当成新凭据提交
        el.placeholder = stored && String(stored).trim()
          ? '已保存（' + stored + '），留空则不修改'
          : el.dataset.rmPlaceholder || el.placeholder;
      });
    });
    var status = $('#zq-rm-status');
    status.textContent = ready() ? '凭据已配置' : '尚未配置凭据，提醒发不出去';
    status.dataset.state = ready() ? 'ok' : 'bad';
  }
  // 记下原始占位符，后面要在「已保存」与「未保存」之间切换
  Object.keys(sh.REMINDER_FIELDS).forEach(function (key) {
    sh.REMINDER_FIELDS[key].forEach(function (pair) { var el = $('#' + pair[0]); el.dataset.rmPlaceholder = el.placeholder; });
  });
  sel.value = settings.channel || 'PUSHPLUS';
  paint();
  sel.onchange = paint;
  morning.onclick = function () {
    var next = !toggleOn(morning);
    // 开启之前先确认渠道真的配得起来：后端 isEnabled 要求对应凭据非空，
    // 否则每天早八都会把提醒标成 FAILED，而用户只看到开关是绿的。
    if (next && !ready()) {
      sh.toast('请先填写并保存推送渠道的凭据，否则提醒发不出去', 'error');
      return;
    }
    sh.safe('保存提醒', async function () {
      await sh.api.put('/reminder/settings', { channel: sh.currentReminderChannel(settings, root), enabled: next });
      settings.enabled = next;
      setToggle(morning, next);
      sh.toast(next ? '提醒推送已开启' : '提醒推送已关闭');
    });
  };
  $('#zq-rm-save').onclick = function () {
    var channel = sh.currentReminderChannel(settings, root);
    var body = { channel: channel, enabled: !!settings.enabled };
    var filled = false;
    (sh.REMINDER_FIELDS[channel] || []).forEach(function (pair) {
      var el = $('#' + pair[0]);
      if (el.value.trim()) { body[pair[1]] = el.value.trim(); filled = true; }
    });
    if (!filled && !ready()) { sh.toast('请先填写凭据', 'error'); return; }
    sh.safe('保存推送渠道', async function () {
      await sh.api.put('/reminder/settings', body);
      var fresh = await sh.api.get('/reminder/settings');
      Object.keys(fresh || {}).forEach(function (k) { settings[k] = fresh[k]; });
      (sh.REMINDER_FIELDS[channel] || []).forEach(function (pair) { $('#' + pair[0]).value = ''; });
      paint();
      setToggle(morning, settings.enabled);
      sh.toast('推送渠道已保存');
    });
  };
  $('#zq-rm-test').onclick = function () {
    sh.safe('发送测试', async function () {
      await sh.api.post('/reminder/test', {});
      sh.toast('测试消息已发出，去对应渠道确认');
    });
  };
}

/**
 * 命令行登录（设备码）与个人访问令牌。
 *
 * 允许之前先把「哪台设备、从哪个地址、什么时候」摆出来 —— 设备码登录的已知风险是别人发起、骗你点允许，
 * 让人看出「这不是我的机器」是唯一的防线。令牌在列表里只显示末 4 位，撤销立即生效。
 * 终端里打印的链接是 #settings/cli?harness=XXXX-XXXX（老的 profile.html#harness= 由壳换过来）：带着它打开时直接填好码并查看。
 */
function bindCli(sh, root, params) {
  var $ = (s) => root.querySelector(s);
  var input = $('#zq-cli-code'), device = $('#zq-cli-device'), list = $('#zq-cli-tokens');
  async function paintTokens() {
    var rows = await sh.safe('命令行令牌', function () { return sh.api.get('/access-tokens'); });
    rows = Array.isArray(rows) ? rows : [];
    list.innerHTML = rows.length
      ? rows.map(function (t) {
          return '<div class="zq-set-token"><div class="zq-set-token-who"><div><strong>' + sh.esc(t.name) + '</strong> <span class="zq-mono">' + sh.esc(t.hint) + '</span></div>'
            + '<div class="zq-set-token-used">' + (t.lastUsedAt ? '最近使用 ' + sh.esc(String(t.lastUsedAt).replace('T', ' ').slice(0, 16)) : '还没用过')
            + '</div></div><button type="button" class="zq-btn-ghost zq-btn-xs" data-revoke="' + sh.esc(t.id) + '">撤销</button></div>';
        }).join('')
      : '<p class="zq-set-note">还没有命令行登录过。</p>';
    list.querySelectorAll('[data-revoke]').forEach(function (b) {
      b.onclick = function () {
        sh.safe('撤销令牌', async function () {
          await sh.api.del('/access-tokens/' + encodeURIComponent(b.dataset.revoke));
          sh.toast('已撤销，那台机器上的命令行需要重新登录');
          await paintTokens();
        });
      };
    });
  }
  async function check() {
    var code = (input.value || '').trim();
    if (!code) { device.innerHTML = ''; return; }
    var info = await sh.safe('查看设备码', function () { return sh.api.get('/access-tokens/device/' + encodeURIComponent(code)); });
    if (!info) { device.innerHTML = ''; return; }
    device.innerHTML = '<div class="zq-set-box">'
      + '<div><strong>' + sh.esc(info.clientName || '命令行') + '</strong> 请求登录你的账号</div>'
      + '<span>来自 ' + sh.esc(info.clientIp || '未知地址') + ' · ' + sh.esc(String(info.createdAt || '').replace('T', ' ').slice(0, 16)) + ' · 设备码 ' + sh.esc(info.userCode) + '</span>'
      + '<p class="zq-set-box-warn">只在这是你自己刚刚在终端里发起的时候才允许。</p>'
      + '<div class="zq-set-btns"><button type="button" class="zq-btn zq-sm" id="zq-cli-approve">允许</button>'
      + '<button type="button" class="zq-btn-ghost zq-sm" id="zq-cli-deny">拒绝</button></div></div>';
    $('#zq-cli-approve').onclick = function () {
      sh.safe('允许命令行登录', async function () {
        await sh.api.post('/access-tokens/device/' + encodeURIComponent(info.userCode) + '/approve', {});
        device.innerHTML = '<p class="zq-set-status" data-state="ok" role="status">已允许。回到终端，命令行会自动完成登录。</p>';
        input.value = '';
        // 令牌在命令行来取（轮询）的那一刻才签出，时间点不固定 —— 刷几次，直到列表里多出一张；弹窗关了就不刷了
        var before = list.querySelectorAll('[data-revoke]').length, tries = 0;
        (function again() {
          setTimeout(async function () {
            if (!root.isConnected) return;
            await paintTokens();
            if (list.querySelectorAll('[data-revoke]').length <= before && ++tries < 10) again();
          }, 3000);
        })();
      });
    };
    $('#zq-cli-deny').onclick = function () {
      sh.safe('拒绝命令行登录', async function () {
        await sh.api.post('/access-tokens/device/' + encodeURIComponent(info.userCode) + '/deny', {});
        device.innerHTML = '<p class="zq-set-status" role="status">已拒绝。</p>';
        input.value = '';
      });
    };
  }
  $('#zq-cli-check').onclick = check;
  input.onkeydown = function (e) { if (e.key === 'Enter') check(); };
  if (/^[A-Za-z0-9-]{8,9}$/.test((params && params.harness) || '')) {
    input.value = params.harness.toUpperCase();
    check();
  }
  return paintTokens();
}

function bindSecurity(sh, root) {
  var $ = (s) => root.querySelector(s);
  sh.safe('登录历史', async function () {
    var hist = await sh.api.get('/user/login-history?limit=5');
    var latest = hist && hist[0];
    $('#zq-sec-latest').textContent = latest ? (sh.fmtDate(latest.loginAt) + (latest.ip ? ' · ' + latest.ip : '')) : '暂无记录';
    $('#zq-sec-device').textContent = latest && latest.userAgent ? shortUA(latest.userAgent) : '—';
  });
  $('#zq-sec-logout').onclick = function () { sh.logout(); };
  var pis = [$('#zq-pw-old'), $('#zq-pw-new'), $('#zq-pw-again')];
  $('#zq-pw-save').onclick = function () {
    if (pis[1].value !== pis[2].value) return sh.toast('两次新密码不一致', 'error');
    sh.safe('修改密码', async function () {
      // 改完密码，之前签发的令牌（别的设备上的、被偷走的）全部作废；这个会话拿新令牌接着用，「记住我」照旧
      var fresh = await sh.api.put('/user/password', { oldPassword: pis[0].value, newPassword: pis[1].value });
      sh.adoptNewToken(fresh && fresh.token);
      sh.toast('密码已更新，其他设备上的登录已失效');
      pis.forEach(function (i) { i.value = ''; });
    });
  };
}

var BINDERS = { profile: bindProfile, models: bindModels, reminders: bindReminders, cli: bindCli, security: bindSecurity };

// ── 弹窗 ────────────────────────────────────────────────────

/**
 * 设置弹窗（Claude 那样：左边分栏、右边内容）。
 * @param sh   壳给的共用功能（zqShared）
 * @param opts tab / params：打开哪一栏、带什么参数（命令行那一栏的设备码）；
 *             onTab(name)：换了栏（壳拿它改地址，刷新还在这一栏）；onClose：关掉了（壳拿它去掉地址）
 * @return {close, show(tab, params)}
 */
export function openSettings(sh, opts) {
  opts = opts || {};
  var first = PANES[opts.tab] ? opts.tab : SETTINGS_TABS[0][0];
  // 分栏照 tabs 的规矩（第七十五轮）：选中的那栏能 Tab 到、别的用方向键；打开时焦点落在选中的那一栏 ——
  // 原来 openModal 把焦点给第一个按钮（「个人资料」），从「AI 模型」进来时两栏一个有焦点框、一个是选中的样子，看着像都选上了
  var handle = sh.openModal({
    title: '设置',
    width: '880px',
    bodyHtml: '<div class="zq-settings"><nav class="zq-settings-tabs" role="tablist" aria-label="设置">'
      + SETTINGS_TABS.map(function (t) {
        var on = t[0] === first;
        return '<button type="button" role="tab" id="zq-set-tab-' + t[0] + '" aria-controls="zq-set-pane" data-set-tab="' + t[0] + '"'
          + ' aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '"' + (on ? ' class="on" autofocus' : '') + '>' + t[1] + '</button>';
      }).join('')
      + '</nav><section id="zq-set-pane" class="zq-settings-pane" role="tabpanel" aria-labelledby="zq-set-tab-' + first + '"></section></div>',
    onClose: opts.onClose
  });
  handle.mask.querySelector('.zq-modal').classList.add('zq-modal-wide');
  var pane = handle.body.querySelector('.zq-settings-pane');
  var current = null;
  function show(name, params) {
    if (!PANES[name]) name = SETTINGS_TABS[0][0];
    current = name;
    // 焦点在分栏上时跟着换过去（方向键换栏；地址换栏 —— 浏览器的前进后退 —— 也一样，不然焦点框留在上一栏）
    var focusTab = handle.body.contains(document.activeElement) && document.activeElement.getAttribute('role') === 'tab';
    handle.body.querySelectorAll('[data-set-tab]').forEach(function (b) {
      var on = b.dataset.setTab === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focusTab) b.focus();
    });
    pane.setAttribute('aria-labelledby', 'zq-set-tab-' + name);
    // 换一栏 = 换一块全新的 DOM：上一栏还在路上的请求回来时写的是已经摘下来的那块，不会串到这一栏
    var fresh = document.createElement('div');
    fresh.innerHTML = PANES[name]();
    pane.replaceChildren(fresh);
    pane.scrollTop = 0;
    BINDERS[name](sh, fresh, params || {});
  }
  function pick(name) {
    if (name === current) return;
    show(name);
    if (opts.onTab) opts.onTab(name);
  }
  handle.body.querySelectorAll('[data-set-tab]').forEach(function (b) {
    b.onclick = function () { pick(b.dataset.setTab); };
  });
  handle.body.querySelector('[role="tablist"]').onkeydown = function (e) {
    var next = tabAfterKey(e.key, current);
    if (!next) return;
    e.preventDefault();
    pick(next);
  };
  show(first, opts.params);
  return { close: handle.close, show: show };
}

/** 分栏的键盘：← ↑ 上一栏、→ ↓ 下一栏（到头绕回去）、Home / End 第一栏 / 最后一栏；别的键回 null（不归分栏管） */
export function tabAfterKey(key, current) {
  var names = SETTINGS_TABS.map(function (t) { return t[0]; });
  var i = Math.max(0, names.indexOf(current)), n = names.length;
  if (key === 'ArrowRight' || key === 'ArrowDown') return names[(i + 1) % n];
  if (key === 'ArrowLeft' || key === 'ArrowUp') return names[(i - 1 + n) % n];
  if (key === 'Home') return names[0];
  if (key === 'End') return names[n - 1];
  return null;
}

/** 一张成就卡片。没解锁的写「未解锁」（和筛选的说法一样；原来写「进行中」），样子在样式表（.zq-ach / .is-on） */
export function achievementCard(sh, a) {
  var on = !!(a.unlocked || a.unlockedAt);
  var name = a.name || a.title || a.achievementName || '成就';
  var points = a.points || a.score || 0;
  return '<article class="zq-ach' + (on ? ' is-on' : '') + '"><div class="zq-ach-head"><div class="zq-ach-badge">' + sh.icon('award') + '</div>'
    + '<div class="zq-ach-who"><h3>' + sh.esc(name) + '</h3><span>' + (on ? '已解锁' : '未解锁') + '</span></div></div>'
    + '<p>' + sh.esc(a.description || '') + '</p><div class="zq-ach-points"><span class="zq-num">+' + sh.esc(points) + ' 点</span></div></article>';
}

/**
 * 成就（第二十六轮从导航收起，第三十轮挪进头像菜单的弹窗）。原来 achievement.html 那一页的样子和 bootAchievement / renderAchList。
 * 弹窗当场打开，列表回来再填 —— 返回的 handle 不等网络。
 */
export function openAchievements(sh, opts) {
  opts = opts || {};
  var filterBtn = function (k, label) { return '<button type="button" data-k="' + k + '" aria-pressed="' + (k === 'all') + '">' + label + '</button>'; };
  var handle = sh.openModal({
    title: '成就',
    width: '880px',
    bodyHtml: '<div class="zq-ach-view">'
      + '<div class="zq-ach-bar"><span>按期完成、连续专注，都会沉淀成这里的里程碑。</span>'
      + '<div class="zq-seg" data-ach-filters role="group" aria-label="筛选成就">' + filterBtn('all', '全部') + filterBtn('on', '已解锁') + filterBtn('off', '未解锁') + '</div></div>'
      + '<section class="zq-grid zq-stat-grid zq-phone-2col">'
      + '<article class="zq-stat is-primary"><span class="zq-stat-label">已解锁</span><strong class="zq-stat-num">—</strong></article>'
      + '<article class="zq-stat"><span class="zq-stat-label">全部成就</span><strong class="zq-stat-num">—</strong></article>'
      + '<article class="zq-stat"><span class="zq-stat-label">成就点数</span><strong class="zq-stat-num">—</strong></article>'
      + '<article class="zq-stat zq-ach-recent" data-ach-recent><span class="zq-stat-label">最近解锁</span><strong>—</strong><span></span></article>'
      + '</section>'
      // 一行几张按宽度来（auto-fill）：原来固定三列，手机上靠 zq-phone-1col 改成一列
      + '<div data-ach-list class="zq-ach-list"></div></div>',
    onClose: opts.onClose
  });
  handle.mask.querySelector('.zq-modal').classList.add('zq-modal-wide');
  var root = handle.body;
  var list = null;   // 还没回来时是 null：列表区先空着，不说「暂无成就」
  function renderAchList(filter) {
    // 按下的样子在样式表（.zq-seg 的 aria-pressed）：原来 JS 改背景色和字的颜色
    root.querySelectorAll('[data-ach-filters] button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.k === filter ? 'true' : 'false');
    });
    if (!list) return;
    var shown = list.filter(function (a) {
      var on = !!(a.unlocked || a.unlockedAt);
      return filter === 'all' ? true : (filter === 'on' ? on : !on);
    });
    root.querySelector('[data-ach-list]').innerHTML = shown.map(function (a) { return achievementCard(sh, a); }).join('') || sh.empty('暂无成就');
  }
  var filter = 'all';
  root.querySelectorAll('[data-ach-filters] button[data-k]').forEach(function (b) { b.onclick = function () { filter = b.dataset.k; renderAchList(filter); }; });
  renderAchList(filter);
  sh.safe('成就', async function () {
    list = (await sh.api.get('/achievement/list')) || [];
    var info = sh.state.user || {};
    var unlockedList = list.filter(function (x) { return x.unlocked || x.unlockedAt; });
    var nums = root.querySelectorAll('.zq-stat-num');
    nums[0].textContent = unlockedList.length;
    nums[1].textContent = list.length;
    nums[2].textContent = info.achievementPoints || 0;
    var recentCard = root.querySelector('[data-ach-recent]');
    var recent = unlockedList.slice().sort(function (a, b) {
      return String(b.unlockedAt || '').localeCompare(String(a.unlockedAt || ''));
    })[0];
    var strong = recentCard.querySelector('strong');
    var note = recentCard.querySelectorAll('span')[1];
    if (recent) {
      strong.textContent = recent.name || recent.title || recent.achievementName || '成就';
      note.textContent = recent.unlockedAt ? sh.d10(recent.unlockedAt) + ' 解锁' : '已解锁';
    } else {
      strong.textContent = '暂无';
      note.textContent = '继续加油';
    }
    renderAchList(filter);
  });
  return { close: handle.close };
}
