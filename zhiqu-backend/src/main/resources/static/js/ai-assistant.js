/* ═══════════════════════════════════════════════════
   ai-assistant.js — AI 助手嵌入式面板
   ═══════════════════════════════════════════════════ */

var aiAnalyzedTasks = [];
var _msgIdCounter = 0;

/* ── 折叠 / 展开面板 ── */
function toggleAiPanel() {
    var body   = document.getElementById('aiPanelBody');
    var toggle = document.getElementById('aiPanelToggle');
    if (!body) return;

    var isHidden = body.classList.contains('hidden');
    body.classList.toggle('hidden');
    if (toggle) toggle.textContent = isHidden ? '收起 ▲' : '展开 ▼';

    if (isHidden) {
        var input = document.getElementById('aiInput');
        if (input) setTimeout(function () { input.focus(); }, 50);
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

    // 确保面板已展开
    var panelBody = document.getElementById('aiPanelBody');
    if (panelBody && panelBody.classList.contains('hidden')) {
        toggleAiPanel();
    }

    var maxSize = 20 * 1024 * 1024;
    if (file.size > maxSize) {
        appendMessage('ai', '❌ 文件过大，请上传 20MB 以内的文件');
        return;
    }

    var isImg = file.type.startsWith('image/');
    var isPdf = file.type === 'application/pdf';
    var fileLabel = isImg ? '🖼️ ' : isPdf ? '📄 ' : '📎 ';
    fileLabel += escapeHtml(file.name);

    appendMessage('user', fileLabel);

    // 图片：消息区域内显示缩略图预览
    if (isImg) {
        var reader = new FileReader();
        reader.onload = function (e) {
            var container = document.getElementById('aiMessages');
            if (!container) return;
            var id = 'ai-msg-' + (++_msgIdCounter);
            var preview = document.createElement('div');
            preview.id = id;
            preview.className = 'ai-msg ai-msg-user';
            preview.innerHTML =
                '<div class="ai-msg-content ai-img-wrap">' +
                '<img src="' + e.target.result + '" class="ai-img-preview" alt="上传的图片">' +
                '</div>' +
                '<div class="ai-msg-avatar">👤</div>';
            container.appendChild(preview);
            container.scrollTop = container.scrollHeight;
        };
        reader.readAsDataURL(file);
    }

    var thinkingId = appendThinking('🔍 正在分析文件内容，请稍候...');

    try {
        var res = await api.upload('/ai/analyze', file);
        removeMessage(thinkingId);

        aiAnalyzedTasks = res.data || [];

        if (aiAnalyzedTasks.length === 0) {
            appendMessage('ai', '未从文件中识别出任务，请检查文件内容或换一个文件试试。');
            return;
        }

        appendMessage('ai', '✅ 识别出 <strong>' + aiAnalyzedTasks.length + '</strong> 条任务，请在右侧确认并创建：');
        renderTaskConfirmList(aiAnalyzedTasks);
    } catch (e) {
        removeMessage(thinkingId);
        appendMessage('ai', '❌ 文件分析失败：' + escapeHtml(e.message || '请检查 AI 配置'));
    }
}

/* ── 渲染任务到右侧确认面板 ── */
function renderTaskConfirmList(tasks) {
    var confirmSide  = document.getElementById('aiConfirmSide');
    var confirmList  = document.getElementById('aiConfirmList');
    var confirmCount = document.getElementById('aiConfirmCount');

    if (!confirmSide || !confirmList) return;

    confirmSide.classList.remove('hidden');
    if (confirmCount) confirmCount.textContent = tasks.length + ' 条';
    confirmList.innerHTML = '';

    tasks.forEach(function (task, index) {
        var item = document.createElement('div');
        item.className = 'ai-confirm-item';

        var hasStartTime = !!task.startTime;
        var hasDuration  = task.durationMinutes != null;
        var hasDeadline  = !!task.deadline;

        var timeStatusHtml;
        if (hasStartTime && hasDuration) {
            timeStatusHtml = '<span class="ai-time-status ai-time-auto">✅ 已自动识别</span>';
        } else if (hasStartTime || hasDeadline) {
            timeStatusHtml = '<span class="ai-time-status ai-time-partial">⚠️ 部分识别，请补充</span>';
        } else {
            timeStatusHtml = '<span class="ai-time-status ai-time-manual">❓ 未识别，请手动填写</span>';
        }

        var reasonHtml = task.reason
            ? '<div class="ai-confirm-reason">💡 ' + escapeHtml(task.reason) + '</div>'
            : '';
        var descHtml = task.description
            ? '<div class="ai-confirm-desc">' + escapeHtml(task.description) + '</div>'
            : '';

        item.innerHTML =
            '<div class="ai-confirm-item-header">' +
            '  <label class="ai-confirm-checkbox">' +
            '    <input type="checkbox" checked data-index="' + index + '" class="ai-task-check">' +
            '    <strong>' + escapeHtml(task.title) + '</strong>' +
            '  </label>' +
            '</div>' +
            descHtml +
            '<div class="ai-confirm-meta">' +
            '  <label>象限' +
            '    <select class="ai-task-quadrant" data-index="' + index + '">' +
            '      <option value="1"' + (task.suggestedQuadrant === 1 ? ' selected' : '') + '>重要且紧急</option>' +
            '      <option value="2"' + (task.suggestedQuadrant === 2 ? ' selected' : '') + '>重要不紧急</option>' +
            '      <option value="3"' + (task.suggestedQuadrant === 3 ? ' selected' : '') + '>紧急不重要</option>' +
            '      <option value="4"' + (task.suggestedQuadrant === 4 ? ' selected' : '') + '>不重要不紧急</option>' +
            '    </select>' +
            '  </label>' +
            '  <label>优先级' +
            '    <select class="ai-task-priority" data-index="' + index + '">' +
            '      <option value="0"' + (task.priority === 0 ? ' selected' : '') + '>低</option>' +
            '      <option value="1"' + (task.priority === 1 ? ' selected' : '') + '>中</option>' +
            '      <option value="2"' + (task.priority === 2 ? ' selected' : '') + '>高</option>' +
            '    </select>' +
            '  </label>' +
            '</div>' +
            '<div class="ai-confirm-time-section">' +
            '  ' + timeStatusHtml +
            '  <div class="ai-confirm-time-row">' +
            '    <label>开始时间' +
            '      <input type="datetime-local" class="ai-task-start-time" data-index="' + index + '"' +
            '             value="' + (hasStartTime ? toDatetimeLocal(task.startTime) : '') + '">' +
            '    </label>' +
            '    <label>持续时长' +
            '      <div class="ai-duration-input">' +
            '        <input type="number" class="ai-task-duration" data-index="' + index + '"' +
            '               value="' + (hasDuration ? task.durationMinutes : '') + '"' +
            '               placeholder="分钟" min="1" max="480">' +
            '        <span class="ai-duration-unit">分钟</span>' +
            '      </div>' +
            '    </label>' +
            '  </div>' +
            '  <div class="ai-confirm-time-row">' +
            '    <label>截止时间' +
            '      <input type="datetime-local" class="ai-task-deadline-input" data-index="' + index + '"' +
            '             value="' + (hasDeadline ? toDatetimeLocal(task.deadline) : '') + '">' +
            '    </label>' +
            '  </div>' +
            '  <div class="ai-duration-quick">' +
            '    <span class="ai-duration-label">时长：</span>' +
            '    <button type="button" class="ai-duration-btn" onclick="setAiDuration(' + index + ', 30)">30分钟</button>' +
            '    <button type="button" class="ai-duration-btn" onclick="setAiDuration(' + index + ', 45)">45分钟</button>' +
            '    <button type="button" class="ai-duration-btn" onclick="setAiDuration(' + index + ', 60)">1小时</button>' +
            '    <button type="button" class="ai-duration-btn" onclick="setAiDuration(' + index + ', 90)">1.5小时</button>' +
            '    <button type="button" class="ai-duration-btn" onclick="setAiDuration(' + index + ', 120)">2小时</button>' +
            '  </div>' +
            '  <div class="ai-confirm-time-row ai-repeat-row">' +
            '    <label>持续周数' +
            '      <div class="ai-repeat-input">' +
            '        <input type="number" class="ai-task-repeat-weeks" data-index="' + index + '"' +
            '               value="' + (task.repeatWeeks ? task.repeatWeeks : '') + '"' +
            '               placeholder="单次" min="1" max="52">' +
            '        <span class="ai-repeat-unit">周</span>' +
            '      </div>' +
            '    </label>' +
            '    <label class="ai-repeat-hint-label" data-index="' + index + '">' +
            (task.repeatWeeks && task.repeatWeeks > 1
                ? '📅 将展开为 ' + task.repeatWeeks + ' 条每周重复的任务'
                : '留空表示单次任务') +
            '    </label>' +
            '  </div>' +
            '  <div class="ai-repeat-quick">' +
            '    <span class="ai-duration-label">周数：</span>' +
            '    <button type="button" class="ai-duration-btn" onclick="setAiRepeatWeeks(' + index + ', 1)">单次</button>' +
            '    <button type="button" class="ai-duration-btn" onclick="setAiRepeatWeeks(' + index + ', 8)">8周</button>' +
            '    <button type="button" class="ai-duration-btn" onclick="setAiRepeatWeeks(' + index + ', 16)">16周</button>' +
            '    <button type="button" class="ai-duration-btn" onclick="setAiRepeatWeeks(' + index + ', 18)">18周</button>' +
            '    <button type="button" class="ai-duration-btn" onclick="setAiRepeatWeeks(' + index + ', 20)">20周</button>' +
            '  </div>' +
            '</div>' +
            reasonHtml;

        confirmList.appendChild(item);
    });

    /* 周数输入联动提示 */
    document.querySelectorAll('.ai-task-repeat-weeks').forEach(function (input) {
        input.addEventListener('input', function () {
            updateRepeatHint(this.getAttribute('data-index'), parseInt(this.value, 10) || 0);
        });
    });
}

/* ── 快捷设置时长 ── */
function setAiDuration(index, minutes) {
    var input = document.querySelector('.ai-task-duration[data-index="' + index + '"]');
    if (input) input.value = minutes;
}

/* ── 快捷设置周数 ── */
function setAiRepeatWeeks(index, weeks) {
    var input = document.querySelector('.ai-task-repeat-weeks[data-index="' + index + '"]');
    if (!input) return;
    input.value = weeks === 1 ? '' : weeks;
    updateRepeatHint(index, weeks === 1 ? 0 : weeks);
}

/* ── 更新周数联动提示 ── */
function updateRepeatHint(index, weeks) {
    var hint = document.querySelector('.ai-repeat-hint-label[data-index="' + index + '"]');
    if (!hint) return;
    if (weeks > 1) {
        hint.textContent = '📅 将展开为 ' + weeks + ' 条每周重复的任务';
        hint.classList.add('ai-repeat-hint-active');
    } else {
        hint.textContent = '留空表示单次任务';
        hint.classList.remove('ai-repeat-hint-active');
    }
}

/* ── 时间格式转换 ── */
function toDatetimeLocal(dateStr) {
    if (!dateStr) return '';
    // "2026-04-15 08:00:00" → "2026-04-15T08:00"
    return String(dateStr).replace(' ', 'T').substring(0, 16);
}
function fromDatetimeLocal(val) {
    if (!val) return null;
    // "2026-04-15T08:00" → "2026-04-15 08:00:00"
    return val.replace('T', ' ') + (val.length === 16 ? ':00' : '');
}

/* ── 确认创建 AI 分析出的任务 ── */
async function confirmAiTasks() {
    var checkboxes      = document.querySelectorAll('.ai-task-check');
    var quadrantSelects = document.querySelectorAll('.ai-task-quadrant');
    var prioritySelects = document.querySelectorAll('.ai-task-priority');
    var startTimeInputs = document.querySelectorAll('.ai-task-start-time');
    var durationInputs  = document.querySelectorAll('.ai-task-duration');
    var deadlineInputs  = document.querySelectorAll('.ai-task-deadline-input');
    var repeatInputs    = document.querySelectorAll('.ai-task-repeat-weeks');

    var tasksToCreate = [];
    var validationError = null;
    checkboxes.forEach(function (cb, i) {
        if (validationError) return;
        if (cb.checked) {
            var task = aiAnalyzedTasks[i];
            if (!task) return;
            var durationVal = durationInputs[i] && durationInputs[i].value
                ? parseInt(durationInputs[i].value, 10)
                : null;
            var repeatVal = repeatInputs[i] && repeatInputs[i].value
                ? parseInt(repeatInputs[i].value, 10)
                : null;
            var startTimeVal = startTimeInputs[i] ? fromDatetimeLocal(startTimeInputs[i].value) : null;

            // 校验：填了周数(>1) 但没填开始时间
            if (repeatVal && repeatVal > 1 && !startTimeVal) {
                validationError = '任务「' + (task.title || ('#' + (i + 1))) + '」设置了周期重复，需要填写开始时间';
                return;
            }

            tasksToCreate.push({
                title:           task.title,
                description:     task.description || '',
                quadrant:        parseInt(quadrantSelects[i].value, 10),
                priority:        parseInt(prioritySelects[i].value, 10),
                startTime:       startTimeVal,
                durationMinutes: (durationVal && !isNaN(durationVal)) ? durationVal : null,
                deadline:        deadlineInputs[i] ? fromDatetimeLocal(deadlineInputs[i].value) : null,
                repeatWeeks:     (repeatVal && !isNaN(repeatVal)) ? repeatVal : null,
                status:          0
            });
        }
    });
    if (validationError) {
        if (typeof showToast === 'function') showToast(validationError, 'warning');
        return;
    }

    if (tasksToCreate.length === 0) {
        if (typeof showToast === 'function') showToast('请至少选择一个任务', 'warning');
        return;
    }

    // 计算实际要创建的条数（含周期展开）
    var totalCount = 0;
    tasksToCreate.forEach(function (t) {
        totalCount += (t.repeatWeeks && t.repeatWeeks > 1) ? t.repeatWeeks : 1;
    });
    var thinkingId = appendThinking('正在创建 ' + totalCount + ' 条任务（含周期展开）...');

    try {
        var res = await api.post('/ai/batch-create-tasks', tasksToCreate);
        removeMessage(thinkingId);

        var created = (res.data && res.data.created) || 0;
        var failed  = (res.data && res.data.failed)  || 0;
        var msg = '🎉 成功创建 ' + created + ' 个任务！';
        if (failed > 0) msg += '（' + failed + ' 个创建失败）';
        appendMessage('ai', msg);

        // 隐藏右侧确认面板，清空状态
        aiAnalyzedTasks = [];
        var confirmSide = document.getElementById('aiConfirmSide');
        if (confirmSide) confirmSide.classList.add('hidden');

        // 刷新看板数据（loadQuadrants 内部已调用 refreshCalendar(allTasksFlat)）
        if (typeof loadQuadrants === 'function') await loadQuadrants();

        if (typeof showToast === 'function') showToast('任务创建成功', 'success');
    } catch (e) {
        removeMessage(thinkingId);
        appendMessage('ai', '❌ 创建失败：' + escapeHtml(e.message || ''));
    }
}

/* ── 取消任务确认 ── */
function cancelAiTasks() {
    aiAnalyzedTasks = [];
    var confirmSide = document.getElementById('aiConfirmSide');
    if (confirmSide) confirmSide.classList.add('hidden');
    appendMessage('ai', '已取消。');
}

/* ── 追加消息，返回元素 id ── */
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

/* ── 追加思考中占位 ── */
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
   拖拽上传（目标：整个 #aiPanelBody）
   ═══════════════════════════════════════════════════ */
function initAiDragDrop() {
    var panelBody = document.getElementById('aiPanelBody');
    var dropZone  = document.getElementById('aiDropZone');
    if (!panelBody) return;

    panelBody.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (dropZone) dropZone.classList.add('drag-over');
    });

    panelBody.addEventListener('dragleave', function (e) {
        if (!panelBody.contains(e.relatedTarget)) {
            if (dropZone) dropZone.classList.remove('drag-over');
        }
    });

    panelBody.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (dropZone) dropZone.classList.remove('drag-over');
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) {
            handleFileUpload(files[0]);
        }
    });

    // 也支持拖到收起的标题栏时自动展开
    var header = document.querySelector('.ai-panel-header');
    if (header) {
        header.addEventListener('dragover', function (e) {
            e.preventDefault();
            if (panelBody.classList.contains('hidden')) toggleAiPanel();
        });
    }
}

document.addEventListener('DOMContentLoaded', function () {
    initAiDragDrop();
});
