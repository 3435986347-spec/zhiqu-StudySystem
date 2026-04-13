/* ═══════════════════════════════════════════════════
   ai-assistant.js — AI 助手对话框
   ═══════════════════════════════════════════════════ */

var aiAnalyzedTasks = [];

/* ── 打开 / 关闭对话框 ── */
function toggleAiDialog() {
    var dialog = document.getElementById('aiDialog');
    if (!dialog) return;
    dialog.classList.toggle('hidden');
    if (!dialog.classList.contains('hidden')) {
        var input = document.getElementById('aiInput');
        if (input) input.focus();
    }
}

/* ── 发送文字消息 ── */
async function sendAiMessage() {
    var input = document.getElementById('aiInput');
    if (!input) return;
    var message = input.value.trim();
    if (!message) return;

    appendMessage('user', escapeHtml(message));
    input.value = '';

    var thinkingId = appendThinking();
    try {
        var res = await api.post('/ai/chat', { message: message });
        removeMessage(thinkingId);
        appendMessage('ai', escapeHtml(res.data || ''));
    } catch (e) {
        removeMessage(thinkingId);
        appendMessage('ai', '❌ ' + escapeHtml(e.message || '请求失败，请检查 AI 配置'));
    }
}

/* ── 处理文件上传 / 拖拽 ── */
async function handleFileUpload(file) {
    if (!file) return;

    var maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
        appendMessage('ai', '❌ 文件过大，请上传 10MB 以内的文件');
        return;
    }

    // 支持的文本类型
    var textTypes = ['text/plain', 'text/csv', 'text/markdown', 'application/json',
                     'application/csv', '', 'text/x-markdown'];
    var fileName = file.name || '';
    var ext = fileName.split('.').pop().toLowerCase();
    var textExts = ['txt', 'csv', 'md', 'json', 'log', 'xml', 'yaml', 'yml'];

    if (!textExts.includes(ext)) {
        appendMessage('ai', '⚠️ 当前支持文本类文件（txt / csv / md / json 等），图片和 PDF 暂不支持。');
        return;
    }

    appendMessage('user', '📎 上传文件：' + escapeHtml(file.name));
    var thinkingId = appendThinking('正在分析文件内容，请稍候...');

    try {
        var res = await api.upload('/ai/analyze', file);
        removeMessage(thinkingId);

        aiAnalyzedTasks = res.data || [];

        if (aiAnalyzedTasks.length === 0) {
            appendMessage('ai', '未从文件中识别出任务，请检查文件内容或尝试其他文件。');
            return;
        }

        appendMessage('ai', '✅ 从文件中识别出 <strong>' + aiAnalyzedTasks.length + '</strong> 条任务，请确认：');
        renderTaskConfirmList(aiAnalyzedTasks);
    } catch (e) {
        removeMessage(thinkingId);
        appendMessage('ai', '❌ 文件分析失败：' + escapeHtml(e.message || '请检查 AI 配置'));
    }
}

/* ── 渲染待确认任务列表 ── */
function renderTaskConfirmList(tasks) {
    var container = document.getElementById('aiMessages');
    if (!container) return;

    var listDiv = document.createElement('div');
    listDiv.className = 'ai-task-confirm-list';

    tasks.forEach(function (task, index) {
        var item = document.createElement('div');
        item.className = 'ai-task-confirm-item';

        var deadlineHtml = task.deadline
            ? '<span class="ai-task-deadline">截止：' + escapeHtml(task.deadline) + '</span>'
            : '';

        item.innerHTML =
            '<div class="ai-task-header">' +
            '  <label class="ai-task-checkbox">' +
            '    <input type="checkbox" checked data-index="' + index + '" class="ai-task-check">' +
            '    <strong>' + escapeHtml(task.title) + '</strong>' +
            '  </label>' +
            '</div>' +
            (task.description ? '<div class="ai-task-desc">' + escapeHtml(task.description) + '</div>' : '') +
            '<div class="ai-task-meta">' +
            '  <label>象限：' +
            '    <select class="ai-task-quadrant" data-index="' + index + '">' +
            '      <option value="1"' + (task.suggestedQuadrant === 1 ? ' selected' : '') + '>1-重要且紧急</option>' +
            '      <option value="2"' + (task.suggestedQuadrant === 2 ? ' selected' : '') + '>2-重要不紧急</option>' +
            '      <option value="3"' + (task.suggestedQuadrant === 3 ? ' selected' : '') + '>3-紧急不重要</option>' +
            '      <option value="4"' + (task.suggestedQuadrant === 4 ? ' selected' : '') + '>4-不重要不紧急</option>' +
            '    </select>' +
            '  </label>' +
            '  <label>优先级：' +
            '    <select class="ai-task-priority" data-index="' + index + '">' +
            '      <option value="0"' + (task.priority === 0 ? ' selected' : '') + '>低</option>' +
            '      <option value="1"' + (task.priority === 1 ? ' selected' : '') + '>中</option>' +
            '      <option value="2"' + (task.priority === 2 ? ' selected' : '') + '>高</option>' +
            '    </select>' +
            '  </label>' +
            '  ' + deadlineHtml +
            '</div>' +
            (task.reason ? '<div class="ai-task-reason">💡 ' + escapeHtml(task.reason) + '</div>' : '');

        listDiv.appendChild(item);
    });

    var btnRow = document.createElement('div');
    btnRow.className = 'ai-task-actions';
    btnRow.innerHTML =
        '<button class="btn btn-primary" onclick="confirmAiTasks()">✅ 确认创建选中任务</button>' +
        '<button class="btn btn-default" onclick="cancelAiTasks(this)">取消</button>';
    listDiv.appendChild(btnRow);

    container.appendChild(listDiv);
    container.scrollTop = container.scrollHeight;
}

/* ── 确认创建 AI 分析出的任务 ── */
async function confirmAiTasks() {
    var checkboxes = document.querySelectorAll('.ai-task-check');
    var quadrantSelects = document.querySelectorAll('.ai-task-quadrant');
    var prioritySelects = document.querySelectorAll('.ai-task-priority');

    var tasksToCreate = [];
    checkboxes.forEach(function (cb, i) {
        if (cb.checked) {
            var task = aiAnalyzedTasks[i];
            if (!task) return;
            tasksToCreate.push({
                title: task.title,
                description: task.description || '',
                quadrant: parseInt(quadrantSelects[i].value, 10),
                priority: parseInt(prioritySelects[i].value, 10),
                deadline: task.deadline || null,
                status: 0
            });
        }
    });

    if (tasksToCreate.length === 0) {
        if (typeof showToast === 'function') showToast('请至少选择一个任务', 'warning');
        return;
    }

    var thinkingId = appendThinking('正在创建 ' + tasksToCreate.length + ' 个任务...');

    try {
        var res = await api.post('/ai/batch-create-tasks', tasksToCreate);
        removeMessage(thinkingId);

        var created = (res.data && res.data.created) || 0;
        var failed  = (res.data && res.data.failed)  || 0;
        var msg = '🎉 成功创建 ' + created + ' 个任务！';
        if (failed > 0) msg += '（' + failed + ' 个失败）';
        appendMessage('ai', msg);

        // 清空待确认列表，移除确认面板
        aiAnalyzedTasks = [];
        var lists = document.querySelectorAll('.ai-task-confirm-list');
        lists.forEach(function (el) { el.remove(); });

        // 刷新看板数据
        if (typeof loadQuadrants === 'function') loadQuadrants();
        if (typeof refreshCalendar === 'function') refreshCalendar();

        if (typeof showToast === 'function') showToast('任务创建成功', 'success');
    } catch (e) {
        removeMessage(thinkingId);
        appendMessage('ai', '❌ 创建失败：' + escapeHtml(e.message || ''));
    }
}

/* ── 取消任务确认 ── */
function cancelAiTasks(btn) {
    aiAnalyzedTasks = [];
    // 移除最近的确认列表
    if (btn) {
        var list = btn.closest('.ai-task-confirm-list');
        if (list) list.remove();
    }
    appendMessage('ai', '已取消任务创建。');
}

/* ── 在对话框中追加消息，返回消息元素 id ── */
var _msgIdCounter = 0;
function appendMessage(role, htmlContent) {
    var container = document.getElementById('aiMessages');
    if (!container) return null;

    var id = 'ai-msg-' + (++_msgIdCounter);
    var msg = document.createElement('div');
    msg.id = id;
    msg.className = 'ai-msg ai-msg-' + role;

    var avatar = role === 'user' ? '👤' : '🤖';
    msg.innerHTML =
        '<div class="ai-msg-avatar">' + avatar + '</div>' +
        '<div class="ai-msg-content">' + htmlContent + '</div>';

    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    return id;
}

/* ── 追加「思考中」占位消息 ── */
function appendThinking(text) {
    return appendMessage('ai',
        '<span class="ai-thinking">' + (text || '思考中...') + '</span>');
}

/* ── 移除指定 id 的消息 ── */
function removeMessage(id) {
    if (!id) return;
    var el = document.getElementById(id);
    if (el) el.remove();
}

/* ── HTML 转义 ── */
function escapeHtml(str) {
    if (str == null) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

/* ═══════════════════════════════════════════════════
   拖拽上传
   ═══════════════════════════════════════════════════ */
function initAiDragDrop() {
    var dialog = document.getElementById('aiDialog');
    var dropZone = document.getElementById('aiDropZone');
    if (!dialog) return;

    dialog.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (dropZone) dropZone.classList.add('drag-over');
    });

    dialog.addEventListener('dragleave', function (e) {
        // 只在真正离开对话框时才移除样式
        if (!dialog.contains(e.relatedTarget)) {
            if (dropZone) dropZone.classList.remove('drag-over');
        }
    });

    dialog.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (dropZone) dropZone.classList.remove('drag-over');
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) {
            handleFileUpload(files[0]);
        }
    });
}

document.addEventListener('DOMContentLoaded', function () {
    initAiDragDrop();
});
