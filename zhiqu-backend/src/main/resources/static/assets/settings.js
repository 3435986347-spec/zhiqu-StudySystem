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
// 手机上怎么排写在类名上（MobileLayoutTest 核对它和 DECISIONS 一致）。

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
function probeColor(s) { s = String(s || '').toUpperCase(); if (/UNSUPPORT|NOT_SUPPORT/.test(s)) return 'var(--zq-text3)'; if (/VERIFIED|PASS|OK|SUCCESS|SUPPORT|YES|TRUE/.test(s)) return 'var(--zq-ok)'; if (/FAIL|ERROR/.test(s)) return 'var(--zq-bad)'; return 'var(--zq-text3)'; }

/** 开关的样子（原来叫 setMorningToggle：提醒推送、让 AI 读我的任务共用）。 */
function setToggle(btn, on) {
  btn.dataset.on = on ? '1' : '0';
  var knob = btn.firstElementChild;
  if (knob) knob.style.left = on ? '21px' : '3px';
  btn.style.background = on ? 'var(--zq-primary)' : 'var(--zq-border)';
}

// ── 各栏的样子（原来个人中心页里的那几块，设计稿的示例值去掉了） ──────────────

const TOGGLE = (id, label) => '<button id="' + id + '" type="button"' + (label ? ' aria-label="' + label + '"' : '')
  + ' style="flex:none; width:42px; height:24px; border:none; border-radius:999px; background:var(--zq-border); cursor:pointer; position:relative; transition:background .2s;">'
  + '<i style="position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.25); transition:left .2s;"></i></button>';
const H3 = (t) => '<h3 style="margin:0 0 12px; font-size:14px; font-weight:var(--zq-fw-medium);">' + t + '</h3>';
const FIELD = (label, input, wide) => '<div class="zq-field" style="gap:5px;' + (wide ? ' grid-column:1 / -1;' : '') + '"><label class="zq-label" style="font-size:11.5px;">' + label + '</label>' + input + '</div>';
const ROW = 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 0; font-size:12.5px;';

const PANES = {
  profile: () => ''
    + '<div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding-bottom:16px; margin-bottom:16px; border-bottom:1px solid var(--zq-border-soft);">'
    + '<div id="zq-set-avatar" title="点击更换头像" style="width:64px; height:64px; flex:none; border-radius:50%; background:var(--zq-tint-strong); color:var(--zq-primary); display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:var(--zq-fw-medium); cursor:pointer; overflow:hidden;"></div>'
    + '<div style="min-width:0; flex:1;"><h2 id="zq-set-name" class="zq-h2" style="font-size:17px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></h2>'
    + '<span id="zq-set-role" class="zq-badge" style="margin-top:6px; background:var(--zq-tint); color:var(--zq-primary); font-weight:var(--zq-fw-medium);"></span></div>'
    + '<div style="display:flex; gap:20px; text-align:center;">'
    + '<div><strong id="zq-set-days" class="zq-num" style="display:block; font-size:18px;">—</strong><span style="font-size:11px; color:var(--zq-text3);">连续天数</span></div>'
    + '<div><strong id="zq-set-done" class="zq-num" style="display:block; font-size:18px;">—</strong><span style="font-size:11px; color:var(--zq-text3);">完成任务</span></div>'
    // 原来写着「本月时长」，显示的却是 totalStudyMinutes（全部的累计）
    + '<div><strong id="zq-set-hours" class="zq-num" style="display:block; font-size:18px;">—</strong><span style="font-size:11px; color:var(--zq-text3);">累计专注</span></div>'
    + '</div></div>'
    + '<div class="zq-phone-1col" style="display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px;">'
    + FIELD('用户名', '<input id="zq-set-username" class="zq-input" readonly style="background:var(--zq-card-soft); color:var(--zq-text3);">')
    + FIELD('昵称', '<input id="zq-set-nickname" class="zq-input">')
    + FIELD('单位 / 学校', '<input id="zq-set-school" class="zq-input">')
    + FIELD('部门 / 职位', '<input id="zq-set-major" class="zq-input">')
    + FIELD('邮箱', '<input id="zq-set-email" class="zq-input" type="email">', true)
    + '</div><div style="display:flex; justify-content:flex-end; margin-top:14px;"><button id="zq-set-save" class="zq-btn">保存资料</button></div>',

  models: () => ''
    + '<p style="margin:0 0 12px; padding:8px 12px; border-radius:var(--zq-rs); background:var(--zq-tint); font-size:12px; color:var(--zq-text2); line-height:1.55;">API Key 加密存储；监管后台不会显示你的完整 Key、知识库正文或任务正文。</p>'
    // 第二十七轮：AI 读不读得到你的任务（用户定的「让它读，给一个开关」；默认开）。说清楚打开时什么会发给谁。
    + '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin:0 0 14px;">'
    + '<span style="font-size:12.5px; color:var(--zq-text2); line-height:1.55;"><b style="color:var(--zq-text);">让 AI 读我的任务</b>：问到今天、这周怎么安排时，AI 先看一眼你没完成的任务（标题、时间、象限）再回答。打开时，这些内容会发给你配置的模型供应商。</span>'
    + TOGGLE('zq-ai-read-tasks', '让 AI 读我的任务') + '</div>'
    + '<div id="zq-models" style="display:flex; flex-direction:column; gap:10px; margin-bottom:18px;"></div>'
    + '<div id="zq-model-form" style="display:flex; flex-direction:column; gap:12px; padding-top:16px; border-top:1px solid var(--zq-border-soft);">'
    + FIELD('显示名称', '<input id="zq-model-display" class="zq-input" placeholder="例如 Claude Sonnet / DeepSeek / 本地 Ollama">')
    + '<div class="zq-phone-1col" style="display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px;">'
    + FIELD('Provider', '<select id="zq-model-provider" class="zq-select"><option>OpenAI-compatible</option><option>Anthropic Claude</option><option>Ollama 本地模型</option><option>vLLM</option><option>Google Gemini</option></select>')
    + FIELD('模型名称', '<input id="zq-model-name" class="zq-input" placeholder="gpt-4o-mini / claude-3-5-sonnet">')
    + '</div>'
    + FIELD('API 接口地址', '<input id="zq-model-url" class="zq-input" placeholder="https://api.openai.com/v1/chat/completions"><span style="font-size:11.5px; color:var(--zq-text3);">Anthropic 用 /v1/messages；Ollama 默认 http://localhost:11434/v1/chat/completions。</span>')
    + FIELD('API Key', '<input id="zq-model-key" class="zq-input" type="password" placeholder="留空则不修改已保存 Key">')
    + FIELD('上下文窗口（token，可选）', '<input id="zq-model-context" class="zq-input" type="number" min="8000" max="1000000" step="1000" placeholder="按模型实际能力填，例如 128000；最多 1000000。留空用保守默认值"><span style="font-size:11.5px; color:var(--zq-text3); line-height:1.5;">填了之后，对话历史、代码和 Wiki 资料都按它放大。填得越大，长对话每一轮带给模型的内容越多 —— 也越耗 token、越慢；超过模型真实上限，请求会被服务商拒绝。</span>')
    + '<div style="padding:10px 12px; border:1px solid var(--zq-border-soft); border-radius:var(--zq-rs); background:var(--zq-card-soft);"><strong style="display:block; font-size:12px;">模型能力由系统测试确认</strong><span style="display:block; margin-top:3px; font-size:11.5px; color:var(--zq-text2); line-height:1.55;">保存后可进行连通性、图像识别（多模态）、深度思考探测，会消耗少量 token。</span></div>'
    + '<div style="display:flex; gap:8px;"><button id="zq-model-save" class="zq-btn">保存模型</button><button id="zq-model-new" class="zq-btn-ghost">新建模型</button></div>'
    + '</div>',

  reminders: () => ''
    + '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">'
    + '<span style="font-size:12.5px; color:var(--zq-text2); line-height:1.5;"><b style="color:var(--zq-text);">提醒推送</b>：打开后，任务的提醒时间、截止前提醒和每天 08:00 的待办汇总都推送到下面的渠道</span>'
    + TOGGLE('zq-morning', '提醒推送') + '</div>'
    // 渠道配置。原来这里写死着一行「渠道：PushPlus · 已绑定」，而用户没有任何途径填凭据（见 bindReminders 的注释）
    + '<div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--zq-border-soft); display:flex; flex-direction:column; gap:9px; max-width:520px;">'
    + '<div style="display:flex; align-items:center; gap:9px;"><label class="zq-label" style="font-size:11.5px; flex:none;">推送渠道</label>'
    + '<select id="zq-rm-channel" class="zq-select" style="height:30px; font-size:12.5px; flex:1;"><option value="PUSHPLUS">PushPlus</option><option value="WECOM">企业微信机器人</option><option value="QQ">QQ 机器人</option></select></div>'
    // display 由 JS 控制：写成内联 display:flex 会压掉 hidden 属性（UA 的 display:none 优先级更低），三个渠道的字段会同时显示出来
    + '<div data-rm-group="PUSHPLUS" style="flex-direction:column; gap:6px;"><input id="zq-rm-pushplus" class="zq-input" type="password" autocomplete="off" placeholder="PushPlus token" style="height:30px; font-size:12.5px;"></div>'
    + '<div data-rm-group="WECOM" style="display:none; flex-direction:column; gap:6px;"><input id="zq-rm-webhook" class="zq-input" type="password" autocomplete="off" placeholder="企业微信机器人 Webhook 地址" style="height:30px; font-size:12.5px;"></div>'
    + '<div data-rm-group="QQ" style="display:none; flex-direction:column; gap:6px;"><input id="zq-rm-qq-appid" class="zq-input" autocomplete="off" placeholder="QQ 机器人 AppID" style="height:30px; font-size:12.5px;">'
    + '<input id="zq-rm-qq-secret" class="zq-input" type="password" autocomplete="off" placeholder="AppSecret" style="height:30px; font-size:12.5px;">'
    + '<input id="zq-rm-qq-group" class="zq-input" autocomplete="off" placeholder="群 openid" style="height:30px; font-size:12.5px;"></div>'
    + '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;"><button id="zq-rm-save" class="zq-btn" style="height:30px; padding:0 14px; font-size:12.5px;">保存渠道</button>'
    + '<button id="zq-rm-test" class="zq-btn-ghost" style="height:30px; padding:0 12px; font-size:12.5px;">发送测试</button><span id="zq-rm-status" style="font-size:11.5px; color:var(--zq-text3);"></span></div>'
    + '</div>',

  cli: () => ''
    + H3('命令行登录')
    + '<p style="margin:-4px 0 10px; font-size:12px; color:var(--zq-text3); line-height:1.6;">在终端运行 <span class="zq-mono">zhiqu login</span>，把它显示的 8 位设备码填在这里。命令行不会拿到你的密码，只拿到一张可随时撤销的令牌。'
    + '登录之后，<span class="zq-mono">zhiqu mcp</span> 还能让 Claude Code、Cursor 这些 MCP 客户端读写你的知识 Wiki 和任务。</p>'
    + '<div style="display:flex; gap:8px; max-width:420px;"><input id="zq-cli-code" class="zq-input" autocomplete="off" placeholder="设备码，如 ABCD-EFGH" style="height:30px; font-size:12.5px; flex:1; text-transform:uppercase;">'
    + '<button id="zq-cli-check" class="zq-btn-ghost" style="height:30px; padding:0 12px; font-size:12.5px;">查看</button></div>'
    + '<div id="zq-cli-device" style="margin-top:8px;"></div>'
    + '<div style="margin-top:18px;">' + H3('已登录的命令行') + '<div id="zq-cli-tokens" style="display:flex; flex-direction:column; gap:6px;"></div></div>',

  security: () => ''
    + H3('修改密码')
    + '<div style="display:flex; flex-direction:column; gap:10px; max-width:360px;">'
    + '<input id="zq-pw-old" class="zq-input" type="password" autocomplete="current-password" placeholder="当前密码">'
    + '<input id="zq-pw-new" class="zq-input" type="password" autocomplete="new-password" placeholder="新密码（至少 6 位）">'
    + '<input id="zq-pw-again" class="zq-input" type="password" autocomplete="new-password" placeholder="确认新密码">'
    + '<button id="zq-pw-save" class="zq-btn" style="align-self:flex-start;">更新密码</button></div>'
    + '<div style="margin-top:22px;">' + H3('最近登录') + '<div style="display:flex; flex-direction:column;">'
    + '<div style="' + ROW + ' border-bottom:1px solid var(--zq-border-soft);"><span style="color:var(--zq-text2); flex:none;">时间与地址</span><span id="zq-sec-latest" style="font-weight:var(--zq-fw-medium); text-align:right;">—</span></div>'
    + '<div style="' + ROW + ' border-bottom:1px solid var(--zq-border-soft);"><span style="color:var(--zq-text2); flex:none;">登录设备</span><span id="zq-sec-device" style="font-weight:var(--zq-fw-medium); text-align:right;">—</span></div>'
    + '<div style="' + ROW + '"><span style="color:var(--zq-text2); flex:none;">退出登录</span><button id="zq-sec-logout" type="button" class="zq-btn-ghost" style="height:26px; padding:0 12px; font-size:12px;">退出</button></div>'
    + '</div></div>'
};

// ── 各栏接上数据 ──────────────────────────────────────────────

function bindProfile(sh, root) {
  var $ = (s) => root.querySelector(s);
  var u = sh.state.user || {};
  var av = $('#zq-set-avatar');
  var paintAvatar = function () {
    // 与侧边栏保持一致：有头像显示头像，否则显示昵称首字
    av.innerHTML = sh.state.user && sh.state.user.avatar
      ? '<img src="' + sh.esc(sh.state.user.avatar) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">'
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

var MODEL_PROVIDERS = ['OPENAI_COMPATIBLE', 'ANTHROPIC', 'OLLAMA', 'VLLM', 'GEMINI'];

function bindModels(sh, root) {
  var $ = (s) => root.querySelector(s);
  var $all = (s) => Array.from(root.querySelectorAll(s));
  var u = sh.state.user || {};
  // 让 AI 读我的任务（第二十七轮）↔ PUT /user/ai-read-tasks；/auth/info 带着 aiReadTasks（服务端：空 = 开）
  var readTasks = $('#zq-ai-read-tasks');
  setToggle(readTasks, u.aiReadTasks !== false);
  readTasks.onclick = function () {
    var next = readTasks.dataset.on !== '1';
    sh.safe('保存设置', async function () {
      await sh.api.put('/user/ai-read-tasks?enabled=' + next);
      sh.state.user.aiReadTasks = next;
      setToggle(readTasks, next);
      sh.toast(next ? '已打开：问到安排时 AI 会先看你的任务' : '已关闭：AI 不再读你的任务');
    });
  };

  var els = { display: $('#zq-model-display'), modelName: $('#zq-model-name'), apiUrl: $('#zq-model-url'), apiKey: $('#zq-model-key'),
    provider: $('#zq-model-provider'), contextWindow: $('#zq-model-context') };
  var editingModelId = null;
  function modelTile(k, v, c) { return '<div style="min-width:0;"><span style="display:block;font-size:10.5px;color:var(--zq-text3);">' + sh.esc(k) + '</span><strong style="display:block;margin-top:3px;font-size:11.5px;font-weight:var(--zq-fw-medium);color:' + c + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + sh.esc(v) + '</strong></div>'; }
  var models = [];
  async function loadModels() {
    var host = $('#zq-models');
    var modelData = await sh.api.get('/ai/models');
    models = sh.normalizeModelList(modelData);
    host.innerHTML = models.map(function (m) {
      var mine = m.ownerType !== 'SYSTEM';
      return '<article style="border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card);padding:12px 14px;"><div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;"><div style="min-width:0;"><div style="font-size:13.5px;font-weight:var(--zq-fw-medium);">' + sh.esc(m.label || m.displayName || m.name) + '</div><div class="zq-mono" style="font-size:11.5px;color:var(--zq-text3);margin-top:2px;">' + sh.esc(m.modelName || '') + '</div></div><span class="zq-badge" style="background:var(--zq-tint);color:var(--zq-primary);font-weight:var(--zq-fw-medium);">' + sh.esc(mine ? '我的' : '系统') + '</span></div>'
        + '<div class="zq-phone-2col" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:11px;padding-top:11px;border-top:1px solid var(--zq-border-soft);">'
        + modelTile('Provider', m.providerType || '—', 'var(--zq-text2)')
        + modelTile('连通性', probeText(m.capabilityProbeStatus), probeColor(m.capabilityProbeStatus))
        + modelTile('视觉', probeText(m.visionStatus), probeColor(m.visionStatus))
        + modelTile('深度思考', probeText(m.reasoningStatus), probeColor(m.reasoningStatus))
        + '</div>'
        + '<div style="margin-top:9px;font-size:11.5px;color:var(--zq-text3);">Key：' + sh.esc(m.apiKeyMasked || m.maskedApiKey || '—') + (m.lastProbeAt ? ' · 上次探测 ' + sh.esc(sh.fmtDate(m.lastProbeAt)) : '') + '</div>'
        + '<div style="display:flex;gap:6px;margin-top:11px;flex-wrap:wrap;">' + (mine ? '<button class="zq-btn-ghost" data-model-edit="' + m.id + '" style="height:26px;padding:0 11px;font-size:12px;">编辑</button>' : '') + '<button class="zq-btn-ghost" data-model-test="' + m.id + '" style="height:26px;padding:0 11px;font-size:12px;">测试连通</button><button class="zq-btn-ghost" data-model-probe="' + m.id + '" style="height:26px;padding:0 11px;font-size:12px;">能力测试</button>' + (mine ? '<button class="zq-btn-ghost" data-model-del="' + m.id + '" style="height:26px;padding:0 11px;font-size:12px;">删除</button>' : '') + '</div></article>';
    }).join('') || sh.empty('暂无模型配置');
    $all('[data-model-edit]').forEach(function (b) { b.onclick = function () { editModel(Number(b.dataset.modelEdit)); }; });
    $all('[data-model-test]').forEach(function (b) { b.onclick = async function () { var n = sh.notice('正在测试连通性…'); try { var r = await sh.api.post('/ai/models/' + b.dataset.modelTest + '/test', {}); n.update('连通性测试完成：' + (r && (r.message || r.status || (r.ok ? '通过' : '完成')) || '完成'), { done: true }); await loadModels(); } catch (e) { n.update('连通性测试失败：' + (e.message || '未知错误'), { error: true }); } }; });
    $all('[data-model-probe]').forEach(function (b) { b.onclick = async function () { var n = sh.notice('正在进行能力测试…'); try { await sh.api.post('/ai/models/' + b.dataset.modelProbe + '/probe', {}); n.update('能力测试完成', { done: true }); await loadModels(); } catch (e) { n.update('能力测试失败：' + (e.message || '未知错误'), { error: true }); } }; });
    $all('[data-model-del]').forEach(function (b) { b.onclick = async function () { if (await sh.askConfirm({ title: '删除模型', message: '删除该模型配置？已保存的 API Key 会一并移除。', okText: '删除', danger: true })) sh.safe('删除模型', async function () { await sh.api.del('/ai/models/' + b.dataset.modelDel); await loadModels(); }); }; });
  }
  function clearModelForm() {
    ['display', 'modelName', 'apiUrl', 'apiKey', 'contextWindow'].forEach(function (k) { els[k].value = ''; });
    els.provider.selectedIndex = 0;
  }
  function editModel(id) {
    var m = models.find(function (x) { return x.id === id; }); if (!m) return;
    editingModelId = id;
    els.display.value = m.label || m.displayName || '';
    els.modelName.value = m.modelName || '';
    els.apiUrl.value = m.apiUrl || m.baseUrl || '';
    els.apiKey.value = '';
    els.contextWindow.value = m.contextWindowTokens || '';
    var idx = MODEL_PROVIDERS.indexOf(m.providerType);
    els.provider.selectedIndex = idx >= 0 ? idx : 0;
    $('#zq-model-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    sh.toast('正在编辑：' + (m.label || m.displayName || m.modelName || '模型'));
  }
  $('#zq-model-new').onclick = function () { editingModelId = null; clearModelForm(); sh.toast('已切换到新建模型'); };
  $('#zq-model-save').onclick = function () {
    var body = {
      displayName: els.display.value.trim(),
      providerType: MODEL_PROVIDERS[els.provider.selectedIndex] || 'OPENAI_COMPATIBLE',
      modelName: els.modelName.value.trim(),
      apiUrl: els.apiUrl.value.trim()
    };
    if (els.apiKey.value.trim()) body.apiKey = els.apiKey.value.trim();
    // 总是带上这个键：空串 = 清掉（回到保守默认）。后端只在请求体里有这个键时才改它
    body.contextWindowTokens = els.contextWindow.value.trim();
    if (!body.modelName) return sh.toast('请填写模型名称', 'error');
    sh.safe('保存模型', async function () {
      if (editingModelId) await sh.api.put('/ai/models/' + editingModelId, body);
      else await sh.api.post('/ai/models', body);
      sh.toast('模型已保存'); editingModelId = null; clearModelForm(); await loadModels();
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
    // 用 style.display 而不是 hidden 属性：这些 div 带着内联样式，
    // 而内联 display 的优先级高于 [hidden] 的 UA 规则 —— 设 hidden 不会让它们消失
    root.querySelectorAll('[data-rm-group]').forEach(function (group) {
      group.style.display = group.dataset.rmGroup === channel ? 'flex' : 'none';
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
    status.style.color = ready() ? 'var(--zq-q2)' : 'var(--zq-q1)';
  }
  // 记下原始占位符，后面要在「已保存」与「未保存」之间切换
  Object.keys(sh.REMINDER_FIELDS).forEach(function (key) {
    sh.REMINDER_FIELDS[key].forEach(function (pair) { var el = $('#' + pair[0]); el.dataset.rmPlaceholder = el.placeholder; });
  });
  sel.value = settings.channel || 'PUSHPLUS';
  paint();
  sel.onchange = paint;
  morning.onclick = function () {
    var next = morning.dataset.on !== '1';
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
          return '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px;'
            + ' padding:6px 8px; border:1px solid var(--zq-border-soft); border-radius:var(--zq-rs);">'
            + '<div style="min-width:0;"><div style="font-weight:var(--zq-fw-medium);">' + sh.esc(t.name) + ' <span class="zq-mono" style="color:var(--zq-text3); font-weight:var(--zq-fw-regular);">' + sh.esc(t.hint) + '</span></div>'
            + '<div style="color:var(--zq-text3); font-size:11px;">' + (t.lastUsedAt ? '最近使用 ' + sh.esc(String(t.lastUsedAt).replace('T', ' ').slice(0, 16)) : '还没用过')
            + '</div></div><button class="zq-btn-ghost" data-revoke="' + sh.esc(t.id) + '" style="height:24px; padding:0 10px; font-size:11.5px;">撤销</button></div>';
        }).join('')
      : '<div style="font-size:11.5px; color:var(--zq-text3);">还没有命令行登录过。</div>';
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
    device.innerHTML = '<div style="padding:10px 12px; border:1px solid var(--zq-border-soft); border-radius:var(--zq-rs); background:var(--zq-card-soft); font-size:12px; line-height:1.6;">'
      + '<div><strong>' + sh.esc(info.clientName || '命令行') + '</strong> 请求登录你的账号</div>'
      + '<div style="color:var(--zq-text3);">来自 ' + sh.esc(info.clientIp || '未知地址') + ' · ' + sh.esc(String(info.createdAt || '').replace('T', ' ').slice(0, 16)) + ' · 设备码 ' + sh.esc(info.userCode) + '</div>'
      + '<div style="color:var(--zq-text2); margin-top:4px;">只在这是你自己刚刚在终端里发起的时候才允许。</div>'
      + '<div style="display:flex; gap:8px; margin-top:8px;"><button class="zq-btn" id="zq-cli-approve" style="height:28px; padding:0 14px; font-size:12px;">允许</button>'
      + '<button class="zq-btn-ghost" id="zq-cli-deny" style="height:28px; padding:0 12px; font-size:12px;">拒绝</button></div></div>';
    $('#zq-cli-approve').onclick = function () {
      sh.safe('允许命令行登录', async function () {
        await sh.api.post('/access-tokens/device/' + encodeURIComponent(info.userCode) + '/approve', {});
        device.innerHTML = '<div style="font-size:12px; color:var(--zq-q2);">已允许。回到终端，命令行会自动完成登录。</div>';
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
        device.innerHTML = '<div style="font-size:12px; color:var(--zq-text3);">已拒绝。</div>';
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
  var handle = sh.openModal({
    title: '设置',
    width: '880px',
    bodyHtml: '<div class="zq-settings"><nav class="zq-settings-tabs" role="tablist" aria-label="设置">'
      + SETTINGS_TABS.map(function (t) { return '<button type="button" role="tab" data-set-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('')
      + '</nav><section class="zq-settings-pane" role="tabpanel"></section></div>',
    onClose: opts.onClose
  });
  handle.mask.querySelector('.zq-modal').classList.add('zq-modal-wide');
  var pane = handle.body.querySelector('.zq-settings-pane');
  var current = null;
  function show(name, params) {
    if (!PANES[name]) name = SETTINGS_TABS[0][0];
    current = name;
    handle.body.querySelectorAll('[data-set-tab]').forEach(function (b) {
      var on = b.dataset.setTab === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // 换一栏 = 换一块全新的 DOM：上一栏还在路上的请求回来时写的是已经摘下来的那块，不会串到这一栏
    var fresh = document.createElement('div');
    fresh.innerHTML = PANES[name]();
    pane.replaceChildren(fresh);
    pane.scrollTop = 0;
    BINDERS[name](sh, fresh, params || {});
  }
  handle.body.querySelectorAll('[data-set-tab]').forEach(function (b) {
    b.onclick = function () {
      if (b.dataset.setTab === current) return;
      show(b.dataset.setTab);
      if (opts.onTab) opts.onTab(b.dataset.setTab);
    };
  });
  show(opts.tab, opts.params);
  return { close: handle.close, show: show };
}

/**
 * 成就（第二十六轮从导航收起，第三十轮挪进头像菜单的弹窗）。原来 achievement.html 那一页的样子和 bootAchievement / renderAchList。
 * 弹窗当场打开，列表回来再填 —— 返回的 handle 不等网络。
 */
export function openAchievements(sh, opts) {
  opts = opts || {};
  var filterBtn = function (k, label) { return '<button type="button" data-k="' + k + '" style="height:30px; padding:0 16px; border:none; cursor:pointer; font-size:12.5px; font-weight:var(--zq-fw-medium); background:var(--zq-card); color:var(--zq-text2);">' + label + '</button>'; };
  var handle = sh.openModal({
    title: '成就',
    width: '880px',
    bodyHtml: '<div style="display:flex; flex-direction:column; gap:14px;">'
      + '<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">'
      + '<span style="color:var(--zq-text2); font-size:12.5px;">按期完成、连续专注，都会沉淀成这里的里程碑。</span>'
      + '<div data-ach-filters style="display:inline-flex; border:1px solid var(--zq-border); border-radius:var(--zq-rs); overflow:hidden;">' + filterBtn('all', '全部') + filterBtn('on', '已解锁') + filterBtn('off', '未解锁') + '</div></div>'
      + '<section class="zq-grid zq-phone-2col" style="grid-template-columns:repeat(4, minmax(0,1fr));">'
      + '<article class="zq-stat"><span class="zq-stat-label">已解锁</span><strong class="zq-stat-num" style="color:var(--zq-primary);">—</strong></article>'
      + '<article class="zq-stat"><span class="zq-stat-label">全部成就</span><strong class="zq-stat-num">—</strong></article>'
      + '<article class="zq-stat"><span class="zq-stat-label">成就点数</span><strong class="zq-stat-num">—</strong></article>'
      + '<article class="zq-stat" data-ach-recent><span class="zq-stat-label">最近解锁</span><strong style="display:block; margin-top:10px; font-size:14px; line-height:1.3;">—</strong><span style="display:block; margin-top:4px; font-size:11.5px; color:var(--zq-text3);"></span></article>'
      + '</section>'
      + '<div data-ach-list class="zq-phone-1col" style="display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:14px;"></div></div>',
    onClose: opts.onClose
  });
  handle.mask.querySelector('.zq-modal').classList.add('zq-modal-wide');
  var root = handle.body;
  var list = null;   // 还没回来时是 null：列表区先空着，不说「暂无成就」
  function renderAchList(filter) {
    root.querySelectorAll('[data-ach-filters] button').forEach(function (b) {
      var on = b.dataset.k === filter;
      b.style.background = on ? 'var(--zq-primary)' : 'var(--zq-card)';
      b.style.color = on ? 'var(--zq-on-primary)' : 'var(--zq-text2)';
    });
    if (!list) return;
    var shown = list.filter(function (a) {
      var on = !!(a.unlocked || a.unlockedAt);
      return filter === 'all' ? true : (filter === 'on' ? on : !on);
    });
    root.querySelector('[data-ach-list]').innerHTML = shown.map(function (a) {
      var on = !!(a.unlocked || a.unlockedAt);
      var name = a.name || a.title || a.achievementName || '成就';
      var desc = a.description || '';
      var points = a.points || a.score || 0;
      return '<article style="padding:16px;border:1px solid ' + (on ? 'var(--zq-ok-tint)' : 'var(--zq-border-soft)') + ';border-radius:var(--zq-rm);background:var(--zq-card);box-shadow:var(--zq-sh1);opacity:' + (on ? 1 : .82) + ';"><div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;"><div style="width:42px;height:42px;flex:none;border-radius:50%;background:' + (on ? 'var(--zq-ok-tint)' : 'var(--zq-card-soft)') + ';color:' + (on ? 'var(--zq-ok)' : 'var(--zq-text3)') + ';display:flex;align-items:center;justify-content:center;">' + sh.icon('award') + '</div><div style="min-width:0;"><h3 style="margin:0;font-size:14.5px;font-weight:var(--zq-fw-medium);">' + sh.esc(name) + '</h3><span style="font-size:11.5px;color:' + (on ? 'var(--zq-ok)' : 'var(--zq-text3)') + ';font-weight:var(--zq-fw-medium);">' + (on ? '已解锁' : '进行中') + '</span></div></div><p style="margin:0 0 10px;font-size:12.5px;color:var(--zq-text2);line-height:1.55;min-height:38px;">' + sh.esc(desc) + '</p><div style="display:flex;justify-content:flex-end;font-size:11.5px;color:var(--zq-text3);"><span class="zq-num">+' + sh.esc(points) + ' 点</span></div></article>';
    }).join('') || sh.empty('暂无成就');
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
