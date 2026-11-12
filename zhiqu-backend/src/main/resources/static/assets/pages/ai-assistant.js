// AI 助手 —— 第三十七轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步的最后一块）。形状见 pages/admin.js 的开头。
// Notebook 与资料、聊天与流式（含断线从库里接回、断网发送）、执行轨迹、计划草稿确认、代码工作区面板。
// 留在壳里、经 zqShared 给的：请求与它的错误、登录跳转、业务时钟、草稿、弹窗与提示、Markdown 渲染、右键菜单（Wiki 也用）。
// 另外导出给测试直接 import 的纯函数（parseSseFrame、stepNoteHtml、messageBodyHtml …），见文件末尾。

let API, REQUEST_TIMEOUT_MS, api, token, role, requestError, redirectToLogin, nowMs, serverTime, state, esc, $, $all, empty, safe, toast, notice,
  askConfirm, askText, openModal, popMenu, drafts, keepDraft, freqLabel, normalizeModelList, renderMarkdown, renderMathIn, icon;
export function bind(sh) {
  ({ API, REQUEST_TIMEOUT_MS, api, token, role, requestError, redirectToLogin, nowMs, serverTime, state, esc, $, $all, empty, safe, toast, notice,
  askConfirm, askText, openModal, popMenu, drafts, keepDraft, freqLabel, normalizeModelList, renderMarkdown, renderMathIn, icon } = sh);
}

export const boots = { 'ai-assistant.html': (sh) => { bind(sh); startWaitTicker(); return bootAiAssistant(); } };

async function bootAiAssistant() {
  restoreAiToggles();
  var webBtn = $('#zq-web'), effortBtn = $('#zq-effort'), sendBtn = $('#zq-send'), draft = $('#zq-draft');
  if (webBtn) webBtn.onclick = function () { aiToggle('web'); };
  if (effortBtn) effortBtn.onclick = toggleEffortMenu;
  if (sendBtn) sendBtn.onclick = sendAiMessage;
  if (draft) {
    if (inDesktop()) draft.placeholder = '给 AI 发消息（⌘/Ctrl + 回车发送，回车换行，/ 看命令）';
    state.chatDraft = keepDraft(draft, chatDraftKey, growDraft);
    bindSlash(draft);
  }

  // 先确定当前 Notebook，聊天记录按 Notebook 隔离加载。
  // 工作区与 notebook / 模型并行拉：它是独立的一块，不该让首屏多等一轮
  await Promise.all([loadAiNotebooks(), loadAiModelSelect(), loadWorkspace()]);
  // 聊天记录和右侧的执行轨迹都只等 Notebook 定下来，互相不等（第三十九轮：原来轨迹排在记录渲染完之后才去取）
  await Promise.all([loadAiMessages(), renderAgentPanels()]);

  var sourceUpload = $('#zq-source-upload');
  if (sourceUpload) sourceUpload.onclick = function () {
    chooseAiFiles(function (files) { uploadAiFiles(files, false); });
  };
  var chatUpload = $('#zq-chat-upload');
  if (chatUpload) chatUpload.onclick = function () {
    chooseAiFiles(function (files) { uploadAiFiles(files, true); });
  };
  bindAiDropZone();

  var addUrlBtn = $('#zq-add-url');
  if (addUrlBtn) addUrlBtn.onclick = async function () { if (!state.notebookId) return toast('请先选择 Notebook', 'error'); var url = await askText({ title: '添加 URL 资料', label: '资料网址', placeholder: 'https://…', hint: '添加后将自动抓取网页内容并解析进当前 Notebook。', okText: '添加' }); if (!url || !url.trim()) return; safe('添加 URL', async function () { await api.post('/ai/notebooks/' + state.notebookId + '/sources', { url: url.trim() }); toast('已添加，正在抓取解析'); await loadAiSources(); }); };
  var newNbBtn = $('#zq-new-notebook');
  if (newNbBtn) newNbBtn.onclick = function () {
    openModal({
      title: '新建 Notebook',
      bodyHtml:
        '<div class="zq-field"><label class="zq-label">名称</label><input id="zq-nb-name" class="zq-input" placeholder="例如：项目资料" value="新资料本"></div>'
        + '<div class="zq-field"><label class="zq-label">说明（可选）</label><textarea id="zq-nb-desc" class="zq-textarea" placeholder="这个资料本用来收集什么"></textarea></div>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-nb-cancel">取消</button><button type="button" class="zq-btn" id="zq-nb-ok">创建</button></div>',
      onMount: function (b, h) {
        var name = $('#zq-nb-name', b); try { name.select(); } catch (e) {}
        $('#zq-nb-cancel', b).onclick = h.close;
        $('#zq-nb-ok', b).onclick = function () {
          var title = name.value.trim(); if (!title) return toast('请填写名称', 'error');
          var description = $('#zq-nb-desc', b).value.trim();
          safe('新建 Notebook', async function () {
            var nb = await api.post('/ai/notebooks', { title: title, description: description });
            setAiNotebookId(nb && nb.id ? nb.id : state.notebookId);
            h.close(); await loadAiNotebooks(); await loadAiMessages(); toast('已新建 Notebook');
          });
        };
      }
    });
  };
  // 从别的页带着一句话过来（?ask=…，看板上的「让 AI 排一下今天」，第二十七轮）：填进输入框、不直接发 —— 和空白时的示例一个规矩。
  // 放在最后：上面载入 Notebook 时会换回这个 Notebook 存着的草稿，先填就被盖掉了。
  var ask = new URLSearchParams(location.search).get('ask');
  if (ask && draft) {
    draft.value = ask.slice(0, 500);
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* 只是不想刷新后再填一遍 */ }
    draft.focus();
  }
}


function chooseAiFiles(cb) {
  // 没有 Notebook 也让选：上传时 ensureAiNotebook 会替用户建一个（2026-10-03 走主流程：原来这里只说「请先新建」）
  var input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.pdf,.xlsx,.xls,.csv,.txt,.md,.json,.docx,.png,.jpg,.jpeg,.webp';
  input.onchange = function () {
    var files = Array.prototype.slice.call(input.files || []);
    if (files.length) cb(files);
  };
  input.click();
}

function setAiDropState(text, mode) {
  var zone = $('#zq-drop-zone'), status = $('#zq-drop-status');
  if (status && text) status.textContent = text;
  if (!zone) return;
  zone.classList.toggle('is-uploading', mode === 'uploading');
  zone.classList.toggle('is-error', mode === 'error');
}

function bindAiDropZone() {
  var zone = $('#zq-drop-zone');
  if (!zone) return;
  // 拖文件进对话这一栏：整栏盖一层「松开即可上传」（第四十四轮；原来输入框上面一直摆着一条虚线框）。
  // 拖着走的时候每进出栏里的一个子元素，dragenter / dragleave 都各来一次 —— 只看最后一个事件，那一层会跟着一闪一闪，
  // 所以数进出了几层，回到 0 才收。有的浏览器拖出窗口、按 Esc 时不给 dragleave：dragover 隔一会儿不来了也收。
  var col = $('#zq-chat-col');
  if (col) {
    var depth = 0, watchdog = 0;
    var hasFiles = function (event) {
      var types = event.dataTransfer && event.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
    };
    var settle = function () { depth = 0; clearTimeout(watchdog); col.classList.remove('is-dragging'); };
    col.addEventListener('dragenter', function (event) {
      if (!hasFiles(event)) return;   // 拖的是页面里的一段字：不管
      event.preventDefault();
      depth++;
      col.classList.add('is-dragging');
    });
    col.addEventListener('dragover', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();         // 不拦 dragover，浏览器就不让放（松手会直接打开那个文件）
      col.classList.add('is-dragging');
      clearTimeout(watchdog);
      watchdog = setTimeout(settle, 1000);
    });
    col.addEventListener('dragleave', function (event) {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) settle();
    });
    col.addEventListener('drop', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      settle();
      var files = Array.prototype.slice.call(event.dataTransfer && event.dataTransfer.files || []);
      if (files.length) uploadAiFiles(files, true);
    });
  }
  // 上传中 / 出错时的那一条状态：点它（或聚焦后按回车 / 空格）也能选文件
  zone.addEventListener('click', function () {
    chooseAiFiles(function (files) { uploadAiFiles(files, true); });
  });
  zone.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chooseAiFiles(function (files) { uploadAiFiles(files, true); });
    }
  });

  // 直接在输入框里粘贴图片 / 文件（⌘V）。走拖拽同一条上传路径，
  // 所以上传完同样会出现在左侧资料区、并自动挂到下一条消息上。
  //
  // 只在剪贴板里真的有文件时才拦截：粘贴纯文本必须照常插进输入框，
  // 一律拦掉的话用户连复制一段话进来都做不到。
  var draftInput = $('#zq-draft');
  if (draftInput) {
    draftInput.addEventListener('paste', function (event) {
      var items = (event.clipboardData && event.clipboardData.items) || [];
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (!files.length) return;   // 纯文本粘贴：不拦
      event.preventDefault();
      uploadAiFiles(files, true);
    });
  }
}

function clearPendingSources() {
  state.pendingSources = [];
  renderAiAttachments();
}

function clearUsedPendingSources(ids) {
  var used = (ids || []).map(Number);
  state.pendingSources = state.pendingSources.filter(function (item) {
    return used.indexOf(Number(item.id)) < 0;
  });
  renderAiAttachments();
}

function addPendingSource(source) {
  if (!source || !source.id || String(source.status || '').toUpperCase() !== 'READY') return;
  if (!state.pendingSources.some(function (item) { return Number(item.id) === Number(source.id); })) {
    state.pendingSources.push(source);
  }
  renderAiAttachments();
}

function renderAiAttachments() {
  var host = $('#zq-attachments');
  if (!host) return;
  host.hidden = !state.pendingSources.length;
  host.innerHTML = state.pendingSources.map(function (source) {
    return '<span class="zq-ai-attachment"><span class="zq-ai-attachment-type">' + esc(srcTypeInfo(source.sourceType)[0]) + '</span><span title="' + esc(source.title || '资料') + '">' + esc(source.title || '资料') + '</span><button type="button" data-remove-source="' + source.id + '" aria-label="移除附件">' + icon('x') + '</button></span>';
  }).join('');
  $all('[data-remove-source]', host).forEach(function (button) {
    button.onclick = function () {
      var id = Number(button.dataset.removeSource);
      state.pendingSources = state.pendingSources.filter(function (item) { return Number(item.id) !== id; });
      renderAiAttachments();
    };
  });
}

/**
 * 资料总要放进一个 Notebook。用户没选的时候（「普通聊天」）原来直接拒绝：「请先新建或选择 Notebook，再上传资料」——
 * 输入框旁边的「上传」按钮点了只会报错，而用户只是想把一个文件交给 AI（2026-10-03 走主流程）。
 * 现在按第一个文件的名字建一个、切过去；已经打在输入框里的字跟着过去（草稿按 Notebook 分开存，不带过去就像被吞了）。
 */
async function ensureAiNotebook(files) {
  if (state.notebookId) return state.notebookId;
  var first = files[0] && files[0].name ? String(files[0].name).replace(/\.[^.]+$/, '').trim() : '';
  var title = (first || '我的资料').slice(0, 40);
  var draft = $('#zq-draft');
  var typed = draft ? draft.value : '';
  var nb = await api.post('/ai/notebooks', { title: title, description: '上传资料时自动新建' });
  if (!nb || !nb.id) throw new Error('没能新建 Notebook');
  setAiNotebookId(nb.id);
  await loadAiNotebooks();
  await loadAiMessages();
  if (draft && typed && !draft.value) {
    draft.value = typed;
    draft.dispatchEvent(new Event('input', { bubbles: true }));
  }
  toast('已新建 Notebook「' + title + '」来放这份资料');
  return nb.id;
}

async function uploadAiFiles(files, attachToNextMessage) {
  var list = Array.prototype.slice.call(files || []).filter(Boolean);
  if (!list.length) return;
  var notebookId;
  try {
    notebookId = await ensureAiNotebook(list);
  } catch (e) {
    toast('上传之前要先有一个 Notebook，新建没有成功：' + (e.message || '请稍后再试'), 'error');
    return;
  }
  setAiDropState('正在上传 0 / ' + list.length + '…', 'uploading');
  var readyCount = 0, archiveCount = 0, errorCount = 0, imageCount = 0, firstError = '';
  for (var i = 0; i < list.length; i++) {
    setAiDropState('正在上传 ' + (i + 1) + ' / ' + list.length + '：' + list[i].name, 'uploading');
    try {
      var source = await api.upload('/ai/notebooks/' + notebookId + '/sources/upload', list[i]);
      var status = String(source && source.status || '').toUpperCase();
      if (status === 'READY') {
        readyCount++;
        if (attachToNextMessage && notebookId === state.notebookId) addPendingSource(source);
      } else if (status === 'UPLOADED') {
        archiveCount++;
        // 图片是 UPLOADED（只存原件、不做文本解析），但它照样要能挂到消息上 ——
        // 后端会把它作为视觉内容块直接交给模型。只认 READY 的话，拖进来的图片
        // 永远到不了模型面前，而界面只显示「0 份可用于问答」，看起来像没用。
        if (attachToNextMessage && notebookId === state.notebookId
            && String(source.sourceType || '').toUpperCase() === 'IMAGE') {
          addPendingSource(source);
          imageCount++;
        }
      } else {
        errorCount++;
        // 失败要说出原因。只报「1 份失败」的话，图片原件没保存下来这种事
        // 看起来跟「文件格式不对」一模一样，用户没法判断该重试还是该换文件。
        if (!firstError && source && source.parseError) firstError = String(source.parseError);
      }
    } catch (error) {
      errorCount++;
      if (!firstError && error && error.message) firstError = String(error.message);
    }
  }
  if (notebookId === state.notebookId) {
    await loadAiNotebooks();
  }
  var summary = readyCount + ' 份可用于问答';
  if (imageCount) summary += '，' + imageCount + ' 张图片已附到下一条消息';
  if (archiveCount - imageCount > 0) summary += '，' + (archiveCount - imageCount) + ' 份仅存档';
  if (errorCount) summary += '，' + errorCount + ' 份失败';
  setAiDropState(summary, errorCount && !readyCount ? 'error' : 'done');
  toast('上传完成：' + summary + (firstError ? '（' + firstError + '）' : ''),
    errorCount && !(readyCount || imageCount) ? 'error' : undefined);
}
// ───────────────────────── 输入框下面的选择（模型、思考档位、联网）：刷新、重开都还在
// 用户 2026-11-06：「每次刷新后ai助手下面的模型就会回到默认模型，深度思考等状态也没有保留，很影响体验」。
// 只记在这台浏览器。按用户分开：模型 ID 是各人的，公用电脑上换个人登录不接上一个人的。存不了（隐私窗口）、存的是坏数据都不炸，只管这一页。
// 退出登录不删：这不是内容，重新登录还接着用（草稿才要删）。
function composerPrefKey() {
  var uid = state.user && state.user.id;
  return uid == null ? null : 'zq.ai.composer.' + uid;
}
function composerPrefs() {
  var key = composerPrefKey(); if (!key) return {};
  try {
    var v = JSON.parse(localStorage.getItem(key) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
function saveComposerPref(name, value) {
  var key = composerPrefKey(); if (!key) return;
  try {
    var p = composerPrefs();
    p[name] = value;
    localStorage.setItem(key, JSON.stringify(p));
  } catch (e) { /* 存不了就只管这一页 */ }
}
var AI_TOGGLE_IDS = { web: 'zq-web' };
function setAiToggleState(kind, on) {
  var button = document.getElementById(AI_TOGGLE_IDS[kind]);
  if (!button) return;
  button.dataset.on = on ? '1' : '0';
  // 按下的样子由样式表按 aria-pressed 画（.zq-chip，第四十四轮）；原来在这里一项一项写内联样式，还写死了字重 600
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
}
function restoreAiToggles() {
  var p = composerPrefs();
  setAiToggleState('web', p.web === true);
  // 第一百零七轮记的是「深度思考」开没开（think），当时的深度思考就是 high
  paintEffort(AI_EFFORTS.indexOf(p.effort) >= 0 ? p.effort : (p.think === true ? 'high' : 'instant'));
}
// 思考档位（第一百零八轮）。用户 2026-11-07：「把深度思考的按钮换成思考档位切换（instant-medium-high-extra-max）同样还是点击之后上方拉出页面点击切换」。
// 面板只写名字（用户：「去掉档位下面的小字」），每档做什么在悬停提示里。发给后端的词在 reasoningModeForRequest，后端映射到各家（ReasoningEffort）。
var AI_EFFORTS = ['instant', 'medium', 'high', 'extra', 'max'];
var AI_EFFORT_DESC = {
  instant: '不思考，最快。有的模型关不掉思考，就按它自己的默认。',
  medium: '想一下再答。',
  high: '仔细想，慢一些、多花一些 token。',
  extra: '想得更久，更慢、更费 token。有的模型到 high 就是顶了。',
  max: '能想多久想多久，最慢、最费 token。',
};
var aiEffort = 'instant';
function paintEffort(effort) {
  aiEffort = effort;
  var btn = $('#zq-effort'), name = $('#zq-effort-name');
  if (!btn || !name) return;
  name.textContent = effort;
  btn.classList.toggle('is-on', effort !== 'instant');
  btn.title = '思考档位：' + AI_EFFORT_DESC[effort];
}
function reasoningModeForRequest() {
  return aiEffort === 'instant' ? 'OFF' : aiEffort.toUpperCase();
}
function toggleEffortMenu() {
  var menu = $('#zq-effort-menu'), btn = $('#zq-effort');
  if (wsMenuOpen && wsMenuOpen.menu === menu) { closeWorkspaceMenu(); return; }
  menu.innerHTML = AI_EFFORTS.map(function (e) {
    return '<button type="button" role="menuitemradio" class="zq-tier-item" data-effort="' + e + '" aria-checked="' + (e === aiEffort) + '" title="' + esc(AI_EFFORT_DESC[e]) + '">' + e + '</button>';
  }).join('');
  $all('[data-effort]', menu).forEach(function (b) {
    b.onclick = function () { chooseEffort(b.getAttribute('data-effort')); };
  });
  openWorkspaceMenu(menu, btn, '[aria-checked="true"]');
}
function chooseEffort(effort) {
  closeWorkspaceMenu();
  paintEffort(effort);
  saveComposerPref('effort', effort);
}
function aiToggle(k) {
  var button = document.getElementById(AI_TOGGLE_IDS[k]);
  if (!button) return;
  var on = button.dataset.on !== '1';
  setAiToggleState(k, on);
  saveComposerPref(k, on);
}
async function loadAiModelSelect() {
  var sel = $('#zq-model'); if (!sel) return;
  sel.onchange = function () { saveComposerPref('model', sel.value); };
  try {
    var models = normalizeModelList(await api.get('/ai/models'));
    // 一个能用的模型都没有时不能再写「默认模型」—— 像是有一个；新用户发出第一句才看到一行红字（2026-10-03 走主流程）
    state.aiNoModel = !(models || []).length;
    sel.innerHTML = '<option value="">' + (state.aiNoModel ? '还没有可用的模型' : '默认模型') + '</option>' + (models || []).map(function (m) {
      return '<option value="' + m.id + '">' + esc(m.label || m.displayName || m.modelName) + '</option>';
    }).join('');
    // 记的那个被删了就回到默认（不去选一个不存在的项）；取列表失败走不到这里，记的不会被擦掉
    var want = String(composerPrefs().model || '');
    if ((models || []).some(function (m) { return String(m.id) === want; })) sel.value = want;
    if (!(state.messages || []).length) renderAiMessages();
  } catch (e) { /* 保持默认项 */ }
}
// ───────────────────────── 输入框下面的选择到此为止
/**
 * 对话区空着的时候说点什么（2026-10-03 走主流程）：原来新用户进来是一片空白 —— 不知道有没有模型、能让它做什么。
 * 示例照着真能触发的说法写（出计划要「制定 / 生成」，写进知识库要「整理到知识库」），点一下填进输入框，不直接发。
 */
var AI_EXAMPLES = ['总结一下我上传的资料，列出要点', '根据这些资料，帮我制定下周的工作计划', '把刚才的结论整理到知识库里'];
function aiEmptyState() {
  if (state.aiNoModel) {
    return '<div data-ai-empty class="zq-ai-empty">'
      + '<div class="zq-ai-empty-title">还没有可用的 AI 模型</div>'
      + '到「设置 → AI 模型」里填一个（OpenAI 兼容、Anthropic、本地 Ollama 都行），回来就能用。'
      + '<div class="zq-ai-empty-actions"><a class="zq-btn" href="#settings/models">去配置模型 →</a></div></div>';
  }
  return '<div data-ai-empty class="zq-ai-empty">'
    + '<div class="zq-ai-empty-title">可以这样开始</div>'
    + '左边新建 Notebook、上传资料，它就会照着你的资料回答；计划和知识库的改动都先给你确认。'
    + '<div class="zq-ai-empty-actions is-examples">' + AI_EXAMPLES.map(function (t) {
      return '<button type="button" class="zq-btn-ghost" data-ai-example="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('') + '</div></div>';
}
// ── 回答里的每一步（第一百二十七轮，用户要的：「像 codex 那样把思考 - run command - create - edit - ls 等等命令和结果按顺序列出来」）──
// 一步一行：图标 + 动作 + 对象 + 结果小结；有细节的（命令输出、diff、列表）是一个 <details>，点开看。
// 形状见 zhiqu-cli/src/steps.js 和后端的 TraceSteps。命令输出、文件内容、标题都是不可信的：一律 esc，样子全在样式表（.zq-trace*）。
var TRACE_ICON = {
  thinking: 'brain', list: 'folder', read: 'file', search: 'search', run: 'terminal', create: 'file-plus', edit: 'pencil', patch: 'pencil',
  delete: 'trash-2', web: 'globe', retrieve: 'book-open', tasks: 'list-checks', wiki: 'book-marked', plan: 'clipboard-check',
  memory: 'lightbulb', check: 'check', agent: 'users', todo: 'list-checks', other: 'sparkles'
};
var TRACE_SHOWN = 60;   // 一条回答默认列多少步；再多的折成「还有 N 步」，点开再看（上百步的一轮不把页面撑到几屏长）
function traceDuration(ms) {
  if (!(ms >= 0)) return '';
  if (ms < 1000) return '';
  var secs = Math.round(ms / 1000);
  return secs < 60 ? secs + ' 秒' : Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒';
}
function traceDiffHtml(lines) {
  return '<div class="zq-mono zq-diff zq-trace-diff">' + lines.map(function (l) {
    var t = String(l);
    if (/^@@/.test(t)) return '<div class="zq-diff-gap">' + esc(t) + '</div>';
    var op = t.charAt(0) === '+' ? 'add' : t.charAt(0) === '-' ? 'del' : 'same';
    return '<div class="zq-diff-row" data-op="' + op + '"><span class="zq-diff-mark">' + esc(op === 'same' ? ' ' : t.charAt(0)) + '</span><span class="zq-diff-text">' + esc(t.slice(1)) + '</span></div>';
  }).join('') + '</div>';
}
function traceDetailHtml(s) {
  var d = s.detail || {};
  var out = '';
  if (d.command != null || d.output != null) {
    out += '<pre class="zq-mono zq-trace-out">';
    if (d.command) out += '<span class="zq-trace-cmd">$ ' + esc(d.command) + (d.cwd ? '  （在 ' + esc(d.cwd) + '）' : '') + '</span>\n';
    var text = String(d.output || '');
    if (d.omitted > 0 && d.splitAt > 0) {
      var lines = text.split('\n');
      text = lines.slice(0, d.splitAt).join('\n') + '\n… 中间省掉 ' + d.omitted + ' 行 …\n' + lines.slice(d.splitAt).join('\n');
    } else if (d.omitted > 0) {
      text += '\n… 后面省掉 ' + d.omitted + ' 行';
    }
    out += esc(text || '（没有输出）');
    if (d.exitCode != null) out += '\n<span class="zq-trace-exit" data-state="' + (d.exitCode === 0 ? 'ok' : 'bad') + '">退出码 ' + esc(d.exitCode) + '</span>';
    out += '</pre>';
  }
  if (Array.isArray(d.files)) {
    out += d.files.map(function (f) {
      var head = '<div class="zq-trace-file"><span class="zq-mono">' + esc(f.movedFrom ? f.movedFrom + ' → ' + f.path : f.path) + '</span>'
        + (f.creating ? '<span class="zq-trace-tag">新建</span>' : '')
        + '<span class="zq-trace-stat"><span data-op="add">+' + esc(f.added || 0) + '</span> <span data-op="del">-' + esc(f.removed || 0) + '</span></span></div>';
      var hunks = Array.isArray(f.hunks) ? f.hunks : [];
      return head + (hunks.length ? traceDiffHtml(hunks) : '') + (f.omitted > 0 ? '<div class="zq-trace-more">… 后面还有 ' + esc(f.omitted) + ' 行改动没列出</div>' : '');
    }).join('');
    if (d.omittedFiles > 0) out += '<div class="zq-trace-more">… 还有 ' + esc(d.omittedFiles) + ' 个文件没列出</div>';
    if (Array.isArray(d.deletes) && d.deletes.length) out += '<div class="zq-trace-more">删除：' + esc(d.deletes.join('、')) + '</div>';
  }
  if (Array.isArray(d.items) && d.items.length) {
    out += '<ul class="zq-trace-items">' + d.items.map(function (it) { return '<li class="zq-mono">' + esc(it) + '</li>'; }).join('') + '</ul>'
      + (d.omitted > 0 && d.command == null ? '<div class="zq-trace-more">… 还有 ' + esc(d.omitted) + ' 项</div>' : '');
  }
  if (d.text) {
    // 思考的原文（第一百二十八轮）：和「思考摘要」同一种样子，长的说省了多少
    out += '<div class="zq-trace-thinking">' + esc(d.text) + (d.omitted > 0 ? '\n… 后面还有 ' + esc(d.omitted) + ' 字没存' : '') + '</div>';
  }
  if (Array.isArray(d.todos) && d.todos.length) {
    out += '<ul class="zq-trace-items">' + d.todos.map(function (t) {
      return '<li data-todo="' + (t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : 'todo') + '">' + esc(t.content) + '</li>';
    }).join('') + '</ul>';
  }
  return out;
}
function traceStepHtml(s, key) {
  // 判断（第一百三十轮）：一行字，不是一个动作。点不开，不画细节，标题原样转义
  if (s.kind === 'note') return '<div class="zq-trace-note" data-kind="note">' + esc(s.title || '') + '</div>';
  var state0 = s.status === 'running' ? 'running' : s.status === 'error' ? 'bad' : 'ok';
  var kind = TRACE_ICON[s.kind] ? s.kind : 'other';
  var line = '<span class="zq-trace-icon">' + icon(TRACE_ICON[kind]) + '</span>'
    + '<span class="zq-trace-title">' + esc(s.title || '') + '</span>'
    + (s.target ? '<span class="zq-mono zq-trace-target">' + esc(s.target) + '</span>' : '')
    + (s.summary ? '<span class="zq-trace-summary">' + esc(s.summary) + '</span>' : '')
    + (traceDuration(s.ms) && s.kind !== 'thinking' ? '<span class="zq-trace-time">' + esc(traceDuration(s.ms)) + '</span>' : '');
  // 有细节才能点开：流式时细节在手上（s.detail），刷新后列表里只有一行一步（s.hasDetail），点开时再去拿（loadTraceDetail）
  var expandable = s.status !== 'running' && (s.hasDetail || (s.detail && (s.kind !== 'thinking' || s.detail.text)));
  if (!expandable) return '<div class="zq-trace-step" data-state="' + state0 + '" data-kind="' + kind + '"><div class="zq-trace-line">' + line + '</div></div>';
  var openKey = key + ':' + s.id;
  var open = Boolean(state.reasoningExpanded[openKey]);
  // 合着的不画细节（review：一条回答的输出和 diff 能有几百 KB，原来合着也整份塞进 DOM，深度思考时每个字重画一次）
  var detail = !open ? '' : s.detail ? traceDetailHtml(s) : '<div class="zq-trace-more">正在取…</div>';
  return '<details class="zq-trace-step" data-state="' + state0 + '" data-kind="' + kind + '" data-reason-key="' + esc(openKey) + '" data-trace-step="' + esc(s.id) + '"'
    + (open ? ' open' : '') + '><summary class="zq-trace-line">' + line + '</summary>'
    + '<div class="zq-trace-detail">' + detail + '</div></details>';
}
/**
 * 一条回答的步骤列表。key 是这条消息的键（展开状态记在 state.reasoningExpanded[key + ':' + 步骤 id]，
 * 和思考摘要同一套：全量重画时 renderAiMessages 先存再还原）。
 */
function traceStepsHtml(trace, key) {
  var steps = (trace && trace.steps) || [];
  var allKey = key + ':all';
  var showAll = Boolean(state.reasoningExpanded[allKey]);
  var shown = showAll ? steps : steps.slice(0, TRACE_SHOWN);
  var hidden = steps.length - shown.length;
  var rows = shown.map(function (s) { return traceStepHtml(s, key); }).join('');
  var tail = '';
  if (hidden > 0) tail += '<button type="button" class="zq-trace-more" data-trace-all="' + esc(allKey) + '">还有 ' + esc(hidden) + ' 步，点开看全部</button>';
  if (trace && trace.dropped > 0) tail += '<div class="zq-trace-more">… 后面还有 ' + esc(trace.dropped) + ' 步没存</div>';
  return '<div class="zq-trace" data-trace-key="' + esc(key) + '">' + rows + tail + '</div>';
}
/** 刷新之后点开一步：这条回答的步骤（带细节）取一次，按 id 补进去再重画这一条。取不到就照实说 */
function loadTraceDetail(m, index) {
  if (!m || !m.id || m._traceLoading) return;
  m._traceLoading = true;
  api.get('/ai/messages/' + m.id + '/steps').then(function (full) {
    var byId = {};
    ((full && full.steps) || []).forEach(function (x) { byId[x.id] = x; });
    ((m.steps && m.steps.steps) || []).forEach(function (x) { if (byId[x.id] && byId[x.id].detail) x.detail = byId[x.id].detail; });
  }).catch(function () {
    ((m.steps && m.steps.steps) || []).forEach(function (x) { if (x.hasDetail && !x.detail) x.detail = { items: ['取不到这一步的细节，稍后再点一次'] }; });
  }).then(function () {
    m._traceLoading = false;
    if (!patchStreamingMessage(index)) renderAiMessages();
  });
}

/** SSE 的 trace.step：按 id 合进这条回答（同一步先 running、后 ok / error，位置不变） */
function mergeTraceStep(m, step) {
  if (!m || !step || step.id == null) return;
  m.steps = m.steps || { steps: [] };
  var list = m.steps.steps;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === step.id) { list[i] = step; return; }
  }
  list.push(step);
}

function renderSteps(steps) {
  var host = $('#zq-steps'); if (!host) return;
  host.innerHTML = steps.length ? steps.map(function (s, i) {
    var status = (s.status || 'DONE').toUpperCase();
    var tone = status === 'DONE' || status === 'COMPLETED' ? 'ok' : status === 'FAILED' ? 'bad' : '';
    var last = i === steps.length - 1;
    var stepName = s.publicSummary || s.title || s.name || s.agentType || ('步骤 ' + (i + 1));
    var metaLine = (s.agentType && s.publicSummary ? s.agentType + ' · ' : '') + status;
    return '<div class="zq-step" data-state="' + tone + '"><div class="zq-step-rail"><span class="zq-step-dot"></span>' + (last ? '' : '<span class="zq-step-line"></span>') + '</div>'
      + '<div class="zq-step-body"><div class="zq-step-name">' + esc(stepName) + '</div><div class="zq-mono zq-step-meta">' + esc(metaLine) + '</div>' + (s.notes || []).map(stepNoteHtml).join('') + '</div></div>';
  }).join('') : empty('暂无执行记录');
}

function artifactTypeLabel(type) {
  return ({
    CITATION: '资料引用',
    FAILED_SOURCE: '抓取失败',
    PLAN_DRAFT: '计划草稿',
    TASK_DRAFT: '任务草稿',
    ROUTINE_DRAFT: '例行计划草稿',
    WIKI_DRAFT: 'Wiki 草稿',
    MEMORY_DRAFT: '记忆草稿',
    CODE_DRAFT: '代码改动草稿',
    NOTE_DRAFT: '笔记草稿',
    GENERATED_FILES: '生成的文件'
  })[String(type || '').toUpperCase()] || '其他产物';
}

function artifactStatusLabel(status) {
  return ({
    DRAFT: '待确认',
    PENDING: '待确认',
    CONFIRMED: '已确认',
    READY: '已生成',
    DISCARDED: '已忽略',
    FAILED: '失败'
  })[String(status || '').toUpperCase()] || (status || '');
}

function normalizeArtifact(raw) {
  var source = raw && raw.artifact ? raw.artifact : (raw || {});
  return Object.assign({}, source, {
    id: source.id || source.artifactId || (raw && raw.artifactId),
    artifactType: source.artifactType || source.type || (raw && raw.artifactType),
    title: source.title || (raw && raw.title),
    status: source.status || (raw && raw.status)
  });
}

function artifactContent(artifact) {
  return artifact && artifact.content && typeof artifact.content === 'object' ? artifact.content : {};
}

function artifactTextPreview(artifact) {
  var content = artifactContent(artifact);
  var text = artifact.preview || content.preview || content.snippet || content.content || content.description || content.reason || content.error || '';
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (text.length > 190) text = text.slice(0, 187) + '…';
  return text;
}

function artifactItemTitles(artifact) {
  if (Array.isArray(artifact.itemTitles)) return artifact.itemTitles.map(String);
  var content = artifactContent(artifact), titles = [];
  ['tasks', 'routines', 'items', 'pages'].forEach(function (key) {
    if (!Array.isArray(content[key])) return;
    content[key].forEach(function (item) {
      var title = item && (item.title || item.name || item.content);
      if (title && titles.length < 8) titles.push(String(title));
    });
  });
  return titles;
}

function groupArtifacts(artifacts) {
  var output = [], citationGroups = Object.create(null);
  (artifacts || []).map(normalizeArtifact).forEach(function (artifact) {
    if (String(artifact.artifactType || '').toUpperCase() !== 'CITATION') {
      output.push(artifact);
      return;
    }
    var content = artifactContent(artifact);
    var sourceId = content.sourceId != null ? content.sourceId : artifact.sourceId;
    var sourceUrl = content.url || artifact.url;
    var key = sourceId != null ? 'source:' + sourceId
      : sourceUrl ? 'url:' + sourceUrl
        : 'title:' + (artifact.title || content.title || artifact.id);
    if (!citationGroups[key]) {
      citationGroups[key] = Object.assign({}, artifact, { _citationParts: [] });
      output.push(citationGroups[key]);
    }
    citationGroups[key]._citationParts.push(artifact);
  });
  return output;
}

function artifactDetailsHtml(artifact) {
  var type = String(artifact.artifactType || '').toUpperCase();
  if (type === 'CITATION') {
    var parts = artifact._citationParts || [artifact];
    return parts.map(function (part, index) {
      var content = artifactContent(part);
      var chunkIndex = content.chunkIndex != null ? content.chunkIndex : part.chunkIndex;
      var label = chunkIndex != null ? '片段 ' + (Number(chunkIndex) + 1) : '命中片段 ' + (index + 1);
      var snippet = content.content || content.snippet || part.preview || '暂无片段预览';
      return '<div class="zq-artifact-part"><strong>' + esc(label) + '</strong><span>' + esc(snippet) + '</span></div>';
    }).join('');
  }
  var content = artifactContent(artifact);
  var safeJson = Object.keys(content).length ? JSON.stringify(content, null, 2) : JSON.stringify({
    title: artifact.title || '',
    preview: artifact.preview || '',
    itemCount: artifact.itemCount || 0,
    itemTitles: artifact.itemTitles || []
  }, null, 2);
  return '<pre class="zq-artifact-json">' + esc(safeJson) + '</pre>';
}

// ── AI 计划草稿确认弹窗 ────────────────────────────────────────────────
// 计划不会自动进日历：AI 生成后先落成 DRAFT 产物，弹窗让用户 忽略/修改/确认，
// 只有「确认」才调 /ai/artifacts/{id}/confirm 真正写入任务与例行计划。
var PLAN_DRAFT_TYPES = ['PLAN_DRAFT', 'TASK_DRAFT', 'ROUTINE_DRAFT'];
var shownPlanModals = Object.create(null); // 已弹过的产物 id，避免同一草稿反复打扰
var activePlanModal = null;
var planModalQueue = [];
var planModalGeneration = 0;
var planModalNotebookId;

function clearPlanModalQueue() {
  var previous = activePlanModal;
  activePlanModal = null;
  planModalQueue = [];
  planModalGeneration++;
  planModalNotebookId = state.notebookId;
  if (previous && previous.handle) previous.handle.close();
}

function setAiNotebookId(id) {
  if (state.notebookId === id) return;
  state.notebookId = id;
  clearPlanModalQueue();
}

function advancePlanModalQueue() {
  if (activePlanModal || planModalNotebookId !== state.notebookId) return null;
  while (planModalQueue.length) {
    var next = planModalQueue.shift();
    if (!isPlanDraft(next) || shownPlanModals[next.id]) continue;
    return openPlanConfirmModal(next) ? next : null;
  }
  return null;
}

function isPlanDraft(artifact) {
  var type = String(artifact.artifactType || '').toUpperCase();
  var status = String(artifact.status || '').toUpperCase();
  return PLAN_DRAFT_TYPES.indexOf(type) >= 0 && (status === 'DRAFT' || status === 'PENDING');
}

// 取出草稿里的条目副本；保留原始字段（象限/时长/提醒等），弹窗只覆盖用户改过的字段后原样回传
function planDraftItems(artifact) {
  var content = artifactContent(artifact);
  var type = String(artifact.artifactType || '').toUpperCase();
  var tasks = Array.isArray(content.tasks) ? content.tasks
    : Array.isArray(content.suggestedTasks) ? content.suggestedTasks : [];
  var routines = Array.isArray(content.routines) ? content.routines
    : Array.isArray(content.suggestedRoutines) ? content.suggestedRoutines : [];
  if (!tasks.length && type === 'TASK_DRAFT' && content.title) tasks = [content];
  if (!routines.length && type === 'ROUTINE_DRAFT' && content.title) routines = [content];
  var copy = function (item) { return Object.assign({}, item); };
  return { tasks: tasks.map(copy), routines: routines.map(copy) };
}

// SSE 的预览/重复事件和 GET 详情共用合并规则：不丢完整字段，不把已确认/忽略退回待确认。
function mergeAgentArtifact(current, incoming) {
  if (!current) return incoming;
  var terminal = ['CONFIRMED', 'DISCARDED', 'FAILED'];
  if (terminal.indexOf(String(current.status || '').toUpperCase()) >= 0
      && terminal.indexOf(String(incoming.status || '').toUpperCase()) < 0) return current;
  var merged = Object.assign({}, current, incoming);
  if (!incoming.content || typeof incoming.content !== 'object') merged.content = current.content;
  return merged;
}

function showFreshPlanDraft(artifacts) {
  if (planModalNotebookId !== state.notebookId) clearPlanModalQueue();
  var current = (artifacts || []).map(normalizeArtifact);
  // reload 或终态事件已撤销当前草稿时关闭旧确认框；其 onClose 不得继续旧队列。
  if (activePlanModal && !current.some(function (artifact) {
    return String(artifact.id) === String(activePlanModal.id) && isPlanDraft(artifact);
  })) clearPlanModalQueue();
  planModalQueue = current.filter(function (artifact) {
    if (artifact.id == null || !isPlanDraft(artifact) || shownPlanModals[artifact.id]) return false;
    var items = planDraftItems(artifact);
    return items.tasks.length || items.routines.length;
  });
  return advancePlanModalQueue();
}

// 刚生成了文件：产物那栏收着的话打开（用户得看得到）。手机上这栏是盖在对话上面的，不替他打开
function revealArtifactsPanel() {
  var panel = document.querySelector('[data-zq-collapse="right"]');
  if (!panel || !panel.classList.contains('zq-collapsed') || window.innerWidth <= 760) return;
  var opener = panel.querySelector('.zq-xbtn');
  if (opener) opener.click();
}

function receiveAgentArtifact(raw) {
  var incoming = normalizeArtifact(raw);
  if (incoming.id == null) return null;
  var existingIndex = state.agentArtifacts.findIndex(function (item) {
    return String(normalizeArtifact(item).id) === String(incoming.id);
  });
  if (existingIndex >= 0) incoming = mergeAgentArtifact(state.agentArtifacts[existingIndex], incoming);
  if (existingIndex >= 0) state.agentArtifacts[existingIndex] = incoming;
  else state.agentArtifacts.push(incoming);
  state.agentArtifactRevision = (state.agentArtifactRevision || 0) + 1;
  renderArtifacts(state.agentArtifacts);
  showFreshPlanDraft(state.agentArtifacts);
  if (String(incoming.artifactType || '').toUpperCase() === 'GENERATED_FILES') revealArtifactsPanel();
  return incoming;
}

function planTaskMeta(item) {
  var bits = [];
  if (item.deadline) bits.push('截止 ' + item.deadline);
  if (item.startTime) bits.push('开始 ' + item.startTime);
  if (item.durationMinutes) bits.push(item.durationMinutes + ' 分钟');
  var q = item.quadrant || item.suggestedQuadrant;
  if (q) bits.push('第 ' + q + ' 象限');
  return bits.join(' · ');
}
function planRoutineMeta(item) {
  var bits = [];
  if (item.frequency) bits.push(freqLabel(item.frequency, item.daysOfWeek));
  if (item.preferredTime) bits.push(item.preferredTime);
  if (item.durationMinutes) bits.push(item.durationMinutes + ' 分钟');
  if (item.startDate) bits.push(item.startDate + (item.endDate ? ' → ' + item.endDate : ''));
  return bits.join(' · ');
}


// 记忆草稿：AI 从对话里挑出的长期事实，逐条勾选，确认后才并进长期记忆。
// 和计划草稿同一条纪律——不确认不落库；记忆更需要它，因为它会进后续每一轮的系统提示词。
var shownMemoryModals = Object.create(null);

function isMemoryDraft(artifact) {
  var status = String(artifact.status || '').toUpperCase();
  return String(artifact.artifactType || '').toUpperCase() === 'MEMORY_DRAFT'
    && (status === 'DRAFT' || status === 'PENDING');
}

function memoryDraftItems(artifact) {
  var content = artifactContent(artifact);
  var items = Array.isArray(content.items) ? content.items : [];
  return items.map(function (item) {
    return typeof item === 'string' ? { text: item } : Object.assign({}, item);
  }).filter(function (item) { return String(item.text || '').trim(); });
}

function openMemoryConfirmModal(artifact) {
  var items = memoryDraftItems(artifact);
  if (!items.length) return null;
  shownMemoryModals[artifact.id] = true;
  var picked = items.map(function () { return true; });
  var handle = openModal({ title: 'AI 想记住这些', width: 520, bodyHtml: '<div class="zq-plan-confirm"></div>' });
  var root = handle.body.querySelector('.zq-plan-confirm');

  function paint() {
    var html = '<p class="zq-plan-hint">以下内容会长期影响 AI 对你的了解，'
      + '<strong>确认后才会写入长期记忆</strong>。</p><div class="zq-plan-group">';
    items.forEach(function (item, i) {
      html += '<label class="zq-plan-row">'
        + '<input type="checkbox" data-pick="' + i + '"' + (picked[i] ? ' checked' : '') + '>'
        + '<div class="zq-plan-row-body"><div class="zq-plan-name">' + esc(String(item.text)) + '</div></div>'
        + '</label>';
    });
    html += '</div><div class="zq-plan-actions">'
      + '<button class="zq-btn" data-mem="ignore">忽略</button>'
      + '<button class="zq-btn zq-btn-primary" data-mem="ok">确认写入</button></div>';
    root.innerHTML = html;
    $all('[data-pick]', root).forEach(function (box) {
      box.onchange = function () { picked[Number(box.dataset.pick)] = box.checked; };
    });
    $('[data-mem="ignore"]', root).onclick = function () {
      safe('忽略记忆草稿', async function () {
        await api.post('/ai/artifacts/' + artifact.id + '/discard', {});
        handle.close(); toast('已忽略'); await renderAgentPanels();
      });
    };
    $('[data-mem="ok"]', root).onclick = function () {
      var chosen = items.filter(function (_, i) { return picked[i]; });
      if (!chosen.length) { toast('请至少勾选一条，或点「忽略」'); return; }
      safe('确认记忆', async function () {
        await api.post('/ai/artifacts/' + artifact.id + '/confirm', { items: chosen });
        handle.close(); toast('已写入长期记忆'); await renderAgentPanels();
      });
    };
  }
  paint();
  return handle;
}

// ── 代码草稿：AI 改代码的产物，确认之前磁盘一个字节都没动 ─────────────────
//
// 与计划 / 记忆草稿同一条纪律，但确认的后果更重：写的是用户自己电脑上的源码。
// 所以弹窗展示的是 **diff**，不是整份新内容 —— 用户要能一眼看出改了哪几行。
var shownCodeModals = Object.create(null);

function isCodeDraft(artifact) {
  var status = String(artifact.status || '').toUpperCase();
  return String(artifact.artifactType || '').toUpperCase() === 'CODE_DRAFT'
    && (status === 'DRAFT' || status === 'PENDING');
}

function codeDraftDesktop(artifact) {
  var content = artifactContent(artifact);
  return !!(content && content.desktop);
}
function codeDraftFolder(artifact) {
  var content = artifactContent(artifact);
  return content && content.folder ? String(content.folder) : '';
}
function codeDraftFiles(artifact) {
  var content = artifactContent(artifact);
  var files = Array.isArray(content.files) ? content.files : [];
  return files.filter(function (f) { return f && f.path; }).map(function (f) {
    return { path: String(f.path), content: String(f.content == null ? '' : f.content),
             baseline: f.baseline, creating: !!f.creating,
             newDirectories: Array.isArray(f.newDirectories) ? f.newDirectories.map(String) : [] };
  });
}

/**
 * 逐行 diff（最长公共子序列）。
 *
 * <p>行数乘积超过 LCS_BUDGET 就不算了 —— O(n·m) 的表在大文件上会把浏览器卡死，
 * 而「卡死」比「没有 diff」糟糕得多。这时退回整份替换视图，并明说退回了。
 */
var LCS_BUDGET = 2000 * 2000;

function diffLines(oldText, newText) {
  var a = String(oldText == null ? '' : oldText).split('\n');
  var b = String(newText == null ? '' : newText).split('\n');
  if (a.length * b.length > LCS_BUDGET) return null;
  var m = a.length, n = b.length;
  var table = [];
  for (var i = 0; i <= m; i++) table.push(new Int32Array(n + 1));
  for (var i2 = m - 1; i2 >= 0; i2--) {
    for (var j2 = n - 1; j2 >= 0; j2--) {
      table[i2][j2] = a[i2] === b[j2] ? table[i2 + 1][j2 + 1] + 1
        : Math.max(table[i2 + 1][j2], table[i2][j2 + 1]);
    }
  }
  var out = [], i3 = 0, j3 = 0;
  while (i3 < m && j3 < n) {
    if (a[i3] === b[j3]) { out.push([' ', a[i3]]); i3++; j3++; }
    else if (table[i3 + 1][j3] >= table[i3][j3 + 1]) { out.push(['-', a[i3]]); i3++; }
    else { out.push(['+', b[j3]]); j3++; }
  }
  while (i3 < m) { out.push(['-', a[i3++]]); }
  while (j3 < n) { out.push(['+', b[j3++]]); }
  return out;
}

/** 只显示改动附近的行，中间大段未改动的折起来 —— 否则一个长文件里几行改动根本找不到。 */
function diffHtml(rows) {
  if (!rows) {
    return '<div class="zq-diff-note">'
      + '文件太大，没有逐行比对（那会把浏览器卡住）。请确认后自行用 git 查看改动。</div>';
  }
  var CONTEXT = 3;
  var keep = rows.map(function () { return false; });
  rows.forEach(function (r, i) {
    if (r[0] === ' ') return;
    for (var k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  var html = '', skipped = 0;
  // 颜色在样式表（.zq-diff-row[data-op]：新增 --zq-q2、删除 --zq-bad，底色是同色 12%）
  var op = { '+': 'add', '-': 'del', ' ': 'same' };
  rows.forEach(function (r, i) {
    if (!keep[i]) { skipped++; return; }
    if (skipped) {
      html += '<div class="zq-diff-gap">⋯ 省略 ' + skipped + ' 行未改动 ⋯</div>';
      skipped = 0;
    }
    html += '<div class="zq-diff-row" data-op="' + op[r[0]] + '"><span class="zq-diff-mark">' + r[0] + '</span>'
      + '<span class="zq-diff-text">' + esc(r[1]) + '</span></div>';
  });
  if (skipped) {
    html += '<div class="zq-diff-gap">⋯ 省略 ' + skipped + ' 行未改动 ⋯</div>';
  }
  return '<div class="zq-mono zq-diff">' + (html || '<div class="zq-diff-note">没有差异</div>') + '</div>';
}

function openCodeConfirmModal(artifact) {
  var files = codeDraftFiles(artifact);
  if (!files.length) return null;
  shownCodeModals[artifact.id] = true;
  var picked = files.map(function () { return true; });
  var handle = openModal({ title: 'AI 想改这些文件', width: 760, bodyHtml: '<div class="zq-plan-confirm"></div>' });
  var root = handle.body.querySelector('.zq-plan-confirm');
  root.innerHTML = '<p class="zq-plan-hint">正在读取文件当前内容…</p>';

  // 先把每个文件<b>现在</b>的内容取回来再比 —— diff 要比的是「磁盘上现在是什么」，
  // 不是模型当时读到的那份。中间用户可能已经自己改过了，那种情况确认时会被基线挡住，
  // 但在弹窗里就该让他看见。
  var onDesktop = codeDraftDesktop(artifact);
  var desktopFolder = codeDraftFolder(artifact);
  Promise.all(files.map(function (f) {
    if (f.creating) return Promise.resolve('');
    if (onDesktop) {
      if (!inDesktop()) return Promise.resolve(null);
      return localCall({ action: 'read', folder: desktopFolder, path: f.path })
        .then(function (r) { return r && r.absent ? '' : (r && r.content != null ? r.content : ''); })
        .catch(function () { return null; });
    }
    return api.get('/workspace/file?path=' + encodeURIComponent(f.path))
      .then(function (r) { return r && r.content != null ? r.content : ''; })
      .catch(function () { return null; });   // 读不到就标出来，而不是当成空文件
  })).then(function (currents) {
    if (onDesktop && !inDesktop()) {
      root.innerHTML = '<p class="zq-plan-hint">这些改动要在桌面应用里确认，才会写进你电脑上的项目。</p>';
      return;
    }
    function paint() {
      var html = '<p class="zq-plan-hint">这些改动<strong>还没有写进磁盘</strong>。'
        + '看过 diff、点「确认写入」之后才会落盘。</p>';
      files.forEach(function (f, i) {
        var current = currents[i];
        var unreadable = current === null;
        html += '<div class="zq-plan-group is-code">'
          + '<label class="zq-plan-row">'
          + '<input type="checkbox" data-pick="' + i + '"' + (picked[i] ? ' checked' : '') + '>'
          + '<div class="zq-plan-row-body"><div class="zq-plan-name zq-mono">' + esc(f.path)
          + (f.creating ? '<span class="zq-plan-tag">新建</span>' : '')
          + (f.newDirectories.length ? '<span class="zq-plan-tag">连同新建目录 '
              + esc(f.newDirectories.join('、')) + '</span>' : '')
          + (unreadable ? '<span class="zq-plan-tag" data-state="bad">读不到当前内容</span>' : '')
          + '</div></div></label>'
          + (unreadable ? '' : diffHtml(diffLines(current, f.content)))
          + '</div>';
      });
      html += '<div class="zq-plan-actions">'
        + '<button class="zq-btn" data-code="ignore">忽略</button>'
        + '<button class="zq-btn zq-btn-primary" data-code="ok">确认写入</button></div>';
      root.innerHTML = html;
      $all('[data-pick]', root).forEach(function (box) {
        box.onchange = function () { picked[Number(box.dataset.pick)] = box.checked; };
      });
      $('[data-code="ignore"]', root).onclick = function () {
        safe('忽略代码草稿', async function () {
          await api.post('/ai/artifacts/' + artifact.id + '/discard', {});
          handle.close(); toast('已忽略'); await renderAgentPanels();
        });
      };
      $('[data-code="ok"]', root).onclick = function () {
        var chosen = files.filter(function (_, i) { return picked[i]; }).map(function (f) { return { path: f.path }; });
        if (!chosen.length) { toast('请至少勾选一个文件，或点「忽略」'); return; }
        safe('写入代码改动', async function () {
          if (onDesktop) {
            if (!inDesktop()) { toast('要在桌面应用里确认，才会写进你的电脑', 'error'); return; }
            var full = files.filter(function (_, i) { return picked[i]; }).map(function (f) {
              return { path: f.path, content: f.content, baseline: f.baseline || 'ABSENT' };
            });
            await localCall({ action: 'apply', folder: desktopFolder, files: full });
          }
          await api.post('/ai/artifacts/' + artifact.id + '/confirm', onDesktop ? { files: chosen, desktopApplied: true } : { files: chosen });
          handle.close(); toast('已写入 ' + chosen.length + ' 个文件'); await renderAgentPanels();
        });
      };
    }
    paint();
  });
  return handle;
}

function openPlanConfirmModal(artifact) {
  var data = planDraftItems(artifact);
  if (!data.tasks.length && !data.routines.length) return null;
  if (planModalNotebookId !== state.notebookId) clearPlanModalQueue();
  if (activePlanModal) {
    if (String(activePlanModal.id) === String(artifact.id)) return activePlanModal.handle;
    if (!planModalQueue.some(function (item) { return String(item.id) === String(artifact.id); })) planModalQueue.unshift(artifact);
    return null;
  }
  shownPlanModals[artifact.id] = true;
  var editing = false;
  var picked = {
    tasks: data.tasks.map(function () { return true; }),
    routines: data.routines.map(function () { return true; })
  };
  var entry = { id: artifact.id, notebookId: state.notebookId, generation: planModalGeneration, handle: null };
  activePlanModal = entry;
  var handle = openModal({ title: 'AI 生成的计划', width: 640, bodyHtml: '<div class="zq-plan-confirm"></div>',
    onClose: function () {
      if (activePlanModal !== entry) return;
      activePlanModal = null;
      if (entry.generation === planModalGeneration && entry.notebookId === state.notebookId) advancePlanModalQueue();
      else clearPlanModalQueue();
    }
  });
  entry.handle = handle;
  var root = handle.body.querySelector('.zq-plan-confirm');

  function rowHtml(kind, item, index, metaFn) {
    var whenValue = kind === 'tasks'
      ? (item.deadline || item.startTime || '')
      : (item.preferredTime || '');
    var inner = editing
      ? '<input class="zq-plan-title" data-kind="' + kind + '" data-i="' + index + '" value="' + esc(String(item.title || '')) + '">'
        + '<input class="zq-plan-when" data-kind="' + kind + '" data-i="' + index + '" value="' + esc(String(whenValue)) + '"'
        + ' placeholder="' + (kind === 'tasks' ? '截止时间，如 2026-07-15 23:59:59' : '时间，如 08:00') + '">'
      : '<div class="zq-plan-name">' + esc(String(item.title || '未命名')) + '</div>'
        + (metaFn(item) ? '<div class="zq-plan-meta">' + esc(metaFn(item)) + '</div>' : '');
    return '<label class="zq-plan-row">'
      + '<input type="checkbox" data-pick="' + kind + '" data-i="' + index + '"' + (picked[kind][index] ? ' checked' : '') + '>'
      + '<div class="zq-plan-row-body">' + inner + '</div></label>';
  }

  function paint() {
    var html = '<p class="zq-plan-hint">' + (editing
      ? '勾选要写入的条目，并可直接修改标题与时间。'
      : 'AI 建议了以下安排，<strong>确认后才会写入你的日历</strong>。') + '</p>';
    if (data.tasks.length) {
      html += '<div class="zq-plan-group"><h4>任务 · ' + data.tasks.length + '</h4>'
        + data.tasks.map(function (t, i) { return rowHtml('tasks', t, i, planTaskMeta); }).join('') + '</div>';
    }
    if (data.routines.length) {
      html += '<div class="zq-plan-group"><h4>例行计划 · ' + data.routines.length + '</h4>'
        + data.routines.map(function (r, i) { return rowHtml('routines', r, i, planRoutineMeta); }).join('') + '</div>';
    }
    html += '<div class="zq-plan-actions">'
      + '<button type="button" class="zq-btn-ghost" data-plan="ignore">忽略</button>'
      + '<button type="button" data-plan="edit">' + (editing ? '完成修改' : '修改') + '</button>'
      + '<button type="button" class="zq-btn-primary" data-plan="ok">确认写入</button>'
      + '</div>';
    root.innerHTML = html;
    wire();
  }

  function wire() {
    $all('[data-pick]', root).forEach(function (cb) {
      cb.onchange = function () { picked[cb.dataset.pick][Number(cb.dataset.i)] = cb.checked; };
    });
    $all('.zq-plan-title', root).forEach(function (inp) {
      inp.oninput = function () { data[inp.dataset.kind][Number(inp.dataset.i)].title = inp.value; };
    });
    $all('.zq-plan-when', root).forEach(function (inp) {
      inp.oninput = function () {
        var item = data[inp.dataset.kind][Number(inp.dataset.i)];
        if (inp.dataset.kind !== 'tasks') { item.preferredTime = inp.value; return; }
        // 原来用哪个字段表达时间，就改回哪个，避免把 startTime 计划误写成 deadline
        if (!item.deadline && item.startTime) item.startTime = inp.value; else item.deadline = inp.value;
      };
    });
    $('[data-plan="edit"]', root).onclick = function () { editing = !editing; paint(); };
    $('[data-plan="ignore"]', root).onclick = function () {
      safe('忽略计划', async function () {
        await api.post('/ai/artifacts/' + artifact.id + '/discard', {});
        handle.close(); toast('已忽略该计划'); await renderAgentPanels();
      });
    };
    $('[data-plan="ok"]', root).onclick = function () {
      var tasks = data.tasks.filter(function (_, i) { return picked.tasks[i]; });
      var routines = data.routines.filter(function (_, i) { return picked.routines[i]; });
      if (!tasks.length && !routines.length) { toast('请至少勾选一项，或点「忽略」'); return; }
      safe('确认计划', async function () {
        // 始终回传当前条目（可能已勾选/编辑过），后端据此覆盖草稿再落库
        await api.post('/ai/artifacts/' + artifact.id + '/confirm', { tasks: tasks, routines: routines });
        handle.close(); toast('已写入日历'); await renderAgentPanels();
      });
    };
  }
  paint();
  return handle;
}

var CONFIRMABLE_TYPES = ['PLAN_DRAFT', 'TASK_DRAFT', 'ROUTINE_DRAFT', 'WIKI_DRAFT', 'NOTE_DRAFT', 'MEMORY_DRAFT', 'CODE_DRAFT'];

/**
 * 产物卡片上的「查看并确认 / 确认」「忽略」。确认框只自动弹一次，关掉以后就靠这里再打开 ——
 * 代码草稿原来不在这份清单里：确认框一关（点到遮罩、按 Esc），不刷新页面就没处确认（第九十二轮在真浏览器里点出来的）。
 */
// ───────────────────────── 生成的文件（第一百一十六轮）─────────────────────────
// 用户：「可以生成文件到artifact」。内容是模型和命令写的，不能信：下载走 attachment，预览不在本站的页面里跑 ——
// HTML 关在没有同源权限的 iframe 里（拿不到这个页面的登录令牌），图片走 <img>（SVG 里的脚本不跑），别的都当纯文本。
var GEN_IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
var GEN_TEXT_PREVIEW_BYTES = 200 * 1024;

function genExtension(path) {
  var name = String(path || '').split('/').pop();
  var dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
function genPreviewKind(path) {
  var ext = genExtension(path);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return GEN_IMAGE_TYPES[ext] ? 'image' : 'text';
}
function humanSize(bytes) {
  var n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function generatedFilesHtml(artifact) {
  var files = artifactContent(artifact).files;
  if (!Array.isArray(files) || !files.length) return '';
  return '<ul class="zq-gen-files">' + files.map(function (f) {
    var path = String(f.path || '');
    var stored = f.id != null;
    var ids = ' data-gen-artifact="' + esc(f.artifactId != null ? f.artifactId : artifact.id) + '" data-gen-file="' + esc(f.id) + '" data-gen-path="' + esc(path) + '"';
    return '<li class="zq-gen-file">' + icon('file')
      + '<span class="zq-gen-name" title="' + esc(path) + '">' + esc(path) + '</span>'
      + '<span class="zq-gen-size zq-num">' + esc(humanSize(f.size)) + '</span>'
      + (stored
        ? '<button type="button" class="zq-gen-act" data-gen-view="1"' + ids + '>预览</button>'
          + '<button type="button" class="zq-gen-act" data-gen-down="1"' + ids + '>下载</button>'
        : '<em class="zq-gen-skip" title="' + esc(f.skipped || '') + '">没存：' + esc(f.skipped || '') + '</em>')
      + '</li>';
  }).join('') + '</ul>';
}
// 这段对话之前生成的文件：面板只显示最近一轮的产物，不单独列的话换一轮、刷新之后就点不到了。这一轮卡片上已有的路径不重复
function earlierGeneratedFiles(files, artifacts) {
  var shown = {};
  (artifacts || []).forEach(function (a) {
    if (String(a.artifactType || '').toUpperCase() !== 'GENERATED_FILES') return;
    var rows = artifactContent(a).files;
    if (Array.isArray(rows)) rows.forEach(function (f) { shown[f.path] = true; });
  });
  return (files || []).filter(function (f) { return !shown[f.path]; });
}
function earlierFilesCard(files) {
  if (!files.length) return '';
  return '<article class="zq-artifact-card">'
    + '<div class="zq-artifact-head"><span>' + esc(artifactTypeLabel('GENERATED_FILES')) + '</span></div>'
    + '<div class="zq-artifact-title">之前生成的 ' + files.length + ' 个文件</div>'
    + generatedFilesHtml({ content: { files: files } })
    + '</article>';
}
function saveBlobAs(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename || 'file';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
}
function downloadGeneratedFile(artifactId, fileId) {
  return safe('下载文件', async function () {
    var got = await api.download('/ai/artifacts/' + artifactId + '/files/' + fileId);
    saveBlobAs(got.blob, got.filename);
  });
}
// 有 NUL 就是二进制：当文本显示只是一屏乱码
function looksBinary(bytes) {
  var n = Math.min(bytes.length, 8192);
  for (var i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
function genPreviewNode(kind, path, blob, bytes) {
  if (kind === 'image') {
    var img = document.createElement('img');
    img.className = 'zq-gen-image'; img.alt = path;
    // 类型照扩展名给，不信文件自己说的：一个写成 .png 的 HTML 在 <img> 里只是一张坏图
    img.src = URL.createObjectURL(new Blob([blob], { type: GEN_IMAGE_TYPES[genExtension(path)] }));
    return img;
  }
  var box = document.createElement(kind === 'text' ? 'pre' : 'div');
  if (looksBinary(bytes)) {
    box.className = 'zq-gen-note';
    box.textContent = '这个文件不是文本，不能预览，下载之后打开。';
    return box;
  }
  var clipped = bytes.length > GEN_TEXT_PREVIEW_BYTES;
  var text = new TextDecoder('utf-8').decode(clipped ? bytes.subarray(0, GEN_TEXT_PREVIEW_BYTES) : bytes);
  if (kind === 'html') {
    var frame = document.createElement('iframe');
    frame.className = 'zq-gen-frame';
    frame.setAttribute('sandbox', 'allow-scripts');   // 没有 allow-same-origin：脚本能跑，但它是个陌生的来源
    frame.title = path;
    frame.srcdoc = text;
    return frame;
  }
  if (kind === 'markdown') {
    box.className = 'zq-gen-markdown';
    box.innerHTML = renderMarkdown(text);
    return box;
  }
  box.className = 'zq-gen-text';
  box.textContent = clipped ? text + '\n…（太长，只预览开头，下载看全部）' : text;
  return box;
}
function previewGeneratedFile(artifactId, fileId, path) {
  return safe('预览文件', async function () {
    var got = await api.download('/ai/artifacts/' + artifactId + '/files/' + fileId);
    var bytes = new Uint8Array(await got.blob.arrayBuffer());
    var node = genPreviewNode(genPreviewKind(path), path, got.blob, bytes);
    openModal({
      title: path, width: 'min(880px, 94vw)', bodyNode: node,
      onClose: function () { if (node.tagName === 'IMG') URL.revokeObjectURL(node.src); }
    });
  });
}

function artifactActionsHtml(artifact) {
  var type = String(artifact.artifactType || '').toUpperCase();
  var status = String(artifact.status || '').toUpperCase();
  if (CONFIRMABLE_TYPES.indexOf(type) < 0 || (status !== 'DRAFT' && status !== 'PENDING')) return '';
  return '<div class="zq-artifact-actions">'
    // 计划、记忆、代码草稿：走弹窗（可逐条勾选 / 看 diff），点这里可随时再打开
    + ((isPlanDraft(artifact) || isMemoryDraft(artifact) || isCodeDraft(artifact))
      ? '<button data-art-view="' + artifact.id + '">查看并确认</button>'
      : '<button data-art-ok="' + artifact.id + '">确认</button>')
    + '<button data-art-no="' + artifact.id + '" class="zq-btn-ghost">忽略</button></div>';
}

function renderArtifacts(artifacts) {
  var host = $('#zq-artifacts'); if (!host) return;
  var grouped = groupArtifacts(artifacts);
  var earlier = earlierFilesCard(earlierGeneratedFiles(state.generatedFiles, grouped));
  host.innerHTML = grouped.length || earlier ? grouped.map(function (artifact) {
    var type = String(artifact.artifactType || '').toUpperCase();
    var status = String(artifact.status || '').toUpperCase();
    var content = artifactContent(artifact);
    var parts = artifact._citationParts || [];
    var hitCount = parts.length || Number(artifact.hitCount || 0);
    var sourceType = content.sourceType || artifact.sourceType || '';
    var sourceInfo = type === 'CITATION'
      ? ((sourceType ? srcTypeInfo(sourceType)[0] + ' · ' : '') + (hitCount || 1) + ' 个命中片段')
      : '';
    var titles = artifactItemTitles(artifact);
    var itemCount = Number(artifact.itemCount || titles.length || 0);
    var draftInfo = itemCount ? itemCount + ' 个项目' : '';
    var meta = sourceInfo || draftInfo;
    var preview = artifactTextPreview(parts[0] || artifact);
    var url = content.url || artifact.url || '';
    var title = artifact.title || content.title || artifactTypeLabel(type);
    var titleHtml = /^https?:\/\//i.test(url)
      ? '<a class="zq-artifact-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>'
      : esc(title);
    var generated = type === 'GENERATED_FILES';
    var itemHtml = generated ? generatedFilesHtml(artifact) : titles.length ? '<ul class="zq-artifact-items">' + titles.slice(0, 5).map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') + '</ul>' : '';
    return '<article class="zq-artifact-card">'
      + '<div class="zq-artifact-head"><span>' + esc(artifactTypeLabel(type)) + '</span><em>' + esc(artifactStatusLabel(status)) + '</em></div>'
      + '<div class="zq-artifact-title">' + titleHtml + '</div>'
      + (meta ? '<div class="zq-artifact-meta">' + esc(meta) + '</div>' : '')
      + (preview ? '<p class="zq-artifact-preview">' + esc(preview) + '</p>' : '')
      + itemHtml
      + (generated ? '' : '<details class="zq-artifact-details"><summary>展开详情</summary>' + artifactDetailsHtml(artifact) + '</details>')
      + artifactActionsHtml(artifact)
      + '</article>';
  }).join('') + earlier : empty('暂无产物');
  $all('[data-art-view]', host).forEach(function (b) {
    b.onclick = function () {
      var target = grouped.filter(function (a) { return String(a.id) === String(b.dataset.artView); })[0];
      if (target) {
        if (isCodeDraft(target)) openCodeConfirmModal(target);
        else if (isMemoryDraft(target)) openMemoryConfirmModal(target);
        else openPlanConfirmModal(target);
      }
    };
  });
  $all('[data-gen-view]', host).forEach(function (b) {
    b.onclick = function () { previewGeneratedFile(b.dataset.genArtifact, b.dataset.genFile, b.dataset.genPath); };
  });
  $all('[data-gen-down]', host).forEach(function (b) {
    b.onclick = function () { downloadGeneratedFile(b.dataset.genArtifact, b.dataset.genFile); };
  });
  $all('[data-art-ok]', host).forEach(function (b) { b.onclick = function () { safe('确认产物', async function () { await api.post('/ai/artifacts/' + b.dataset.artOk + '/confirm', {}); toast('已确认'); await renderAgentPanels(); }); }; });
  $all('[data-art-no]', host).forEach(function (b) { b.onclick = function () { safe('忽略产物', async function () { await api.post('/ai/artifacts/' + b.dataset.artNo + '/discard', {}); toast('已忽略'); await renderAgentPanels(); }); }; });
}
async function renderAgentPanels() {
  if (!$('#zq-steps') && !$('#zq-artifacts')) return;
  var nbId = state.notebookId;
  var revision = state.agentArtifactRevision || 0;
  var runs = await safe('执行轨迹', function () { return api.get('/ai/agent-runs' + (nbId ? '?notebookId=' + nbId : '')); });
  if (!nbId && Array.isArray(runs)) {
    // 空 Notebook 工作区只展示真正不绑定 Notebook 的普通聊天 Run，
    // 避免已删除 Notebook 的历史轨迹重新出现在右侧。
    runs = runs.filter(function (run) { return run.notebookId == null; });
  }
  var latest = runs && runs.length ? runs[0] : null;
  var detail = latest ? await safe('执行详情', function () { return api.get('/ai/agent-runs/' + latest.id); }) : null;
  var generated = await safe('生成的文件', function () { return api.get('/ai/generated-files' + (nbId ? '?notebookId=' + nbId : '')); });
  if (nbId !== state.notebookId || revision !== (state.agentArtifactRevision || 0)) return;
  state.generatedFiles = Array.isArray(generated) ? generated : [];
  // 请求开始后若收到了新 SSE 产物，旧快照不能盖回去或弹出上一轮草稿。
  renderSteps((detail && (detail.steps || detail.stepList)) || []);
  var artifacts = (detail && (detail.artifacts || detail.artifactList)) || [];
  artifacts = artifacts.map(function (raw) {
    var incoming = normalizeArtifact(raw);
    var current = (state.agentArtifacts || []).find(function (item) { return String(item.id) === String(incoming.id); });
    return mergeAgentArtifact(current, incoming);
  });
  state.agentArtifacts = artifacts;
  renderArtifacts(artifacts);
  // 新生成的计划草稿主动弹窗：右侧产物卡片容易被忽略，而计划要用户确认后才写入日历，
  // 不弹的话用户会以为"什么都没发生"。每个草稿只弹一次，之后可从卡片「查看并确认」重开。
  showFreshPlanDraft(artifacts);
  var freshMemory = groupArtifacts(artifacts).filter(function (a) {
    return isMemoryDraft(a) && !shownMemoryModals[a.id];
  })[0];
  if (freshMemory) openMemoryConfirmModal(freshMemory);
  var freshCode = groupArtifacts(artifacts).filter(function (a) {
    return isCodeDraft(a) && !shownCodeModals[a.id];
  })[0];
  if (freshCode) openCodeConfirmModal(freshCode);
}
var CHAT_PAGE_SIZE = 50;
async function loadAiMessages() {
  // 聊天记录按 notebook 隔离:后端会话 key = notebook-{id},切换 notebook 时重新拉取
  var nbId = state.notebookId;
  var list = await api.get('/ai/messages?limit=' + CHAT_PAGE_SIZE + (nbId ? '&notebookId=' + nbId : ''));
  if (nbId !== state.notebookId) return; // 响应期间已切换 notebook,防止慢响应覆盖新窗口
  state.messages = list || [];
  state.historyOf = { notebookId: nbId };   // 这个 notebook 的记录到手了 —— 此后空着才是真的空（见 historyLoaded）
  // 拿满一页 = 可能还有更早的。这是个上界判断，不是精确值：
  // 正好整页而其实没有更早的时候，用户点一次会拿到空列表，按钮随即消失。
  // 换成精确值要么多查一次、要么改响应形状（现在是裸数组，前端其它地方都按数组读）。
  state.chatHasMore = state.messages.length >= CHAT_PAGE_SIZE;
  renderAiMessages();
  watchStreamingMessages();
  restorePendingSend();
}

/**
 * 「我发了、但没看到它进列表」的那一条（第一百三十二轮）。
 *
 * <p>用户：发出去一条，点进管理后台再回来，消息不见了，只剩输入框里的字；再发一次说「上一轮还没完」。
 * 根因是这一轮在浏览器里被导航打断，请求根本没到服务器（或者到了但没存），而页面只在内存里记着它。
 *
 * <p>现在发送时在 sessionStorage 留一个记号，正常收到 userMessageId 就清掉。回到页面时如果记号还在、
 * 而服务器那边又找不到这句话，就把它放回输入框并说清楚 —— 总比「字没了、也没有任何解释」强。
 */
var PENDING_SEND_KEY = 'zq.ai.pending';
function markPendingSend(text) {
  try { sessionStorage.setItem(PENDING_SEND_KEY, JSON.stringify({ nb: state.notebookId, text: text, at: Date.now() })); } catch (e) { /* 隐私模式 */ }
}
function clearPendingSend() {
  try { sessionStorage.removeItem(PENDING_SEND_KEY); } catch (e) { /* 同上 */ }
}
function restorePendingSend() {
  var raw = null;
  try { raw = sessionStorage.getItem(PENDING_SEND_KEY); } catch (e) { return; }
  if (!raw) return;
  var mark;
  try { mark = JSON.parse(raw); } catch (e) { clearPendingSend(); return; }
  clearPendingSend();
  if (!mark || mark.nb !== state.notebookId) return;
  if (Date.now() - Number(mark.at || 0) > 10 * 60 * 1000) return;   // 十分钟前的不管了
  var already = (state.messages || []).some(function (m) {
    return m.role === 'user' && String(m.content || '').trim() === String(mark.text || '').trim();
  });
  if (already) return;
  var inp = $('#zq-draft');
  if (inp && !inp.value.trim()) {
    inp.value = mark.text;
    if (typeof growDraft === 'function') growDraft();
    if (typeof paintSlash === 'function') paintSlash();
  }
  toast('上一条没发出去（这一页中途被切走过），已经放回输入框');
}

/**
 * 刷新之后接住「还在生成」的那条消息。
 *
 * 后端在流开始时就建好了 assistant 消息行（status=STREAMING），并在生成过程中
 * 阶段性把已生成的正文写进 content（见 AiMessageMapper.flushStreamingContent）。
 * 所以刷新后能看到已经生成的部分 —— 但这一页没有 SSE 连接了，剩下的部分不会自己出现。
 * 这里补一个轻量轮询，直到它进入终态。
 *
 * 三个边界：
 * - 本标签页正在发送时不轮询（SSE 在跑，轮询只会和它抢着改同一批消息）。
 * - 切换了 notebook 就停：那是另一个会话，拉回来的消息会覆盖当前窗口。
 * - 有上限。后端进程若在生成中途被杀，这条消息会永远停在 STREAMING，
 *   没有上限的话这个页面会一直轮询到关闭为止。上限取 5 分钟，与 SSE 的
 *   STREAM_TIMEOUT_MS 一致 —— 超过它，那条流无论如何都已经不在了。
 */
var STREAM_POLL_INTERVAL_MS = 2000;
var STREAM_POLL_MAX_ATTEMPTS = 150;   // 150 × 2s = 5min，与后端 STREAM_TIMEOUT_MS 对齐
function stopStreamWatch() {
  if (state.streamPollTimer) { clearTimeout(state.streamPollTimer); state.streamPollTimer = null; }
}
function watchStreamingMessages(attempt) {
  stopStreamWatch();
  if (state.aiSending) return;   // 本页正在流，SSE 会负责更新
  var pending = (state.messages || []).some(function (m) {
    return String(m.status || '').toUpperCase() === 'STREAMING';
  });
  if (!pending) return;
  var tries = attempt || 0;
  if (tries >= STREAM_POLL_MAX_ATTEMPTS) return;
  var watchedNb = state.notebookId;
  state.streamPollTimer = setTimeout(function () {
    state.streamPollTimer = null;
    if (state.aiSending || watchedNb !== state.notebookId) return;
    var nbId = state.notebookId;
    api.get('/ai/messages?limit=50' + (nbId ? '&notebookId=' + nbId : ''))
      .then(function (list) {
        if (watchedNb !== state.notebookId || state.aiSending) return;
        state.messages = list || [];
        renderAiMessages({ keepScroll: !state.chatFollow });
        watchStreamingMessages(tries + 1);
      })
      .catch(function () { watchStreamingMessages(tries + 1); });
  }, STREAM_POLL_INTERVAL_MS);
}
// 历史坏数据修复：早期流式链路会丢弃纯换行增量，整条消息被压成一行。
// 只对"记号多、换行几乎为零"的消息做启发式回填换行，健康消息原样返回。
function reflowFlatMarkdown(text) {
  var s = String(text || '');
  var newlines = (s.match(/\n/g) || []).length;
  var headingHits = (s.match(/#{2,4}/g) || []).length;
  if (newlines >= 3 || s.length < 120 || (headingHits < 2 && !/\|\s*:?-{3,}/.test(s))) return s;
  return s
    .replace(/\|\s+\|/g, '|\n|')
    .replace(/\s*(#{2,6})\s*/g, '\n\n$1 ')
    .replace(/(#{2,6}[^|\n]*?)\s+\|/g, '$1\n\n|')
    .replace(/([^|:\-\n])(-{3,})(?!-)(?!\s*\|)/g, '$1\n\n---\n\n')
    .replace(/([。：；！？])\s*\|/g, '$1\n|')
    .replace(/([^\n\d-])- (?=\S)/g, '$1\n- ')
    .replace(/([。；！？])\s*(\d+)[.、]\s+(?=\S)/g, '$1\n$2. ');
}
/**
 * 距底多少像素以内算「还在底部」。
 *
 * 取 48 而不是 0：行高 1.65 的正文一行约 22px，留两行的余量 ——
 * 用户手指刚离开、或浏览器因图片/公式渲染微调了一下高度，都不该被判成「他翻上去了」。
 */
var CHAT_BOTTOM_SLACK_PX = 48;
function chatAtBottom(host) {
  return host.scrollHeight - host.scrollTop - host.clientHeight <= CHAT_BOTTOM_SLACK_PX;
}
/**
 * 聊天区的滚动策略。
 *
 * 此前是无条件 `host.scrollTop = host.scrollHeight` —— 流式期间每个 token 都重渲染一次，
 * 于是用户只要想往上翻看前面说了什么，就会被立刻拽回底部，一个字也读不完。
 *
 * 现在：用户在底部才跟随；他一旦往上翻，就停在原地，并冒出一个「↓ 新内容」按钮，
 * 点它（或自己滑回底部）恢复跟随。发送新消息时无条件回到底部 —— 那是他自己的动作。
 */
function applyChatScroll(host, prevScroll, keepScroll) {
  if (keepScroll || !state.chatFollow) {
    host.scrollTop = prevScroll;
  } else {
    host.scrollTop = host.scrollHeight;
  }
  var jump = $('#zq-chat-jump');
  if (jump) jump.hidden = state.chatFollow;
}
/**
 * 绑滚动监听与「↓ 新内容」按钮。
 *
 * 两者各有各的 guard，而不是共用一个：按钮在首次渲染时万一还不在 DOM 里，
 * 共用 guard 会让它<b>永远</b>绑不上 —— 监听已经标记成「绑过了」，后面再也不进来。
 * 这类「一个 guard 罩住两件事」的写法，失效的那件事不会有任何迹象。
 */
function bindChatScroll(host) {
  if (host.dataset.zqScrollBound !== '1') {
    host.dataset.zqScrollBound = '1';
    host.addEventListener('scroll', function () {
      var atBottom = chatAtBottom(host);
      if (atBottom === state.chatFollow) return;
      state.chatFollow = atBottom;
      var jump = $('#zq-chat-jump');
      if (jump) jump.hidden = atBottom;
    }, { passive: true });
  }
  var jump = $('#zq-chat-jump');
  if (jump && jump.dataset.zqBound !== '1') {
    jump.dataset.zqBound = '1';
    jump.onclick = function () {
      state.chatFollow = true;
      host.scrollTop = host.scrollHeight;
      jump.hidden = true;
    };
  }
}
/**
 * 一条消息的气泡内容（思考摘要 + 正文）。
 *
 * <p>抽出来是为了让<b>全量渲染</b>与<b>流式增量补丁</b>共用同一份生成逻辑 ——
 * 两处各写一份的话，Markdown / 数学公式 / 「仍在生成」尾巴的处理迟早会分叉，
 * 而分叉只在流式时可见，最难被发现。
 */
function messageBodyHtml(m, i) {
  /** 「> 过程：a · b · c …共 N 步」在结尾：拆出正文和步数（不是这个样子就 null） */
  // 头一步要像命令行旧版 describeCall 写的那几种（第一百二十八轮 review）：模型正常的回答里也可能有一段「> 过程：先求导…」，
  // 原来见到就把它和后面的整段藏掉、换成「做了 N 步」。认不出的旧存档宁可照原样显示（之前就是这样），也不能吞掉正文
  var LEGACY_FIRST_STEP = /^(?:列出 |读取 |搜索「|写入 |追加到 |修改 |打补丁 |删除 |运行 |后台运行 |看 \S+ 的输出|停掉 |找 MCP 工具「|提交计划|派(?:干活的|只读探索的)?子 agent：|等子 agent |给 \S+ 交代：|更新任务清单|目标状态：|查知识库|列出知识库的页面|读知识库「|生成知识库草稿「|生成计划草稿|读你的任务|把任务 #|读长期记忆|生成长期记忆草稿|MCP \S)/;
  function splitLegacyProcess(content) {
    var text = String(content || '');
    var at = text.lastIndexOf('\n\n> 过程：');
    if (at < 0) return null;
    var tail = text.slice(at + 7);
    if (!LEGACY_FIRST_STEP.test(tail)) return null;
    var total = /…共 (\d+) 步\s*$/.exec(tail);
    return { content: text.slice(0, at), count: total ? Number(total[1]) : tail.split(' · ').length };
  }
  var me = m.role === 'user';
  var reasoningMode = String(m.reasoningMode || 'OFF').toUpperCase();
  var reasoningText = m.reasoningSummary || m.reasoning || '';
  var reasonKey = String(m._clientKey || m.id || m.requestId || ('assistant-' + i));
  // 步骤里已经有「思考」那一步（第一百二十八轮起存的是思考原文）：下面不再另放一个「思考摘要」，同一段话不说两遍。
  // 旧消息的思考步骤只有字数（第一百二十七轮的 detail 只有 {chars}，列表接口不给这种标 hasDetail），点不开、看不到内容 —— 这种不能算「已经有」，
  // 否则 reasoningSummary 被整条藏掉，页面上再也没有入口。
  var thinkingInSteps = Boolean(m.steps && m.steps.steps && m.steps.steps.some(function (x) {
    return x.kind === 'thinking' && ((x.detail && x.detail.text) || x.hasDetail);
  }));
  var reason = (!me && reasoningMode !== 'OFF' && reasoningText && !thinkingInSteps)
    ? '<details class="zq-ai-reasoning" data-reason-key="' + esc(reasonKey) + '"' + (state.reasoningExpanded[reasonKey] ? ' open' : '') + '><summary>思考摘要</summary><span>' + esc(reasoningText) + '</span></details>'
    : '';
  // 命令行存档的旧样子（第一百二十八轮之前）：回答后面拼着一行「> 过程：列出 . · 运行 … 共 32 步」，heredoc 被当 Markdown / 公式渲染成乱码。
  // 收起来，只说一共几步（新的存档每一步单独存，上面画成一步一行）
  var legacy = !me ? splitLegacyProcess(m.content) : null;
  if (legacy) m = Object.assign({}, m, { content: legacy.content });
  // 流式中的内容换行完好且可能只收到半截,跳过压平回填,防止启发式误触
  var body = m.content ? renderMarkdown((me || m.status === 'STREAMING') ? m.content : reflowFlatMarkdown(m.content)) : (m.status === 'STREAMING' ? '<span class="zq-msg-wait" data-wait-since="' + waitSince(m) + '">' + waitText(waitSince(m)) + '</span>' : '');
  // 刷新之后那条消息会带着「已经生成的一半」回来（后端阶段性落库）。
  // 光有半截正文看不出它是写完了还是还在写 —— 补一个尾巴说清楚，
  // 否则用户会以为回答就到这里为止。
  if (!me && m.content && String(m.status || '').toUpperCase() === 'STREAMING') {
    body += '<div class="zq-msg-note">' + esc(m._processing || '仍在生成…') + '</div>';
  }
  // 失败了要说出来，哪怕已经出来了半截（原来有半截正文就把错误原因丢掉，看着像是模型说完了）；
  // 能用但不完整（输出上限、内容审核、太长）也说。两句都存在库里，刷新之后还在。
  if (!me && m.errorMessage) {
    body += '<div data-msg-error class="zq-msg-note" data-state="bad">' + esc(m.errorMessage) + '</div>';
  }
  if (!me && m.notice) {
    body += '<div data-msg-notice class="zq-msg-note" data-state="warn">' + esc(m.notice) + '</div>';
  }
  // 回答里按顺序列出的每一步（第一百二十七轮）：在正文上面；没有步骤时这里是空串，什么都不多
  // 步骤的展开状态按 requestId 记（流式时是 _clientKey、收尾重新拉列表后是 id —— 两者都会变，requestId 两边都有）
  var traceKey = String(m.requestId || reasonKey);
  var steps = (!me && m.steps && m.steps.steps && m.steps.steps.length) ? traceStepsHtml(m.steps, traceKey) : '';
  if (legacy) body += '<div class="zq-msg-note">（命令行那一轮做了 ' + esc(legacy.count) + ' 步，旧的存档没有分步记下）</div>';
  return steps + reason + body;
}

/**
 * 还没收到第一个字时，说出已经等了多久（第十九轮）。模型卡住时服务器要 60 秒才放弃（回答之前的检索、代码循环更久），
 * 而网页没有「停止」：原来这段时间里只有一行一动不动的「正在生成…」，看不出是在想还是已经死了。
 */
function waitSince(m) {
  if (m._startedAt) return m._startedAt;
  // createdAt 是业务时区的钟面、不带时区：按业务时区换成时刻，和按服务器的钟的「此刻」比（第二十一轮：原来 Date.parse 按浏览器时区，
  // 比东八区快的浏览器一刷新就是「已等 21600 秒」、慢的永远从 0 数起）
  var t = m.createdAt ? serverTime(m.createdAt) : NaN;
  return isFinite(t) && t <= nowMs() ? t : nowMs();
}
function waitText(since) {
  var s = Math.floor((nowMs() - since) / 1000);
  if (s < 5) return '正在生成…';
  if (s < 30) return '正在生成…（已等 ' + s + ' 秒）';
  return '还在等模型开始回答（已等 ' + s + ' 秒）';
}
// 原来是壳顶层的一个 setInterval（每一页都在跑，只是别的页上找不到这个元素）。挪进模块后改成启动这一页时开一次 ——
// 模块被 import 时不该有副作用（测试在 node 里 import 它，那里没有 document）。
var waitTicker = null;
function startWaitTicker() {
  if (waitTicker) return;
  waitTicker = setInterval(function () {
    var nodes = document.querySelectorAll('[data-wait-since]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = waitText(Number(nodes[i].getAttribute('data-wait-since')));
  }, 1000);
}

/**
 * 流式增量：只改正在生成的那一条，不重建整个聊天区。
 *
 * <h2>为什么值得单独走一条路</h2>
 *
 * <p>此前每收到一个 token 都跑一次完整的 renderAiMessages：重建全部消息的 innerHTML、
 * 重新绑定每条消息的右键菜单、并对<b>整个聊天区</b>重跑一次数学公式渲染。
 * 代价随对话长度增长 —— 聊得越久，每个 token 越贵，而一轮有几千个 token。
 *
 * <p>返回 false 表示 DOM 不是预期的形状（比如这条消息还没被渲染出来），
 * 调用方退回全量渲染。不假装成功，也不静默什么都不做。
 */
function patchStreamingMessage(index) {
  var host = $('#zq-chat'); if (!host) return false;
  var node = host.querySelector('[data-msg-body="' + index + '"]');
  var m = state.messages[index];
  if (!node || !m) return false;
  var prevScroll = host.scrollTop;
  $all('details[data-reason-key]', node).forEach(function (details) {
    state.reasoningExpanded[details.dataset.reasonKey] = details.open;
  });
  node.innerHTML = messageBodyHtml(m, index);
  bindTraceToggles(node);
  renderMathIn(node);
  applyChatScroll(host, prevScroll, false);
  return true;
}
/** 这一块里的步骤：点开 / 合上记下来，点开时画细节（没有就去拿）；「还有 N 步」点了列全部 */
function bindTraceToggles(scope) {
  $all('details.zq-trace-step[data-reason-key]', scope).forEach(function (details) {
    details.ontoggle = function () {
      var was = Boolean(state.reasoningExpanded[details.dataset.reasonKey]);
      state.reasoningExpanded[details.dataset.reasonKey] = details.open;
      if (!details.open || was) return;
      var body = details.closest('[data-msg-body]');
      var m = body && state.messages[Number(body.dataset.msgBody)];
      var step = m && m.steps && (m.steps.steps || []).filter(function (x) { return String(x.id) === details.dataset.traceStep; })[0];
      if (!step) return;
      if (step.detail) { var host = details.querySelector('.zq-trace-detail'); if (host) host.innerHTML = traceDetailHtml(step); return; }
      loadTraceDetail(m, Number(body.dataset.msgBody));
    };
  });
  $all('[data-trace-all]', scope).forEach(function (b) {
    b.onclick = function () {
      state.reasoningExpanded[b.dataset.traceAll] = true;
      var idx = b.closest('[data-msg-body]');
      if (idx && !patchStreamingMessage(Number(idx.dataset.msgBody))) renderAiMessages();
    };
  });
}
/**
 * 往更早翻一页。
 *
 * <h2>预挂载前必须记住高度</h2>
 *
 * <p>在列表<b>前面</b>插内容会把已有内容整体往下推，浏览器保持 scrollTop 不变，
 * 于是用户正在读的那一段瞬间跑到屏幕下方 —— 视觉上就是「一点加载就跳走了」。
 * 所以要在渲染前记下 scrollHeight，渲染后把 scrollTop 加上高度差，
 * 让用户眼前的那一行留在原处。
 *
 * <p>这也是为什么这里不能复用 renderAiMessages 的滚动策略：那套策略管的是
 * 「新内容加在末尾」，而这里是加在开头，两者要做的补偿方向相反。
 */
async function loadOlderMessages() {
  if (state.chatLoadingMore || !state.chatHasMore || !state.messages.length) return;
  var host = $('#zq-chat'); if (!host) return;
  var oldest = null;
  for (var i = 0; i < state.messages.length; i++) {
    if (state.messages[i].id != null) { oldest = state.messages[i].id; break; }
  }
  if (oldest == null) return;   // 全是本地临时消息，没有可用游标

  state.chatLoadingMore = true;
  renderAiMessages({ keepScroll: true });
  var nbId = state.notebookId;
  try {
    var older = await api.get('/ai/messages?limit=' + CHAT_PAGE_SIZE
      + (nbId ? '&notebookId=' + nbId : '') + '&before=' + oldest);
    if (nbId !== state.notebookId) return;   // 期间切了 notebook，这页属于别的会话
    older = older || [];
    if (!older.length) {
      state.chatHasMore = false;
      return;
    }
    // 锚点取当前第一条消息的气泡，记它在视口里的位置。
    // 不用 scrollHeight 之差：那一页若正好把「加载更早」按钮用没了（older 不满一页），
    // 按钮那约 34px 会算进差值里，视口就会跳一下。锚元素与按钮在不在无关。
    var anchor = host.querySelector('[data-msg-body="0"]');
    var topBefore = anchor ? anchor.getBoundingClientRect().top : null;

    state.messages = older.concat(state.messages);
    state.chatHasMore = older.length >= CHAT_PAGE_SIZE;
    state.chatLoadingMore = false;   // 先落定，让下面这次渲染就是最终形态
    renderAiMessages({ keepScroll: true });

    // 原来的第 0 条现在排在 older.length 位；把视口挪回去，让它看起来没动过
    var moved = host.querySelector('[data-msg-body="' + older.length + '"]');
    if (moved && topBefore != null) {
      host.scrollTop += moved.getBoundingClientRect().top - topBefore;
    }
  } finally {
    // 只有上面提前 return 的两条分支还没落定
    if (state.chatLoadingMore) {
      state.chatLoadingMore = false;
      if (nbId === state.notebookId) renderAiMessages({ keepScroll: true });
    }
  }
}

/**
 * 当前 notebook 的聊天记录拿到了没有。没拿到时对话区留白，不画「可以这样开始」：
 * 打开页面时模型列表比聊天记录先回来（loadAiModelSelect 会重画一次），切 notebook 时先清空再取 ——
 * 原来这两处都会先闪一下空状态（像是「你还没有对话」），记录到了才换成真的（第三十九轮，页面不再整块遮着等数据之后露出来的）。
 */
function historyLoaded() {
  return Boolean(state.historyOf) && state.historyOf.notebookId === state.notebookId;
}
function renderAiMessages(opts) {
  var host = $('#zq-chat'); if (!host) return;
  bindChatScroll(host);
  var keepScroll = opts && opts.keepScroll, prevScroll = host.scrollTop;
  $all('details[data-reason-key]', host).forEach(function (details) {
    state.reasoningExpanded[details.dataset.reasonKey] = details.open;
  });
  var moreRow = state.chatHasMore
    ? '<div class="zq-chat-more">'
      + '<button type="button" data-load-older="1"' + (state.chatLoadingMore ? ' disabled' : '') + '>'
      + (state.chatLoadingMore ? '加载中…' : icon('arrow-up') + '加载更早的消息') + '</button></div>'
    : '';
  // 用户的话是右边一个浅灰的气泡，AI 的回答不套气泡、不要头像，直接排在页面上（第四十四轮，像 Claude）；样子都在样式表的 .zq-msg
  host.innerHTML = moreRow + state.messages.map(function (m, i) {
    var me = m.role === 'user';
    return '<div data-msg-idx="' + i + '" class="zq-msg ' + (me ? 'is-me' : 'is-ai') + '"><div data-msg-body="' + i + '" class="zq-msg-body">' + messageBodyHtml(m, i) + '</div></div>';
  }).join('');
  if (!state.messages.length) {
    host.innerHTML = moreRow + (historyLoaded() ? aiEmptyState() : '');
    $all('[data-ai-example]', host).forEach(function (b) {
      b.onclick = function () {
        var draft = $('#zq-draft'); if (!draft) return;
        draft.value = b.dataset.aiExample;
        draft.dispatchEvent(new Event('input', { bubbles: true }));
        draft.focus();
      };
    });
  }
  var olderButton = host.querySelector('[data-load-older]');
  if (olderButton) olderButton.onclick = function () { loadOlderMessages(); };
  $all('details[data-reason-key]', host).forEach(function (details) {
    details.ontoggle = function () {
      state.reasoningExpanded[details.dataset.reasonKey] = details.open;
    };
  });
  bindTraceToggles(host);
  // 右键删除消息:仅真实历史消息(有 id)可删;流式中的临时消息尚未入库,不弹菜单
  if (state.messages.length) $all('[data-msg-idx]', host).forEach(function (d) {
    d.oncontextmenu = function (e) {
      var m = state.messages[Number(d.dataset.msgIdx)];
      if (!m || !m.id) return;
      e.preventDefault();
      popMenu(e.clientX, e.clientY, [{
        label: '删除消息', danger: true,
        onClick: async function () {
          if (!await askConfirm({ title: '删除消息', message: '删除这条消息？删除后不可恢复。', okText: '删除', danger: true })) return;
          safe('删除消息', async function () {
            await api.del('/ai/messages/' + m.id);
            state.messages = state.messages.filter(function (x) { return x !== m; });
            toast('已删除');
            renderAiMessages({ keepScroll: true });
          });
        }
      }]);
    };
  });
  renderMathIn(host);
  // 删除消息等场景保持原滚动位置;其余按「用户是否在底部」决定跟不跟随
  applyChatScroll(host, prevScroll, keepScroll);
  keepPinned(host);
}
/**
 * 跟着底部的时候，消息画完之后又长高了（公式是 KaTeX 异步排的、图片后到、字体后换上），也留在底部。
 * 原来这些发生在整页遮着等数据的时候，看不到；第三十九轮页面一打开就露出来，排完公式那一下对话区往上跳了一截。
 * 用户自己往上翻了（chatFollow 为假）就不动他。
 */
var pinObserver = null;
function keepPinned(host) {
  if (typeof ResizeObserver !== 'function') return;
  if (!pinObserver) pinObserver = new ResizeObserver(function () {
    var chat = $('#zq-chat');
    if (chat && state.chatFollow) chat.scrollTop = chat.scrollHeight;
  });
  pinObserver.disconnect();
  Array.prototype.forEach.call(host.children, function (row) { pinObserver.observe(row); });
}
/**
 * 记住当前 notebook，让刷新之后还落在同一个会话上。
 *
 * 聊天记录是按 notebook 隔离的（后端会话 key = notebook-{id}）。刷新后 state.notebookId
 * 是 null，于是 loadAiNotebooks 永远选 notebooks[0] —— 你在第三个 notebook 里聊了半天，
 * 刷新一下看到的是第一个的记录。内容没丢，只是你被换到了别的房间，看上去和丢了一样。
 *
 * localStorage 在隐私窗口/禁用站点数据时会抛，所以读写都兜住；读不到就回落到原来的行为。
 */
var NOTEBOOK_KEY = 'zq-ai-notebook';
function rememberNotebook(id) {
  try {
    if (id == null) localStorage.removeItem(NOTEBOOK_KEY);
    else localStorage.setItem(NOTEBOOK_KEY, String(id));
  } catch (e) {}
}
function recallNotebook() {
  try {
    var raw = localStorage.getItem(NOTEBOOK_KEY);
    return raw ? Number(raw) : null;
  } catch (e) { return null; }
}
async function loadAiNotebooks() {
  var list = await api.get('/ai/notebooks');
  state.notebooks = list || [];
  if (!state.notebooks.length) {
    setAiNotebookId(null);
    rememberNotebook(null);
    clearPendingSources();
    renderNotebooks();
    await loadAiSources();
    renderSteps([]);
    renderArtifacts([]);
    return;
  }
  // 本次会话内已有选择就用它；刚刷新时（还没有选择）用上次记住的那个。
  // 记住的那个可能已被删除，所以仍要过「还在不在」这一关，最后才回落到第一个。
  if (state.notebookId == null) setAiNotebookId(recallNotebook());
  var selectedStillExists = state.notebooks.some(function (item) { return Number(item.id) === Number(state.notebookId); });
  if (!selectedStillExists) setAiNotebookId(state.notebooks[0].id);
  rememberNotebook(state.notebookId);
  renderNotebooks();
  await loadAiSources();
}
function renderCurrentNotebookLabel() {
  var label = $('#zq-current-notebook');
  if (!label) return;
  var current = (state.notebooks || []).find(function (item) {
    return Number(item.id) === Number(state.notebookId);
  });
  label.textContent = current ? '当前 Notebook：' + (current.title || '未命名') : '普通聊天（未选择 Notebook）';
  label.title = current ? (current.title || '未命名') : '';   // 名字长时标题栏只显示开头，悬停看全名
}
function renameNotebook(nb) {
  askText({ title: '重命名 Notebook', label: '名称', value: nb.title || '' }).then(function (name) {
    if (!name || !name.trim() || name.trim() === nb.title) return;
    safe('重命名', async function () {
      await api.put('/ai/notebooks/' + nb.id, { title: name.trim() });
      toast('已重命名'); await loadAiNotebooks();
    });
  });
}
function renderNotebooks() {
  if (state.chatDraft && state.chatDraft.key() !== chatDraftKey()) state.chatDraft.reload();
  var host = $('#zq-notebooks'); if (!host) return;
  renderCurrentNotebookLabel();
  host.innerHTML = (state.notebooks || []).map(function (nb) {
    var active = nb.id === state.notebookId;
    return '<div data-notebook="' + nb.id + '" class="zq-nb"' + (active ? ' aria-current="true"' : '') + '><div data-nb-name="' + nb.id + '" class="zq-nb-name" title="' + esc(nb.title || 'Notebook') + (active ? ' · 点击重命名' : '') + '">' + esc(nb.title || 'Notebook') + '</div><div class="zq-nb-meta">' + esc(nb.sourceCount != null ? nb.sourceCount + ' 份资料' : '资料工作区') + '</div></div>';
  }).join('') || '<div class="zq-ai-empty-notebook"><strong>暂无 Notebook</strong><span>普通聊天仍可使用；上传资料前请先新建。</span></div>';
  $all('[data-notebook]', host).forEach(function (d) {
    var id = Number(d.dataset.notebook);
    var nb = (state.notebooks || []).find(function (x) { return x.id === id; });
    d.onclick = function (e) {
      // 已选中的 notebook 再点名字 → 改名；否则点击切换
      if (id === state.notebookId && e.target.closest('[data-nb-name]')) { renameNotebook(nb); return; }
      setAiNotebookId(id);
      rememberNotebook(id);   // 这条切换路径不经过 loadAiNotebooks，要自己记
      clearPendingSources();
      state.messages = [];
      renderNotebooks();
      renderAiMessages();
      renderSteps([]);
      renderArtifacts([]);
      loadAiSources();
      renderAgentPanels();
      safe('加载聊天记录', loadAiMessages);
    };
    d.oncontextmenu = function (e) {
      e.preventDefault();
      popMenu(e.clientX, e.clientY, [
        { label: '重命名', onClick: function () { renameNotebook(nb); } },
        {
          label: '删除 Notebook', danger: true,
          onClick: async function () {
            if (!await askConfirm({ title: '删除 Notebook', message: '删除「' + (nb.title || 'Notebook') + '」？其中的聊天记录、上传资料与 URL 将一并删除，且不可恢复。', okText: '删除', danger: true })) return;
            safe('删除 Notebook', async function () {
              await api.del('/ai/notebooks/' + nb.id);
              // 删的是当前选中项时必须清掉,让 loadAiNotebooks 回落到剩余的第一个
              if (state.notebookId === nb.id) {
                setAiNotebookId(null);
                state.messages = [];
                clearPendingSources();
                renderAiMessages();
                renderSteps([]);
                renderArtifacts([]);
              }
              toast('已删除');
              await loadAiNotebooks();
              await loadAiMessages();
              await renderAgentPanels();
            });
          }
        }
      ]);
    };
  });
}
// 资料类型 → 文字标注 + 底色（固定色相，不随主题象限色漂移；整块铺满卡片）
function srcTypeInfo(type) {
  var t = String(type || '').toUpperCase();
  var map = {
    PDF: ['PDF 文档', '#c2574f'],
    EXCEL: ['表格文件', '#3f8f63'],
    SHEET: ['表格文件', '#3f8f63'],
    TEXT: ['文本文件', '#3f6fae'],
    WEB_URL: ['网页链接', '#4a5fc1'],
    MANUAL_NOTE: ['手动笔记', '#b07d3c'],
    IMAGE: ['图片文件', '#7e5fb0']
  };
  return map[t] || [t || '资料', '#6b7280'];
}
function srcStatusLabel(s, sourceType) {
  // 图片不做文本解析，UPLOADED 就是它的正常终态 —— 而它是作为视觉内容交给模型的，
  // 写「仅存档，暂未进入问答」会让人以为图片没用、模型看不到。
  if (String(sourceType || '').toUpperCase() === 'IMAGE') {
    var st = String(s || '').toUpperCase();
    if (st === 'UPLOADED') return '图片，勾选后随消息交给模型';
    if (st === 'ERROR') return '图片不可用';
  }
  return ({
    READY: '已解析，可用于问答',
    PARSING: '正在解析，暂不可用',
    UPLOADED: '仅存档，暂未进入问答',
    ERROR: '解析失败，暂不可用'
  })[String(s || '').toUpperCase()] || (s || '');
}
function srcIndexStatusLabel(source) {
  if (String(source && source.status || '').toUpperCase() !== 'READY') return '';
  var status = String(source && source.indexStatus || 'NOT_INDEXED').toUpperCase();
  return ({
    PENDING: '语义索引中',
    INDEXED: '语义检索可用',
    ERROR: '索引失败，当前使用关键词检索',
    NOT_INDEXED: '当前使用关键词检索'
  })[status] || '当前使用关键词检索';
}
// 点击卡片下载：优先 showSaveFilePicker 让用户选保存位置，否则走浏览器默认下载
async function downloadAiSource(sid, title) {
  var n = notice('正在准备下载「' + title + '」…');
  try {
    var headers = {}; if (token()) headers.Authorization = 'Bearer ' + token();
    var res = await fetch(API + '/ai/notebooks/' + state.notebookId + '/sources/' + sid + '/download', { headers: headers, credentials: 'same-origin' });
    // 附件优先：带 Content-Disposition: attachment 的都是正常文件（含 .json 原件）；
    // 只有"无附件头 + JSON"才是 GlobalExceptionHandler 包装的业务错误（HTTP 200）
    var cd = res.headers.get('Content-Disposition') || '';
    var isAttachment = /attachment/i.test(cd);
    var ct = res.headers.get('Content-Type') || '';
    if (!res.ok || (!isAttachment && ct.indexOf('application/json') >= 0)) {
      var j = null; try { j = await res.json(); } catch (e) {}
      throw new Error((j && j.message) || ('下载失败(' + res.status + ')'));
    }
    var blob = await res.blob();
    var m = cd.match(/filename\*=UTF-8''([^;]+)/i);
    var fname = m ? decodeURIComponent(m[1]) : (title || '资料');
    if (window.showSaveFilePicker) {
      try {
        var handle = await window.showSaveFilePicker({ suggestedName: fname });
        var writable = await handle.createWritable();
        await writable.write(blob); await writable.close();
        n.update('已保存：' + fname, { done: true });
        return;
      } catch (e2) {
        if (e2 && e2.name === 'AbortError') { n.close(); return; } // 用户取消选位置
        // 其他失败回退到浏览器默认下载
      }
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    n.update('已开始下载：' + fname, { done: true });
  } catch (e) {
    n.update('下载失败：' + (e.message || '未知错误'), { error: true });
  }
}
async function loadAiSources() {
  var host = $('#zq-sources'); if (!host) return;
  if (!state.notebookId) {
    host.innerHTML = '<div class="zq-ai-source-empty"><strong>尚未选择 Notebook</strong><span>新建 Notebook 后即可上传资料。</span></div>';
    return;
  }
  var nbId = state.notebookId;
  var list = await api.get('/ai/notebooks/' + nbId + '/sources');
  if (nbId !== state.notebookId) return; // 响应期间已切换 notebook,丢弃过期资料列表
  host.innerHTML = (list || []).length ? '<div class="zq-src-grid">' + list.map(function (s) {
    var info = srcTypeInfo(s.sourceType);
    var title = s.title || s.url || '资料';
    var status = String(s.status || '').toUpperCase();
    var indexText = srcIndexStatusLabel(s);
    var statusText = srcStatusLabel(status, s.sourceType) + (status === 'ERROR' && s.parseError ? '：' + s.parseError : '')
      + (indexText ? ' · ' + indexText : '');
    return '<div class="zq-src-tile" data-source="' + s.id + '" data-source-title="' + esc(title) + '" data-source-url="' + esc(s.url || '') + '" style="--srcc:' + info[1] + ';" title="' + esc(statusText) + '">'
      + '<span class="zq-src-type">' + esc(info[0]) + '</span>'
      + '<span class="zq-src-dl">' + icon('download') + '</span>'
      + '<div class="zq-src-glass">'
      + '<div class="zq-src-title">' + esc(title) + '</div>'
      + '<div class="zq-src-meta"><span class="zq-src-dot" data-state="' + (status === 'READY' ? 'ok' : status === 'ERROR' ? 'bad' : '') + '"></span><span>' + esc(srcStatusLabel(status, s.sourceType)) + '</span></div>'
      + (indexText ? '<div class="zq-src-meta"><span class="zq-src-dot" data-state="' + (String(s.indexStatus || '').toUpperCase() === 'INDEXED' ? 'indexed' : String(s.indexStatus || '').toUpperCase() === 'ERROR' ? 'warn' : '') + '"></span><span>' + esc(indexText) + '</span></div>' : '')
      + '</div></div>';
  }).join('') + '</div>' : empty('暂无资料');
  $all('[data-source]', host).forEach(function (d) {
    var sid = d.dataset.source, sTitle = d.dataset.sourceTitle, sUrl = d.dataset.sourceUrl;
    d.onclick = function () { downloadAiSource(sid, sTitle); };
    d.oncontextmenu = function (e) {
      e.preventDefault();
      var items = [{ label: '下载到本地', onClick: function () { downloadAiSource(sid, sTitle); } }];
      // 仅放行 http/https，抓取失败留下的畸形 URL 不给打开入口
      if (sUrl && /^https?:\/\//i.test(sUrl)) items.push({ label: '打开原网址', onClick: function () { window.open(sUrl, '_blank', 'noopener'); } });
      items.push({
        label: '删除该资料', danger: true,
        onClick: async function () {
          if (!await askConfirm({ title: '删除资料', message: '删除「' + sTitle + '」？其解析内容将从 Notebook 中移除。', okText: '删除', danger: true })) return;
          safe('删除资料', async function () { await api.del('/ai/notebooks/' + state.notebookId + '/sources/' + sid); toast('已删除'); await loadAiNotebooks(); });
        }
      });
      popMenu(e.clientX, e.clientY, items);
    };
  });
}
/**
 * 一个 SSE 帧 → { event, data }。纯注释的帧（服务器心跳 `:ping`，见 SseHeartbeats）返回 null —— 它不是事件，
 * 不许被当成一个空的 message 交给处理函数。
 * SSE 规范：多条 data: 行以 \n 连接还原；只剥一个可选前导空格，不 trim（防止破坏换行 / 空白）。
 */
function parseSseFrame(frame) {
  var event = null, dataLines = [];
  frame.split(/\r\n|\n|\r/).forEach(function (l) {
    if (l.indexOf('event:') === 0) event = l.slice(6).trim();
    else if (l.indexOf('data:') === 0) dataLines.push(l.slice(5).replace(/^ /, ''));
  });
  if (event == null && !dataLines.length) return null;
  var dataStr = dataLines.join('\n');
  var data = {};
  if (dataStr) { try { data = JSON.parse(dataStr); } catch (e) { data = { text: dataStr }; } }
  return { event: event || 'message', data: data };
}
/**
 * 读一块，但最多等 ms 毫秒。服务器每 15 秒发一次心跳，所以 75 秒一个字节都没有，就是连接悄悄死了 ——
 * 原来这里会永远等下去，界面停在「发送中」，下面那套「断线后从库里接回」根本没有机会启动。
 */
var STREAM_IDLE_MS = 75000;
function readWithIdleTimeout(reader, ms) {
  var timer;
  return Promise.race([
    reader.read(),
    new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(requestError('连接 ' + Math.round(ms / 1000) + ' 秒没有任何数据', { idle: true }));
      }, ms);
    })
  ]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
}
async function streamAiChat(body, handlers) {
  var headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
  if (token()) headers.Authorization = 'Bearer ' + token();
  // 响应头 30 秒不到也算连不上（服务器挂住时 fetch 会一直等）
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  state.streamAbort = ctrl;   // 界面上的「立即」要能打断它
  var headTimer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
  var res;
  try {
    res = await fetch(API + '/ai/chat/stream', { method: 'POST', credentials: 'same-origin', headers: headers, body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
  } catch (e) {
    // 一个字节都没回来就连不上。原来原样抛出浏览器的「Failed to fetch」，页面上就是这句英文（第二十二轮断网实测）。
    // 等满 30 秒没有回应不算「没发出去」：连接是通的、请求多半已经到了，只是服务器卡着 —— 它可能正在存这句、正在回答
    var headTimedOut = !!(ctrl && ctrl.signal.aborted);
    throw requestError(headTimedOut ? '服务器 ' + Math.round(REQUEST_TIMEOUT_MS / 1000) + ' 秒没有回应' : '网络连接失败',
      { network: true, beforeResponse: !headTimedOut, timedOut: headTimedOut });
  } finally {
    if (headTimer) clearTimeout(headTimer);
  }
  if (res.status === 401 || res.status === 403) { redirectToLogin(); throw new Error('未登录或无权限'); }
  if (!res.ok || !res.body) throw new Error(res.status === 429 ? '请求过于频繁，请稍后再试' : '流式连接失败(' + res.status + ')');
  var reader = res.body.getReader(), decoder = new TextDecoder('utf-8'), buf = '';
  // 业务终止事件(done/error)送达后,个别容器/代理收尾时不发终止 chunk,读取器会报 network error;
  // 此时流在语义上已完整,按正常结束处理,不让收尾噪声打断发送方后续流程
  var terminalSeen = false;
  while (true) {
    var chunk;
    try {
      chunk = await readWithIdleTimeout(reader, STREAM_IDLE_MS);
    } catch (e) {
      if (e && e.idle) { try { reader.cancel(); } catch (x) { /* 已经断了 */ } }
      if (terminalSeen) break;
      if (e && !e.userFacing) throw requestError('连接断了', { network: true });   // 浏览器的原话是「network error」
      throw e;
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    // SSE 帧边界:规范允许 LF/CRLF/CR 三种行尾,空行即帧结束
    var m;
    while ((m = /\r\n\r\n|\n\n|\r\r/.exec(buf))) {
      var frame = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
      var parsed = parseSseFrame(frame);
      if (!parsed) continue;
      handlers(parsed.event, parsed.data);
      if (parsed.event === 'done' || parsed.event === 'error') terminalSeen = true;
    }
  }
}
function upsertAgentStep(raw, done) {
  var step = raw.step || raw;
  var id = step.id || step.stepId || step.title || (state.agentSteps.length + 1);
  var existing = state.agentSteps.find(function (s) { return s._id === id; });
  // 流式事件带的是 publicSummary / agentType，不是 title —— 原来只取 title，
  // 于是实时显示的轨迹是「步骤 1、步骤 2」，要等刷新重载才有名字。
  if (existing) {
    existing.status = done ? 'DONE' : (step.status || existing.status);
    if (step.title) existing.title = step.title;
    if (step.publicSummary) existing.publicSummary = step.publicSummary;
  } else {
    state.agentSteps.push({ _id: id, title: step.title || step.name || step.stepType || ('步骤 ' + (state.agentSteps.length + 1)),
      publicSummary: step.publicSummary || '', agentType: step.agentType || '',
      status: done ? 'DONE' : (step.status || 'RUNNING'), notes: [] });
  }
  renderSteps(state.agentSteps);
}
/**
 * coding agent 的逐步叙述（agent.step.note）：读了哪个文件、跑了什么命令、输出是什么。
 * 挂在对应步骤下面。命令行 zhiqu 读的是同一份事件 —— 两边说同样的话。
 * 每步最多留 NOTE_CAP 条：一个 10 轮的循环可能有几十次调用，全留会把轨迹栏撑爆。
 */
var NOTE_CAP = 40;
function addAgentStepNote(data) {
  if (!data || !data.message) return;
  var step = state.agentSteps.find(function (s) { return s._id === data.stepId; });
  if (!step) return;
  step.notes = step.notes || [];
  step.notes.push({ phase: data.phase || '', message: String(data.message) });
  if (step.notes.length > NOTE_CAP) step.notes.splice(0, step.notes.length - NOTE_CAP);
  renderSteps(state.agentSteps);
}
/** 一条叙述的 HTML。命令输出可能含任意字符（包括 HTML），一律 esc —— 它来自用户机器上跑出来的东西。 */
function stepNoteHtml(n) {
  if (n.phase === 'result') {
    var lines = n.message.split('\n');
    var shown = lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n…' : '');
    return '<pre class="zq-mono zq-step-out">' + esc(shown) + '</pre>';
  }
  return '<div class="zq-mono zq-step-note" data-state="' + (n.phase === 'error' ? 'bad' : n.phase === 'budget' ? 'warn' : '') + '">⎿ ' + esc(n.message) + '</div>';
}
/** 单行时的高度，与同排按钮对齐；也是清空后要回到的高度。 */
var DRAFT_BASE_HEIGHT = 44;   // 两行（输入框行高 22px，第四十四轮起没有上下内边距和边框 —— 框是外面那一层 .zq-composer）
var DRAFT_MAX_HEIGHT = 200;
/**
 * 输入框自适应高度。先置 auto 再读 scrollHeight —— 不置的话 scrollHeight 会被
 * 当前高度撑住，内容变少时收不回去。
 */
/** 聊天框的草稿按 Notebook 分开存。 */
function chatDraftKey() { return 'chat.' + (state.notebookId || 'none'); }
function growDraft() {
  var el = $('#zq-draft');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.max(DRAFT_BASE_HEIGHT, Math.min(el.scrollHeight, DRAFT_MAX_HEIGHT)) + 'px';
  paintSlash();
}
function waitLocal(runId, assistant, sameNb) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(d) {
      if (done) return;
      done = true;
      window.removeEventListener('zq-local', onEv);
      clearTimeout(timer);
      resolve(d || { type: 'fatal', message: '本机代码助手没有交结果' });
    }
    function onEv(e) {
      var d = (e && e.detail) || {};
      if (d.runId !== runId) return;
      if (d.type === 'trace' && d.step) {
        mergeTraceStep(assistant, d.step);
        if (sameNb()) renderAiMessages();
      }
      if (d.type === 'result' || d.type === 'fatal') finish(d);
    }
    var timer = setTimeout(function () {
      localCall({ action: 'stop' }).catch(function () {});
      finish({ type: 'fatal', message: '这一轮太久了，已经停下' });
    }, 250000);
    window.addEventListener('zq-local', onEv);
  });
}
/** 桌面应用里档位开着、选了文件夹：这一轮交给外壳，不走服务器的工作区（那碰不到这台电脑） */
async function sendDesktopTurn(txt, codeCommand) {
  var inp = $('#zq-draft');
  var folder = wsStatus && wsStatus.selectedRoot;
  if (!folder) { toast('先选一个项目文件夹', 'error'); return; }
  if (state.chatDraft) state.chatDraft.flush();
  var draftKey = state.chatDraft ? state.chatDraft.key() : null;
  inp.value = '';
  inp.style.height = DRAFT_BASE_HEIGHT + 'px';
  paintSlash();
  state.aiSending = true;
  var sendButton = $('#zq-send');
  if (sendButton) { sendButton.classList.add('is-busy'); sendButton.setAttribute('aria-label', '生成中（回车 = 排队）'); }
  var clientKey = 'local-' + Date.now();
  var assistant = { role: 'assistant', content: '', status: 'STREAMING', _clientKey: clientKey, _startedAt: nowMs(), steps: { steps: [] } };
  state.messages.push({ role: 'user', content: txt, _clientKey: clientKey + '-user' }, assistant);
  state.chatFollow = true;
  renderAiMessages();
  var stored = false;
  var sentNb = state.notebookId;
  try {
    await safe('本机代码', async function () {
      var minted = await api.post('/access-tokens/desktop-code', {});
      var token = minted && minted.token;
      if (!token) throw requestError('没拿到本机代码的登录令牌');
      var history = (state.messages || []).filter(function (m) {
        return m && m !== assistant && m._clientKey !== clientKey + '-user'
          && (m.role === 'user' || m.role === 'assistant') && m.content && m.status !== 'STREAMING';
      }).slice(-40).map(function (m) { return { role: m.role, content: String(m.content).slice(0, 8000) }; });
      var level = (wsStatus && wsStatus.selectedMode) || 'READ';
      if (codeCommand === 'review') level = 'READ';
      if (['READ', 'WRITE', 'EXEC'].indexOf(level) < 0) level = 'READ';
      var modelSel = $('#zq-model');
      var effortName = $('#zq-effort-name');
      var effortText = effortName && effortName.textContent ? String(effortName.textContent).trim() : '';
      var effort = AI_EFFORTS.indexOf(effortText) >= 0 ? effortText : 'instant';
      var body = {
        action: 'run', folder: folder, message: txt, history: history,
        model: modelSel && modelSel.value ? Number(modelSel.value) : null,
        effort: effort, level: level, token: token
      };
      if (codeCommand) body.command = codeCommand;
      var reply = await localCall(body);
      var runId = reply && reply.runId;
      if (!runId) throw requestError('本机代码助手没有开始');
      assistant.requestId = runId;
      var result = await waitLocal(runId, assistant, function () { return sentNb === state.notebookId; });
      assistant.status = '';
      var conclusion = result && (result.conclusion || (result.type === 'fatal' ? result.message : ''));
      assistant.content = String(conclusion || '').trim() || '（没有结论）';
      if (result && result.type === 'fatal') assistant.errorMessage = result.message || '本机代码助手没有做完';
      renderAiMessages();
      var saved = await api.post('/ai/desktop-turn', {
        notebookId: sentNb || null, message: txt, conclusion: assistant.content,
        steps: assistant.steps || { steps: [] }, drafts: (result && result.drafts) || [],
        folder: folder, command: codeCommand || ''
      });
      if (saved && saved.userMessageId && draftKey) drafts.clearIf(draftKey, txt);
      stored = true;
      if (sentNb === state.notebookId) {
        await loadAiMessages();
        await renderAgentPanels();
      }
    });
  } finally {
    state.aiSending = false;
    state.streamAbort = null;
    if (stored) clearPendingSend();
    if (sendButton) { sendButton.classList.remove('is-busy'); sendButton.setAttribute('aria-label', '发送（⌘/Ctrl + 回车）'); }
    if (!stored) {
      var at = state.messages.indexOf(assistant);
      if (at > 0 && state.messages[at - 1]._clientKey === clientKey + '-user') state.messages.splice(at - 1, 2);
      renderAiMessages();
      if (inp && !inp.value.trim()) { inp.value = txt; growDraft(); }
    }
    // 排队的那几条：桌面这一轮完了接着发（第一百三十二轮）。原来只有服务器那条路径有，桌面路径没有 ——
    // 点了「立即」停下来了，队列却不动
    pumpSendQueue();
  }
}

async function sendAiMessage(queuedText) {
  var inp = $('#zq-draft'), txt = String(queuedText != null ? queuedText : (inp && inp.value) || '').trim();
  if (!txt) return;
  // 斜杠命令和选文件夹只在桌面应用里（第一百三十一轮，用户：网页上没有）。网页里 / 开头就是一句话
  var slash = inDesktop() && queuedText == null ? parseSlash(inp.value) : null, codeCommand = null;
  closeSlashMenu();
  if (slash && !slash.def.turn) { runLocalSlash(slash); return; }
  // 正在回答时又发了一条（第一百三十二轮）：普通的话排进队列，这一轮结束自动发。
  // 原来这里是 `if (state.aiSending) return;` —— 字被吃掉了，用户以为发出去了。
  // 命令（/review 这种要起一轮的）不排：一轮没完不发新的一轮，字留着，等完了再按
  if (state.aiSending) {
    if (slash) { toast('正在回答，命令等这一轮完了再发'); return; }
    enqueueSend(txt);
    return;
  }
  if (slash) {
    var blocked = slashBlocked(slash.def);
    if (blocked) { toast(blocked, 'error'); return; }   // 字留着，切好了接着发；没叫模型
    codeCommand = slash.def.name.slice(1);
  }
  if (inDesktop() && (codeCommand || codeModeOn())) return sendDesktopTurn(txt, codeCommand);
  // 草稿等服务器确认收到了这条消息（任一事件带 userMessageId）才删；没收到就把字放回输入框（第十五轮）。
  // 原来一按发送就清空：没配模型、被限流、一刷新，这句话就没了。
  if (state.chatDraft) state.chatDraft.flush();
  var draftKeyAtSend = state.chatDraft ? state.chatDraft.key() : null;
  var stored = false;
  var gotEvent = false;
  inp.value = '';
  inp.style.height = DRAFT_BASE_HEIGHT + 'px'; // 收回单行，否则清空后仍撑着上一条的高度
  paintSlash();
  state.aiSending = true;
  markPendingSend(txt);   // 中途被导航打断的话，回来能知道「这一条没落地」
  stopStreamWatch();   // SSE 接管，轮询再跑就会和它抢着改同一批消息
  var sendButton = $('#zq-send');
  // 发送键只有一个箭头（第四十四轮）：生成中换成转圈（样式表画），读屏念「生成中」
  if (sendButton) { sendButton.classList.add('is-busy'); sendButton.setAttribute('aria-label', '生成中（回车 = 排队）'); }
  var reasoningMode = reasoningModeForRequest();
  // READY（有分块，走检索）和 IMAGE（无分块，走视觉内容块）都要发给后端。
  // 只发 READY 的话图片就被挡在这一层，后端永远收不到它。
  var selectedSourceIds = state.pendingSources
    .filter(function (source) {
      var st = String(source.status || '').toUpperCase();
      return st === 'READY' || String(source.sourceType || '').toUpperCase() === 'IMAGE';
    })
    .map(function (source) { return Number(source.id); });
  var clientKey = 'stream-' + Date.now();
  var assistant = {
    role: 'assistant',
    content: '',
    reasoningSummary: '',
    reasoningMode: reasoningMode,
    status: 'STREAMING',
    _clientKey: clientKey,
    _startedAt: nowMs()
  };
  state.messages.push({ role: 'user', content: txt, _clientKey: clientKey + '-user' }, assistant);
  // 用户刚按下发送，这是他自己的动作：无条件回到底部，之后再由他的滚动决定跟不跟随
  state.chatFollow = true;
  renderAiMessages();
  state.agentSteps = []; state.agentArtifacts = [];
  clearPlanModalQueue();
  state.agentArtifactRevision = (state.agentArtifactRevision || 0) + 1;
  renderSteps([]); renderArtifacts([]);
  var modelSel = $('#zq-model');
  var body = {
    message: txt,
    modelConfigId: modelSel && modelSel.value ? Number(modelSel.value) : null,
    enableWebSearch: !!($('#zq-web') && $('#zq-web').dataset.on === '1'),
    reasoningMode: reasoningMode,
    notebookId: state.notebookId || null,
    agentMode: 'AUTO',
    contextOptions: {
      includeWiki: true,
      selectedSourceIds: selectedSourceIds,
      codeMode: codeModeOn(),
      codeCommand: codeCommand || undefined
    }
  };
  // SSE 回调期间用户可能切换 notebook:快照发送时的 id,不再渲染/改写新窗口的全局流式状态
  var sentNb = state.notebookId;
  var sameNb = function () { return sentNb === state.notebookId; };
  // 后端 done 事件带 dropped/CANCELED:notebook 在流式期间被删除(可能来自其他标签页/API),
  // 本轮问答未入库——不能把已收到的回答当成功结果留在页面上
  var dropped = false;
  var completed = false;
  // 本轮以 SSE error 收场。注意它与 catch(e) 那条路不同：error 事件是**流正常结束**，
  // 不抛异常，所以下面的收尾照跑 —— 这正是错误文案被冲掉的原因，见末尾。
  var failed = false;
  // 传输层断开（与 SSE 的 error 事件不同：那是流正常结束）。断了之后要去把
  // 后端已经落库的部分接回来，见下面的 finally。
  var disconnected = false;
  // 一个字都没收到就连不上（断着网点了发送）：多半根本没发出去
  var notSent = false;
  try {
    await safe('AI 发送', async function () {
    try {
      await streamAiChat(body, function (event, data) {
        gotEvent = true;
        // 第一条带 requestId 的事件就记下：回答里步骤的展开状态按它记，流式中和收尾重拉列表之后是同一个键
        if (!assistant.requestId && data && data.requestId) assistant.requestId = data.requestId;
        if (!stored && data && data.userMessageId) {
          stored = true;
          if (draftKeyAtSend) drafts.clearIf(draftKeyAtSend, txt);
        }
        if (event === 'message.delta') {
          assistant.content += (data.text || data.delta || data.content || '');
          // 只改这一条气泡。退回全量渲染的两种情形：节点还没渲染出来（第一个增量），
          // 或 DOM 不是预期形状。不假装成功，也不静默什么都不做。
          if (sameNb() && !patchStreamingMessage(state.messages.indexOf(assistant))) renderAiMessages();
        }
        else if (event === 'reasoning.delta' && reasoningMode !== 'OFF') {
          assistant.reasoningSummary += (data.text || data.delta || '');
          if (sameNb()) renderAiMessages();
        }
        else if (event === 'agent.step.start') { if (sameNb()) upsertAgentStep(data, false); }
        else if (event === 'agent.step.done') { if (sameNb()) upsertAgentStep(data, true); }
        else if (event === 'agent.step.note') { if (sameNb()) addAgentStepNote(data); }
        else if (event === 'trace.step') {
          mergeTraceStep(assistant, data && data.step);
          if (sameNb() && !patchStreamingMessage(state.messages.indexOf(assistant))) renderAiMessages();
        }
        // 消息太长被截了中间（后端 UserMessageFit）：说给用户，而且多停一会儿 —— 这句话要读完
        else if (event === 'message.notice') { toast((data && data.message) || '这条消息被截短了', data && data.level === 'error' ? 'error' : 'warn', 9000); }
        else if (event === 'message.processing') {
          if (!assistant._planDraftReady && assistant.status === 'STREAMING' && data && data.stage === 'PLAN_DRAFT') {
            assistant._processing = data.message || '正在整理可确认的计划草稿…';
            if (sameNb()) renderAiMessages();
          }
        }
        else if (event === 'artifact.created') {
          if (sameNb()) {
            var incoming = receiveAgentArtifact(data);
            if (incoming && isPlanDraft(incoming)) {
              var readyItems = planDraftItems(incoming);
              if (readyItems.tasks.length || readyItems.routines.length) {
                assistant._planDraftReady = true;
                assistant._processing = '';
                renderAiMessages();
              }
            }
          }
        }
        else if (event === 'done') {
          assistant._processing = '';
          if (data && (data.dropped || data.status === 'CANCELED')) {
            dropped = true;
            assistant.status = '';
            toast(data.message || 'Notebook 已删除，本轮回答未保存', 'error');
          } else {
            if (data && data.content && !assistant.content) assistant.content = data.content;
            if (reasoningMode !== 'OFF' && data && data.reasoningSummary) {
              assistant.reasoningSummary = data.reasoningSummary;
            }
            if (data && data.assistantMessageId) assistant.id = data.assistantMessageId;
            if (data && data.requestId) assistant.requestId = data.requestId;
            if (data && data.steps && data.steps.steps) assistant.steps = data.steps;
            if (data && data.notice) assistant.notice = data.notice;
            assistant.status = '';
            completed = true;
            if (sameNb()) renderAiMessages();
          }
        }
        else if (event === 'error') {
          failed = true;
          assistant._processing = '';
          assistant.status = '';
          // 已经收到的半截留着，原因另起一行说（原来有半截就不说原因 —— 看着像是模型说完了）
          assistant.errorMessage = (data && data.message) || '未知错误';
          if (sameNb()) renderAiMessages();
        }
      });
    } catch (e) {
      if (!gotEvent && e && e.beforeResponse) {
        // 断着网点了发送：原来这里也当成「流到一半断了」—— 气泡里写「（连接中断，正在尝试接回…）」，可根本没有什么可接的，
        // 而且一直挂在那（第二十二轮断网实测）。本地先摆上的这两条撤掉，字放回输入框（finally），照实说没发出去。
        // 万一其实发到了（回应丢在路上）：网回来之后拉一次消息，那两条会从服务器那边回来
        notSent = true;
        var at = state.messages.indexOf(assistant);
        if (at > 0 && state.messages[at - 1]._clientKey === clientKey + '-user') state.messages.splice(at - 1, 2);
        renderAiMessages();
        throw requestError(e.message + '，这句没发出去 —— 字放回输入框了，连上网再发', { network: true });
      }
      // 连接断了，但后端多半还在生成 —— 而正文已经在阶段性落库（flushStreamingContent）。
      // 所以这里不再是死路。真正的重新拉取放在 finally 里：那时 state.aiSending 才置回
      // false，watchStreamingMessages 才会真的开始轮询（它见 aiSending 为真就直接返回）。
      // 在这里拉的话，轮询会被自己的「本页正在流」判断挡掉，接回悄悄失效。
      disconnected = true;
      assistant.status = '';
      if (!assistant.content) assistant.content = '（连接中断，正在尝试接回…）';
      renderAiMessages();
      if (!gotEvent && e && e.timedOut) {
        // 服务器等满 30 秒都没回应：这句可能已经存上了、正在回答。不说「没发出去」（那会诱导再发一遍、问两次），
        // 等一下从服务器拉一次（finally 里的 whenOnline）：存上了就接着显示，没存上那两条会自己消失
        throw requestError(e.message + '，不确定这句发出去没有 —— 稍后会从服务器拉一次，先别重发', { network: true });
      }
      throw e && e.network ? requestError('连接断了，网回来之后会把回答接上', { network: true }) : e;
    }
    if (dropped) {
      // 当前会话若还挂在已删 notebook 上,回落到默认选择(与右键删除 notebook 的刷新流程一致);
      // 重新拉列表+消息会自然清掉未保存的临时问答
      if (sameNb()) setAiNotebookId(null);
      await loadAiNotebooks();
      await loadAiMessages();
      await renderAgentPanels();
      return;
    }
    assistant.status = '';
    if (completed && sameNb()) clearUsedPendingSources(selectedSourceIds);
    renderAiMessages();
    // 出错时**不能**重新拉取。streamChatInternal 的四道前置检查（requireModel / 空消息 /
    // 深度思考支持 / 联网搜索可用）全部跑在落库之前，任一道抛 BusinessException 就是
    // 一条也没入库；而 /ai/messages 找不到会话会返回空列表，
    // state.messages = list || [] 会把本地这两条连同上面那句错误原因一起清空。
    // 用户看到的就是「闪一下两条，然后什么都没有」—— 而唯一说明"为什么不行"的那句话，
    // 恰好被这一步删掉了，于是他连去查什么都不知道。
    // 实测（未修时，全新用户无模型配置）：SSE 返回
    //   {"message":"请先在「设置 → AI 模型」里配置可用的 AI 模型","nonRetryable":true}
    // 随后 /ai/messages 返回 []，页面消息节点归零。
    if (!failed) await loadAiMessages();
    await renderAgentPanels();
    });
  } finally {
    state.aiSending = false;
    if (sendButton) { sendButton.classList.remove('is-busy'); sendButton.setAttribute('aria-label', '发送（⌘/Ctrl + 回车）'); }
    // 服务器没收到这句（没配模型、限流、根本没连上）：字放回输入框，草稿里也还在 —— 改一改就能再发。
    // 收到了（事件带过 userMessageId）的不放回：那会诱导再发一遍、存两条
    if (!stored && (failed || !gotEvent) && sameNb() && inp && !inp.value.trim()) {
      inp.value = txt;
      growDraft();
    }
    // 断线接回：此刻 aiSending 已经是 false，loadAiMessages 末尾的 watchStreamingMessages
    // 才会真的开始轮询，把后端继续生成的部分续上。不用用户手动刷新。
    // 网还断着的话这一下拉不到 —— 原来就停在这了；现在等网回来再拉（whenOnline）
    if (disconnected || notSent) whenOnline(function () { return sameNb() && !state.aiSending ? loadAiMessages() : null; });
    // 排队的那几条：这一轮完了接着发（第一百三十二轮）
    pumpSendQueue();
  }
}
/**
 * 网回来之后做一次 fn（返回 promise）：现在就试；失败了等 online 事件或 3 秒再试，最多试 40 次（约两分钟）。
 * 「网还断着」浏览器不一定知道（Wi-Fi 连着、外面不通），所以不只等 online 事件。
 */
function whenOnline(fn) {
  var tries = 0;
  function attempt() {
    tries++;
    Promise.resolve().then(fn).catch(function () {
      if (tries >= 40) return;
      var fired = false;
      var go = function () { if (fired) return; fired = true; window.removeEventListener('online', go); clearTimeout(timer); attempt(); };
      var timer = setTimeout(go, 3000);
      window.addEventListener('online', go);
    });
  }
  attempt();
}


// ───────────────────────── 代码工作区：选项目、切档位 ─────────────────────────
// 斜杠命令和选择文件夹只在桌面应用里（第一百三十一轮）。网页上没有这座桥，这两处都不露。
function inDesktop() {
  try {
    var w = typeof window === 'undefined' ? null : window;
    var h = w && w.webkit && w.webkit.messageHandlers;
    return !!(h && h.zqLocal && typeof h.zqLocal.postMessage === 'function');
  } catch (e) { return false; }
}
function localCall(body) {
  return window.webkit.messageHandlers.zqLocal.postMessage(body);
}
// 用户 2026-11-02：「在输入框上方选择项目里面选择目录，参考其他的 coding agent 产品，几个模式档位也用按钮点击切换」「模式的名字改成plan，auto，manual，close」；
// 2026-11-05：「左侧下面的工作区去掉」「点击选择文件夹应该直接打开系统的文件夹和文件页面」「档位切换有明显卡顿，放在输入框下方，点击向上拉起切换档位的面板」。
// 项目按钮在输入框上方，档位按钮在输入框下面那条工具里。前提（回环 / 目录存在 / 本机的请求）由后端裁决，前端不复述 ——
// 选了的档位没生效时，把后端说的原因（reason）写出来，不偷偷改按钮。
var WS_MODE_ORDER = ['OFF', 'READ', 'WRITE', 'EXEC'];   // 按能力从小到大，最常用的离按钮最近
var WS_MODE_NAME = { OFF: 'close', READ: 'plan', WRITE: 'manual', EXEC: 'auto' };
var WS_MODE_DESC = {
  OFF: '关闭。普通聊天，AI 助手看不到任何本机文件。',
  READ: '只读。AI 能读项目文件夹、跑命令查东西，出方案；命令关在系统沙箱里，一个字节都改不了。',
  WRITE: '能改文件，每一处改动都要你在草稿里确认后才落盘；命令还是只读的。',
  EXEC: '能改文件，还能自己跑命令：命令关在系统沙箱里（只能写这个文件夹、断网、读不到家目录），写的东西直接落盘；AI 用编辑工具改的照样要你确认。没有系统沙箱的电脑退回白名单命令。仅本机自用。'
};
// 最近用过的项目只记在这台浏览器里（每个人自己的方便，不是要存的状态）；存不了就当没有
var WS_RECENT_KEY = 'zq.ws.recent';
function recentProjects() {
  try {
    var v = JSON.parse(localStorage.getItem(WS_RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x; }).slice(0, 6) : [];
  } catch (e) { return []; }
}
function rememberProject(root) {
  if (!root) return;
  try { localStorage.setItem(WS_RECENT_KEY, JSON.stringify([root].concat(recentProjects().filter(function (x) { return x !== root; })).slice(0, 6))); } catch (e) { /* 存不了就算了 */ }
}
function projectName(root) {
  var parts = String(root || '').replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || String(root || '');
}

var wsStatus = null, wsBarBusy = false, wsBarNext = null;
// 这一句走不走代码模式：档位开着（不是 close，而且生效了）就走。用户 2026-11-05：「代码按钮删掉，感觉多余了」——
// 选了项目、选了档位就是要它在里面干活；原来还要再按一个按钮，不按就靠关键词猜，猜漏了就是「我无法操作你的电脑」。想普通聊天切到 close。
// 能不能写、能不能跑照旧由档位卡在后端（门在 CodeWorkspaceAgent）；编辑工具的改动先成草稿，auto 档 shell 写的直接落盘（用户定的）
function codeModeOn() {
  if (!wsStatus || !wsStatus.enabled) return false;
  // 桌面应用没有选中的文件夹就不走本机代码（网页上档位开着、没选文件夹是生成到产物）
  if (inDesktop()) return !!wsStatus.selectedRoot;
  return true;
}

// ───────────────────────── 输入框里的 / 命令（第一百一十八轮；第一百三十一轮起只在桌面应用里）
// 用户 2026-11-07 在网页里要过这层面板。2026-11-12 改了：面板和选择文件夹只有桌面应用有，网页上打 / 就是一句话。
// 只有第一个词正好是认识的命令才算命令：「/usr/bin 有问题」照常发给模型；不接参数的命令后面跟了字（「/init 是什么意思」）也是一句话。
// 全部走现有的功能，这里不另存一份档位、模型。桌面里的档位和文件夹记在这台电脑上，不改服务器的工作区。
var SLASH_COMMANDS = [
  { name: '/mode', args: 'close | plan | manual | auto', desc: '切换档位', choices: function () {
    return WS_MODE_ORDER.map(function (m) { return { value: WS_MODE_NAME[m], desc: WS_MODE_DESC[m] }; });
  } },
  { name: '/effort', args: 'instant | medium | high | extra | max', desc: '思考档位：想得越久答得越稳，也越慢、越费 token', choices: function () {
    return AI_EFFORTS.map(function (e) { return { value: e, desc: AI_EFFORT_DESC[e] }; });
  } },
  { name: '/model', args: '模型名', desc: '查看 / 切换模型', choices: function () { return slashModels().map(function (m) { return { value: m.label, desc: '' }; }); } },
  { name: '/project', args: '文件夹路径', desc: '选项目；不写路径就打开选择', folder: true },
  { name: '/web', args: 'on | off', desc: '联网搜索开 / 关', choices: function () { return [{ value: 'on', desc: '打开联网搜索' }, { value: 'off', desc: '关掉联网搜索' }]; } },
  { name: '/new', desc: '新建一个 Notebook', bare: true },
  { name: '/init', desc: '读项目，写一份 ZHIQU.md 初稿', bare: true, turn: true, folder: true },
  { name: '/review', args: '[--base 分支 | --commit 提交] [说明]', desc: '只读地审查改动，按 P0–P3 列问题', turn: true, folder: true },
  { name: '/help', desc: '列出这些命令', bare: true },
];
var slashItems = [], slashActive = 0, slashDismissed = null;

function slashDef(name) { return SLASH_COMMANDS.filter(function (c) { return c.name === name; })[0] || null; }
/** 认得的命令才返回：{ def, rest }。开头有空格不算（那一段要和输入框的字逐个对齐上色，也不像在打命令） */
function parseSlash(text) {
  var m = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/.exec(String(text || ''));
  if (!m) return null;
  var def = slashDef(m[1]);
  var rest = (m[2] || '').trim();
  if (!def || (def.bare && rest)) return null;
  return { def: def, rest: rest };
}
/** 现在这段字对应面板里哪几项。{ name, args, desc }：name 是选中后输入框里的样子 */
function slashMatches(text) {
  var value = String(text || '');
  if (value.charAt(0) !== '/' || /\n/.test(value)) return [];
  if (!/\s/.test(value)) {
    return SLASH_COMMANDS.filter(function (c) {
      return c.name.indexOf(value) === 0;   // 要文件夹的命令只在桌面里列（面板本身也只在桌面里开）
    }).map(function (c) { return { name: c.name, args: c.args || '', desc: c.desc }; });
  }
  var m = /^(\/[a-z]+)\s+(.*)$/.exec(value);
  var def = m && slashDef(m[1]);
  if (!def || !def.choices) return [];
  var typed = m[2].trim().toLowerCase();
  return def.choices().filter(function (c) { return c.value.toLowerCase().indexOf(typed) === 0; })
    .map(function (c) { return { name: def.name + ' ' + c.value, args: '', desc: c.desc }; });
}
function slashModels() {
  var sel = $('#zq-model');
  return sel && sel.options ? Array.prototype.slice.call(sel.options).filter(function (o) { return o.value; })
    .map(function (o) { return { value: o.value, label: String(o.textContent || '').trim() }; }) : [];
}
/** /init、/review 现在做不了的话，告诉用户差什么（不叫模型）。能做返回 null */
function slashBlocked(def) {
  if (!inDesktop()) return def.name + ' 只在桌面应用里';
  if (!wsStatus || (wsStatus.selectedMode || 'OFF') === 'OFF') return '代码模式关着（close）。先切档位：/mode ' + (def.name === '/review' ? 'plan' : 'manual');
  if (!wsStatus.selectedRoot) return def.name + ' 要先选项目：/project';
  if (!wsStatus.enabled) return '代码工作区没有生效：' + (wsStatus.reason || '看一下项目和档位');
  if (def.name === '/init' && wsStatus.selectedMode === 'READ') return 'plan 是只读的，写不了 ZHIQU.md。先切档位：/mode manual';
  return null;
}
/** 当场做完的命令。参数不对就说、字留着；做了就清掉输入框 */
function runLocalSlash(slash) {
  var ok = localSlashActions[slash.def.name](slash.rest);
  if (ok === false) return;
  var inp = $('#zq-draft');
  inp.value = slash.def.name === '/help' ? '/' : '';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  if (state.chatDraft) state.chatDraft.flush();
  if (slash.def.name === '/help') inp.focus();
}
function slashNo(text) { toast(text, 'error'); return false; }
var localSlashActions = {
  '/mode': function (arg) {
    if (!wsStatus) return slashNo('工作区的状态还没读到，等一下再切');
    if (!arg) { toggleTierMenu(); return true; }
    var mode = WS_MODE_ORDER.filter(function (m) { return WS_MODE_NAME[m] === arg; })[0];
    if (!mode) return slashNo('/mode 接 close、plan、manual、auto，收到 ' + arg);
    chooseTier(mode);
    return true;
  },
  '/effort': function (arg) {
    if (!arg) { toggleEffortMenu(); return true; }
    if (AI_EFFORTS.indexOf(arg) < 0) return slashNo('/effort 接 ' + AI_EFFORTS.join('、') + '，收到 ' + arg);
    chooseEffort(arg);
    return true;
  },
  '/model': function (arg) {
    var sel = $('#zq-model'), models = slashModels();
    if (!sel) return false;
    if (!arg) {
      sel.focus();
      try { sel.showPicker(); } catch (e) { /* 老的 WebKit 没有，焦点已经在上面了 */ }
      return true;
    }
    var typed = arg.toLowerCase();
    var exact = models.filter(function (m) { return m.label.toLowerCase() === typed || m.value === arg; });
    var hits = exact.length ? exact : models.filter(function (m) { return m.label.toLowerCase().indexOf(typed) >= 0; });
    if (hits.length !== 1) {
      return slashNo(hits.length ? arg + ' 对得上几个：' + hits.map(function (m) { return m.label; }).join('、')
        : models.length ? '没有叫 ' + arg + ' 的模型，可以选：' + models.map(function (m) { return m.label; }).join('、') : '还没有可用的模型');
    }
    sel.value = hits[0].value;
    saveComposerPref('model', sel.value);
    toast('模型：' + hits[0].label);
    return true;
  },
  '/project': function (arg) {
    if (!wsStatus) return slashNo('工作区的状态还没读到，等一下再选');
    if (!inDesktop()) return slashNo('选择文件夹只在桌面应用里');
    if (!arg) { toggleProjectMenu(); return true; }
    var folder = arg.replace(/^(["'])(.*)\1$/, '$2');
    // 不是路径就不去切（「/project 这个目录怎么样」）：切了，这句话就没了
    if (!/^(\/|[A-Za-z]:[\\/])/.test(folder)) return slashNo('/project 接文件夹的绝对路径，收到 ' + arg);
    switchWorkspace(modeForProject(wsStatus.selectedMode), folder);
    return true;
  },
  '/web': function (arg) {
    if (arg && arg !== 'on' && arg !== 'off') return slashNo('/web 接 on 或 off，收到 ' + arg);
    var on = $('#' + AI_TOGGLE_IDS.web).dataset.on === '1';
    if (!arg || (arg === 'on') !== on) aiToggle('web');
    toast('联网搜索：' + ($('#' + AI_TOGGLE_IDS.web).dataset.on === '1' ? '开' : '关'));
    return true;
  },
  '/new': function () { $('#zq-new-notebook').click(); return true; },
  '/help': function () { return true; },
};

function closeSlashMenu() {
  var menu = $('#zq-slash-menu'), inp = $('#zq-draft');
  slashItems = [];
  if (!menu || !inp) return;
  menu.hidden = true;
  inp.removeAttribute('aria-activedescendant');
}
function slashOpen() { return slashItems.length > 0; }
/** 命令那一段换颜色：输入框不能一段一段上色，后面垫一层排版一样的字。只有在打命令时才启用，平时还是原来的输入框 */
function paintSlash() {
  var inp = $('#zq-draft'), mirror = $('#zq-draft-mirror'), box = $('#zq-composer');
  if (!inp || !mirror || !box) return;
  if (!inDesktop()) {
    box.classList.remove('has-command');
    if (mirror.innerHTML) mirror.innerHTML = '';
    closeSlashMenu();
    return;
  }
  var slash = parseSlash(inp.value);
  box.classList.toggle('has-command', !!slash);
  if (slash) {
    // 末尾的零宽字符：最后一个字是换行时，后面这层也要多出一行，不然滚到底对不齐
    mirror.innerHTML = '<span class="zq-draft-cmd">' + esc(slash.def.name) + '</span>' + esc(inp.value.slice(slash.def.name.length)) + '\u200b';
    mirror.scrollTop = inp.scrollTop;
  } else if (mirror.innerHTML) mirror.innerHTML = '';
  paintSlashMenu();
}
function paintSlashMenu() {
  var menu = $('#zq-slash-menu'), inp = $('#zq-draft');
  if (!menu || !inp) return;
  if (!inDesktop()) { closeSlashMenu(); return; }
  var value = inp.value;
  var items = slashDismissed === value || (document.activeElement && document.activeElement !== inp) ? [] : slashMatches(value);
  if (!items.length) { closeSlashMenu(); return; }
  slashItems = items;
  slashActive = 0;
  menu.innerHTML = items.map(function (it, i) {
    return '<button type="button" role="option" tabindex="-1" class="zq-slash-item" id="zq-slash-' + i + '" data-slash-i="' + i + '" aria-selected="' + (i === 0) + '">'
      + '<span class="zq-slash-name">' + esc(it.name) + '</span>'
      + (it.args ? '<span class="zq-slash-args">' + esc(it.args) + '</span>' : '')
      + '<span class="zq-slash-desc">' + esc(it.desc) + '</span></button>';
  }).join('');
  menu.hidden = false;
  inp.setAttribute('aria-activedescendant', 'zq-slash-0');
}
function moveSlash(step) {
  var menu = $('#zq-slash-menu'), inp = $('#zq-draft');
  slashActive = (slashActive + step + slashItems.length) % slashItems.length;
  $all('[data-slash-i]', menu).forEach(function (b, i) {
    b.setAttribute('aria-selected', i === slashActive ? 'true' : 'false');
    if (i === slashActive && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
  });
  inp.setAttribute('aria-activedescendant', 'zq-slash-' + slashActive);
}
function setDraftText(text) {
  var inp = $('#zq-draft');
  inp.value = text;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.focus();
}
/** Tab：补全，接着打参数（要参数的后面留一个空格） */
function completeSlash(item) {
  var def = slashDef(item.name);
  setDraftText(item.name + (def && def.args ? ' ' : ''));
}
/** 回车、点一下：就是它，执行 */
function acceptSlash(item) {
  setDraftText(item.name);
  sendAiMessage();
}
function bindSlash(draft) {
  draft.setAttribute('aria-autocomplete', 'list');
  draft.setAttribute('aria-controls', 'zq-slash-menu');
  draft.addEventListener('input', function () { slashDismissed = null; growDraft(); });
  draft.addEventListener('scroll', function () {
    var mirror = $('#zq-draft-mirror');
    if (mirror) mirror.scrollTop = draft.scrollTop;
  });
  draft.addEventListener('focus', paintSlashMenu);
  draft.addEventListener('blur', closeSlashMenu);
  draft.addEventListener('keydown', slashKeydown);
  var menu = $('#zq-slash-menu');
  if (!menu) return;
  // 按下时不让输入框失焦（失焦就收起了，这一下点不到）
  menu.addEventListener('mousedown', function (event) { event.preventDefault(); });
  menu.addEventListener('click', function (event) {
    var row = event.target.closest && event.target.closest('[data-slash-i]');
    if (row) acceptSlash(slashItems[Number(row.getAttribute('data-slash-i'))]);
  });
}
function slashKeydown(event) {
  // ⌘/Ctrl + 回车发送，单独回车换行 —— 与多数聊天工具一致。
  // 旧行为是「回车发送、Shift+回车换行」，而那时 #zq-draft 还是 <input>：
  // Shift+回车那一半从来就没生效过，input 根本装不下换行符。
  // 换成 textarea 之后「换行」才第一次真的可用，所以发送键位一并让出去。
  // 只有一处按键处理：面板开着时这个回车是选命令的，两处各管各就会发两次
  if (event.isComposing || event.keyCode === 229) return;   // 正在选拼音：这个回车是选字的
  var enter = event.key === 'Enter' && !event.shiftKey;
  if (slashOpen()) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSlash(event.key === 'ArrowDown' ? 1 : -1); return; }
    if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); completeSlash(slashItems[slashActive]); return; }
    if (event.key === 'Escape') { event.preventDefault(); slashDismissed = event.target.value; closeSlashMenu(); return; }
    if (enter) { event.preventDefault(); acceptSlash(slashItems[slashActive]); return; }
    return;
  }
  // 面板收着（打了参数）：一行的命令回车就执行。两行以上是在写长说明，回车还是换行，⌘/Ctrl + 回车才发
  var command = inDesktop() && event.target.value.trim().indexOf('\n') < 0 && parseSlash(event.target.value);
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || (enter && command))) {
    event.preventDefault();
    sendAiMessage();
  }
}
// 切换只发这一个请求，回来的就是新状态，直接画（第一百零五轮：原来再读一遍设置、再读一遍文件树，库在远程时每个都要多走一趟）。
// 一次只发一个。在途时又选了：记下最后选的，这一个回来再发它（最后选的生效）。失败了照后端重画（名字是选的时候先改的，要退回去）
async function applyWorkspace(mode, root) {
  if (wsBarBusy) { wsBarNext = { mode: mode, root: root }; return; }
  wsBarBusy = true;
  var fresh = null;
  try {
    await safe('切换代码工作区', async function () {
      fresh = await api.put('/workspace/settings', { mode: mode, root: root });
      if (mode !== 'OFF') rememberProject(root);
    });
  } finally {
    wsBarBusy = false;
    var next = wsBarNext; wsBarNext = null;
    if (next) await applyWorkspace(next.mode, next.root);
    else if (fresh) paintWorkspaceBar(fresh);
    else await loadWorkspace();
  }
}
// 名字先变、面板先收，请求在后面走：点下去不等网络
function switchWorkspace(mode, root) {
  // 桌面应用的档位和文件夹记在这台电脑上，不改服务器的工作区（服务器碰不到用户的磁盘）
  if (inDesktop()) {
    var folders = (wsStatus && wsStatus.folders) || [];
    if (root && folders.length && folders.indexOf(root) < 0) {
      toast('这个文件夹还没在「选择文件夹」里选过', 'error');
      return;
    }
    try {
      localStorage.setItem('zq.desktop.mode', mode);
      if (root) localStorage.setItem('zq.desktop.folder', root);
      else localStorage.removeItem('zq.desktop.folder');
    } catch (e) { /* 存不了也先切上 */ }
    if (root) rememberProject(root);
    var available = !wsStatus || wsStatus.available !== false;
    wsStatus = Object.assign({}, wsStatus || {}, {
      selectedMode: mode, selectedRoot: root, desktop: true, folders: folders,
      enabled: mode !== 'OFF' && !!root && available,
      reason: mode !== 'OFF' && !root ? '先选一个项目文件夹' : null
    });
    paintWorkspaceChoice();
    var note = $('#zq-ws-bar-note');
    if (note) note.textContent = mode !== 'OFF' && !wsStatus.enabled && wsStatus.reason ? '没有生效：' + wsStatus.reason : '';
    return;
  }
  // 切到 close 马上算关了（紧接着发的那句不走代码模式）；开着的要等后端说生效了才算
  wsStatus = Object.assign({}, wsStatus, { selectedMode: mode, selectedRoot: root, enabled: mode === 'OFF' ? false : wsStatus.enabled });
  paintWorkspaceChoice();
  applyWorkspace(mode, root);
}
// 选了项目而档位还是 close：开成 plan（只读，最小的那一档），不然选了像没选
function modeForProject(mode) { return mode && mode !== 'OFF' ? mode : 'READ'; }

function paintWorkspaceChoice() {
  var mode = wsStatus.selectedMode || 'OFF', root = wsStatus.selectedRoot || '';
  var btn = $('#zq-ws-project');
  // 档位开着、没选文件夹：生成到产物（第一百一十六轮）
  var toArtifact = mode !== 'OFF' && !root;
  $('#zq-ws-project-name').textContent = root ? projectName(root) : toArtifact ? '生成到产物' : '选择项目';
  btn.title = root ? '项目：' + root + '（点开换一个）'
    : toArtifact ? '没选文件夹：文件生成到产物，能预览、下载（点开选一个文件夹）' : '选择项目：AI 只读写这一个文件夹；不选就生成到产物';
  $('#zq-tier-name').textContent = WS_MODE_NAME[mode] || mode;
  $('#zq-tier').title = '代码工作区的档位：' + (WS_MODE_DESC[mode] || '');
}

function paintWorkspaceBar(status) {
  var bar = $('#zq-ws-bar'), tier = $('#zq-tier-pick');
  if (!bar) return;
  closeWorkspaceMenu();
  wsStatus = status;
  var only = !!(status && status.artifactOnly);   // 服务器上：没有文件夹，只有产物
  bar.hidden = !status || (only && (status.selectedMode || 'OFF') === 'OFF');   // 只剩一句说明：close 时没什么可说
  if (tier) tier.hidden = !status;
  if (!status) return;
  $('#zq-ws-project').hidden = !inDesktop() || only;   // 选择文件夹只在桌面应用里
  paintWorkspaceChoice();
  $('#zq-ws-project').onclick = function () { toggleProjectMenu(); };
  $('#zq-tier').onclick = function () { toggleTierMenu(); };
  var mode = status.selectedMode || 'OFF';
  $('#zq-ws-bar-note').textContent = mode !== 'OFF' && !status.enabled && status.reason ? '没有生效：' + status.reason : status.artifactMode ? '文件会生成到产物里，能预览、下载' : '';
}

// 两个弹出的面板（项目、档位）同一套开关：同时只开一个；点别处、按 Esc 收起（Esc 之后焦点回到按钮）；上下键在几项之间走
var wsMenuOpen = null;
function closeWorkspaceMenu() {
  if (!wsMenuOpen) return;
  var open = wsMenuOpen; wsMenuOpen = null;
  open.menu.hidden = true;
  open.btn.setAttribute('aria-expanded', 'false');
  open.off();
}
function openWorkspaceMenu(menu, btn, focusSelector) {
  closeWorkspaceMenu();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  var first = $(focusSelector, menu) || $('button', menu);
  if (first) first.focus();
  function away(e) { if (!menu.contains(e.target) && !btn.contains(e.target)) closeWorkspaceMenu(); }
  function onKey(e) {
    if (e.key === 'Escape') { closeWorkspaceMenu(); btn.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var items = $all('button', menu), at = items.indexOf(document.activeElement);
    if (!items.length) return;
    e.preventDefault();
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }
  document.addEventListener('mousedown', away);
  document.addEventListener('keydown', onKey);
  wsMenuOpen = { menu: menu, btn: btn, off: function () { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', onKey); } };
}

function toggleTierMenu() {
  var menu = $('#zq-tier-menu'), btn = $('#zq-tier');
  if (wsMenuOpen && wsMenuOpen.menu === menu) { closeWorkspaceMenu(); return; }
  var current = wsStatus.selectedMode || 'OFF';
  menu.innerHTML = WS_MODE_ORDER.map(function (m) {
    return '<button type="button" role="menuitemradio" class="zq-tier-item" data-ws-mode="' + m + '" aria-checked="' + (m === current) + '" title="' + esc(WS_MODE_DESC[m]) + '">' + esc(WS_MODE_NAME[m]) + '</button>';
  }).join('');
  $all('[data-ws-mode]', menu).forEach(function (b) {
    b.onclick = function () { chooseTier(b.getAttribute('data-ws-mode')); };
  });
  openWorkspaceMenu(menu, btn, '[aria-checked="true"]');
}
function chooseTier(mode) {
  closeWorkspaceMenu();
  if (mode === (wsStatus.selectedMode || 'OFF')) return;
  var root = wsStatus.selectedRoot || '';
  // 没选项目也能开：就是生成到产物。要文件夹点项目那个按钮（第一百一十六轮，原来这里直接弹选文件夹的框）
  switchWorkspace(mode, root);
}

function toggleProjectMenu() {
  var menu = $('#zq-ws-menu'), btn = $('#zq-ws-project');
  if (wsMenuOpen && wsMenuOpen.menu === menu) { closeWorkspaceMenu(); return; }
  var root = wsStatus.selectedRoot || '';
  var desktop = inDesktop();
  function toProject(picked) { switchWorkspace(modeForProject(wsStatus.selectedMode), picked); }
  var list = [root].concat(desktop ? (wsStatus.folders || []) : []).concat(recentProjects()).filter(function (x, i, all) { return x && all.indexOf(x) === i; });
  menu.innerHTML = (list.length ? '<div class="zq-ws-menu-head">最近的项目</div>' : '')
    + list.map(function (r) {
      return '<button type="button" role="menuitem" class="zq-ws-menu-item" data-ws-root="' + esc(r) + '"' + (r === root ? ' aria-current="true"' : '') + ' title="' + esc(r) + '">'
        + icon('folder') + '<span class="zq-ws-menu-name">' + esc(projectName(r)) + '</span><span class="zq-ws-menu-path">' + esc(r) + '</span></button>';
    }).join('')
    + '<div class="zq-ws-menu-sep"></div>'
    + '<button type="button" role="menuitem" class="zq-ws-menu-item" data-ws-browse="1">' + icon('plus') + '<span class="zq-ws-menu-name">选择文件夹…</span></button>'
    + (desktop ? '' : '<button type="button" role="menuitem" class="zq-ws-menu-item" data-ws-artifact="1"' + (root ? '' : ' aria-current="true"') + '>' + icon('file') + '<span class="zq-ws-menu-name">不选文件夹，生成到产物</span></button>');
  $all('[data-ws-root]', menu).forEach(function (b) {
    b.onclick = function () {
      var r = b.getAttribute('data-ws-root');
      closeWorkspaceMenu();
      if (r !== root || wsStatus.selectedMode === 'OFF') toProject(r);
    };
  });
  $('[data-ws-browse]', menu).onclick = function () {
    closeWorkspaceMenu();
    pickProjectFolder(root, toProject);
  };
  var artifactBtn = $('[data-ws-artifact]', menu);
  if (artifactBtn) artifactBtn.onclick = function () {
    closeWorkspaceMenu();
    if (root || wsStatus.selectedMode === 'OFF') switchWorkspace(modeForProject(wsStatus.selectedMode), '');
  };
  openWorkspaceMenu(menu, btn, '[aria-current="true"]');
}

// 选文件夹：弹系统的选择框（后端起的，它和用户在同一台电脑上），等用户选完才回，所以超时给得比后端 10 分钟的上限长。
// 弹不了才退回页面里那个一层层点的。连点两下只弹一个
var WS_PICK_TIMEOUT_MS = 11 * 60 * 1000;
var wsPicking = false;
async function pickProjectFolder(start, onPick) {
  if (wsPicking) return;
  wsPicking = true;
  if (inDesktop()) {
    try {
      await safe('选择文件夹', async function () {
        var res = await localCall({ action: 'pick' });
        if (res && res.folder) onPick(res.folder);
      });
    } finally { wsPicking = false; }
    return;
  }
  try {
    await safe('选择文件夹', async function () {
      var res = await api.post('/workspace/pick-folder', { start: start || '' }, null, { timeoutMs: WS_PICK_TIMEOUT_MS });
      if (res && res.path) onPick(res.path);
      else if (res && res.unavailable) { toast(res.unavailable + '，用页面里的选择器'); openWorkspaceFolderPicker(start, onPick); }
    });
  } finally {
    wsPicking = false;
  }
}

// 文件夹选择器：走后端 /workspace/browse 一层层点进去。onPick(绝对路径) 选定当前文件夹。
function openWorkspaceFolderPicker(startPath, onPick) {
  var cur = { path: startPath || '', parent: null };
  var h = openModal({
    title: '选择工作文件夹',
    width: 480,
    bodyHtml:
      '<div id="zq-fp-cur" class="zq-mono zq-fp-cur">读取中…</div>' +
      '<div class="zq-fp-bar">' +
        '<button id="zq-fp-up" class="zq-btn-ghost">' + icon('arrow-up') + '上一层</button>' +
        '<button id="zq-fp-pick" class="zq-btn">选定当前文件夹</button>' +
      '</div>' +
      '<div id="zq-fp-list" class="zq-fp-list"></div>',
    onMount: function (body) {
      async function go(path) {
        var res;
        try {
          res = await api.get('/workspace/browse' + (path ? '?path=' + encodeURIComponent(path) : ''));
        } catch (e) { toast('读不了这个目录', 'error'); return; }
        cur.path = res.path; cur.parent = res.parent;
        $('#zq-fp-cur', body).textContent = res.path;
        $('#zq-fp-up', body).disabled = !res.parent;   // 灰掉的样子在样式表（.zq-fp-bar .zq-btn-ghost:disabled）
        var list = $('#zq-fp-list', body);
        var dirs = res.dirs || [];
        list.innerHTML = dirs.length ? '' : '<div class="zq-fp-note">（没有子文件夹）</div>';
        // 一项是一个按钮（原来是没有 href 的 <a>，键盘 Tab 不到）；悬停的底色在样式表
        dirs.forEach(function (d) {
          var a = document.createElement('button');
          a.type = 'button';
          a.className = 'zq-fp-item';
          a.innerHTML = icon('folder') + '<span class="zq-fp-name">' + esc(d.name) + '</span>';
          a.onclick = function () { go(d.path); };
          list.appendChild(a);
        });
        if (res.truncated) {
          var more = document.createElement('div');
          more.className = 'zq-fp-note';
          more.textContent = '子文件夹太多，只显示了前 500 个';
          list.appendChild(more);
        }
      }
      $('#zq-fp-up', body).onclick = function () { if (cur.parent) go(cur.parent); };
      $('#zq-fp-pick', body).onclick = function () {
        if (!cur.path) return;
        onPick(cur.path);
        h.close();
      };
      go(cur.path);
    }
  });
}


async function loadDesktopWorkspace() {
  var st = null;
  try { st = await localCall({ action: 'status' }); } catch (e) { paintWorkspaceBar(null); return; }
  var folders = st && Array.isArray(st.folders) ? st.folders.filter(function (x) { return typeof x === 'string' && x; }) : [];
  var mode = 'OFF', root = '';
  try {
    var savedMode = localStorage.getItem('zq.desktop.mode');
    if (WS_MODE_ORDER.indexOf(savedMode) >= 0) mode = savedMode;
    root = localStorage.getItem('zq.desktop.folder') || '';
  } catch (e) { /* 没有就关着 */ }
  if (folders.indexOf(root) < 0) root = folders[0] || '';
  var available = !!(st && st.available);
  paintWorkspaceBar({
    selectedMode: mode, selectedRoot: root, folders: folders, desktop: true, available: available,
    enabled: mode !== 'OFF' && !!root && available,
    reason: mode !== 'OFF' && !root ? '先选一个项目文件夹' : (mode !== 'OFF' && !available ? '这台电脑没有本机代码助手' : null)
  });
}
async function loadWorkspace() {
  if (inDesktop()) { await loadDesktopWorkspace(); return; }
  var status = null;
  try {
    // /settings 只认本机的请求（第一百一十五轮起登录的用户都能用）：拿得到 = 在本机，选项目和档位就该显示（哪怕当前 close，要给他开的地方）。拿不到（403）= 非管理员，静默不显示
    status = await api.get('/workspace/settings');
  } catch (e) { /* 不显示 */ }
  paintWorkspaceBar(status);
}

/**
 * 生成中又发了一条：排进队列（第一百三十二轮）。
 * 原来 sendAiMessage 一开头就是  —— 字被静默吃掉，用户以为发出去了。
 * 现在进队列，这一轮回答完自动发；每条可以「立即」（打断这一轮）或者「×」删掉。
 */
function enqueueSend(text) {
  state.sendQueue = state.sendQueue || [];
  state.sendQueue.push({ text: text, at: Date.now() });
  var inp = $('#zq-draft');
  if (inp) { inp.value = ''; inp.style.height = DRAFT_BASE_HEIGHT + 'px'; paintSlash(); }
  if (state.chatDraft) state.chatDraft.flush();
  renderSendQueue();
  toast('已排队：这一轮回答完就发');
}

/** 排队条：在输入框上方，一行一条 */
function renderSendQueue() {
  var list = state.sendQueue || [];
  var host = $('#zq-send-queue');
  if (!host) {
    var draft = $('#zq-draft');
    if (!draft || !draft.parentNode) return;
    host = document.createElement('div');
    host.id = 'zq-send-queue';
    host.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:0 0 8px;';
    draft.parentNode.insertBefore(host, draft);
  }
  host.innerHTML = '';
  if (!list.length) { host.style.display = 'none'; return; }
  host.style.display = 'flex';
  list.forEach(function (item, i) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--zq-border-soft);border-radius:10px;background:var(--zq-card-soft);font-size:12px;color:var(--zq-text2);';
    var label = document.createElement('span');
    label.textContent = '排队 ' + (i + 1) + '：' + (item.text.length > 40 ? item.text.slice(0, 40) + '…' : item.text);
    label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    var now = document.createElement('button');
    now.type = 'button'; now.textContent = '立即';
    now.style.cssText = 'border:none;background:transparent;color:var(--zq-primary,#2563eb);cursor:pointer;font:inherit;padding:0 4px;';
    now.onclick = function () { sendQueuedNow(i); };
    var del = document.createElement('button');
    del.type = 'button'; del.textContent = '×';
    del.style.cssText = 'border:none;background:transparent;color:var(--zq-text3);cursor:pointer;font:inherit;padding:0 2px;';
    del.onclick = function () { state.sendQueue.splice(i, 1); renderSendQueue(); };
    row.appendChild(label); row.appendChild(now); row.appendChild(del);
    host.appendChild(row);
  });
}

/** 「立即」：把它提到队首并打断当前这一轮；abort 之后 finally 里的 pumpSendQueue 会发出去 */
function sendQueuedNow(i) {
  var item = (state.sendQueue || [])[i];
  if (!item) return;
  state.sendQueue.splice(i, 1);
  state.sendQueue.unshift(item);
  renderSendQueue();
  // 网页这一轮：有 AbortController，直接掐断，finally 里会接着发
  if (state.streamAbort) {
    try { state.streamAbort.abort(); } catch (e) { /* 已经断了 */ }
    toast('已打断这一轮，接着发这条');
    return;
  }
  // 桌面应用这一轮走外壳（没有 AbortController）：让本机助手停下，它收尾时 finally 会接着发。
  // 原来这里只试 streamAbort，桌面路径永远是 null —— 点了「立即」什么都不发生（用户实测）
  if (inDesktop()) {
    localCall({ action: 'stop' }).catch(function () {});
    toast('已让本机助手停下，接着发这条');
    return;
  }
  toast('这一轮还没真正开始，已经排在最前面，它一结束就发');
}

/** 这一轮结束了：把队首那条发出去 */
function pumpSendQueue() {
  if (state.aiSending) return;
  state.sendQueue = state.sendQueue || [];
  if (!state.sendQueue.length) return;
  var next = state.sendQueue.shift();
  renderSendQueue();
  sendAiMessage(next.text);
}

// 给测试直接 import 的纯函数（第三十七轮）：step-note-check.js（执行轨迹里一条叙述的转义）、diff-check.js（改动草稿的逐行对比）。
// 它们只用到 esc —— 测试 bind 一个只有 esc 的 sh 就能跑。
export { traceStepsHtml, mergeTraceStep, stepNoteHtml, diffLines, diffHtml, generatedFilesHtml, genPreviewKind, genPreviewNode, humanSize, earlierGeneratedFiles, earlierFilesCard, parseSlash, slashMatches, slashBlocked, bindSlash, paintSlash, sendAiMessage, paintWorkspaceBar };
