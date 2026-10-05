// AI 助手 —— 第三十七轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步的最后一块）。形状见 pages/admin.js 的开头。
// Notebook 与资料、聊天与流式（含断线从库里接回、断网发送）、执行轨迹、计划草稿确认、代码工作区面板。
// 留在壳里、经 zqShared 给的：请求与它的错误、登录跳转、业务时钟、草稿、弹窗与提示、Markdown 渲染、右键菜单（Wiki 也用）。
// 另外导出给测试直接 import 的纯函数（parseSseFrame、stepNoteHtml、messageBodyHtml …），见文件末尾。

let API, REQUEST_TIMEOUT_MS, api, token, role, requestError, redirectToLogin, nowMs, serverTime, state, esc, $, $all, empty, safe, toast, notice,
  askConfirm, askText, openModal, popMenu, drafts, keepDraft, freqLabel, normalizeModelList, highlightCode, renderMarkdown, renderMathIn;
export function bind(sh) {
  ({ API, REQUEST_TIMEOUT_MS, api, token, role, requestError, redirectToLogin, nowMs, serverTime, state, esc, $, $all, empty, safe, toast, notice,
  askConfirm, askText, openModal, popMenu, drafts, keepDraft, freqLabel, normalizeModelList, highlightCode, renderMarkdown, renderMathIn } = sh);
}

export const boots = { 'ai-assistant.html': (sh) => { bind(sh); startWaitTicker(); return bootAiAssistant(); } };

async function bootAiAssistant() {
  setAiToggleState('web', false);
  setAiToggleState('think', false);
  var codeRemembered = false;
  try { codeRemembered = localStorage.getItem('zq.codeMode') === '1'; } catch (e) { /* 隐私模式 */ }
  setAiToggleState('code', codeRemembered);
  var webBtn = $('#zq-web'), thinkBtn = $('#zq-think'), sendBtn = $('#zq-send'), draft = $('#zq-draft');
  var codeBtn = $('#zq-code');
  if (codeBtn) codeBtn.onclick = function () { aiToggle('code'); };
  if (webBtn) webBtn.onclick = function () { aiToggle('web'); };
  if (thinkBtn) thinkBtn.onclick = function () { aiToggle('think'); };
  if (sendBtn) sendBtn.onclick = sendAiMessage;
  if (draft) {
    state.chatDraft = keepDraft(draft, chatDraftKey, growDraft);
    draft.addEventListener('input', growDraft);
    draft.addEventListener('keydown', function (event) {
      // ⌘/Ctrl + 回车发送，单独回车换行 —— 与多数聊天工具一致。
      // 旧行为是「回车发送、Shift+回车换行」，而那时 #zq-draft 还是 <input>：
      // Shift+回车那一半从来就没生效过，input 根本装不下换行符。
      // 换成 textarea 之后「换行」才第一次真的可用，所以发送键位一并让出去。
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendAiMessage();
      }
    });
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
        + '<div class="zq-field"><label class="zq-label">说明（可选）</label><textarea id="zq-nb-desc" class="zq-textarea" style="min-height:70px;" placeholder="这个资料本用来收集什么"></textarea></div>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-nb-cancel">取消</button><button type="button" class="zq-btn" id="zq-nb-ok">创建</button></div>',
      onMount: function (b, h) {
        var name = $('#zq-nb-name', b); try { name.select(); } catch (e) {}
        $('#zq-nb-cancel', b).onclick = h.close;
        $('#zq-nb-ok', b).onclick = function () {
          var title = name.value.trim(); if (!title) return toast('请填写名称', 'error');
          var description = $('#zq-nb-desc', b).value.trim();
          safe('新建 Notebook', async function () {
            var nb = await api.post('/ai/notebooks', { title: title, description: description });
            state.notebookId = nb && nb.id ? nb.id : state.notebookId;
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

var AI_TOGGLE_IDS = { web: 'zq-web', think: 'zq-think', code: 'zq-code' };
function setAiToggleState(kind, on) {
  var button = document.getElementById(AI_TOGGLE_IDS[kind]);
  if (!button) return;
  button.dataset.on = on ? '1' : '0';
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  button.style.border = '1px solid ' + (on ? 'var(--zq-tint-strong)' : 'var(--zq-border)');
  button.style.background = on ? 'var(--zq-tint)' : 'var(--zq-card)';
  button.style.color = on ? 'var(--zq-primary)' : 'var(--zq-text2)';
  button.style.fontWeight = '600';
}

function aiToggle(k) {
  var button = document.getElementById(AI_TOGGLE_IDS[k]);
  if (!button) return;
  setAiToggleState(k, button.dataset.on !== '1');
  // 「代码」开关要记住：进了写代码的状态，一般会连着说好几轮，每次都重按是折磨。
  // 联网 / 深度思考不记 —— 它们按轮计费或变慢，默认关着更稳妥。
  if (k === 'code') {
    try { localStorage.setItem('zq.codeMode', button.dataset.on === '1' ? '1' : '0'); } catch (e) { /* 隐私模式 */ }
  }
}
/** 「代码」开关此刻是否生效：按钮可见（工作区生效）且按下。隐藏时即使按下过也不算。 */
function codeModeOn() {
  var b = $('#zq-code');
  return !!(b && !b.hidden && b.dataset.on === '1');
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
  ['dragenter', 'dragover'].forEach(function (name) {
    zone.addEventListener(name, function (event) {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.add('is-dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (name) {
    zone.addEventListener(name, function (event) {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.remove('is-dragging');
    });
  });
  zone.addEventListener('drop', function (event) {
    var files = Array.prototype.slice.call(event.dataTransfer && event.dataTransfer.files || []);
    if (files.length) uploadAiFiles(files, true);
  });
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
    return '<span class="zq-ai-attachment"><span class="zq-ai-attachment-type">' + esc(srcTypeInfo(source.sourceType)[0]) + '</span><span title="' + esc(source.title || '资料') + '">' + esc(source.title || '资料') + '</span><button type="button" data-remove-source="' + source.id + '" aria-label="移除附件">×</button></span>';
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
  state.notebookId = nb.id;
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
async function loadAiModelSelect() {
  var sel = $('#zq-model'); if (!sel) return;
  try {
    var models = normalizeModelList(await api.get('/ai/models'));
    // 一个能用的模型都没有时不能再写「默认模型」—— 像是有一个；新用户发出第一句才看到一行红字（2026-10-03 走主流程）
    state.aiNoModel = !(models || []).length;
    sel.innerHTML = '<option value="">' + (state.aiNoModel ? '还没有可用的模型' : '默认模型') + '</option>' + (models || []).map(function (m) {
      return '<option value="' + m.id + '">' + esc(m.label || m.displayName || m.modelName) + '</option>';
    }).join('');
    if (!(state.messages || []).length) renderAiMessages();
  } catch (e) { /* 保持默认项 */ }
}
/**
 * 对话区空着的时候说点什么（2026-10-03 走主流程）：原来新用户进来是一片空白 —— 不知道有没有模型、能让它做什么。
 * 示例照着真能触发的说法写（出计划要「制定 / 生成」，写进知识库要「整理到知识库」），点一下填进输入框，不直接发。
 */
var AI_EXAMPLES = ['总结一下我上传的资料，列出要点', '根据这些资料，帮我制定下周的工作计划', '把刚才的结论整理到知识库里'];
function aiEmptyState() {
  if (state.aiNoModel) {
    return '<div data-ai-empty style="max-width:420px;margin:56px auto 0;text-align:center;color:var(--zq-text2);font-size:13px;line-height:1.75;">'
      + '<div style="font-size:15px;font-weight:700;color:var(--zq-text);margin-bottom:6px;">还没有可用的 AI 模型</div>'
      + '到「设置 → AI 模型」里填一个（OpenAI 兼容、Anthropic、本地 Ollama 都行），回来就能用。'
      + '<div style="margin-top:14px;"><a class="zq-btn" href="#settings/models" style="display:inline-flex;">去配置模型 →</a></div></div>';
  }
  return '<div data-ai-empty style="max-width:460px;margin:48px auto 0;text-align:center;color:var(--zq-text2);font-size:13px;line-height:1.7;">'
    + '<div style="font-size:15px;font-weight:700;color:var(--zq-text);margin-bottom:6px;">可以这样开始</div>'
    + '左边新建 Notebook、上传资料，它就会照着你的资料回答；计划和知识库的改动都先给你确认。'
    + '<div style="display:flex;flex-direction:column;gap:8px;margin-top:14px;">' + AI_EXAMPLES.map(function (t) {
      return '<button type="button" class="zq-btn-ghost" data-ai-example="' + esc(t) + '" style="justify-content:flex-start;height:auto;min-height:34px;white-space:normal;text-align:left;">' + esc(t) + '</button>';
    }).join('') + '</div></div>';
}
function renderSteps(steps) {
  var host = $('#zq-steps'); if (!host) return;
  host.innerHTML = steps.length ? steps.map(function (s, i) {
    var status = (s.status || 'DONE').toUpperCase();
    var color = status === 'DONE' || status === 'COMPLETED' ? 'var(--zq-ok)' : status === 'FAILED' ? 'var(--zq-bad)' : 'var(--zq-text3)';
    var last = i === steps.length - 1;
    var stepName = s.publicSummary || s.title || s.name || s.agentType || ('步骤 ' + (i + 1));
    var metaLine = (s.agentType && s.publicSummary ? s.agentType + ' · ' : '') + status;
    return '<div style="display:flex;gap:9px;padding:5px 0;"><div style="display:flex;flex-direction:column;align-items:center;flex:none;width:10px;"><span style="width:8px;height:8px;border-radius:50%;background:' + color + ';margin-top:4px;"></span>' + (last ? '' : '<span style="flex:1;width:1px;background:var(--zq-border-soft);margin-top:2px;"></span>') + '</div><div style="min-width:0;padding-bottom:6px;"><div style="font-size:11.5px;font-weight:600;line-height:1.45;">' + esc(stepName) + '</div><div class="zq-mono" style="font-size:10px;color:' + color + ';margin-top:1px;">' + esc(metaLine) + '</div>' + (s.notes || []).map(stepNoteHtml).join('') + '</div></div>';
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
    NOTE_DRAFT: '笔记草稿'
  })[String(type || '').toUpperCase()] || '其他产物';
}

function artifactStatusLabel(status) {
  return ({
    DRAFT: '待确认',
    PENDING: '待确认',
    CONFIRMED: '已确认',
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
    return '<div style="padding:8px;font-size:11.5px;color:var(--zq-text3);">'
      + '文件太大，没有逐行比对（那会把浏览器卡住）。请确认后自行用 git 查看改动。</div>';
  }
  var CONTEXT = 3;
  var keep = rows.map(function () { return false; });
  rows.forEach(function (r, i) {
    if (r[0] === ' ') return;
    for (var k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  var html = '', skipped = 0;
  var color = { '+': 'var(--zq-q2)', '-': 'var(--zq-bad)', ' ': 'var(--zq-text3)' };
  var bg = { '+': 'color-mix(in srgb, var(--zq-q2) 12%, transparent)',
             '-': 'color-mix(in srgb, var(--zq-bad) 12%, transparent)', ' ': 'transparent' };
  rows.forEach(function (r, i) {
    if (!keep[i]) { skipped++; return; }
    if (skipped) {
      html += '<div style="padding:2px 8px;font-size:10.5px;color:var(--zq-text3);">⋯ 省略 '
        + skipped + ' 行未改动 ⋯</div>';
      skipped = 0;
    }
    html += '<div style="display:flex;background:' + bg[r[0]] + ';">'
      + '<span style="flex:none;width:16px;text-align:center;color:' + color[r[0]] + ';">' + r[0] + '</span>'
      + '<span style="flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;color:'
      + (r[0] === ' ' ? 'var(--zq-text2)' : color[r[0]]) + ';">' + esc(r[1]) + '</span></div>';
  });
  if (skipped) {
    html += '<div style="padding:2px 8px;font-size:10.5px;color:var(--zq-text3);">⋯ 省略 '
      + skipped + ' 行未改动 ⋯</div>';
  }
  return '<div class="zq-mono" style="font-size:11.5px;line-height:1.55;max-height:46vh;overflow:auto;'
    + 'border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);">'
    + (html || '<div style="padding:8px;color:var(--zq-text3);">没有差异</div>') + '</div>';
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
  Promise.all(files.map(function (f) {
    if (f.creating) return Promise.resolve('');
    return api.get('/workspace/file?path=' + encodeURIComponent(f.path))
      .then(function (r) { return r && r.content != null ? r.content : ''; })
      .catch(function () { return null; });   // 读不到就标出来，而不是当成空文件
  })).then(function (currents) {
    function paint() {
      var html = '<p class="zq-plan-hint">这些改动<strong>还没有写进磁盘</strong>。'
        + '看过 diff、点「确认写入」之后才会落盘。</p>';
      files.forEach(function (f, i) {
        var current = currents[i];
        var unreadable = current === null;
        html += '<div class="zq-plan-group" style="margin-bottom:10px;">'
          + '<label class="zq-plan-row" style="align-items:center;">'
          + '<input type="checkbox" data-pick="' + i + '"' + (picked[i] ? ' checked' : '') + '>'
          + '<div class="zq-plan-row-body"><div class="zq-plan-name zq-mono">' + esc(f.path)
          + (f.creating ? '<span style="margin-left:6px;font-size:10.5px;color:var(--zq-q2);">新建</span>' : '')
          + (f.newDirectories.length ? '<span style="margin-left:6px;font-size:10.5px;color:var(--zq-q2);">连同新建目录 '
              + esc(f.newDirectories.join('、')) + '</span>' : '')
          + (unreadable ? '<span style="margin-left:6px;font-size:10.5px;color:var(--zq-bad);">读不到当前内容</span>' : '')
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
          await api.post('/ai/artifacts/' + artifact.id + '/confirm', { files: chosen });
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
  shownPlanModals[artifact.id] = true;
  var editing = false;
  var picked = {
    tasks: data.tasks.map(function () { return true; }),
    routines: data.routines.map(function () { return true; })
  };
  var handle = openModal({ title: 'AI 生成的计划', width: 640, bodyHtml: '<div class="zq-plan-confirm"></div>' });
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

function renderArtifacts(artifacts) {
  var host = $('#zq-artifacts'); if (!host) return;
  var grouped = groupArtifacts(artifacts);
  host.innerHTML = grouped.length ? grouped.map(function (artifact) {
    var type = String(artifact.artifactType || '').toUpperCase();
    var status = String(artifact.status || '').toUpperCase();
    var draft = ['PLAN_DRAFT', 'TASK_DRAFT', 'ROUTINE_DRAFT', 'WIKI_DRAFT', 'NOTE_DRAFT', 'MEMORY_DRAFT'].indexOf(type) >= 0
      && (status === 'DRAFT' || status === 'PENDING');
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
    var itemHtml = titles.length ? '<ul class="zq-artifact-items">' + titles.slice(0, 5).map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') + '</ul>' : '';
    return '<article class="zq-artifact-card">'
      + '<div class="zq-artifact-head"><span>' + esc(artifactTypeLabel(type)) + '</span><em>' + esc(artifactStatusLabel(status)) + '</em></div>'
      + '<div class="zq-artifact-title">' + titleHtml + '</div>'
      + (meta ? '<div class="zq-artifact-meta">' + esc(meta) + '</div>' : '')
      + (preview ? '<p class="zq-artifact-preview">' + esc(preview) + '</p>' : '')
      + itemHtml
      + '<details class="zq-artifact-details"><summary>展开详情</summary>' + artifactDetailsHtml(artifact) + '</details>'
      + (draft ? '<div class="zq-artifact-actions">'
          // 计划类草稿：优先走弹窗（可逐条勾选/修改），点这里可随时切回完整视图重看
          + ((isPlanDraft(artifact) || isMemoryDraft(artifact) || isCodeDraft(artifact))
            ? '<button data-art-view="' + artifact.id + '">查看并确认</button>'
            : '<button data-art-ok="' + artifact.id + '">确认</button>')
          + '<button data-art-no="' + artifact.id + '" class="zq-btn-ghost">忽略</button></div>' : '')
      + '</article>';
  }).join('') : empty('暂无产物');
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
  $all('[data-art-ok]', host).forEach(function (b) { b.onclick = function () { safe('确认产物', async function () { await api.post('/ai/artifacts/' + b.dataset.artOk + '/confirm', {}); toast('已确认'); await renderAgentPanels(); }); }; });
  $all('[data-art-no]', host).forEach(function (b) { b.onclick = function () { safe('忽略产物', async function () { await api.post('/ai/artifacts/' + b.dataset.artNo + '/discard', {}); toast('已忽略'); await renderAgentPanels(); }); }; });
}
async function renderAgentPanels() {
  if (!$('#zq-steps') && !$('#zq-artifacts')) return;
  var nbId = state.notebookId;
  var runs = await safe('执行轨迹', function () { return api.get('/ai/agent-runs' + (nbId ? '?notebookId=' + nbId : '')); });
  if (!nbId && Array.isArray(runs)) {
    // 空 Notebook 工作区只展示真正不绑定 Notebook 的普通聊天 Run，
    // 避免已删除 Notebook 的历史轨迹重新出现在右侧。
    runs = runs.filter(function (run) { return run.notebookId == null; });
  }
  var latest = runs && runs.length ? runs[0] : null;
  var detail = latest ? await safe('执行详情', function () { return api.get('/ai/agent-runs/' + latest.id); }) : null;
  if (nbId !== state.notebookId) return; // 响应期间已切换 notebook,丢弃过期数据
  renderSteps((detail && (detail.steps || detail.stepList)) || []);
  var artifacts = (detail && (detail.artifacts || detail.artifactList)) || [];
  renderArtifacts(artifacts);
  // 新生成的计划草稿主动弹窗：右侧产物卡片容易被忽略，而计划要用户确认后才写入日历，
  // 不弹的话用户会以为"什么都没发生"。每个草稿只弹一次，之后可从卡片「查看并确认」重开。
  var freshPlan = groupArtifacts(artifacts).filter(function (a) {
    return isPlanDraft(a) && !shownPlanModals[a.id];
  })[0];
  if (freshPlan) openPlanConfirmModal(freshPlan);
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
  var sync = $('#zq-sync-count'); if (sync) sync.textContent = '已同步 ' + state.messages.length + ' 条历史消息';
  renderAiMessages();
  watchStreamingMessages();
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
  var me = m.role === 'user';
  var reasoningMode = String(m.reasoningMode || 'OFF').toUpperCase();
  var reasoningText = m.reasoningSummary || m.reasoning || '';
  var reasonKey = String(m._clientKey || m.id || m.requestId || ('assistant-' + i));
  var reason = (!me && reasoningMode !== 'OFF' && reasoningText)
    ? '<details class="zq-ai-reasoning" data-reason-key="' + esc(reasonKey) + '"' + (state.reasoningExpanded[reasonKey] ? ' open' : '') + '><summary>思考摘要</summary><span>' + esc(reasoningText) + '</span></details>'
    : '';
  // 流式中的内容换行完好且可能只收到半截,跳过压平回填,防止启发式误触
  var body = m.content ? renderMarkdown((me || m.status === 'STREAMING') ? m.content : reflowFlatMarkdown(m.content)) : (m.status === 'STREAMING' ? '<span style="color:var(--zq-text3);" data-wait-since="' + waitSince(m) + '">' + waitText(waitSince(m)) + '</span>' : '');
  // 刷新之后那条消息会带着「已经生成的一半」回来（后端阶段性落库）。
  // 光有半截正文看不出它是写完了还是还在写 —— 补一个尾巴说清楚，
  // 否则用户会以为回答就到这里为止。
  if (!me && m.content && String(m.status || '').toUpperCase() === 'STREAMING') {
    body += '<div style="margin-top:6px;font-size:11.5px;color:var(--zq-text3);">仍在生成…</div>';
  }
  // 失败了要说出来，哪怕已经出来了半截（原来有半截正文就把错误原因丢掉，看着像是模型说完了）；
  // 能用但不完整（输出上限、内容审核、太长）也说。两句都存在库里，刷新之后还在。
  if (!me && m.errorMessage) {
    body += '<div data-msg-error style="margin-top:8px;font-size:12px;color:var(--zq-bad);">⚠ ' + esc(m.errorMessage) + '</div>';
  }
  if (!me && m.notice) {
    body += '<div data-msg-notice style="margin-top:8px;font-size:12px;color:var(--zq-warn);">' + esc(m.notice) + '</div>';
  }
  return reason + body;
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
  node.innerHTML = messageBodyHtml(m, index);
  renderMathIn(node);
  applyChatScroll(host, prevScroll, false);
  return true;
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
    ? '<div style="display:flex;justify-content:center;padding:2px 0 6px;">'
      + '<button type="button" data-load-older="1"' + (state.chatLoadingMore ? ' disabled' : '')
      + ' style="height:26px;padding:0 12px;border:1px solid var(--zq-border);border-radius:999px;'
      + 'background:var(--zq-card-soft);color:var(--zq-text2);font-size:11.5px;cursor:pointer;">'
      + (state.chatLoadingMore ? '加载中…' : '↑ 加载更早的消息') + '</button></div>'
    : '';
  host.innerHTML = moreRow + state.messages.map(function (m, i) {
    var me = m.role === 'user';
    var name = me ? '我' : 'AI';
    var body = messageBodyHtml(m, i);
    return '<div data-msg-idx="' + i + '" style="display:flex;gap:10px;flex-direction:' + (me ? 'row-reverse' : 'row') + ';"><div style="width:30px;height:30px;flex:none;border-radius:50%;background:' + (me ? 'var(--zq-card-soft)' : 'var(--zq-primary)') + ';color:' + (me ? 'var(--zq-text2)' : 'var(--zq-on-primary)') + ';display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">' + name + '</div><div data-msg-body="' + i + '" class="zq-msg-body" style="max-width:72%;padding:8px 12px;border-radius:var(--zq-rm);background:' + (me ? 'var(--zq-tint)' : 'var(--zq-card)') + ';border:1px solid ' + (me ? 'var(--zq-tint-strong)' : 'var(--zq-border-soft)') + ';font-size:13.5px;line-height:1.65;">' + body + '</div></div>';
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
    state.notebookId = null;
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
  if (state.notebookId == null) state.notebookId = recallNotebook();
  var selectedStillExists = state.notebooks.some(function (item) { return Number(item.id) === Number(state.notebookId); });
  if (!selectedStillExists) state.notebookId = state.notebooks[0].id;
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
    return '<div data-notebook="' + nb.id + '" style="padding:9px 11px;border:1px solid ' + (active ? 'var(--zq-tint-strong)' : 'var(--zq-border-soft)') + ';border-radius:var(--zq-rs);background:' + (active ? 'var(--zq-tint)' : 'var(--zq-card)') + ';cursor:pointer;"><div data-nb-name="' + nb.id + '" title="' + esc(nb.title || 'Notebook') + (active ? ' · 点击重命名' : '') + '" style="font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(nb.title || 'Notebook') + '</div><div style="font-size:11px;color:var(--zq-text3);margin-top:2px;">' + esc(nb.sourceCount != null ? nb.sourceCount + ' 份资料' : '资料工作区') + '</div></div>';
  }).join('') || '<div class="zq-ai-empty-notebook"><strong>暂无 Notebook</strong><span>普通聊天仍可使用；上传资料前请先新建。</span></div>';
  $all('[data-notebook]', host).forEach(function (d) {
    var id = Number(d.dataset.notebook);
    var nb = (state.notebooks || []).find(function (x) { return x.id === id; });
    d.onclick = function (e) {
      // 已选中的 notebook 再点名字 → 改名；否则点击切换
      if (id === state.notebookId && e.target.closest('[data-nb-name]')) { renameNotebook(nb); return; }
      state.notebookId = id;
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
                state.notebookId = null;
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
      + '<span class="zq-src-dl">↓</span>'
      + '<div class="zq-src-glass">'
      + '<div class="zq-src-title">' + esc(title) + '</div>'
      + '<div class="zq-src-meta"><span style="width:6px;height:6px;border-radius:50%;flex:none;background:' + (status === 'READY' ? 'var(--zq-ok)' : status === 'ERROR' ? 'var(--zq-bad)' : 'var(--zq-text3)') + ';"></span><span>' + esc(srcStatusLabel(status, s.sourceType)) + '</span></div>'
      + (indexText ? '<div class="zq-src-meta" style="margin-top:4px;"><span style="width:6px;height:6px;border-radius:50%;flex:none;background:' + (String(s.indexStatus || '').toUpperCase() === 'INDEXED' ? 'var(--zq-primary)' : String(s.indexStatus || '').toUpperCase() === 'ERROR' ? 'var(--zq-warn)' : 'var(--zq-text3)') + ';"></span><span>' + esc(indexText) + '</span></div>' : '')
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
    return '<pre class="zq-mono" style="margin:2px 0 3px 12px;padding:4px 6px;font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-all;background:var(--zq-card-soft);border-radius:4px;color:var(--zq-text2);">' + esc(shown) + '</pre>';
  }
  return '<div class="zq-mono" style="font-size:10.5px;color:' + (n.phase === 'error' ? 'var(--zq-bad)' : n.phase === 'budget' ? 'var(--zq-warn)' : 'var(--zq-text2)')
    + ';margin-top:2px;word-break:break-all;">⎿ ' + esc(n.message) + '</div>';
}
/** 单行时的高度，与同排按钮对齐；也是清空后要回到的高度。 */
var DRAFT_BASE_HEIGHT = 32;
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
  el.style.height = Math.max(DRAFT_BASE_HEIGHT, Math.min(el.scrollHeight, 120)) + 'px';
}
async function sendAiMessage() {
  if (state.aiSending) return; // 发送中保护:双击/回车连发只算一次
  var inp = $('#zq-draft'), txt = inp && inp.value.trim();
  if (!txt) return;
  // 草稿等服务器确认收到了这条消息（任一事件带 userMessageId）才删；没收到就把字放回输入框（第十五轮）。
  // 原来一按发送就清空：没配模型、被限流、一刷新，这句话就没了。
  if (state.chatDraft) state.chatDraft.flush();
  var draftKeyAtSend = state.chatDraft ? state.chatDraft.key() : null;
  var stored = false;
  var gotEvent = false;
  inp.value = '';
  inp.style.height = DRAFT_BASE_HEIGHT + 'px'; // 收回单行，否则清空后仍撑着上一条的高度
  state.aiSending = true;
  stopStreamWatch();   // SSE 接管，轮询再跑就会和它抢着改同一批消息
  var sendButton = $('#zq-send');
  if (sendButton) { sendButton.disabled = true; sendButton.textContent = '生成中'; }
  var reasoningMode = ($('#zq-think') && $('#zq-think').dataset.on === '1') ? 'DEEP' : 'OFF';
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
      codeMode: codeModeOn()
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
        // 消息太长被截了中间（后端 UserMessageFit）：说给用户，而且多停一会儿 —— 这句话要读完
        else if (event === 'message.notice') { toast((data && data.message) || '这条消息被截短了', data && data.level === 'error' ? 'error' : 'warn', 9000); }
        else if (event === 'artifact.created') {
          if (sameNb()) {
            var incoming = normalizeArtifact(data);
            var existingIndex = state.agentArtifacts.findIndex(function (item) {
              return Number(normalizeArtifact(item).id) === Number(incoming.id);
            });
            if (existingIndex >= 0) state.agentArtifacts[existingIndex] = incoming;
            else state.agentArtifacts.push(incoming);
            renderArtifacts(state.agentArtifacts);
          }
        }
        else if (event === 'done') {
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
            if (data && data.notice) assistant.notice = data.notice;
            assistant.status = '';
            completed = true;
            if (sameNb()) renderAiMessages();
          }
        }
        else if (event === 'error') {
          failed = true;
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
      if (sameNb()) state.notebookId = null;
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
    if (sendButton) { sendButton.disabled = false; sendButton.textContent = '发送'; }
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


// ───────────────────────── 代码工作区（只读） ─────────────────────────
/**
 * 工作区面板。
 *
 * <p>整块默认不显示。三种情况都不显示，而且<b>只有第三种要说话</b>：
 * 非管理员（接口 403）、压根没配（正常状态，不该打扰用户）、
 * 配了但前置没满足（必须说清是哪一条 —— 否则用户以为功能坏了）。
 */
var wsState = { path: '', enabled: false };

// ── 工作区设置：像 Cursor 那样选工作文件夹 + 切档位 ─────────────────────
//
// 三条前提（回环 / 目录存在 / 管理员）由后端裁决，前端不复述判断 —— 只把后端返回的
// effectiveMode / reason / loopback 如实显示。切换按钮在非回环上也点得动，但后端会拒，
// 并把原因显示出来，而不是前端偷偷禁用（那样用户不知道为什么不行）。

function openWorkspaceSettings(settings) {
  var modes = (settings && settings.modes) || ['OFF', 'READ', 'WRITE', 'EXEC'];
  var chosen = (settings && settings.selectedMode) || 'OFF';
  var chosenRoot = (settings && settings.selectedRoot) || '';
  var loopback = !(settings && settings.loopback === false);

  var desc = {
    OFF: '关闭。AI 助手看不到任何本机文件。',
    READ: '只读：AI 能读工作文件夹里的文件，一个字节都不改。',
    WRITE: '读 + 写：能改文件，但每次改动都要你在草稿里确认后才落盘。',
    EXEC: '读 + 写 + 运行：能改、还能跑白名单命令（python3 / node / java…）。仅本机自用。'
  };

  var h = openModal({
    title: '工作区设置',
    width: 520,
    bodyHtml:
      (loopback ? '' :
        '<div style="margin-bottom:12px;padding:9px 11px;border-radius:var(--zq-rs);background:var(--zq-tint);' +
        'font-size:12px;color:var(--zq-text2);line-height:1.6;">当前不是本机回环地址（多半是服务器 / 网页版）。' +
        '出于安全，工作区只能在<b>本机桌面应用</b>里开启，这里改了也不会生效。</div>') +
      '<div style="font-size:12px;font-weight:700;margin-bottom:6px;">工作文件夹</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;">' +
        '<input id="zq-wss-root" class="zq-input" readonly placeholder="（未选择）" style="flex:1;height:32px;font-size:12px;" />' +
        '<button id="zq-wss-browse" class="zq-btn-ghost" style="height:32px;font-size:12px;white-space:nowrap;">浏览…</button>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--zq-text3);margin-bottom:16px;">AI 只能读/改/运行这一个文件夹里的东西，范围越小越安全。</div>' +
      '<div style="font-size:12px;font-weight:700;margin-bottom:6px;">访问档位</div>' +
      '<div id="zq-wss-modes" style="display:flex;gap:6px;margin-bottom:8px;">' +
        modes.map(function (m) {
          return '<button type="button" data-mode="' + m + '" class="zq-btn-ghost" style="flex:1;height:32px;font-size:12px;">' +
            (WS_MODE_LABEL[m] || m) + '</button>';
        }).join('') +
      '</div>' +
      '<div id="zq-wss-desc" style="font-size:11.5px;color:var(--zq-text2);line-height:1.6;min-height:34px;"></div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
        '<button id="zq-wss-cancel" class="zq-btn-ghost" style="height:34px;font-size:12.5px;">取消</button>' +
        '<button id="zq-wss-save" class="zq-btn" style="height:34px;font-size:12.5px;">保存并生效</button>' +
      '</div>',
    onMount: function (body) {
      var rootInput = $('#zq-wss-root', body);
      rootInput.value = chosenRoot;
      var descEl = $('#zq-wss-desc', body);

      function paintModes() {
        $all('[data-mode]', body).forEach(function (btn) {
          var on = btn.getAttribute('data-mode') === chosen;
          btn.style.background = on ? 'var(--zq-primary)' : '';
          btn.style.color = on ? 'var(--zq-on-primary)' : '';
          btn.style.borderColor = on ? 'var(--zq-primary)' : '';
        });
        descEl.textContent = desc[chosen] || '';
      }
      $all('[data-mode]', body).forEach(function (btn) {
        btn.onclick = function () { chosen = btn.getAttribute('data-mode'); paintModes(); };
      });
      paintModes();

      $('#zq-wss-browse', body).onclick = function () {
        openWorkspaceFolderPicker(chosenRoot, function (picked) {
          chosenRoot = picked;
          rootInput.value = picked;
        });
      };
      $('#zq-wss-cancel', body).onclick = function () { h.close(); };
      $('#zq-wss-save', body).onclick = function () {
        if (chosen !== 'OFF' && !chosenRoot) {
          toast('先选一个工作文件夹', 'error');
          return;
        }
        safe('保存工作区设置', async function () {
          await api.put('/workspace/settings', { mode: chosen, root: chosenRoot });
          h.close();
          await loadWorkspace();
          toast('工作区设置已保存');
        });
      };
    }
  });
}

// 文件夹选择器：走后端 /workspace/browse 一层层点进去。onPick(绝对路径) 选定当前文件夹。
function openWorkspaceFolderPicker(startPath, onPick) {
  var cur = { path: startPath || '', parent: null };
  var h = openModal({
    title: '选择工作文件夹',
    width: 480,
    bodyHtml:
      '<div id="zq-fp-cur" class="zq-mono" style="font-size:11.5px;color:var(--zq-text2);word-break:break-all;margin-bottom:8px;">读取中…</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:8px;">' +
        '<button id="zq-fp-up" class="zq-btn-ghost" style="height:28px;font-size:12px;">↑ 上一层</button>' +
        '<button id="zq-fp-pick" class="zq-btn" style="height:28px;font-size:12px;margin-left:auto;">选定当前文件夹</button>' +
      '</div>' +
      '<div id="zq-fp-list" style="max-height:46vh;overflow:auto;display:flex;flex-direction:column;gap:1px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);padding:6px;"></div>',
    onMount: function (body) {
      async function go(path) {
        var res;
        try {
          res = await api.get('/workspace/browse' + (path ? '?path=' + encodeURIComponent(path) : ''));
        } catch (e) { toast('读不了这个目录', 'error'); return; }
        cur.path = res.path; cur.parent = res.parent;
        $('#zq-fp-cur', body).textContent = res.path;
        $('#zq-fp-up', body).disabled = !res.parent;
        $('#zq-fp-up', body).style.opacity = res.parent ? '1' : '.4';
        var list = $('#zq-fp-list', body);
        var dirs = res.dirs || [];
        list.innerHTML = dirs.length ? '' : '<div style="padding:10px;font-size:12px;color:var(--zq-text3);">（没有子文件夹）</div>';
        dirs.forEach(function (d) {
          var a = document.createElement('a');
          a.style.cssText = 'display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:var(--zq-rs);cursor:pointer;font-size:12.5px;color:var(--zq-text2);';
          a.innerHTML = '<span>📁</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(d.name) + '</span>';
          a.onmouseenter = function () { a.style.background = 'var(--zq-card-soft)'; };
          a.onmouseleave = function () { a.style.background = ''; };
          a.onclick = function () { go(d.path); };
          list.appendChild(a);
        });
        if (res.truncated) {
          var more = document.createElement('div');
          more.style.cssText = 'padding:8px 9px;font-size:11px;color:var(--zq-text3);';
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

var WS_MODE_LABEL = { OFF: '未启用', READ: '只读', WRITE: '读+写', EXEC: '读+写+运行' };

async function loadWorkspace() {
  var section = $('#zq-ws');
  if (!section) return;            // 只有 AI 助手页有这一块
  var status;
  try {
    // /settings 是管理员限定的：拿得到 = 是管理员，这一块就该显示（哪怕当前 OFF，
    // 也要给出齿轮让他去开）。拿不到（403）= 非管理员，静默不显示。
    status = await api.get('/workspace/settings');
  } catch (e) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  var gear = $('#zq-ws-settings');
  if (gear) gear.onclick = function () { openWorkspaceSettings(status); };

  wsState.enabled = !!(status && status.enabled);
  // 「代码」按钮只在工作区真的生效时出现。没生效时按了也没用 —— 后端会因为工作区不可读
  // 而不造 CODE_AGENT 节点，按钮却亮着，那是在骗人。
  var codeToggle = $('#zq-code');
  if (codeToggle) codeToggle.hidden = !wsState.enabled;
  if (!wsState.enabled) {
    // 没开：显示原因（配了没生效）或一句「点⚙开启」，并把文件树/搜索收起来
    $('#zq-ws-sub').textContent = '未启用';
    $('#zq-ws-path').textContent = (status && status.reason)
      ? status.reason : '点右上角 ⚙ 选择工作文件夹并开启';
    $('#zq-ws-tree').innerHTML = '';
    $('#zq-ws-up').hidden = true;
    var sr0 = $('#zq-ws-search-row'); if (sr0) sr0.hidden = true;
    return;
  }
  $('#zq-ws-sub').textContent = WS_MODE_LABEL[status.effectiveMode] || status.effectiveMode;
  wsState.root = status.root || '';
  $('#zq-ws-up').onclick = function () {
    var at = wsState.path.lastIndexOf('/');
    paintWorkspace(at > 0 ? wsState.path.slice(0, at) : '');
  };
  var searchRow = $('#zq-ws-search-row');
  if (searchRow) { searchRow.hidden = false; }
  var q = $('#zq-ws-q');
  if (q) {
    q.onkeydown = function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var text = q.value.trim();
      // 空关键词不发请求：后端会拒，但那是一次没必要的往返和一条没必要的报错
      if (!text) { paintWorkspace(wsState.path); return; }
      searchWorkspace(text);
    };
  }
  var back = $('#zq-ws-back');
  if (back) {
    back.onclick = function () { if (q) { q.value = ''; } paintWorkspace(wsState.path); };
  }
  await paintWorkspace('');
}

/**
 * 工作区路径那一行：明确画成<b>文件夹</b>。
 *
 * <p>原来只印一行 {@code /Users/.../test}，没有图标、结尾没有斜杠，下面紧跟「这个目录是空的」——
 * 用户看成了「工作区是一个具体的文件」。现在：📁 + 文件夹名 + 「/」，完整路径放在第二行、字小一号。
 */
function paintWorkspacePath() {
  var el = $('#zq-ws-path'); if (!el) return;
  // 两种分隔符都认：Windows 上根目录是 C:\code\test，只按「/」切会把整条路径当成文件夹名。
  var root = String(wsState.root || '').replace(/[\\/]+$/, '');
  var sep = root.indexOf('\\') >= 0 && root.indexOf('/') < 0 ? '\\' : '/';
  var rootName = root ? root.slice(Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\')) + 1) : '工作区';
  var shown = rootName + '/' + (wsState.path ? wsState.path.replace(/\/+$/, '') + '/' : '');
  el.innerHTML = '<div style="display:flex;align-items:center;gap:5px;color:var(--zq-text2);font-size:12px;font-weight:600;">'
    + '<span style="flex:none;">📁</span><span style="min-width:0;word-break:break-all;">' + esc(shown) + '</span></div>'
    + (root ? '<div style="margin-top:2px;font-size:10.5px;color:var(--zq-text3);word-break:break-all;" title="工作文件夹的完整路径">'
      + esc(root + sep + (wsState.path ? wsState.path.split('/').join(sep) + sep : '')) + '</div>' : '');
}

async function paintWorkspace(path) {
  var tree = $('#zq-ws-tree'); if (!tree) return;
  var entries, listTruncated = false;
  try {
    // 响应是 {truncated, entries}：条目太多时后端只给前 N 条，而「N 条」和「至少 N 条」
    // 是两回事 —— 不显示的话用户会以为这个目录就这么大。
    var res = await api.get('/workspace/files' + (path ? '?path=' + encodeURIComponent(path) : ''));
    entries = (res && res.entries) || [];
    listTruncated = !!(res && res.truncated);
  } catch (e) {
    tree.innerHTML = '<div style="font-size:11.5px;color:var(--zq-bad);">' + esc(e.message || '读取失败') + '</div>';
    return;
  }
  wsState.path = path || '';
  paintWorkspacePath();
  $('#zq-ws-up').hidden = !wsState.path;
  var backBtn = $('#zq-ws-back');
  if (backBtn) { backBtn.hidden = true; }
  tree.innerHTML = (entries || []).map(function (e) {
    var name = e.path.indexOf('/') >= 0 ? e.path.slice(e.path.lastIndexOf('/') + 1) : e.path;
    // 不可读的文件也列出来但置灰 —— 让用户知道它在那儿、而且知道系统刻意没读它，
    // 比干脆不显示诚实
    var dim = !e.directory && !e.readable;
    return '<button type="button" data-ws-entry="' + esc(e.path) + '" data-ws-dir="' + (e.directory ? '1' : '0')
      + '" data-ws-readable="' + (e.readable ? '1' : '0')
      + '" style="display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border:none;border-radius:var(--zq-rs);'
      + 'background:transparent;color:' + (dim ? 'var(--zq-text3)' : 'var(--zq-text2)') + ';font-size:11.5px;'
      + 'text-align:left;cursor:' + (dim ? 'not-allowed' : 'pointer') + ';">'
      + '<span style="flex:none;">' + (e.directory ? '📁' : '📄') + '</span>'
      + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(name) + '</span>'
      + (dim ? '<span style="flex:none;font-size:10px;">不可读</span>' : '')
      + '</button>';
  }).join('') || '<div style="font-size:11.5px;color:var(--zq-text3);padding:4px 6px;">这个文件夹还是空的'
    + (wsState.path ? '' : ' —— 按下输入框旁的「代码」，让 AI 在这里新建文件') + '</div>';
  if (listTruncated) {
    tree.innerHTML += '<div style="font-size:10.5px;color:var(--zq-warn);padding:6px;">'
      + '条目过多，只列出了前 ' + (entries || []).length + ' 条 —— 这不是全部</div>';
  }

  $all('[data-ws-entry]', tree).forEach(function (b) {
    b.onclick = function () {
      if (b.dataset.wsDir === '1') { paintWorkspace(b.dataset.wsEntry); return; }
      if (b.dataset.wsReadable !== '1') { toast('这个文件不在允许读取的清单里', 'error'); return; }
      openWorkspaceFile(b.dataset.wsEntry);
    };
  });
}

/**
 * 工作区搜索。结果复用文件树那块区域 —— 侧栏窄，再开一块只会两边都挤。
 *
 * <p>截断状态<b>必须显示出来</b>：用户看到 80 条会以为一共 80 条，
 * 而「至少 80 条，没找完」是完全不同的结论。后端已经把 truncated 传上来了，
 * 传上来却不显示，等于没传。
 */
function searchWorkspace(query) {
  var tree = $('#zq-ws-tree'); if (!tree) return;
  tree.innerHTML = '<div style="font-size:11.5px;color:var(--zq-text3);padding:4px 6px;">搜索中…</div>';
  var back = $('#zq-ws-back');
  if (back) { back.hidden = false; }
  $('#zq-ws-up').hidden = true;
  $('#zq-ws-path').textContent = '搜索「' + query + '」'
    + (wsState.path ? ' · 范围 ' + wsState.path : '');

  safe('搜索工作区', async function () {
    var res = await api.get('/workspace/search?query=' + encodeURIComponent(query)
      + (wsState.path ? '&path=' + encodeURIComponent(wsState.path) : ''));
    var hits = (res && res.hits) || [];
    if (!hits.length) {
      tree.innerHTML = '<div style="font-size:11.5px;color:var(--zq-text3);padding:4px 6px;">'
        + '没找到。扫了 ' + ((res && res.filesScanned) || 0) + ' 个文件。</div>';
      return;
    }
    tree.innerHTML = hits.map(function (h) {
      return '<button type="button" data-ws-hit="' + esc(h.path) + '"'
        + ' style="display:block;width:100%;padding:5px 6px;border:none;border-radius:var(--zq-rs);'
        + 'background:transparent;text-align:left;cursor:pointer;">'
        + '<span class="zq-mono" style="display:block;font-size:10.5px;color:var(--zq-text3);'
        + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
        + esc(h.path) + ':' + esc(String(h.line)) + '</span>'
        + '<span class="zq-mono" style="display:block;font-size:11px;color:var(--zq-text2);'
        + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(h.text) + '</span>'
        + '</button>';
    }).join('')
      + '<div style="font-size:10.5px;color:' + (res.truncated ? 'var(--zq-warn)' : 'var(--zq-text3)')
      + ';padding:6px;">'
      + (res.truncated
        ? '还有更多 —— 只显示了前 ' + hits.length + ' 条，换个更具体的关键词'
        : '共 ' + hits.length + ' 条，扫了 ' + (res.filesScanned || 0) + ' 个文件')
      + '</div>';

    $all('[data-ws-hit]', tree).forEach(function (b) {
      b.onclick = function () { openWorkspaceFile(b.dataset.wsHit); };
    });
  });
}

/** 从文件名取语言标记，喂给着色器。取不到就不着色，不瞎猜。 */
function langOfPath(path) {
  var at = String(path || '').lastIndexOf('.');
  return at < 0 ? '' : path.slice(at + 1).toLowerCase();
}

function openWorkspaceFile(path) {
  safe('读取文件', async function () {
    var file = await api.get('/workspace/file?path=' + encodeURIComponent(path));
    openModal({
      title: path,
      width: 860,
      bodyHtml: '<pre style="margin:0;max-height:62vh;overflow:auto;padding:12px 14px;border:1px solid var(--zq-border-soft);'
        + 'border-radius:var(--zq-rs);background:var(--zq-card-soft);"><code class="zq-mono" style="font-size:12.5px;'
        + 'line-height:1.6;white-space:pre;">' + highlightCode(file.content || '', langOfPath(path)) + '</code></pre>'
    });
  });
}

// 给测试直接 import 的纯函数（第三十七轮）：step-note-check.js（执行轨迹里一条叙述的转义）、diff-check.js（改动草稿的逐行对比）。
// 它们只用到 esc —— 测试 bind 一个只有 esc 的 sh 就能跑。
export { stepNoteHtml, diffLines, diffHtml };
