/* ═══════════════════════════════════════════════════
   ai-assistant.js — AI 助手嵌入式面板
   ═══════════════════════════════════════════════════ */

var aiAnalyzedTasks = [];
var aiAnalyzedRoutines = [];
var _msgIdCounter = 0;
var _aiHistoryLoaded = false;
var _aiRestoringState = false;
var _aiPageLeaving = false;
var _aiMessagesState = [];
var _selectedAiModelId = null;
var _currentAiWikiDraft = null;
var _aiStreamStates = {};
var _activeAiStream = null;
var _aiNotebooks = [];
var _aiSources = [];
var _selectedAiNotebookId = null;
var _currentAgentRunId = null;
var AI_STATE_KEY = 'zhiqu.aiAssistant.uiState.v13';
var AI_LEGACY_STATE_KEYS = [
    'zhiqu.aiAssistant.uiState.v1',
    'zhiqu.aiAssistant.uiState.v2',
    'zhiqu.aiAssistant.uiState.v3',
    'zhiqu.aiAssistant.uiState.v4',
    'zhiqu.aiAssistant.uiState.v5',
    'zhiqu.aiAssistant.uiState.v6',
    'zhiqu.aiAssistant.uiState.v7',
    'zhiqu.aiAssistant.uiState.v8',
    'zhiqu.aiAssistant.uiState.v10',
    'zhiqu.aiAssistant.uiState.v11',
    'zhiqu.aiAssistant.uiState.v9',
    'zhiqu.aiAssistant.uiState.v12'
];
var AI_STATE_TTL_MS = 6 * 60 * 60 * 1000;

if (typeof checkAuth === 'function') {
    checkAuth();
}
if (typeof renderNavbar === 'function' && document.getElementById('navbar')) {
    renderNavbar('navbar');
}

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
        appendMessage('ai', '文件过大，请上传 20MB 以内的文件');
        persistAiState();
        return;
    }

    var isImg = file.type.startsWith('image/');
    var isPdf = file.type === 'application/pdf';
    var fileLabel = isImg ? '图片：' : isPdf ? 'PDF：' : '文件：';
    fileLabel += escapeHtml(file.name);

    appendMessage('user', fileLabel);
    persistAiState();

    // 图片：消息区域内显示缩略图预览
    if (isImg) {
        var reader = new FileReader();
        reader.onload = function (e) {
            appendMessage(
                'user',
                '<img src="' + e.target.result + '" class="ai-img-preview" alt="上传的图片">',
                'ai-img-wrap',
                file.name,
                false
            );
        };
        reader.readAsDataURL(file);
    }

    var thinkingId = appendThinking('正在分析文件内容，请稍候...');

    try {
        var res = await api.upload('/ai/analyze', file);
        removeMessage(thinkingId);

        aiAnalyzedTasks = res.data || [];
        aiAnalyzedRoutines = [];

        if (aiAnalyzedTasks.length === 0) {
            appendMessage('ai', '未从文件中识别出任务，请检查文件内容或换一个文件试试。');
            persistAiState();
            return;
        }

        appendMessage('ai', '识别出 <strong>' + aiAnalyzedTasks.length + '</strong> 条任务，请在右侧确认并创建：');
        renderTaskConfirmList(aiAnalyzedTasks, []);
        persistAiState();
    } catch (e) {
        removeMessage(thinkingId);
        if (isAiRequestInterruptedByPageLeave(e)) {
            clearAiState();
            return;
        }
        appendMessage('ai', '文件分析失败：' + escapeHtml(e.message || '请检查 AI 配置'));
        persistAiState();
    }
}

function buildAiPlanSummary(taskCount, routineCount) {
    var partsHtml = [];
    var partsText = [];
    if (taskCount) {
        partsHtml.push('<strong>' + taskCount + '</strong> 个一次性任务');
        partsText.push(taskCount + ' 个一次性任务');
    }
    if (routineCount) {
        partsHtml.push('<strong>' + routineCount + '</strong> 个例行计划');
        partsText.push(routineCount + ' 个例行计划');
    }
    if (!partsHtml.length) {
        partsHtml.push('<strong>0</strong> 项计划');
        partsText.push('0 项计划');
    }
    return {
        html: partsHtml.join('、'),
        text: partsText.join('、')
    };
}

/* ── 渲染计划到右侧确认面板 ── */
function renderTaskConfirmList(tasks, routines) {
    tasks = Array.isArray(tasks) ? tasks : [];
    routines = Array.isArray(routines) ? routines : [];
    var confirmSide  = document.getElementById('aiConfirmSide');
    var confirmList  = document.getElementById('aiConfirmList');
    var confirmCount = document.getElementById('aiConfirmCount');
    var confirmTitle = document.querySelector('.ai-confirm-title');

    if (!confirmSide || !confirmList) return;

    confirmSide.classList.remove('hidden');
    if (confirmTitle) confirmTitle.textContent = routines.length ? '识别出的计划' : '识别出的任务';
    if (confirmCount) confirmCount.textContent = buildAiPlanSummary(tasks.length, routines.length).text;
    confirmList.innerHTML = '';

    if (tasks.length) {
        confirmList.appendChild(renderAiConfirmSectionHeader('一次性任务', '有明确截止时间、阶段检查点或单次行动的事项。'));
    }
    tasks.forEach(function (task, index) {
        var item = document.createElement('div');
        item.className = 'ai-confirm-item';

        var hasStartTime = !!task.startTime;
        var hasDuration  = task.durationMinutes != null;
        var hasDeadline  = !!task.deadline;
        var taskType     = task.taskType || 'assignment';
        var difficulty   = task.difficulty || 3;

        var timeStatusHtml;
        if (hasStartTime && hasDuration) {
            timeStatusHtml = '<span class="ai-time-status ai-time-auto">已自动识别</span>';
        } else if (hasStartTime || hasDeadline) {
            timeStatusHtml = '<span class="ai-time-status ai-time-partial">部分识别，请补充</span>';
        } else {
            timeStatusHtml = '<span class="ai-time-status ai-time-manual">未识别，请手动填写</span>';
        }

        var reasonHtml = task.reason
            ? '<div class="ai-confirm-reason">' + escapeHtml(task.reason) + '</div>'
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
            '  <label>类型' +
            '    <select class="ai-task-type" data-index="' + index + '">' +
            '      <option value="assignment"' + (taskType === 'assignment' ? ' selected' : '') + '>作业</option>' +
            '      <option value="exam"' + (taskType === 'exam' ? ' selected' : '') + '>考试</option>' +
            '      <option value="report"' + (taskType === 'report' ? ' selected' : '') + '>报告/论文</option>' +
            '      <option value="presentation"' + (taskType === 'presentation' ? ' selected' : '') + '>展示/答辩</option>' +
            '      <option value="course"' + (taskType === 'course' ? ' selected' : '') + '>课程</option>' +
            '      <option value="activity"' + (taskType === 'activity' ? ' selected' : '') + '>活动</option>' +
            '      <option value="other"' + (taskType === 'other' ? ' selected' : '') + '>其他</option>' +
            '    </select>' +
            '  </label>' +
            '  <label>难度' +
            '    <select class="ai-task-difficulty" data-index="' + index + '">' +
            '      <option value="1"' + (difficulty === 1 ? ' selected' : '') + '>1</option>' +
            '      <option value="2"' + (difficulty === 2 ? ' selected' : '') + '>2</option>' +
            '      <option value="3"' + (difficulty === 3 ? ' selected' : '') + '>3</option>' +
            '      <option value="4"' + (difficulty === 4 ? ' selected' : '') + '>4</option>' +
            '      <option value="5"' + (difficulty === 5 ? ' selected' : '') + '>5</option>' +
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
            '  <div class="ai-reminder-block">' +
            '    <div class="ai-reminder-title">早八提醒</div>' +
            '    <div class="ai-reminder-options" data-index="' + index + '">' +
            renderAiReminderOptions(task, index) +
            '    </div>' +
            '    <div class="ai-reminder-custom-row">' +
            '      <input type="number" min="0" max="365" class="ai-reminder-custom" data-index="' + index + '" placeholder="自定义天数">' +
            '      <button type="button" class="ai-duration-btn" onclick="addAiReminderOffset(' + index + ')">添加</button>' +
            '    </div>' +
            (task.reminderReason ? '    <div class="ai-reminder-reason">' + escapeHtml(task.reminderReason) + '</div>' : '') +
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
                ? '将展开为 ' + task.repeatWeeks + ' 条每周重复的任务'
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

    if (routines.length) {
        confirmList.appendChild(renderAiConfirmSectionHeader('例行计划', '每天、每周或固定周期重复的学习动作，不会展开成一堆普通任务。'));
    }
    routines.forEach(function (routine, index) {
        confirmList.appendChild(renderRoutineConfirmItem(routine, index));
    });

    /* 周数输入联动提示 */
    document.querySelectorAll('.ai-task-repeat-weeks').forEach(function (input) {
        input.addEventListener('input', function () {
            updateRepeatHint(this.getAttribute('data-index'), parseInt(this.value, 10) || 0);
            persistAiState();
        });
    });
    wireAiStatePersistenceForConfirmList();
}

function renderAiConfirmSectionHeader(title, desc) {
    var section = document.createElement('div');
    section.className = 'ai-confirm-section-title';
    section.innerHTML = '<strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(desc) + '</span>';
    return section;
}

function renderRoutineConfirmItem(routine, index) {
    var item = document.createElement('div');
    item.className = 'ai-confirm-item ai-routine-item';

    var frequency = normalizeRoutineFrequency(routine.frequency);
    var days = normalizeRoutineDays(routine.daysOfWeek);
    var startDate = toDateInput(routine.startDate) || todayDateInput();
    var endDate = toDateInput(routine.endDate) || addDaysDateInput(startDate, 29);
    var preferredTime = toTimeInput(routine.preferredTime) || '08:00';
    var duration = routine.durationMinutes || 45;
    var taskType = routine.taskType || 'course';
    var difficulty = routine.difficulty || 3;
    var quadrant = routine.quadrant || routine.suggestedQuadrant || 2;
    var priority = routine.priority == null ? 1 : routine.priority;
    var reminderEnabled = routine.reminderEnabled !== false;

    var descHtml = routine.description
        ? '<div class="ai-confirm-desc">' + escapeHtml(routine.description) + '</div>'
        : '';
    var reasonHtml = routine.reason || routine.reminderReason
        ? '<div class="ai-confirm-reason">' + escapeHtml(routine.reason || routine.reminderReason) + '</div>'
        : '';

    item.innerHTML =
        '<div class="ai-confirm-item-header">' +
        '  <label class="ai-confirm-checkbox">' +
        '    <input type="checkbox" checked data-index="' + index + '" class="ai-routine-check">' +
        '    <strong>' + escapeHtml(routine.title || '未命名例行计划') + '</strong>' +
        '  </label>' +
        '</div>' +
        descHtml +
        '<div class="ai-confirm-meta">' +
        '  <label>频率' +
        '    <select class="ai-routine-frequency" data-index="' + index + '">' +
        '      <option value="DAILY"' + (frequency === 'DAILY' ? ' selected' : '') + '>每天</option>' +
        '      <option value="WEEKLY"' + (frequency === 'WEEKLY' ? ' selected' : '') + '>每周</option>' +
        '    </select>' +
        '  </label>' +
        '  <label>象限' +
        '    <select class="ai-routine-quadrant" data-index="' + index + '">' +
        '      <option value="1"' + (quadrant === 1 ? ' selected' : '') + '>重要且紧急</option>' +
        '      <option value="2"' + (quadrant === 2 ? ' selected' : '') + '>重要不紧急</option>' +
        '      <option value="3"' + (quadrant === 3 ? ' selected' : '') + '>紧急不重要</option>' +
        '      <option value="4"' + (quadrant === 4 ? ' selected' : '') + '>不重要不紧急</option>' +
        '    </select>' +
        '  </label>' +
        '  <label>优先级' +
        '    <select class="ai-routine-priority" data-index="' + index + '">' +
        '      <option value="0"' + (priority === 0 ? ' selected' : '') + '>低</option>' +
        '      <option value="1"' + (priority === 1 ? ' selected' : '') + '>中</option>' +
        '      <option value="2"' + (priority === 2 ? ' selected' : '') + '>高</option>' +
        '      <option value="3"' + (priority === 3 ? ' selected' : '') + '>紧急</option>' +
        '    </select>' +
        '  </label>' +
        '</div>' +
        '<div class="ai-confirm-meta">' +
        '  <label>类型' +
        '    <select class="ai-routine-type" data-index="' + index + '">' +
        '      <option value="assignment"' + (taskType === 'assignment' ? ' selected' : '') + '>作业</option>' +
        '      <option value="exam"' + (taskType === 'exam' ? ' selected' : '') + '>考试</option>' +
        '      <option value="report"' + (taskType === 'report' ? ' selected' : '') + '>报告/论文</option>' +
        '      <option value="presentation"' + (taskType === 'presentation' ? ' selected' : '') + '>展示/答辩</option>' +
        '      <option value="course"' + (taskType === 'course' ? ' selected' : '') + '>课程</option>' +
        '      <option value="activity"' + (taskType === 'activity' ? ' selected' : '') + '>活动</option>' +
        '      <option value="other"' + (taskType === 'other' ? ' selected' : '') + '>其他</option>' +
        '    </select>' +
        '  </label>' +
        '  <label>难度' +
        '    <select class="ai-routine-difficulty" data-index="' + index + '">' +
        '      <option value="1"' + (difficulty === 1 ? ' selected' : '') + '>1</option>' +
        '      <option value="2"' + (difficulty === 2 ? ' selected' : '') + '>2</option>' +
        '      <option value="3"' + (difficulty === 3 ? ' selected' : '') + '>3</option>' +
        '      <option value="4"' + (difficulty === 4 ? ' selected' : '') + '>4</option>' +
        '      <option value="5"' + (difficulty === 5 ? ' selected' : '') + '>5</option>' +
        '    </select>' +
        '  </label>' +
        '</div>' +
        '<div class="ai-routine-days" data-index="' + index + '">' +
        renderRoutineDayChips(index, days) +
        '</div>' +
        '<div class="ai-confirm-time-section">' +
        '  <span class="ai-time-status ai-time-auto">例行计划会按日期动态显示</span>' +
        '  <div class="ai-confirm-time-row">' +
        '    <label>开始日期<input type="date" class="ai-routine-start-date" data-index="' + index + '" value="' + startDate + '"></label>' +
        '    <label>结束日期<input type="date" class="ai-routine-end-date" data-index="' + index + '" value="' + endDate + '"></label>' +
        '  </div>' +
        '  <div class="ai-confirm-time-row">' +
        '    <label>偏好时间<input type="time" class="ai-routine-preferred-time" data-index="' + index + '" value="' + preferredTime + '"></label>' +
        '    <label>预计时长<input type="number" class="ai-routine-duration" data-index="' + index + '" value="' + duration + '" min="1" max="480"></label>' +
        '  </div>' +
        '  <label class="ai-routine-reminder-toggle">' +
        '    <input type="checkbox" class="ai-routine-reminder-enabled" data-index="' + index + '"' + (reminderEnabled ? ' checked' : '') + '>' +
        '    早八汇总提醒包含这项例行计划' +
        '  </label>' +
        '</div>' +
        reasonHtml;

    return item;
}

function renderRoutineDayChips(index, selectedDays) {
    var labels = [
        [1, '周一'],
        [2, '周二'],
        [3, '周三'],
        [4, '周四'],
        [5, '周五'],
        [6, '周六'],
        [7, '周日']
    ];
    return labels.map(function (pair) {
        var value = pair[0];
        var checked = selectedDays.indexOf(value) >= 0;
        return '<label class="ai-routine-day-chip">' +
            '<input type="checkbox" class="ai-routine-day" data-index="' + index + '" value="' + value + '"' +
            (checked ? ' checked' : '') + '>' +
            '<span>' + pair[1] + '</span>' +
            '</label>';
    }).join('');
}

function normalizeAiReminderOffsets(task) {
    var raw = task.suggestedReminderOffsets || task.reminderOffsets || [];
    if (typeof raw === 'string') {
        raw = raw.split(',');
    }
    if (!Array.isArray(raw)) return [];
    var result = [];
    raw.forEach(function (item) {
        var n = parseInt(item, 10);
        if (!isNaN(n) && n >= 0 && n <= 365 && result.indexOf(n) === -1) {
            result.push(n);
        }
    });
    result.sort(function (a, b) { return b - a; });
    return result;
}

function renderAiReminderOptions(task, index) {
    var offsets = normalizeAiReminderOffsets(task);
    if (!offsets.length) {
        return '<span class="ai-reminder-empty">暂无推荐，可手动添加</span>';
    }
    return offsets.map(function (offset) {
        return renderAiReminderChip(index, offset, true);
    }).join('');
}

function renderAiReminderChip(index, offset, checked) {
    var label = offset === 0 ? '截止当天' : ('提前' + offset + '天');
    return '<label class="ai-reminder-chip">' +
        '<input type="checkbox" class="ai-reminder-offset" data-index="' + index + '" value="' + offset + '"' +
        (checked ? ' checked' : '') + '>' +
        '<span>' + label + '</span>' +
        '</label>';
}

function addAiReminderOffset(index) {
    var input = document.querySelector('.ai-reminder-custom[data-index="' + index + '"]');
    var box = document.querySelector('.ai-reminder-options[data-index="' + index + '"]');
    if (!input || !box) return;
    var value = parseInt(input.value, 10);
    if (isNaN(value) || value < 0 || value > 365) {
        if (typeof showToast === 'function') showToast('请输入 0-365 之间的提醒天数', 'warning');
        return;
    }
    if (box.querySelector('.ai-reminder-offset[value="' + value + '"]')) {
        input.value = '';
        return;
    }
    var empty = box.querySelector('.ai-reminder-empty');
    if (empty) empty.remove();
    box.insertAdjacentHTML('beforeend', renderAiReminderChip(index, value, true));
    input.value = '';
    persistAiState();
}

function collectAiReminderOffsets(index) {
    var values = [];
    document.querySelectorAll('.ai-reminder-offset[data-index="' + index + '"]:checked').forEach(function (input) {
        var n = parseInt(input.value, 10);
        if (!isNaN(n) && n >= 0 && n <= 365 && values.indexOf(n) === -1) {
            values.push(n);
        }
    });
    values.sort(function (a, b) { return b - a; });
    return values;
}

function normalizeRoutineFrequency(value) {
    value = String(value || '').toUpperCase();
    return value === 'WEEKLY' ? 'WEEKLY' : 'DAILY';
}

function normalizeRoutineDays(raw) {
    var values = [];
    if (Array.isArray(raw)) {
        values = raw;
    } else if (typeof raw === 'string') {
        values = raw.split(',');
    }
    var result = [];
    values.forEach(function (item) {
        var n = parseInt(item, 10);
        if (!isNaN(n) && n >= 1 && n <= 7 && result.indexOf(n) === -1) {
            result.push(n);
        }
    });
    if (!result.length) {
        result = [1, 2, 3, 4, 5, 6, 7];
    }
    result.sort(function (a, b) { return a - b; });
    return result;
}

function collectRoutineDays(index, frequency) {
    var values = [];
    document.querySelectorAll('.ai-routine-day[data-index="' + index + '"]:checked').forEach(function (input) {
        var n = parseInt(input.value, 10);
        if (!isNaN(n) && values.indexOf(n) === -1) values.push(n);
    });
    values.sort(function (a, b) { return a - b; });
    if (frequency === 'DAILY') {
        return values.length ? values : [1, 2, 3, 4, 5, 6, 7];
    }
    return values.length ? values : [new Date().getDay() || 7];
}

/* ── 快捷设置时长 ── */
function setAiDuration(index, minutes) {
    var input = document.querySelector('.ai-task-duration[data-index="' + index + '"]');
    if (input) input.value = minutes;
    persistAiState();
}

/* ── 快捷设置周数 ── */
function setAiRepeatWeeks(index, weeks) {
    var input = document.querySelector('.ai-task-repeat-weeks[data-index="' + index + '"]');
    if (!input) return;
    input.value = weeks === 1 ? '' : weeks;
    updateRepeatHint(index, weeks === 1 ? 0 : weeks);
    persistAiState();
}

/* ── 更新周数联动提示 ── */
function updateRepeatHint(index, weeks) {
    var hint = document.querySelector('.ai-repeat-hint-label[data-index="' + index + '"]');
    if (!hint) return;
    if (weeks > 1) {
        hint.textContent = '将展开为 ' + weeks + ' 条每周重复的任务';
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

function toDateInput(value) {
    if (!value) return '';
    return String(value).replace(/\//g, '-').substring(0, 10);
}

function toTimeInput(value) {
    if (!value) return '';
    return String(value).replace(' ', 'T').substring(0, 5);
}

function todayDateInput() {
    return formatDateInput(new Date());
}

function addDaysDateInput(dateStr, days) {
    var d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
    if (Number.isNaN(d.getTime())) d = new Date();
    d.setDate(d.getDate() + days);
    return formatDateInput(d);
}

function formatDateInput(date) {
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/* ── 确认创建 AI 分析出的任务 ── */
async function confirmAiTasks() {
    var checkboxes      = document.querySelectorAll('.ai-task-check');
    var quadrantSelects = document.querySelectorAll('.ai-task-quadrant');
    var prioritySelects = document.querySelectorAll('.ai-task-priority');
    var taskTypeSelects = document.querySelectorAll('.ai-task-type');
    var difficultySelects = document.querySelectorAll('.ai-task-difficulty');
    var startTimeInputs = document.querySelectorAll('.ai-task-start-time');
    var durationInputs  = document.querySelectorAll('.ai-task-duration');
    var deadlineInputs  = document.querySelectorAll('.ai-task-deadline-input');
    var repeatInputs    = document.querySelectorAll('.ai-task-repeat-weeks');
    var routineChecks   = document.querySelectorAll('.ai-routine-check');

    var tasksToCreate = [];
    var routinesToCreate = [];
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
                taskType:        taskTypeSelects[i] ? taskTypeSelects[i].value : (task.taskType || 'assignment'),
                difficulty:      difficultySelects[i] ? parseInt(difficultySelects[i].value, 10) : (task.difficulty || 3),
                aiReminderReason: task.reminderReason || task.aiReminderReason || '',
                reminderOffsets: collectAiReminderOffsets(i),
                startTime:       startTimeVal,
                durationMinutes: (durationVal && !isNaN(durationVal)) ? durationVal : null,
                deadline:        deadlineInputs[i] ? fromDatetimeLocal(deadlineInputs[i].value) : null,
                repeatWeeks:     (repeatVal && !isNaN(repeatVal)) ? repeatVal : null,
                status:          0
            });
        }
    });

    routineChecks.forEach(function (cb) {
        if (validationError) return;
        var index = parseInt(cb.getAttribute('data-index'), 10);
        if (!cb.checked) return;
        var routine = aiAnalyzedRoutines[index];
        if (!routine) return;
        var frequency = valueOfSelector('.ai-routine-frequency[data-index="' + index + '"]') || 'DAILY';
        var startDate = valueOfSelector('.ai-routine-start-date[data-index="' + index + '"]');
        var endDate = valueOfSelector('.ai-routine-end-date[data-index="' + index + '"]');
        if (!startDate || !endDate) {
            validationError = '例行计划「' + (routine.title || ('#' + (index + 1))) + '」需要填写开始日期和结束日期';
            return;
        }
        if (new Date(endDate + 'T00:00:00').getTime() < new Date(startDate + 'T00:00:00').getTime()) {
            validationError = '例行计划「' + (routine.title || ('#' + (index + 1))) + '」的结束日期不能早于开始日期';
            return;
        }
        routinesToCreate.push({
            title: routine.title || '未命名例行计划',
            description: routine.description || '',
            frequency: frequency,
            daysOfWeek: collectRoutineDays(index, frequency),
            startDate: startDate,
            endDate: endDate,
            preferredTime: valueOfSelector('.ai-routine-preferred-time[data-index="' + index + '"]') || '08:00',
            durationMinutes: parseIntOrDefault(valueOfSelector('.ai-routine-duration[data-index="' + index + '"]'), 45),
            taskType: valueOfSelector('.ai-routine-type[data-index="' + index + '"]') || routine.taskType || 'course',
            difficulty: parseIntOrDefault(valueOfSelector('.ai-routine-difficulty[data-index="' + index + '"]'), routine.difficulty || 3),
            quadrant: parseIntOrDefault(valueOfSelector('.ai-routine-quadrant[data-index="' + index + '"]'), routine.quadrant || routine.suggestedQuadrant || 2),
            priority: parseIntOrDefault(valueOfSelector('.ai-routine-priority[data-index="' + index + '"]'), routine.priority == null ? 1 : routine.priority),
            reminderEnabled: !!document.querySelector('.ai-routine-reminder-enabled[data-index="' + index + '"]')?.checked,
            reminderOffsets: [0]
        });
    });
    if (validationError) {
        if (typeof showToast === 'function') showToast(validationError, 'warning');
        return;
    }

    if (tasksToCreate.length === 0 && routinesToCreate.length === 0) {
        if (typeof showToast === 'function') showToast('请至少选择一个任务或例行计划', 'warning');
        return;
    }

    // 计算实际要创建的条数（含周期展开）
    var totalCount = 0;
    tasksToCreate.forEach(function (t) {
        totalCount += (t.repeatWeeks && t.repeatWeeks > 1) ? t.repeatWeeks : 1;
    });
    var totalPlanCount = totalCount + routinesToCreate.length;
    var thinkingId = appendThinking('正在写入 ' + totalPlanCount + ' 项计划...');

    try {
        var idempotencyKey = localStorage.getItem('zhiqu:ai-batch-create:idempotency');
        if (!idempotencyKey) {
            idempotencyKey = 'ai-batch-' + Date.now() + '-' + Math.random().toString(16).slice(2);
            localStorage.setItem('zhiqu:ai-batch-create:idempotency', idempotencyKey);
        }
        var res = routinesToCreate.length
            ? await api.post('/ai/batch-create-plan', {
                planTitle: 'AI 生成学习计划',
                tasks: tasksToCreate,
                routines: routinesToCreate
            }, {
                headers: { 'Idempotency-Key': idempotencyKey }
            })
            : await api.post('/ai/batch-create-tasks', tasksToCreate, {
                headers: { 'Idempotency-Key': idempotencyKey }
            });
        removeMessage(thinkingId);
        localStorage.removeItem('zhiqu:ai-batch-create:idempotency');

        var created = routinesToCreate.length
            ? ((res.data && res.data.createdTasks) || 0)
            : ((res.data && res.data.created) || 0);
        var createdRoutines = routinesToCreate.length ? ((res.data && res.data.createdRoutines) || 0) : 0;
        var failed  = routinesToCreate.length
            ? ((res.data && res.data.failedTasks) || 0)
            : ((res.data && res.data.failed)  || 0);
        var msg = '已写入 ' + created + ' 个任务';
        if (createdRoutines > 0) msg += '、' + createdRoutines + ' 个例行计划';
        msg += '。';
        if (failed > 0) msg += '（' + failed + ' 个创建失败）';
        appendMessage('ai', msg);

        // 隐藏右侧确认面板，清空状态
        aiAnalyzedTasks = [];
        aiAnalyzedRoutines = [];
        var confirmSide = document.getElementById('aiConfirmSide');
        if (confirmSide) confirmSide.classList.add('hidden');
        clearAiPendingTasksState();
        persistAiState();

        if (typeof loadDashboardOverview === 'function') {
            await loadDashboardOverview();
        } else if (typeof loadQuadrants === 'function') {
            await loadQuadrants();
        }

        if (typeof showToast === 'function') showToast('计划创建成功', 'success');
    } catch (e) {
        removeMessage(thinkingId);
        appendMessage('ai', '创建失败：' + escapeHtml(e.message || ''));
    }
}

/* ── 取消任务确认 ── */
function cancelAiTasks() {
    aiAnalyzedTasks = [];
    aiAnalyzedRoutines = [];
    var confirmSide = document.getElementById('aiConfirmSide');
    if (confirmSide) confirmSide.classList.add('hidden');
    appendMessage('ai', '已取消。');
    clearAiPendingTasksState();
    persistAiState();
}

async function loadAiChatHistory() {
    var container = document.getElementById('aiMessages');
    if (!container || _aiHistoryLoaded) return;
    _aiHistoryLoaded = true;

    var statusEl = document.getElementById('aiHistoryStatus');
    try {
        var res = await api.get('/ai/messages?limit=50');
        var messages = res.data || [];
        if (messages.length) {
            var welcome = document.getElementById('aiWelcomeMessage');
            if (welcome) welcome.remove();
            var existingIds = collectRenderedAiMessageIds();
            messages.forEach(function (item) {
                var itemId = normalizeAiMessageId(item && item.id);
                if (itemId != null && existingIds.has(String(itemId))) return;
                var role = normalizeAiMessageRole(item.role);
                var content = item.content || '';
                if (role === 'ai') {
                    appendMessage('ai', renderAiHistoryMessage(item), 'ai-md', content, false, {
                        messageId: item.id,
                        status: normalizeAiMessageStatus(item.status)
                    });
                } else {
                    appendMessage('user', escapeHtml(content), '', content, false, {
                        messageId: item.id,
                        status: normalizeAiMessageStatus(item.status)
                    });
                }
                if (itemId != null) existingIds.add(String(itemId));
                if (item.agentRunId) {
                    _currentAgentRunId = item.agentRunId;
                }
            });
            scrollAiToLatest(true);
            if (_currentAgentRunId) {
                loadAiAgentRun(_currentAgentRunId);
            }
        }
        if (statusEl) {
            statusEl.textContent = messages.length ? ('已载入 ' + messages.length + ' 条记录') : '暂无历史记录';
        }
        if (!messages.length) scrollAiToLatest(true);
    } catch (e) {
        if (statusEl) statusEl.textContent = '聊天记录读取失败';
    }
}

function collectRenderedAiMessageIds() {
    var ids = new Set();
    document.querySelectorAll('#aiMessages [data-message-id]').forEach(function (el) {
        var id = normalizeAiMessageId(el.getAttribute('data-message-id'));
        if (id != null) ids.add(String(id));
    });
    _aiMessagesState.forEach(function (entry) {
        var id = normalizeAiMessageId(entry.messageId);
        if (id != null) ids.add(String(id));
    });
    return ids;
}

function normalizeAiMessageStatus(status) {
    var value = String(status || 'DONE').trim().toUpperCase();
    return ['STREAMING', 'DONE', 'ERROR', 'ABORTED'].indexOf(value) >= 0 ? value : 'DONE';
}

function renderAiHistoryMessage(item) {
    var status = normalizeAiMessageStatus(item && item.status);
    var content = item && item.content ? String(item.content) : '';
    var html = content ? renderMarkdown(content) : '';
    if (status === 'STREAMING') {
        return html + renderAiStatusNotice('回答仍在生成或连接已中断，可稍后刷新查看。', 'streaming');
    }
    if (status === 'ERROR') {
        return html + renderAiStatusNotice(item && item.errorMessage ? item.errorMessage : '这次回答生成失败。', 'error');
    }
    if (status === 'ABORTED') {
        return html + renderAiStatusNotice('这次回答已由用户停止。', 'aborted');
    }
    return html +
        renderAiReasoningSummary(shouldRenderAiReasoning(item) ? ((item && item.reasoningSummary) || '') : '') +
        renderAiCitations(Array.isArray(item && item.citations) ? item.citations : []) +
        renderAiCitationFailures(Array.isArray(item && item.citations) ? item.citations : []);
}

function shouldRenderAiReasoning(item) {
    if (!item || !item.reasoningSummary) return false;
    return String(item.reasoningMode || 'OFF').trim().toUpperCase() !== 'OFF';
}

function renderAiStatusNotice(text, type) {
    return '<div class="ai-stream-interrupted ai-status-' + escapeHtml(type || 'info') + '">' +
        escapeHtml(text || '') +
        '</div>';
}

function persistAiState() {
    if (_aiRestoringState) return;
    var container = document.getElementById('aiMessages');
    if (!container) return;
    var input = document.getElementById('aiInput');
    var confirmSide = document.getElementById('aiConfirmSide');
    var confirmList = document.getElementById('aiConfirmList');
    var state = {
        savedAt: Date.now(),
        messages: sanitizeAiMessagesState(_aiMessagesState).filter(function (entry) {
            return entry.role === 'ai' && entry.streamStatus === 'streaming';
        }).slice(-20),
        inputDraft: input ? input.value : '',
        analyzedTasks: aiAnalyzedTasks || [],
        analyzedRoutines: aiAnalyzedRoutines || [],
        confirmVisible: !!(confirmSide && !confirmSide.classList.contains('hidden')),
        confirmFormState: collectConfirmFormState(),
        confirmScrollTop: confirmList ? confirmList.scrollTop : 0,
        messagesScrollTop: container.scrollTop
    };
    try {
        sessionStorage.setItem(AI_STATE_KEY, JSON.stringify(state));
    } catch (e) {
        // Ignore storage quota or privacy-mode failures.
    }
}

function restoreAiState() {
    var raw;
    try {
        raw = sessionStorage.getItem(AI_STATE_KEY);
    } catch (e) {
        return false;
    }
    if (!raw) return false;

    var state;
    try {
        state = JSON.parse(raw);
    } catch (e) {
        clearAiState();
        return false;
    }
    if (!state || !state.savedAt || Date.now() - state.savedAt > AI_STATE_TTL_MS) {
        clearAiState();
        return false;
    }

    var container = document.getElementById('aiMessages');
    if (!container) return false;

    _aiRestoringState = true;
    try {
        _aiMessagesState = [];
        var input = document.getElementById('aiInput');
        if (input) input.value = state.inputDraft || '';

        aiAnalyzedTasks = Array.isArray(state.analyzedTasks) ? state.analyzedTasks : [];
        aiAnalyzedRoutines = Array.isArray(state.analyzedRoutines) ? state.analyzedRoutines : [];
        if ((aiAnalyzedTasks.length || aiAnalyzedRoutines.length) && state.confirmVisible) {
            renderTaskConfirmList(aiAnalyzedTasks, aiAnalyzedRoutines);
            applyConfirmFormState(state.confirmFormState || []);
            var confirmList = document.getElementById('aiConfirmList');
            if (confirmList) confirmList.scrollTop = state.confirmScrollTop || 0;
        } else {
            var confirmSide = document.getElementById('aiConfirmSide');
            if (confirmSide) confirmSide.classList.add('hidden');
        }
        scrollAiToLatest(true);
        var statusEl = document.getElementById('aiHistoryStatus');
        if (statusEl) statusEl.textContent = '已恢复上次页面状态';
        return true;
    } finally {
        _aiRestoringState = false;
    }
}

function clearAiState() {
    try {
        sessionStorage.removeItem(AI_STATE_KEY);
        AI_LEGACY_STATE_KEYS.forEach(function (key) {
            sessionStorage.removeItem(key);
        });
    } catch (e) {
        // ignore
    }
}

function clearAiPendingTasksState() {
    var state = readAiState();
    if (!state) return;
    state.analyzedTasks = [];
    state.analyzedRoutines = [];
    state.confirmVisible = false;
    state.confirmFormState = [];
    state.confirmScrollTop = 0;
    try {
        sessionStorage.setItem(AI_STATE_KEY, JSON.stringify(state));
    } catch (e) {
        // ignore
    }
}

function readAiState() {
    try {
        var raw = sessionStorage.getItem(AI_STATE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function collectConfirmFormState() {
    var rows = [];
    document.querySelectorAll('.ai-task-check').forEach(function (checkbox) {
        var index = checkbox.getAttribute('data-index');
        rows.push({
            kind: 'task',
            index: parseInt(index, 10),
            checked: checkbox.checked,
            quadrant: valueOfSelector('.ai-task-quadrant[data-index="' + index + '"]'),
            priority: valueOfSelector('.ai-task-priority[data-index="' + index + '"]'),
            taskType: valueOfSelector('.ai-task-type[data-index="' + index + '"]'),
            difficulty: valueOfSelector('.ai-task-difficulty[data-index="' + index + '"]'),
            startTime: valueOfSelector('.ai-task-start-time[data-index="' + index + '"]'),
            duration: valueOfSelector('.ai-task-duration[data-index="' + index + '"]'),
            deadline: valueOfSelector('.ai-task-deadline-input[data-index="' + index + '"]'),
            repeatWeeks: valueOfSelector('.ai-task-repeat-weeks[data-index="' + index + '"]'),
            reminderOffsets: collectAiReminderOffsets(index)
        });
    });
    document.querySelectorAll('.ai-routine-check').forEach(function (checkbox) {
        var index = checkbox.getAttribute('data-index');
        rows.push({
            kind: 'routine',
            index: parseInt(index, 10),
            checked: checkbox.checked,
            frequency: valueOfSelector('.ai-routine-frequency[data-index="' + index + '"]'),
            quadrant: valueOfSelector('.ai-routine-quadrant[data-index="' + index + '"]'),
            priority: valueOfSelector('.ai-routine-priority[data-index="' + index + '"]'),
            taskType: valueOfSelector('.ai-routine-type[data-index="' + index + '"]'),
            difficulty: valueOfSelector('.ai-routine-difficulty[data-index="' + index + '"]'),
            startDate: valueOfSelector('.ai-routine-start-date[data-index="' + index + '"]'),
            endDate: valueOfSelector('.ai-routine-end-date[data-index="' + index + '"]'),
            preferredTime: valueOfSelector('.ai-routine-preferred-time[data-index="' + index + '"]'),
            duration: valueOfSelector('.ai-routine-duration[data-index="' + index + '"]'),
            reminderEnabled: !!document.querySelector('.ai-routine-reminder-enabled[data-index="' + index + '"]')?.checked,
            daysOfWeek: collectRoutineDays(index, valueOfSelector('.ai-routine-frequency[data-index="' + index + '"]') || 'DAILY')
        });
    });
    return rows;
}

function applyConfirmFormState(rows) {
    if (!Array.isArray(rows)) return;
    rows.forEach(function (row) {
        var index = String(row.index);
        if (row.kind === 'routine') {
            setSelectorValue('.ai-routine-check[data-index="' + index + '"]', row.checked, true);
            setSelectorValue('.ai-routine-frequency[data-index="' + index + '"]', row.frequency);
            setSelectorValue('.ai-routine-quadrant[data-index="' + index + '"]', row.quadrant);
            setSelectorValue('.ai-routine-priority[data-index="' + index + '"]', row.priority);
            setSelectorValue('.ai-routine-type[data-index="' + index + '"]', row.taskType);
            setSelectorValue('.ai-routine-difficulty[data-index="' + index + '"]', row.difficulty);
            setSelectorValue('.ai-routine-start-date[data-index="' + index + '"]', row.startDate);
            setSelectorValue('.ai-routine-end-date[data-index="' + index + '"]', row.endDate);
            setSelectorValue('.ai-routine-preferred-time[data-index="' + index + '"]', row.preferredTime);
            setSelectorValue('.ai-routine-duration[data-index="' + index + '"]', row.duration);
            setSelectorValue('.ai-routine-reminder-enabled[data-index="' + index + '"]', row.reminderEnabled, true);
            restoreRoutineDays(index, row.daysOfWeek || []);
            return;
        }
        setSelectorValue('.ai-task-check[data-index="' + index + '"]', row.checked, true);
        setSelectorValue('.ai-task-quadrant[data-index="' + index + '"]', row.quadrant);
        setSelectorValue('.ai-task-priority[data-index="' + index + '"]', row.priority);
        setSelectorValue('.ai-task-type[data-index="' + index + '"]', row.taskType);
        setSelectorValue('.ai-task-difficulty[data-index="' + index + '"]', row.difficulty);
        setSelectorValue('.ai-task-start-time[data-index="' + index + '"]', row.startTime);
        setSelectorValue('.ai-task-duration[data-index="' + index + '"]', row.duration);
        setSelectorValue('.ai-task-deadline-input[data-index="' + index + '"]', row.deadline);
        setSelectorValue('.ai-task-repeat-weeks[data-index="' + index + '"]', row.repeatWeeks);
        restoreReminderOffsets(index, row.reminderOffsets || []);
        updateRepeatHint(index, parseInt(row.repeatWeeks, 10) || 0);
    });
}

function parseIntOrDefault(value, fallback) {
    var n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
}

function valueOfSelector(selector) {
    var el = document.querySelector(selector);
    return el ? el.value : '';
}

function setSelectorValue(selector, value, isCheckbox) {
    var el = document.querySelector(selector);
    if (!el) return;
    if (isCheckbox) {
        el.checked = !!value;
    } else if (value != null) {
        el.value = value;
    }
}

function restoreReminderOffsets(index, offsets) {
    if (!Array.isArray(offsets)) return;
    var box = document.querySelector('.ai-reminder-options[data-index="' + index + '"]');
    if (!box) return;
    document.querySelectorAll('.ai-reminder-offset[data-index="' + index + '"]').forEach(function (input) {
        input.checked = false;
    });
    offsets.forEach(function (offset) {
        var selector = '.ai-reminder-offset[data-index="' + index + '"][value="' + offset + '"]';
        var existing = document.querySelector(selector);
        if (!existing) {
            var empty = box.querySelector('.ai-reminder-empty');
            if (empty) empty.remove();
            box.insertAdjacentHTML('beforeend', renderAiReminderChip(index, offset, true));
        } else {
            existing.checked = true;
        }
    });
}

function restoreRoutineDays(index, days) {
    if (!Array.isArray(days)) return;
    document.querySelectorAll('.ai-routine-day[data-index="' + index + '"]').forEach(function (input) {
        input.checked = days.indexOf(parseInt(input.value, 10)) >= 0;
    });
}

function wireAiStatePersistenceForConfirmList() {
    document.querySelectorAll(
        '.ai-task-check, .ai-task-quadrant, .ai-task-priority, .ai-task-type, .ai-task-difficulty, ' +
        '.ai-task-start-time, .ai-task-duration, .ai-task-deadline-input, .ai-task-repeat-weeks, .ai-reminder-offset, ' +
        '.ai-routine-check, .ai-routine-frequency, .ai-routine-quadrant, .ai-routine-priority, .ai-routine-type, ' +
        '.ai-routine-difficulty, .ai-routine-day, .ai-routine-start-date, .ai-routine-end-date, ' +
        '.ai-routine-preferred-time, .ai-routine-duration, .ai-routine-reminder-enabled'
    ).forEach(function (el) {
        el.addEventListener('change', persistAiState);
        el.addEventListener('input', persistAiState);
    });
}

function sanitizeAiMessagesState(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
        .filter(function (entry) { return entry && (entry.role === 'ai' || entry.role === 'user'); })
        .filter(function (entry) { return !isDiscardableFetchAbortMessage(entry); })
        .map(function (entry) {
            return {
                messageId: normalizeAiMessageId(entry.messageId),
                domId: entry.domId == null ? '' : String(entry.domId),
                role: entry.role === 'user' ? 'user' : 'ai',
                content: entry.content == null ? '' : String(entry.content),
                html: entry.html == null ? '' : String(entry.html),
                contentClass: entry.contentClass == null ? '' : String(entry.contentClass),
                markdown: !!entry.markdown,
                reasoningMode: entry.reasoningMode == null ? '' : String(entry.reasoningMode),
                reasoningSummary: entry.reasoningSummary == null ? '' : String(entry.reasoningSummary),
                citations: Array.isArray(entry.citations) ? entry.citations : [],
                retrievalStatus: entry.retrievalStatus && typeof entry.retrievalStatus === 'object' ? entry.retrievalStatus : {},
                usage: entry.usage && typeof entry.usage === 'object' ? entry.usage : {},
                streamStatus: entry.streamStatus == null ? '' : String(entry.streamStatus)
            };
        });
}

function appendMessageFromState(entry) {
    var role = entry.role === 'user' ? 'user' : 'ai';
    var domId;
    if (role === 'ai' && entry.streamStatus && entry.streamStatus !== 'done') {
        var interrupted = entry.content
            ? renderMarkdown(entry.content || '') + renderAiStreamInterruptedNotice()
            : renderAiStreamInterruptedNotice();
        interrupted += renderAiReasoningSummary(shouldRenderAiReasoning(entry) ? (entry.reasoningSummary || '') : '', false);
        interrupted += renderAiCitations(entry.citations || [], false);
        interrupted += renderAiCitationFailures(entry.citations || [], false);
        domId = appendMessage(role, interrupted, entry.contentClass || 'ai-md', entry.content || '', false, {
            skipState: true,
            messageId: entry.messageId
        });
        entry.domId = domId || entry.domId || '';
        return;
    }
    if (role === 'ai' && (entry.reasoningSummary || (entry.citations && entry.citations.length))) {
        domId = appendMessage(role,
        renderMarkdown(entry.content || '') +
        renderAiReasoningSummary(shouldRenderAiReasoning(entry) ? (entry.reasoningSummary || '') : '', false) +
        renderAiCitations(entry.citations || [], false) +
        renderAiCitationFailures(entry.citations || [], false),
            entry.contentClass || 'ai-md',
            entry.content || '',
            false,
            {
                skipState: true,
                messageId: entry.messageId
            });
        entry.domId = domId || entry.domId || '';
        return;
    }
    if (entry.markdown) {
        domId = appendMessage(role, renderMarkdown(entry.content || ''), entry.contentClass || 'ai-md', entry.content || '', true, {
            skipState: true,
            messageId: entry.messageId
        });
        entry.domId = domId || entry.domId || '';
        return;
    }
    var html = entry.html || escapeHtml(entry.content || '');
    domId = appendMessage(role, html, entry.contentClass || '', entry.content || '', false, {
        skipState: true,
        messageId: entry.messageId
    });
    entry.domId = domId || entry.domId || '';
}

function storeAiMessageState(role, htmlContent, contentClass, rawContent, markdown, messageId, domId, status) {
    upsertAiMessageState({
        messageId: normalizeAiMessageId(messageId),
        domId: domId || '',
        role: role === 'user' ? 'user' : 'ai',
        content: rawContent == null ? htmlToPlainText(htmlContent) : String(rawContent),
        html: markdown ? '' : String(htmlContent || ''),
        contentClass: contentClass || '',
        markdown: !!markdown,
        streamStatus: normalizeAiMessageStatus(status).toLowerCase()
    });
}

function upsertAiMessageState(entry) {
    if (!entry) return;
    var messageId = normalizeAiMessageId(entry.messageId);
    var index = _aiMessagesState.findIndex(function (item) {
        if (entry.domId && item.domId === entry.domId) return true;
        return messageId != null && normalizeAiMessageId(item.messageId) === messageId;
    });
    var normalized = {
        messageId: messageId,
        requestId: entry.requestId == null ? '' : String(entry.requestId),
        domId: entry.domId || '',
        role: entry.role === 'user' ? 'user' : 'ai',
        content: entry.content == null ? '' : String(entry.content),
        html: entry.html == null ? '' : String(entry.html),
        contentClass: entry.contentClass || '',
        markdown: !!entry.markdown,
        reasoningMode: entry.reasoningMode == null ? '' : String(entry.reasoningMode),
        reasoningSummary: entry.reasoningSummary == null ? '' : String(entry.reasoningSummary),
        citations: Array.isArray(entry.citations) ? entry.citations : [],
        retrievalStatus: entry.retrievalStatus && typeof entry.retrievalStatus === 'object' ? entry.retrievalStatus : {},
        usage: entry.usage && typeof entry.usage === 'object' ? entry.usage : {},
        streamStatus: entry.streamStatus == null ? '' : String(entry.streamStatus)
    };
    if (index >= 0) {
        _aiMessagesState[index] = Object.assign({}, _aiMessagesState[index], normalized);
    } else {
        _aiMessagesState.push(normalized);
    }
}

function updateStreamingAiState(domId, state) {
    if (!domId) return;
    var next = Object.assign({}, _aiStreamStates[domId] || {}, state || {});
    _aiStreamStates[domId] = next;
    upsertAiMessageState({
        domId: domId,
        messageId: normalizeAiMessageId(next.messageId),
        requestId: next.requestId || '',
        role: 'ai',
        content: next.answer || '',
        html: '',
        contentClass: 'ai-md',
        markdown: false,
        reasoningSummary: next.reasoning || '',
        citations: Array.isArray(next.citations) ? next.citations : [],
        retrievalStatus: next.retrievalStatus && typeof next.retrievalStatus === 'object' ? next.retrievalStatus : {},
        usage: next.usage && typeof next.usage === 'object' ? next.usage : {},
        streamStatus: next.status || 'streaming'
    });
    persistAiState();
}

function normalizeAiMessageId(messageId) {
    if (messageId == null || messageId === '') return null;
    var value = parseInt(messageId, 10);
    return isNaN(value) ? null : value;
}

function normalizeAiChatResponse(data) {
    if (typeof data === 'string') {
        return { reply: data, userMessageId: null, assistantMessageId: null, suggestedTasks: [], suggestedRoutines: [] };
    }
    data = data || {};
    return {
        reply: data.reply || data.content || '',
        userMessageId: normalizeAiMessageId(data.userMessageId),
        assistantMessageId: normalizeAiMessageId(data.assistantMessageId),
        suggestedTasks: Array.isArray(data.suggestedTasks) ? data.suggestedTasks : [],
        suggestedRoutines: Array.isArray(data.suggestedRoutines) ? data.suggestedRoutines : [],
        wikiRevision: data.wikiRevision || null,
        citations: Array.isArray(data.citations) ? data.citations : [],
        retrievalStatus: data.retrievalStatus && typeof data.retrievalStatus === 'object' ? data.retrievalStatus : {},
        usage: data.usage && typeof data.usage === 'object' ? data.usage : {},
        reasoningSummary: data.reasoningSummary || ''
    };
}

async function loadAiWorkspace() {
    await loadAiNotebooks();
}

async function loadAiNotebooks() {
    var box = document.getElementById('aiNotebookList');
    if (!box) return;
    box.innerHTML = '<div class="ai-notebook-item"><span>正在加载...</span></div>';
    try {
        var res = await api.get('/ai/notebooks');
        _aiNotebooks = res.data || [];
        if (!_selectedAiNotebookId && _aiNotebooks.length) _selectedAiNotebookId = _aiNotebooks[0].id;
        renderAiNotebooks();
        await loadAiSources();
    } catch (e) {
        box.innerHTML = '<div class="ai-notebook-item"><span>Notebook 读取失败</span></div>';
    }
}

function renderAiNotebooks() {
    var box = document.getElementById('aiNotebookList');
    if (!box) return;
    if (!_aiNotebooks.length) {
        box.innerHTML = '<div class="ai-notebook-item"><span>暂无 Notebook</span></div>';
        return;
    }
    box.innerHTML = _aiNotebooks.map(function (item) {
        var active = String(item.id) === String(_selectedAiNotebookId) ? ' active' : '';
        return '<div class="ai-notebook-item' + active + '" onclick="selectAiNotebook(' + Number(item.id) + ')">' +
            '<strong>' + escapeHtml(item.title || 'Notebook') + '</strong>' +
            '<span>' + escapeHtml((item.sourceCount || 0) + ' 个资料源') + '</span>' +
            '</div>';
    }).join('');
}

async function createAiNotebook() {
    var title = prompt('Notebook 名称', '新的 Notebook');
    if (!title) return;
    try {
        var res = await api.post('/ai/notebooks', { title: title });
        _selectedAiNotebookId = res.data && res.data.id;
        await loadAiNotebooks();
    } catch (e) {
        if (typeof showToast === 'function') showToast(e.message || '创建失败', 'error');
    }
}

async function selectAiNotebook(id) {
    _selectedAiNotebookId = id;
    renderAiNotebooks();
    await loadAiSources();
}

async function loadAiSources() {
    var box = document.getElementById('aiSourceList');
    if (!box) return;
    if (!_selectedAiNotebookId) {
        box.innerHTML = '<div class="ai-source-item"><span>请选择 Notebook</span></div>';
        return;
    }
    box.innerHTML = '<div class="ai-source-item"><span>正在加载资料...</span></div>';
    try {
        var res = await api.get('/ai/notebooks/' + _selectedAiNotebookId + '/sources');
        _aiSources = res.data || [];
        renderAiSources();
    } catch (e) {
        box.innerHTML = '<div class="ai-source-item"><span>资料读取失败</span></div>';
    }
}

function renderAiSources() {
    var box = document.getElementById('aiSourceList');
    if (!box) return;
    if (!_aiSources.length) {
        box.innerHTML = '<div class="ai-source-item"><span>上传文件或添加 URL 后，可作为 AI 上下文。</span></div>';
        return;
    }
    box.innerHTML = _aiSources.map(function (item) {
        var status = String(item.status || 'UPLOADED').toUpperCase();
        var meta = item.parseError ? item.parseError : ((item.chunkCount || 0) + ' 个片段');
        return '<div class="ai-source-item">' +
            '<strong>' + escapeHtml(item.title || '资料') + '</strong>' +
            '<span>' + escapeHtml(item.sourceType || '') + ' · ' + escapeHtml(meta) + '</span>' +
            '<em class="ai-source-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</em>' +
            '</div>';
    }).join('');
}

async function uploadAiNotebookSource(file) {
    if (!file || !_selectedAiNotebookId) return;
    try {
        await api.upload('/ai/notebooks/' + _selectedAiNotebookId + '/sources/upload', file);
        await loadAiSources();
        if (typeof showToast === 'function') showToast('资料已加入 Notebook', 'success');
    } catch (e) {
        if (typeof showToast === 'function') showToast(e.message || '上传失败', 'error');
    }
}

async function addAiUrlSource() {
    if (!_selectedAiNotebookId) return;
    var url = prompt('输入网页 URL（http/https）');
    if (!url) return;
    try {
        await api.post('/ai/notebooks/' + _selectedAiNotebookId + '/sources', { sourceType: 'WEB_URL', url: url, title: url });
        await loadAiSources();
        if (typeof showToast === 'function') showToast('URL 已加入 Notebook', 'success');
    } catch (e) {
        if (typeof showToast === 'function') showToast(e.message || '添加失败', 'error');
    }
}

function getAiContextOptions() {
    var readySourceIds = (_aiSources || [])
        .filter(function (item) { return String(item.status || '').toUpperCase() === 'READY'; })
        .map(function (item) { return item.id; });
    return {
        notebookOnly: true,
        includeWiki: false,
        allowWebSearch: isAiToggleEnabled('aiWebSearchToggle'),
        selectedSourceIds: readySourceIds,
        selectedWikiPageIds: []
    };
}

function getAiAgentModeForMessage(message) {
    var text = String(message || '').toLowerCase();
    if (text.indexOf('计划') >= 0 || text.indexOf('任务') >= 0 || text.indexOf('plan') >= 0) return 'PLAN';
    if (isAiToggleEnabled('aiWebSearchToggle') || (_aiSources || []).some(function (item) { return String(item.status || '').toUpperCase() === 'READY'; })) return 'RESEARCH';
    return 'AUTO';
}

function handleAiAgentStepEvent(data) {
    if (!data) return;
    if (data.agentRunId || data.runId) _currentAgentRunId = data.agentRunId || data.runId;
    var box = document.getElementById('aiAgentTimeline');
    if (!box) return;
    var stepId = data.stepId ? String(data.stepId) : (String(data.agentType || 'STEP') + '-' + String(data.stepOrder || 0));
    var existing = box.querySelector('[data-step-id="' + stepId + '"]');
    var html = renderAiAgentStep(data);
    if (existing) existing.outerHTML = html;
    else box.insertAdjacentHTML('beforeend', html);
}

function handleAiAgentTaskEvent(data) {
    if (!data) return;
    if (data.agentRunId || data.runId) _currentAgentRunId = data.agentRunId || data.runId;
    var box = document.getElementById('aiAgentTimeline');
    if (!box) return;
    var taskId = data.taskId ? String(data.taskId) : (String(data.agentType || 'TASK') + '-' + String(data.taskType || ''));
    var existing = box.querySelector('[data-task-id="' + taskId + '"]');
    var html = renderAiAgentTask(data);
    if (existing) existing.outerHTML = html;
    else box.insertAdjacentHTML('beforeend', html);
}

function renderAiAgentTimeline(steps, tasks) {
    var box = document.getElementById('aiAgentTimeline');
    if (!box) return;
    tasks = Array.isArray(tasks) ? tasks : [];
    steps = Array.isArray(steps) ? steps : [];
    if (tasks.length) {
        box.innerHTML = tasks.map(renderAiAgentTask).join('');
        if (steps.length) {
            box.insertAdjacentHTML('beforeend', '<div class="ai-agent-subtitle">Steps</div>' + steps.map(renderAiAgentStep).join(''));
        }
        return;
    }
    box.innerHTML = steps.length ? steps.map(renderAiAgentStep).join('') : '<div class="ai-agent-step"><span>暂无执行轨迹</span></div>';
}

function renderAiAgentTask(task) {
    var status = String(task.status || 'PENDING').toUpperCase();
    var taskId = task.taskId || task.id || (String(task.agentType || 'TASK') + '-' + String(task.taskType || ''));
    return '<div class="ai-agent-step ai-agent-task" data-task-id="' + escapeHtml(taskId) + '">' +
        '<strong>' + escapeHtml(task.agentType || 'TASK') + '</strong>' +
        '<span>' + escapeHtml(task.publicSummary || task.public_summary || task.taskType || '') + '</span>' +
        '<em class="ai-agent-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</em>' +
        '</div>';
}

function renderAiAgentStep(step) {
    var status = String(step.status || 'PENDING').toUpperCase();
    var stepId = step.stepId || step.id || (String(step.agentType || 'STEP') + '-' + String(step.stepOrder || 0));
    return '<div class="ai-agent-step" data-step-id="' + escapeHtml(stepId) + '">' +
        '<strong>' + escapeHtml(step.agentType || 'STEP') + '</strong>' +
        '<span>' + escapeHtml(step.publicSummary || step.public_summary || '') + '</span>' +
        '<em class="ai-agent-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</em>' +
        '</div>';
}

function handleAiArtifactEvent(data) {
    if (!data) return;
    if (data.agentRunId || data.runId) _currentAgentRunId = data.agentRunId || data.runId;
    var box = document.getElementById('aiArtifactList');
    if (!box) return;
    var id = data.artifactId || data.id;
    if (!id) return;
    var existing = box.querySelector('[data-artifact-id="' + id + '"]');
    var html = renderAiArtifact({ id: id, artifactType: data.artifactType, title: data.title, status: data.status || 'DRAFT', content: {} });
    if (existing) existing.outerHTML = html;
    else box.insertAdjacentHTML('beforeend', html);
}

async function loadAiAgentRun(runId) {
    if (!runId) return;
    try {
        var res = await api.get('/ai/agent-runs/' + runId);
        var run = res.data || {};
        renderAiAgentTimeline(run.steps || [], run.tasks || []);
        renderAiArtifacts(run.artifacts || [], run.claims || [], run.evidence || [], run.verifierFindings || []);
    } catch (e) {
        // Keep live stream state if detail loading fails.
    }
}

function renderAiArtifacts(artifacts, claims, evidence, findings) {
    var box = document.getElementById('aiArtifactList');
    if (!box) return;
    artifacts = Array.isArray(artifacts) ? artifacts : [];
    claims = Array.isArray(claims) ? claims : [];
    evidence = Array.isArray(evidence) ? evidence : [];
    findings = Array.isArray(findings) ? findings : [];
    var html = '';
    if (artifacts.length) html += '<div class="ai-artifact-group-title">Artifacts</div>' + artifacts.map(renderAiArtifact).join('');
    if (claims.length) html += '<div class="ai-artifact-group-title">Claims</div>' + claims.map(renderAiClaim).join('');
    if (evidence.length) html += '<div class="ai-artifact-group-title">Evidence</div>' + evidence.map(renderAiEvidence).join('');
    if (findings.length) html += '<div class="ai-artifact-group-title">Verifier</div>' + findings.map(renderAiVerifierFinding).join('');
    box.innerHTML = html || '<div class="ai-artifact-item"><span>暂无产物</span></div>';
}

function renderAiArtifact(item) {
    var status = String(item.status || 'DRAFT').toUpperCase();
    var type = item.artifactType || item.artifact_type || 'ARTIFACT';
    var content = item.content || {};
    var snippet = content.snippet || content.content || content.markdown || '';
    var actions = status === 'DRAFT'
        ? '<div class="ai-artifact-actions"><button class="primary" onclick="confirmAiArtifact(' + Number(item.id) + ')">确认</button><button onclick="discardAiArtifact(' + Number(item.id) + ')">忽略</button></div>'
        : '';
    return '<div class="ai-artifact-item" data-artifact-id="' + escapeHtml(item.id) + '">' +
        '<strong>' + escapeHtml(item.title || type) + '</strong>' +
        '<span>' + escapeHtml(type) + (snippet ? ' · ' + escapeHtml(String(snippet).slice(0, 80)) : '') + '</span>' +
        '<em class="ai-artifact-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</em>' +
        actions +
        '</div>';
}

function renderAiClaim(item) {
    return '<div class="ai-artifact-item ai-claim-item">' +
        '<strong>' + escapeHtml(item.claimType || 'CLAIM') + '</strong>' +
        '<span>' + escapeHtml(String(item.content || '').slice(0, 140)) + '</span>' +
        '</div>';
}

function renderAiEvidence(item) {
    return '<div class="ai-artifact-item ai-evidence-item">' +
        '<strong>' + escapeHtml(item.sourceType || 'EVIDENCE') + '</strong>' +
        '<span>' + escapeHtml(String(item.snippet || '').slice(0, 140)) + '</span>' +
        '</div>';
}

function renderAiVerifierFinding(item) {
    var status = String(item.severity || 'INFO').toUpperCase();
    return '<div class="ai-artifact-item ai-finding-item">' +
        '<strong>' + escapeHtml(item.code || 'FINDING') + '</strong>' +
        '<span>' + escapeHtml(String(item.message || '').slice(0, 140)) + '</span>' +
        '<em class="ai-artifact-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</em>' +
        '</div>';
}

async function confirmAiArtifact(id) {
    try {
        await api.post('/ai/artifacts/' + id + '/confirm', {});
        if (_currentAgentRunId) await loadAiAgentRun(_currentAgentRunId);
        if (typeof showToast === 'function') showToast('已确认', 'success');
    } catch (e) {
        if (typeof showToast === 'function') showToast(e.message || '确认失败', 'error');
    }
}

async function discardAiArtifact(id) {
    try {
        await api.post('/ai/artifacts/' + id + '/discard', {});
        if (_currentAgentRunId) await loadAiAgentRun(_currentAgentRunId);
    } catch (e) {
        if (typeof showToast === 'function') showToast(e.message || '操作失败', 'error');
    }
}

async function sendAiMessage() {
    var input = document.getElementById('aiInput');
    if (!input) return;
    var message = input.value.trim();
    if (!message) return;

    var userDomId = appendMessage('user', escapeHtml(message), '', message, false);
    input.value = '';
    persistAiState();

    var aiDomId = appendMessage('ai',
        '<div class="ai-stream-answer"><span class="ai-thinking">Thinking...</span></div>' +
        '<div class="ai-stream-extra" data-stream-extra></div>',
        'ai-md ai-streaming',
        '',
        false,
        { transient: true });

    try {
        await streamAiChat(message, userDomId, aiDomId);
    } catch (e) {
        if (_activeAiStream && _activeAiStream.domId === aiDomId) {
            _activeAiStream = null;
        }
        if (isAiRequestInterruptedByPageLeave(e)) {
            persistAiState();
            return;
        }
        renderAiStreamError(aiDomId, e && e.message ? e.message : '请检查 AI 配置');
        persistAiState();
    }
}

async function streamAiChat(message, userDomId, aiDomId) {
    var controller = new AbortController();
    _activeAiStream = {
        domId: aiDomId,
        requestId: null,
        assistantMessageId: null,
        controller: controller
    };
    var response = await fetch('/api/ai/chat/stream', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(getAuthToken() ? { Authorization: 'Bearer ' + getAuthToken() } : {})
        },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({
            message: message,
            modelConfigId: getSelectedAiModelId(),
            enableWebSearch: isAiToggleEnabled('aiWebSearchToggle'),
            reasoningMode: isAiToggleEnabled('aiReasoningToggle') ? 'DEEP' : 'OFF',
            notebookId: _selectedAiNotebookId,
            agentMode: getAiAgentModeForMessage(message),
            contextOptions: getAiContextOptions()
        })
    });
    if (response.status === 401 || response.status === 403) {
        clearAuthState?.();
        window.location.href = '/index.html';
        throw new Error('Unauthorized');
    }
    if (!response.ok || !response.body) {
        throw new Error('Stream request failed');
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    var reply = '';
    var reasoning = '';
    var citations = [];
    var retrievalStatus = {};
    var usage = {};
    var doneData = {};
    updateStreamingAiState(aiDomId, {
        answer: '',
        reasoning: '',
        citations: [],
        retrievalStatus: {},
        usage: {},
        status: 'streaming',
        requestId: null,
        messageId: null
    });

    while (true) {
        var read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        var split = buffer.split(/\r?\n\r?\n/);
        buffer = split.pop() || '';
        split.forEach(function (chunk) {
            var event = parseSseChunk(chunk);
            if (!event) return;
            if (!shouldAcceptAiStreamEvent(event, aiDomId)) return;
            if (event.name === 'agent.run.start') {
                var runStart = event.dataObject || tryParseJson(event.dataText) || {};
                _currentAgentRunId = runStart.agentRunId || runStart.runId || null;
                renderAiAgentTimeline([{ agentType: 'RUN', status: runStart.status || 'RUNNING', publicSummary: 'AgentRun 已启动' }]);
            } else if (event.name === 'agent.task.created' || event.name === 'agent.task.start' || event.name === 'agent.task.done' || event.name === 'agent.task.error') {
                handleAiAgentTaskEvent(event.dataObject || tryParseJson(event.dataText) || {});
            } else if (event.name === 'agent.step.start' || event.name === 'agent.step.done') {
                handleAiAgentStepEvent(event.dataObject || tryParseJson(event.dataText) || {});
            } else if (event.name === 'artifact.created') {
                handleAiArtifactEvent(event.dataObject || tryParseJson(event.dataText) || {});
            } else if (event.name === 'claim.created' || event.name === 'evidence.created' || event.name === 'verifier.finding') {
                if (_currentAgentRunId) loadAiAgentRun(_currentAgentRunId);
            } else if (event.name === 'stream.start') {
                var startData = event.dataObject || tryParseJson(event.dataText) || {};
                _currentAgentRunId = startData.agentRunId || _currentAgentRunId;
                setMessagePersistedId(userDomId, startData.userMessageId);
                setMessagePersistedId(aiDomId, startData.assistantMessageId);
                setMessageRequestId(aiDomId, startData.requestId);
                updateStreamingAiState(aiDomId, {
                    answer: reply,
                    reasoning: reasoning,
                    citations: citations,
                    retrievalStatus: retrievalStatus,
                    usage: usage,
                    status: 'streaming',
                    requestId: startData.requestId || '',
                    messageId: startData.assistantMessageId
                });
            } else if (event.name === 'message.delta') {
                reply += getSseTextPayload(event);
                renderStreamingAiMessage(aiDomId, reply, reasoning, citations, { streaming: true });
                updateStreamingAiState(aiDomId, { answer: reply, reasoning: reasoning, citations: citations, retrievalStatus: retrievalStatus, usage: usage, status: 'streaming', requestId: _activeAiStream && _activeAiStream.requestId || '', messageId: _activeAiStream && _activeAiStream.assistantMessageId });
            } else if (event.name === 'reasoning.delta') {
                reasoning += getSseTextPayload(event);
                renderStreamingAiMessage(aiDomId, reply, reasoning, citations, { streaming: true });
                updateStreamingAiState(aiDomId, { answer: reply, reasoning: reasoning, citations: citations, retrievalStatus: retrievalStatus, usage: usage, status: 'streaming', requestId: _activeAiStream && _activeAiStream.requestId || '', messageId: _activeAiStream && _activeAiStream.assistantMessageId });
            } else if (event.name === 'citation') {
                var citation = event.dataObject || tryParseJson(event.dataText);
                if (citation) {
                    citations.push(citation);
                    renderStreamingAiMessage(aiDomId, reply, reasoning, citations, { streaming: true });
                    updateStreamingAiState(aiDomId, { answer: reply, reasoning: reasoning, citations: citations, retrievalStatus: retrievalStatus, usage: usage, status: 'streaming', requestId: _activeAiStream && _activeAiStream.requestId || '', messageId: _activeAiStream && _activeAiStream.assistantMessageId });
                }
            } else if (event.name === 'retrieval.status') {
                retrievalStatus = event.dataObject || tryParseJson(event.dataText) || {};
                updateStreamingAiState(aiDomId, { answer: reply, reasoning: reasoning, citations: citations, retrievalStatus: retrievalStatus, usage: usage, status: 'streaming', requestId: _activeAiStream && _activeAiStream.requestId || '', messageId: _activeAiStream && _activeAiStream.assistantMessageId });
            } else if (event.name === 'usage') {
                usage = event.dataObject || tryParseJson(event.dataText) || {};
                updateStreamingAiState(aiDomId, { answer: reply, reasoning: reasoning, citations: citations, retrievalStatus: retrievalStatus, usage: usage, status: 'streaming', requestId: _activeAiStream && _activeAiStream.requestId || '', messageId: _activeAiStream && _activeAiStream.assistantMessageId });
            } else if (event.name === 'done') {
                doneData = event.dataObject || tryParseJson(event.dataText) || {};
                shouldAcceptAiStreamEvent({ name: 'done', dataObject: doneData, dataText: event.dataText }, aiDomId);
            } else if (event.name === 'error') {
                var errorData = event.dataObject || tryParseJson(event.dataText) || {};
                var streamError = new Error(errorData.message || event.dataText || 'AI stream error');
                streamError.nonRetryable = errorData.nonRetryable === true;
                streamError.requestId = errorData.requestId || (_activeAiStream && _activeAiStream.requestId) || '';
                streamError.assistantMessageId = normalizeAiMessageId(errorData.assistantMessageId || (_activeAiStream && _activeAiStream.assistantMessageId));
                setMessagePersistedId(userDomId, errorData.userMessageId);
                setMessagePersistedId(aiDomId, streamError.assistantMessageId);
                setMessageRequestId(aiDomId, streamError.requestId);
                renderAiStreamError(aiDomId, streamError.message);
                updateStreamingAiState(aiDomId, {
                    answer: reply,
                    reasoning: reasoning,
                    citations: citations,
                    retrievalStatus: retrievalStatus,
                    usage: usage,
                    status: 'error',
                    requestId: streamError.requestId,
                    messageId: streamError.assistantMessageId
                });
                throw streamError;
            }
        });
    }
    if (buffer.trim()) {
        var tail = parseSseChunk(buffer);
        if (tail && tail.name === 'done' && shouldAcceptAiStreamEvent(tail, aiDomId)) {
            doneData = tail.dataObject || tryParseJson(tail.dataText) || {};
        }
    }

    if (doneData.reply && !reply) reply = doneData.reply;
    if (doneData.reasoningSummary && !reasoning) reasoning = doneData.reasoningSummary;
    if (Array.isArray(doneData.citations) && !citations.length) citations = doneData.citations;
    if (doneData.retrievalStatus) retrievalStatus = doneData.retrievalStatus;
    if (doneData.usage) usage = doneData.usage;
    if (doneData.agentRunId) {
        _currentAgentRunId = doneData.agentRunId;
    }

    var chatData = normalizeAiChatResponse({
        reply: reply,
        userMessageId: doneData.userMessageId,
        assistantMessageId: doneData.assistantMessageId,
        suggestedTasks: doneData.suggestedTasks,
        suggestedRoutines: doneData.suggestedRoutines,
        wikiRevision: doneData.wikiRevision,
        citations: citations,
        reasoningSummary: reasoning,
        retrievalStatus: retrievalStatus,
        usage: usage
    });
    setMessagePersistedId(userDomId, chatData.userMessageId);
    setMessagePersistedId(aiDomId, chatData.assistantMessageId);
    renderStreamingAiMessage(aiDomId, chatData.reply, chatData.reasoningSummary, chatData.citations, { streaming: false });
    if (_currentAgentRunId) {
        loadAiAgentRun(_currentAgentRunId);
    }
    var aiEl = document.getElementById(aiDomId);
    if (aiEl) {
        var content = aiEl.querySelector('.ai-msg-content');
        if (content) {
            content.classList.remove('ai-streaming');
            updateStreamingAiState(aiDomId, {
                answer: chatData.reply,
                reasoning: chatData.reasoningSummary,
                citations: chatData.citations,
                retrievalStatus: chatData.retrievalStatus,
                usage: chatData.usage,
                status: 'done',
                requestId: doneData.requestId || (_activeAiStream && _activeAiStream.requestId) || '',
                messageId: chatData.assistantMessageId
            });
        }
    }
    handleAiChatExtras(chatData);
    persistAiState();
    if (_activeAiStream && _activeAiStream.domId === aiDomId) {
        _activeAiStream = null;
    }
}

function handleAiChatExtras(chatData) {
    if (chatData.wikiRevision) {
        openAiWikiDraftModal(chatData.wikiRevision);
    }
    if (chatData.suggestedTasks.length || chatData.suggestedRoutines.length) {
        aiAnalyzedTasks = chatData.suggestedTasks;
        aiAnalyzedRoutines = chatData.suggestedRoutines;
        renderTaskConfirmList(aiAnalyzedTasks, aiAnalyzedRoutines);
        var planSummary = buildAiPlanSummary(aiAnalyzedTasks.length, aiAnalyzedRoutines.length);
        appendMessage(
            'ai',
            '我已经把这版计划整理好了：' + planSummary.html + '。右侧可以过目、微调时间和提醒，确认后再写入学习系统。',
            'ai-md',
            '我已经把这版计划整理好了：' + planSummary.text + '。右侧可以过目、微调时间和提醒，确认后再写入学习系统。',
            false
        );
    }
}

function renderStreamingAiMessage(domId, reply, reasoning, citations, options) {
    var el = document.getElementById(domId);
    if (!el) return;
    var content = el.querySelector('.ai-msg-content');
    if (!content) return;
    var openState = getAiCollapsibleOpenState(content);
    var opts = options || {};
    content.innerHTML = renderMarkdown(reply || '', { streaming: opts.streaming === true }) +
        renderAiReasoningSummary(reasoning || '', openState.reasoning) +
        renderAiCitations(citations || [], openState.citations) +
        renderAiCitationFailures(citations || [], openState.failures);
    scrollAiToLatest(false);
}

function renderAiStreamError(domId, message) {
    var el = document.getElementById(domId);
    if (!el) return;
    var content = el.querySelector('.ai-msg-content');
    if (!content) return;
    content.classList.remove('ai-streaming');
    content.innerHTML = renderAiStatusNotice('请求失败：' + (message || '请检查 AI 配置'), 'error');
    scrollAiToLatest(false);
}

function parseSseChunk(chunk) {
    var eventName = 'message';
    var dataLines = [];
    String(chunk || '').split(/\r?\n/).forEach(function (line) {
        if (line.indexOf('event:') === 0) {
            eventName = line.slice(6).trim();
        } else if (line.indexOf('data:') === 0) {
            dataLines.push(line.slice(5).trimStart());
        }
    });
    var dataText = dataLines.join('\n');
    return {
        name: eventName,
        dataText: dataText,
        dataObject: tryParseJson(dataText)
    };
}

function shouldAcceptAiStreamEvent(event, domId) {
    if (!_activeAiStream || _activeAiStream.domId !== domId) return false;
    var payload = event && (event.dataObject || tryParseJson(event.dataText) || {});
    var requestId = payload && payload.requestId ? String(payload.requestId) : '';
    var assistantMessageId = normalizeAiMessageId(payload && payload.assistantMessageId);
    if (requestId) {
        if (_activeAiStream.requestId && _activeAiStream.requestId !== requestId) return false;
        _activeAiStream.requestId = requestId;
    }
    if (assistantMessageId != null) {
        if (_activeAiStream.assistantMessageId != null && _activeAiStream.assistantMessageId !== assistantMessageId) return false;
        _activeAiStream.assistantMessageId = assistantMessageId;
    }
    return true;
}

function tryParseJson(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

function getSseTextPayload(event) {
    if (event && event.dataObject && typeof event.dataObject.text === 'string') {
        return event.dataObject.text;
    }
    return event ? (event.dataText || '') : '';
}

function normalizeAiCitations(citations) {
    return Array.isArray(citations) ? citations.filter(Boolean) : [];
}

function getAiCitationStatus(item) {
    return String(item && item.status || '').trim().toUpperCase();
}

function isSuccessfulAiCitation(item) {
    var status = getAiCitationStatus(item);
    return !status || status === 'OK' || status === 'SUCCESS';
}

function renderAiCitations(citations, open) {
    var rows = normalizeAiCitations(citations).filter(isSuccessfulAiCitation);
    if (!rows.length) return '';
    return '<details class="ai-collapsible ai-citations"' + (open ? ' open' : '') + '>' +
        '<summary><span>来源引用</span><em>' + rows.length + '</em></summary>' +
        '<ol class="ai-citations-list">' +
        rows.map(function (item) {
            var url = String(item.url || '').trim();
            var status = escapeHtml(item.sourceType || item.status || '');
            var title = escapeHtml(item.title || url || '来源');
            var snippet = escapeHtml(item.snippet || '');
            if (!/^https?:\/\//i.test(url)) {
                return '<li><strong>' + title + '</strong><small>' + status + '</small><span>' + snippet + '</span></li>';
            }
            return '<li><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' +
                title +
                '</a><small>' + status + '</small><span>' + snippet + '</span></li>';
        }).join('') +
        '</ol></details>';
}

function renderAiCitationFailures(citations, open) {
    var rows = normalizeAiCitations(citations).filter(function (item) {
        return !isSuccessfulAiCitation(item);
    });
    if (!rows.length) return '';
    return '<details class="ai-collapsible ai-citation-failures"' + (open ? ' open' : '') + '>' +
        '<summary><span>抓取失败</span><em>' + rows.length + '</em></summary>' +
        '<ol class="ai-citations-list ai-citation-failure-list">' +
        rows.map(function (item) {
            var url = String(item.url || '').trim();
            var status = escapeHtml(item.status || 'FAILED');
            var title = escapeHtml(item.title || url || '网页');
            var snippet = escapeHtml(item.snippet || '网页可能限制访问、超时、需要登录、依赖 JS 渲染，或被安全策略拦截。');
            var titleHtml = /^https?:\/\//i.test(url)
                ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + title + '</a>'
                : '<strong>' + title + '</strong>';
            return '<li>' + titleHtml + '<small>' + status + '</small><span>' + snippet + '</span></li>';
        }).join('') +
        '</ol></details>';
}

function renderAiReasoningSummary(summary, open) {
    if (!summary) return '';
    return '<details class="ai-collapsible ai-reasoning-summary"' + (open ? ' open' : '') + '>' +
        '<summary><span>思考摘要</span></summary>' +
        '<p>' + escapeHtml(summary) + '</p>' +
        '</details>';
}

function renderAiStreamInterruptedNotice() {
    return '<div class="ai-stream-interrupted">上次回答在完成前中断了，可以重新发送这条问题。</div>';
}

function getAiCollapsibleOpenState(container) {
    return {
        reasoning: !!(container && container.querySelector('.ai-reasoning-summary[open]')),
        citations: !!(container && container.querySelector('.ai-citations[open]')),
        failures: !!(container && container.querySelector('.ai-citation-failures[open]'))
    };
}

function isAiToggleEnabled(id) {
    return document.getElementById(id)?.getAttribute('aria-pressed') === 'true';
}

function bindAiFeatureToggles() {
    ['aiWebSearchToggle', 'aiReasoningToggle'].forEach(function (id) {
        var btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', function () {
            var active = btn.getAttribute('aria-pressed') === 'true';
            btn.setAttribute('aria-pressed', active ? 'false' : 'true');
        });
    });
}

function setMessagePersistedId(domId, messageId) {
    var normalized = normalizeAiMessageId(messageId);
    if (!domId || normalized == null) return;
    var el = document.getElementById(domId);
    if (el) {
        el.setAttribute('data-message-id', String(normalized));
    }
    _aiMessagesState.forEach(function (entry) {
        if (entry.domId === domId) {
            entry.messageId = normalized;
        }
    });
    persistAiState();
}

function setMessageRequestId(domId, requestId) {
    if (!domId || !requestId) return;
    var value = String(requestId);
    var el = document.getElementById(domId);
    if (el) {
        el.setAttribute('data-request-id', value);
    }
    _aiMessagesState.forEach(function (entry) {
        if (entry.domId === domId) {
            entry.requestId = value;
        }
    });
    var streamState = _aiStreamStates[domId];
    if (streamState) {
        streamState.requestId = value;
    }
    persistAiState();
}

function removeAiMessageState(domId, messageId) {
    var normalized = normalizeAiMessageId(messageId);
    _aiMessagesState = _aiMessagesState.filter(function (entry) {
        if (domId && entry.domId === domId) return false;
        if (normalized != null && normalizeAiMessageId(entry.messageId) === normalized) return false;
        return true;
    });
}

function scrollAiToLatest(includePage) {
    window.requestAnimationFrame(function () {
        var container = document.getElementById('aiMessages');
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
        if (includePage) {
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
            var input = document.getElementById('aiInput');
            if (input) input.focus({ preventScroll: true });
        }
    });
}

function htmlToPlainText(html) {
    var div = document.createElement('div');
    div.innerHTML = String(html || '');
    return div.textContent || div.innerText || '';
}

function isAiRequestInterruptedByPageLeave(error) {
    if (!_aiPageLeaving) return false;
    var message = String(error && (error.message || error.name) || '').toLowerCase();
    return !message ||
        message.indexOf('failed to fetch') !== -1 ||
        message.indexOf('abort') !== -1 ||
        message.indexOf('networkerror') !== -1 ||
        message.indexOf('load failed') !== -1;
}

function isDiscardableFetchAbortMessage(entry) {
    if (!entry || entry.role !== 'ai') return false;
    return isFailedFetchOnlyMessage(entry.content) ||
        isFailedFetchOnlyMessage(htmlToPlainText(entry.html || ''));
}

function isFailedFetchOnlyMessage(text) {
    return /^\s*❌?\s*failed to fetch\s*$/i.test(String(text || '').trim());
}

/* ── 追加消息，返回元素 id ── */
function appendMessage(role, htmlContent, contentClass, rawContent, markdown, options) {
    var container = document.getElementById('aiMessages');
    if (!container) return null;
    var opts = options || {};

    var id = 'ai-msg-' + (++_msgIdCounter);
    var msg = document.createElement('div');
    msg.id = id;
    msg.className = 'ai-msg ai-msg-' + role;
    msg.setAttribute('data-message-dom-id', id);
    var messageId = normalizeAiMessageId(opts.messageId);
    if (messageId != null) {
        msg.setAttribute('data-message-id', String(messageId));
    }
    if (opts.requestId) {
        msg.setAttribute('data-request-id', String(opts.requestId));
    }

    var avatar = role === 'user' ? '我' : 'AI';
    var extraClass = contentClass ? ' ' + contentClass : '';
    msg.innerHTML =
        '<div class="ai-msg-avatar">' + avatar + '</div>' +
        '<div class="ai-msg-content' + extraClass + '">' + htmlContent + '</div>';

    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    if (!_aiRestoringState && !opts.skipState && !opts.transient) {
        storeAiMessageState(role, htmlContent, contentClass, rawContent, markdown, messageId, id, opts.status);
        if (opts.requestId) {
            setMessageRequestId(id, opts.requestId);
        }
    }
    persistAiState();
    return id;
}

/* ── 追加思考中占位 ── */
function appendThinking(text) {
    return appendMessage('ai',
        '<span class="ai-thinking">' + (text || '思考中...') + '</span>',
        '',
        '',
        false,
        { transient: true });
}

/* ── 移除指定 id 的消息 ── */
function removeMessage(id) {
    if (!id) return;
    var el = document.getElementById(id);
    if (el) {
        removeAiMessageState(id, el.getAttribute('data-message-id'));
        el.remove();
        persistAiState();
    }
}

/* ── HTML 转义 ── */
function escapeHtml(str) {
    if (str == null) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

/* ── 安全 Markdown 渲染：先转义 HTML，再渲染常用 Markdown ── */
function normalizeAssistantMarkdownBreaks(markdown) {
    return String(markdown || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/&lt;br\s*\/?&gt;/gi, '\n');
}

function renderMarkdown(markdown, options) {
    var opts = options || {};
    var normalizedMarkdown = normalizeAssistantMarkdownBreaks(markdown);
    if (opts.streaming) {
        var split = splitStreamingMarkdown(normalizedMarkdown);
        return renderMarkdownCore(split.stable) + renderStreamingMarkdownTail(split.tail);
    }
    return renderMarkdownCore(normalizedMarkdown);
}

function renderMarkdownCore(markdown) {
    var text = canonicalizeModelMarkdown(normalizeLooseMarkdown(normalizeAssistantMarkdownBreaks(markdown)));
    var lines = text.split('\n');
    var html = [];
    var paragraph = [];
    var inCode = false;
    var codeLang = '';
    var codeLines = [];
    var listType = null;
    var lastListItemCanContinue = false;

    function flushParagraph() {
        if (paragraph.length) {
            html.push('<p>' + paragraph.map(renderInlineMarkdown).join('<br>') + '</p>');
            paragraph = [];
        }
    }

    function closeList() {
        if (listType) {
            html.push('</' + listType + '>');
            listType = null;
        }
        lastListItemCanContinue = false;
    }

    function openList(type) {
        if (listType !== type) {
            closeList();
            html.push('<' + type + '>');
            listType = type;
        }
    }

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var fence = line.match(/^```([A-Za-z0-9_+#.-]*)\s*$/);
        if (fence) {
            if (inCode) {
                html.push(
                    '<pre class="ai-md-code"><code' +
                    (codeLang ? ' class="language-' + escapeHtml(codeLang) + '"' : '') +
                    '>' + escapeHtml(codeLines.join('\n')) + '</code></pre>'
                );
                inCode = false;
                codeLang = '';
                codeLines = [];
            } else {
                flushParagraph();
                closeList();
                inCode = true;
                codeLang = fence[1] || '';
                codeLines = [];
            }
            continue;
        }

        if (inCode) {
            codeLines.push(line);
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            closeList();
            continue;
        }

        var modelTable = readModelMarkdownTableBlock(lines, i);
        if (modelTable) {
            flushParagraph();
            closeList();
            html.push(renderMarkdownTable(modelTable.headers, modelTable.alignments, modelTable.rows));
            i = modelTable.endIndex;
            continue;
        }

        var studyPhaseTable = readStudyPhaseTable(lines, i);
        if (studyPhaseTable) {
            flushParagraph();
            closeList();
            html.push(renderMarkdownTable(studyPhaseTable.headers, studyPhaseTable.alignments, studyPhaseTable.rows));
            i = studyPhaseTable.endIndex;
            continue;
        }

        var dateRangeTable = readDateRangeTable(lines, i);
        if (dateRangeTable) {
            flushParagraph();
            closeList();
            html.push(renderMarkdownTable(dateRangeTable.headers, dateRangeTable.alignments, dateRangeTable.rows));
            i = dateRangeTable.endIndex;
            continue;
        }

        var flexibleTable = readFlexibleMarkdownTable(lines, i);
        if (flexibleTable) {
            flushParagraph();
            closeList();
            html.push(renderMarkdownTable(flexibleTable.headers, flexibleTable.alignments, flexibleTable.rows));
            i = flexibleTable.endIndex;
            continue;
        }

        var nextLine = lines[i + 1] || '';
        if (isMarkdownTableRow(line) && isMarkdownTableSeparator(nextLine)) {
            flushParagraph();
            closeList();
            var headers = parseMarkdownTableRow(line);
            var alignments = parseMarkdownTableAlignments(nextLine);
            var rows = [];
            var columnCount = headers.length;
            i += 2;
            while (i < lines.length && isMarkdownTableRow(lines[i])) {
                var row = parseMarkdownTableRow(lines[i]);
                if (shouldAppendTableContinuation(row, columnCount, rows)) {
                    appendTableContinuation(rows[rows.length - 1], row);
                } else {
                    rows.push(row);
                }
                i++;
            }
            i--;
            if (!rows.length) {
                paragraph.push(line.trim());
                paragraph.push(nextLine.trim());
                continue;
            }
            html.push(renderMarkdownTable(headers, alignments, rows));
            continue;
        }

        var heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            flushParagraph();
            closeList();
            var level = Math.min(6, heading[1].length);
            html.push('<h' + level + '>' + renderInlineMarkdown(heading[2]) + '</h' + level + '>');
            continue;
        }

        if (/^\s*[-*_]{2,}\s*$/.test(line)) {
            flushParagraph();
            closeList();
            html.push('<hr>');
            continue;
        }

        var quote = line.match(/^\s*>\s?(.+)$/);
        if (quote) {
            flushParagraph();
            closeList();
            html.push('<blockquote>' + renderInlineMarkdown(quote[1]) + '</blockquote>');
            continue;
        }

        if (isBareTaskListLine(line)) {
            flushParagraph();
            openList('ul');
            html.push(renderTaskListItem(parseTaskListMarkdown(line)));
            lastListItemCanContinue = true;
            continue;
        }

        if (isLooseUnorderedListLine(line)) {
            flushParagraph();
            openList('ul');
            html.push('<li>' + renderInlineMarkdown(stripLooseUnorderedListMarker(line)) + '</li>');
            lastListItemCanContinue = false;
            continue;
        }

        var ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
        if (ordered) {
            flushParagraph();
            openList('ol');
            html.push('<li>' + renderInlineMarkdown(ordered[1]) + '</li>');
            lastListItemCanContinue = false;
            continue;
        }

        if (listType === 'ul' && lastListItemCanContinue && isTaskListContinuationLine(line, lines[i + 1] || '')) {
            html[html.length - 1] = html[html.length - 1].replace('</li>', '<br>' + renderInlineMarkdown(line.trim()) + '</li>');
            continue;
        }

        closeList();
        paragraph.push(line.trim());
    }

    if (inCode) {
        html.push('<pre class="ai-md-code"><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
    }
    flushParagraph();
    closeList();
    return html.join('');
}

function splitStreamingMarkdown(markdown) {
    var text = String(markdown || '').replace(/\r\n?/g, '\n');
    if (!text) return { stable: '', tail: '' };
    if (!hasUnstableStreamingMarkdownTail(text)) {
        return { stable: text, tail: '' };
    }
    var cut = text.lastIndexOf('\n\n');
    if (cut < 0) {
        return { stable: '', tail: text };
    }
    return {
        stable: text.slice(0, cut),
        tail: text.slice(cut + 2)
    };
}

function hasUnstableStreamingMarkdownTail(text) {
    return hasUnclosedStreamingFence(text) ||
        hasUnclosedStreamingFormula(text) ||
        hasUnstableStreamingTableTail(text);
}

function hasUnclosedStreamingFence(text) {
    return ((String(text || '').match(/^```/gm) || []).length % 2) === 1;
}

function hasUnclosedStreamingFormula(text) {
    return ((String(text || '').match(/^\s*\$\$\s*$/gm) || []).length % 2) === 1;
}

function hasUnstableStreamingTableTail(text) {
    var value = String(text || '');
    var cut = value.lastIndexOf('\n\n');
    var tail = cut >= 0 ? value.slice(cut + 2) : value;
    var lines = tail.split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
    if (!lines.length) return false;
    var pipeLines = lines.filter(function (line) { return line.indexOf('|') !== -1; });
    if (!pipeLines.length) return false;
    var hasSeparator = lines.some(isMarkdownTableSeparator);
    if (!hasSeparator) return pipeLines.length >= 1;
    return pipeLines.length < 3 || !/\n\s*$/.test(value);
}

function renderStreamingMarkdownTail(tail) {
    if (!tail) return '';
    return '<p class="ai-md-stream-tail">' + escapeHtml(tail).replace(/\n/g, '<br>') + '</p>';
}

function isLooseUnorderedListLine(line) {
    var trimmed = String(line || '').trim();
    return /^[-*+]\s+/.test(trimmed)
        || /^[-*+][\u4e00-\u9fffA-Za-z0-9`【《（(]/.test(trimmed)
        || /^[•·]\s*/.test(trimmed);
}

function stripLooseUnorderedListMarker(line) {
    return String(line || '').trim()
        .replace(/^[-*+]\s+/, '')
        .replace(/^[-*+](?=[\u4e00-\u9fffA-Za-z0-9`【《（(])/, '')
        .replace(/^[•·]\s*/, '');
}

function isBareTaskListLine(line) {
    return /^\s*\[[ xX]\]\s+/.test(String(line || ''));
}

function parseTaskListMarkdown(line) {
    var match = String(line || '').trim().match(/^\[([ xX])\]\s*(.*)$/);
    if (!match) return { checked: null, text: String(line || '').trim() };
    return { checked: match[1].toLowerCase() === 'x', text: match[2] || '' };
}

function renderTaskListItem(task) {
    if (!task || task.checked == null) return '<li>' + renderInlineMarkdown(task && task.text || '') + '</li>';
    return '<li><input type="checkbox" disabled ' + (task.checked ? 'checked' : '') + '> ' +
        renderInlineMarkdown(task.text || '') + '</li>';
}

function isTaskListContinuationLine(line, nextLine) {
    var value = String(line || '').trim();
    if (!value || value.length > 40) return false;
    if (isBareTaskListLine(value) || isLooseUnorderedListLine(value)) return false;
    if (/^(#{1,6}\s+|[-*_]{2,}|周[一二三四五六日天]|第[一二三四五六七八九十]+阶段|防崩盘规则|底线目标)/.test(value)) return false;
    if (hasTabularSeparator(value) || /[。？！；;]$/.test(value)) return false;
    return isBareTaskListLine(nextLine);
}

function normalizeLooseMarkdown(markdown) {
    var text = String(markdown || '').replace(/\r\n?/g, '\n');
    var parts = text.split(/(```[\s\S]*?```)/g);
    var normalized = parts.map(function (part) {
        if (/^```[\s\S]*```$/.test(part)) return part;
        return normalizeLooseMarkdownPart(part);
    }).join('');
    return splitLooseTableTitleLines(normalized);
}

function canonicalizeModelMarkdown(markdown) {
    var lines = String(markdown || '').split('\n');
    var output = [];
    var inCode = false;
    for (var i = 0; i < lines.length;) {
        var line = String(lines[i] || '');
        if (/^```/.test(line.trim())) {
            inCode = !inCode;
            output.push(line);
            i++;
            continue;
        }
        if (inCode) {
            output.push(line);
            i++;
            continue;
        }

        var table = readModelMarkdownTableBlock(lines, i);
        if (table) {
            if (output.length && output[output.length - 1].trim()) output.push('');
            output.push.apply(output, serializeModelMarkdownTable(table));
            output.push('');
            i = table.endIndex + 1;
            continue;
        }

        output.push(line);
        i++;
    }
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function serializeModelMarkdownTable(table) {
    var headers = table.headers || [];
    var rows = table.rows || [];
    if (!headers.length || !rows.length) return [];
    var lines = [];
    lines.push('| ' + headers.map(serializeModelMarkdownTableCell).join(' | ') + ' |');
    lines.push('| ' + headers.map(function () { return '---'; }).join(' | ') + ' |');
    rows.forEach(function (row) {
        lines.push('| ' + headers.map(function (_, index) {
            return serializeModelMarkdownTableCell(row[index] || '');
        }).join(' | ') + ' |');
    });
    return lines;
}

function serializeModelMarkdownTableCell(value) {
    return String(value || '')
        .replace(/\s*\n+\s*/g, '<br>')
        .replace(/\|/g, '／')
        .replace(/\s{2,}/g, ' ')
        .trim() || ' ';
}

function splitLooseTableTitleLines(text) {
    return String(text || '')
        .replace(/([^\n|]{2,80}?)\s+\|\s*((?:\u4efb\u52a1|\u79d1\u76ee)\s*\|\s*(?:\u65f6\u95f4|\u4efb\u52a1)\s*\|[^\n]+)/g, '$1\n| $2');
}

function normalizeLooseMarkdownPart(text) {
    return normalizeLooseMarkdownTables(normalizeStudyPhaseHeaderLines(text))
        .replace(/(^|\n)(#{1,6})(?=\S)/g, '$1$2 ')
        .replace(/(^|\n)\s*(?:\*\*|__)\s*(?=\n|$)/g, '$1')
        .replace(/([：:])\s*(?:\*\*|__)\s*(?=\n|$)/g, '$1')
        .replace(/^\s*\*\*\s+(?=[-+*\u2022\u00b7])/g, '')
        .replace(/(^|\n)\s*\*\*\s+([-+*\u2022\u00b7]\s*)/g, '$1$2')
        .replace(/(^|\n)\s*(---+)\s*(#{1,6}\s+)/g, '$1$2\n$3')
        .replace(/([^\n])\s*(---+)\s*(#{1,6}\s+)/g, '$1\n\n$2\n$3')
        .replace(/([^\n])\s+(#{1,6}\s+)/g, '$1\n\n$2')
        .replace(/([^\n])\s+(\d{1,2}[.)]\s+)/g, '$1\n$2')
        .replace(/([^\n])\s+([-+*]\s*(?=\*\*|[\u4e00-\u9fffA-Za-z0-9`【《（(]))/g, '$1\n$2')
        .replace(/([^\n])\s+([\u2022\u00b7]\s*(?=\*\*|[\u4e00-\u9fffA-Za-z0-9`【《（(]))/g, '$1\n$2')
        .replace(/(^|\n)\s*([-+*])(?=\*\*|[\u4e00-\u9fffA-Za-z0-9`【《（(])/g, '$1$2 ')
        .replace(/([^\n])\s+([-*]\s*(?=[\u4e00-\u9fffA-Za-z0-9`【《（(]))/g, '$1\n$2')
        .replace(/(#{1,6}\s+[^\n]{1,80}?)(\s+(?:\u76ee\u6807|\u5efa\u8bae|\u63a8\u8350|\u6bcf\u5929|\u653f\u6cbb|\u6570\u5b66|\u82f1\u8bed|\u5982\u679c|\u4f60\u53ef\u4ee5|\u4e0d\u5fc5|\u53ef\u4ee5)[\uff1a:，,])/g, '$1\n$2');
}

function normalizeStudyPhaseHeaderLines(text) {
    return String(text || '').split('\n').map(function (line) {
        return splitStudyPhaseHeaderPrefix(line);
    }).join('\n');
}

function splitStudyPhaseHeaderPrefix(line) {
    var value = String(line || '');
    var match = value.match(/\u9636\u6bb5[\s|]+\u65e5\u5386\u65f6\u95f4[\s|]+(?:\u4f60\u7684)?\u5b66\u671f/);
    if (!match || match.index <= 0) return value;

    var headerStart = match.index;
    var pipeBeforeHeader = value.lastIndexOf('|', match.index);
    if (pipeBeforeHeader >= 0 && value.slice(pipeBeforeHeader, match.index).trim() === '|') {
        headerStart = pipeBeforeHeader;
    }

    var before = value.slice(0, headerStart).trim();
    var after = value.slice(headerStart).trim();
    if (!before || !after) return value;
    return before + '\n' + after;
}

function normalizeLooseMarkdownTables(text) {
    return String(text || '').split('\n').map(function (line) {
        if (!looksLikeCollapsedMarkdownTable(line)) return line;
        return normalizeCollapsedMarkdownTableLine(line);
    }).join('\n');
}

function looksLikeCollapsedMarkdownTable(line) {
    var value = String(line || '');
    if (value.indexOf('|') === -1) return false;
    if (value.indexOf('\n') !== -1) return false;
    return /\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?/.test(value);
}

function normalizeCollapsedMarkdownTableLine(line) {
    return extractCollapsedMarkdownTableLine(line) || String(line || '');
}

function extractCollapsedMarkdownTableLine(line) {
    var value = String(line || '');
    var separator = value.match(/\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|/);
    if (!separator) return null;

    var tableStart = value.indexOf('|');
    if (tableStart < 0 || tableStart > separator.index) return null;

    var before = value.slice(0, tableStart).trim();
    var body = value.slice(tableStart).trim();
    var chunks = body.split(/\|\s*(?=\|)/).map(function (chunk) {
        return chunk.trim();
    }).filter(Boolean);
    if (chunks.length < 2) return null;

    var headerCells = parseMarkdownTableRow(chunks[0]);
    if (headerCells.length < 2) return null;
    var columnCount = headerCells.length;
    var output = before ? [before] : [];
    var after = '';

    for (var i = 0; i < chunks.length; i++) {
        var normalized = normalizeCollapsedTableChunk(chunks[i], columnCount);
        if (!normalized || !normalized.row) continue;
        output.push(normalized.row);
        if (normalized.trailing) {
            after = normalized.trailing;
            break;
        }
    }

    if (output.length < (before ? 3 : 2)) return null;
    if (after) output.push(after);
    return output.join('\n');
}

function normalizeCollapsedTableChunk(chunk, columnCount) {
    var cells = parseMarkdownTableRow(chunk);
    if (!cells.length) return null;
    var trailing = '';
    if (cells.length > columnCount) {
        trailing = cells.slice(columnCount).join(' | ').trim();
        cells = cells.slice(0, columnCount);
    }
    while (cells.length < columnCount) cells.push('');
    return {
        row: '| ' + cells.join(' | ') + ' |',
        trailing: trailing
    };
}

function splitTextBeforeCollapsedTable(line) {
    var firstPipe = line.indexOf('|');
    if (firstPipe <= 0) return line;
    var before = line.slice(0, firstPipe).trim();
    var after = line.slice(firstPipe).trim();
    if (!before || !after) return line;
    if (!/\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?/.test(after)) return line;
    return before + '\n' + after;
}

function readModelMarkdownTableBlock(lines, startIndex) {
    var firstLine = String(lines[startIndex] || '').trim();
    if (!firstLine) return null;
    var firstCells = parseModelTableCells(firstLine);
    if (!shouldStartModelMarkdownTable(firstLine, firstCells, lines[startIndex + 1] || '')) return null;

    var headers;
    var i = startIndex;
    if (isModelMarkdownTableHeaderLine(firstLine, firstCells, lines[startIndex + 1] || '')) {
        headers = normalizeTableRow(firstCells, Math.max(2, firstCells.length));
        i++;
        if (isMarkdownTableSeparator(lines[i])) i++;
    } else {
        headers = inferModelMarkdownTableHeaders(firstCells.length, firstCells);
    }

    var columnCount = headers.length;
    var rows = [];
    var currentRow = null;

    while (i < lines.length) {
        var raw = String(lines[i] || '');
        var line = raw.trim();
        if (!line) {
            var next = nextSignificantModelMarkdownLine(lines, i + 1, 2);
            if (currentRow && next && !isModelMarkdownTableBoundary(next.line, headers, columnCount)) {
                i++;
                continue;
            }
            break;
        }
        if (isMarkdownTableSeparator(line)) {
            i++;
            continue;
        }
        if (isModelMarkdownTableBoundary(line, headers, columnCount)) break;

        var cells = parseModelTableCells(line);
        if (isModelMarkdownTableRowLine(line, cells, headers, currentRow)) {
            if (currentRow && shouldMergeBrokenModelMarkdownTableRow(currentRow, cells, columnCount, line)) {
                mergeBrokenModelMarkdownTableRow(currentRow, cells, columnCount);
            } else {
                currentRow = normalizeTableRow(cells, columnCount);
                rows.push(currentRow);
            }
            i++;
            continue;
        }

        if (currentRow && looksLikeModelMarkdownCellContinuation(line, headers, currentRow)) {
            appendTableContinuation(currentRow, [cleanTableContinuationText(stripLooseUnorderedListMarker(line))]);
            i++;
            continue;
        }
        break;
    }

    if (!rows.length) return null;
    return {
        headers: headers,
        alignments: [],
        rows: rows,
        endIndex: i - 1
    };
}

function shouldStartModelMarkdownTable(line, cells, nextLine) {
    if (!Array.isArray(cells) || meaningfulModelTableCellCount(cells) < 2) return false;
    if (isMarkdownTableSeparator(line)) return false;
    if (isModelMarkdownTableHeaderLine(line, cells, nextLine)) return true;
    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(nextLine)) return true;
    if (String(line || '').indexOf('|') !== -1 && (line.trim().charAt(0) === '|' || /\|\s*$/.test(line.trim()))) return true;
    return looksLikeScheduleModelTableRow(cells) || looksLikePhaseModelTableRow(cells);
}

function isModelMarkdownTableHeaderLine(line, cells, nextLine) {
    if (!Array.isArray(cells) || meaningfulModelTableCellCount(cells) < 2) return false;
    var joined = cells.join('|');
    if (/时间段.*时长.*内容/.test(joined)) return true;
    if (/阶段.*时间范围/.test(joined)) return true;
    if (/任务.*(时间|说明|内容)/.test(joined)) return true;
    if (/科目.*(时间|内容|说明)/.test(joined)) return true;
    if (isMarkdownTableSeparator(nextLine)) return true;
    return false;
}

function isModelMarkdownTableRowLine(line, cells, headers, currentRow) {
    if (!Array.isArray(cells) || meaningfulModelTableCellCount(cells) < 2) return false;
    if (isModelMarkdownTableHeaderLine(line, cells, '')) return false;
    if (String(line || '').indexOf('|') !== -1 || String(line || '').indexOf('\t') !== -1) return true;
    if (looksLikeScheduleModelTableRow(cells)) return true;
    if (looksLikePhaseModelTableRow(cells)) return true;
    return !!currentRow && shouldMergeBrokenModelMarkdownTableRow(currentRow, cells, headers.length, line);
}

function isModelMarkdownTableBoundary(line, headers, columnCount) {
    var value = String(line || '').trim();
    if (!value) return false;
    var cells = parseModelTableCells(value);
    var multiCellData = meaningfulModelTableCellCount(cells) >= 2
        && (hasTabularSeparator(value) || looksLikeScheduleModelTableRow(cells) || looksLikePhaseModelTableRow(cells));
    if (multiCellData && !isModelMarkdownTableHeaderLine(value, cells, '')) return false;
    if (/^\s*[-*_]{2,}\s*$/.test(value)) return true;
    if (/^(#{1,6}\s+)/.test(value)) return true;
    if (/^(第二阶段|第三阶段|第四阶段|防崩盘规则|底线目标|这是整体节奏|你觉得|确认后)/.test(value)) return true;
    if (/^周[一二三四五六日天](?:至周[一二三四五六日天])?$/.test(value)) return true;
    if (isBareTaskListLine(value)) return true;
    if (isModelMarkdownTableHeaderLine(value, cells, '') && meaningfulModelTableCellCount(cells) !== columnCount) return true;
    if (isModelMarkdownTableHeaderLine(value, cells, '') && !sameModelMarkdownTableHeaderKind(headers, cells)) return true;
    return false;
}

function sameModelMarkdownTableHeaderKind(headers, cells) {
    var current = (headers || []).join('|');
    var next = (cells || []).join('|');
    if (/时间段.*时长.*内容/.test(current) && /时间段.*时长.*内容/.test(next)) return true;
    if (/阶段.*时间范围/.test(current) && /阶段.*时间范围/.test(next)) return true;
    return current === next;
}

function shouldMergeBrokenModelMarkdownTableRow(previousRow, cells, columnCount, line) {
    var meaningful = (cells || []).map(cleanTableContinuationText).filter(Boolean);
    if (!previousRow || !meaningful.length) return false;
    if (/^[+＋]/.test(meaningful[0])) return true;
    if (hasUnclosedModelMarkdownBracket(previousRow.join(' '))) return true;
    if (String(line || '').trim().endsWith('|') && meaningful.length < columnCount) return true;
    return previousRow.some(function (cell, index) {
        return index < columnCount && !String(cell || '').trim();
    }) && meaningful.length < columnCount;
}

function looksLikeModelMarkdownCellContinuation(line, headers, currentRow) {
    var raw = String(line || '').trim();
    var value = cleanTableContinuationText(stripLooseUnorderedListMarker(raw));
    if (!value) return false;
    if (isModelMarkdownTableBoundary(value, headers, headers.length)) return false;
    if (parseModelTableCells(value).length >= 2 && hasTabularSeparator(value)) return false;
    if (value.length > 120) return false;
    if (/[。？！]$/.test(value)) return false;
    if (/^[+＋]/.test(value)) return true;
    if (isScheduleModelHeader(headers)) {
        return /^(APP|少量|继续|若|做|看|早年|逐句|回顾|在笔记|计网|OS|数据结构|英语|数学|408|自由补弱|休息|主线推进|复习)/.test(value)
            || value.length <= 30;
    }
    if (isPhaseModelHeader(headers)) {
        if (/\|\s*$/.test(raw) && value.length <= 40) return true;
        return hasUnclosedModelMarkdownBracket((currentRow || []).join(' '))
            && value.length <= 40
            && /[）)]|周末|暑假|家教/.test(value);
    }
    return false;
}

function parseModelTableCells(line) {
    var value = String(line || '').trim();
    if (!value) return [];
    if (value.indexOf('|') !== -1) return parseMarkdownTableRow(value).map(cleanTableContinuationText).filter(Boolean);
    if (value.indexOf('\t') !== -1) return value.split(/\t+/).map(cleanTableContinuationText).filter(Boolean);
    if (/\s{2,}/.test(value)) return value.split(/\s{2,}/).map(cleanTableContinuationText).filter(Boolean);
    return [cleanTableContinuationText(value)].filter(Boolean);
}

function inferModelMarkdownTableHeaders(columnCount, firstRow) {
    var joined = (firstRow || []).join('|');
    if (columnCount === 2) return ['项目', '内容'];
    if (columnCount === 3) {
        if (/\d{1,2}[:：]\d{2}|小时|分钟/.test(joined)) return ['时间段', '时长', '内容'];
        if (/第[一二三四五六七八九十]+阶段|基础期|强化期|冲刺期|暑假|寒假|大[一二三四]/.test(joined)) return ['阶段', '时间范围', '说明'];
        return ['项目', '内容', '说明'];
    }
    if (columnCount === 4) {
        if (/\d{1,2}[:：]\d{2}|小时|分钟|英语|数学|408/.test(joined)) return ['时间段', '时长', '内容', '说明'];
        return ['项目', '内容', '说明', '备注'];
    }
    return Array.from({ length: columnCount }, function (_, idx) { return '列 ' + (idx + 1); });
}

function mergeBrokenModelMarkdownTableRow(row, cells, columnCount) {
    var meaningful = (cells || []).map(cleanTableContinuationText).filter(Boolean);
    if (!row || !meaningful.length) return;
    var attachIndex = findModelMarkdownContinuationAttachIndex(row);
    row[attachIndex] = row[attachIndex]
        ? row[attachIndex] + ' ' + meaningful[0].replace(/^[+＋]\s*/, '')
        : meaningful[0].replace(/^[+＋]\s*/, '');
    meaningful.slice(1).forEach(function (cell) {
        var emptyIndex = -1;
        for (var i = attachIndex + 1; i < columnCount; i++) {
            if (!String(row[i] || '').trim()) {
                emptyIndex = i;
                break;
            }
        }
        if (emptyIndex >= 0) {
            row[emptyIndex] = cell;
        } else if (row.length < columnCount) {
            row.push(cell);
        } else {
            var lastIndex = Math.max(0, Math.min(columnCount, row.length) - 1);
            row[lastIndex] = row[lastIndex] ? row[lastIndex] + ' ' + cell : cell;
        }
    });
    while (row.length < columnCount) row.push('');
}

function findModelMarkdownContinuationAttachIndex(row) {
    for (var i = 0; i < row.length; i++) {
        if (!String(row[i] || '').trim()) return Math.max(0, i - 1);
    }
    return Math.max(0, row.length - 1);
}

function nextSignificantModelMarkdownLine(lines, startIndex, maxDistance) {
    var end = Math.min(lines.length, startIndex + Math.max(1, maxDistance || 1));
    for (var i = startIndex; i < end; i++) {
        var line = String(lines[i] || '').trim();
        if (line) return { line: line, index: i };
    }
    return null;
}

function meaningfulModelTableCellCount(cells) {
    return (cells || []).filter(function (cell) { return String(cell || '').trim(); }).length;
}

function looksLikeScheduleModelTableRow(cells) {
    var joined = (cells || []).join('|');
    return /\d{1,2}[:：]\d{2}|上午|下午|晚上|通勤|饭后|主学习段|副学习段|结束前/.test(joined)
        && /(小时|分钟|英语|数学|408|内容)/.test(joined);
}

function looksLikePhaseModelTableRow(cells) {
    var joined = (cells || []).join('|');
    return /第[一二三四五六七八九十]+阶段|基础期|强化期|冲刺期/.test(joined)
        && /202\d|现在|暑假|大[一二三四]/.test(joined);
}

function isScheduleModelHeader(headers) {
    var joined = (headers || []).join('|');
    return /时间段/.test(joined) && /时长/.test(joined) && /内容/.test(joined);
}

function isPhaseModelHeader(headers) {
    var joined = (headers || []).join('|');
    return /阶段/.test(joined) && /(时间范围|核心定位|考研每日时间)/.test(joined);
}

function hasUnclosedModelMarkdownBracket(value) {
    var text = String(value || '');
    var opens = (text.match(/[（(]/g) || []).length;
    var closes = (text.match(/[）)]/g) || []).length;
    return opens > closes;
}

function readStudyPhaseTable(lines, startIndex) {
    if (!isStudyPhaseHeaderLine(lines[startIndex])) return null;

    var rows = [];
    var i = startIndex + 1;
    while (i < lines.length) {
        var line = String(lines[i] || '');
        var trimmed = line.trim();

        if (!trimmed) {
            if (rows.length && hasStudyPhaseContinuationAhead(lines, i + 1)) {
                i++;
                continue;
            }
            break;
        }

        if (isMarkdownTableSeparator(line)) {
            i++;
            continue;
        }

        var row = parseStudyPhaseRow(line);
        if (row) {
            rows.push(row);
            i++;
            continue;
        }

        if (rows.length && isStudyPhaseContinuationLine(line)) {
            rows[rows.length - 1][2] = rows[rows.length - 1][2]
                ? rows[rows.length - 1][2] + '\n' + cleanTableContinuationText(line)
                : cleanTableContinuationText(line);
            i++;
            continue;
        }

        break;
    }

    if (!rows.length) return null;
    return {
        headers: getStudyPhaseTableHeaders(),
        alignments: [],
        rows: rows,
        endIndex: i - 1
    };
}

function isStudyPhaseHeaderLine(line) {
    var text = normalizeStudyPhaseLine(line);
    return /\u9636\u6bb5/.test(text) && /\u65e5\u5386\u65f6\u95f4/.test(text) && /\u5b66\u671f/.test(text);
}

function parseStudyPhaseRow(line) {
    var text = normalizeStudyPhaseLine(line);
    var match = text.match(/^(\u57fa\u7840\u671f|\u5f3a\u5316\u671f|\u51b2\u523a\u671f)\s+(\d{4}\.\d+\s*[\u2013-]\s*\d{4}\.\d+)\s+(.+)$/);
    if (!match) return null;
    return [match[1], match[2], cleanTableContinuationText(match[3])];
}

function normalizeStudyPhaseLine(line) {
    return String(line || '')
        .replace(/^\s*\|\s*/, '')
        .replace(/\s*\|\s*$/, '')
        .replace(/\s*\|\s*/g, ' ')
        .replace(/\t+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function hasStudyPhaseContinuationAhead(lines, startIndex) {
    for (var i = startIndex; i < Math.min(lines.length, startIndex + 3); i++) {
        var line = String(lines[i] || '').trim();
        if (!line) continue;
        return !!parseStudyPhaseRow(line) || isStudyPhaseContinuationLine(line);
    }
    return false;
}

function isStudyPhaseContinuationLine(line) {
    var text = cleanTableContinuationText(line);
    if (!text) return false;
    if (parseStudyPhaseRow(line)) return false;
    if (/^(\*\*|__|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/.test(text)) return false;
    if (/[\u3002\uff01\uff1f!?\uff1b;]/.test(text)) return false;
    if (text.length > 24) return false;
    return /\u5b66\u671f|\u6691\u5047|\u5bd2\u5047|\u5927[\u4e00\u4e8c\u4e09\u56db]|\u7814[\u4e00\u4e8c\u4e09]/.test(text);
}

function readDateRangeTable(lines, startIndex) {
    var headers = parseDateRangeTableHeaders(lines[startIndex], lines[startIndex + 1] || '');
    if (!headers) return null;

    var rows = [];
    var i = startIndex + 1;
    while (i < lines.length) {
        var line = String(lines[i] || '');
        var trimmed = line.trim();

        if (!trimmed) {
            if (rows.length && hasDateRangeContinuationAhead(lines, i + 1)) {
                i++;
                continue;
            }
            break;
        }

        if (isMarkdownTableSeparator(line)) {
            i++;
            continue;
        }

        var row = parseDateRangeTableRow(line);
        if (row) {
            rows.push(row);
            i++;
            continue;
        }

        if (rows.length && isStudyPhaseContinuationLine(line)) {
            rows[rows.length - 1][2] = rows[rows.length - 1][2]
                ? rows[rows.length - 1][2] + '\n' + cleanTableContinuationText(line)
                : cleanTableContinuationText(line);
            i++;
            continue;
        }

        break;
    }

    if (!rows.length) return null;
    return {
        headers: normalizeTableRow(headers, 3),
        alignments: [],
        rows: rows,
        endIndex: i - 1
    };
}

function parseDateRangeTableHeaders(line, nextLine) {
    if (!parseDateRangeTableRow(nextLine)) return null;
    if (isStudyPhaseHeaderLine(line)) return getStudyPhaseTableHeaders();
    var cells = parseFlexibleTableCells(line);
    if (cells.length >= 3 && !parseDateRangeTableRow(line)) {
        return normalizeTableRow(cells, 3);
    }
    return null;
}

function parseDateRangeTableRow(line) {
    var text = normalizeStudyPhaseLine(line);
    var match = text.match(/^(.{1,24}?)\s+(\d{4}[./-]\d{1,2}\s*(?:[\u2013\u2014-]|~|\u81f3|\u5230)\s*\d{4}[./-]\d{1,2})\s+(.+)$/);
    if (!match) return null;
    return [cleanTableContinuationText(match[1]), match[2], cleanTableContinuationText(match[3])];
}

function hasDateRangeContinuationAhead(lines, startIndex) {
    for (var i = startIndex; i < Math.min(lines.length, startIndex + 3); i++) {
        var line = String(lines[i] || '').trim();
        if (!line) continue;
        return !!parseDateRangeTableRow(line) || isStudyPhaseContinuationLine(line);
    }
    return false;
}

function getStudyPhaseTableHeaders() {
    return ['\u9636\u6bb5', '\u65e5\u5386\u65f6\u95f4', '\u4f60\u7684\u5b66\u671f'];
}

function readFlexibleMarkdownTable(lines, startIndex) {
    var headerCells = parseFlexibleTableCells(lines[startIndex]);
    if (!looksLikeFlexibleTableHeader(headerCells, lines[startIndex], lines[startIndex + 1] || '')) {
        return null;
    }

    var columnCount = headerCells.length;
    var rows = [];
    var i = startIndex + 1;

    while (i < lines.length) {
        var line = lines[i];
        var trimmed = String(line || '').trim();

        if (!trimmed) {
            if (rows.length && hasTableContinuationAhead(lines, i + 1)) {
                i++;
                continue;
            }
            break;
        }

        if (isMarkdownTableSeparator(line)) {
            i++;
            continue;
        }

        var cells = parseFlexibleTableCells(line);
        if (cells.length >= 2) {
            rows.push(normalizeTableRow(cells, columnCount));
            i++;
            continue;
        }

        if (rows.length && isLikelyTableContinuationLine(line)) {
            appendTableContinuation(rows[rows.length - 1], [cleanTableContinuationText(line)]);
            i++;
            continue;
        }

        break;
    }

    if (!rows.length) return null;
    return {
        headers: normalizeTableRow(headerCells, columnCount),
        alignments: [],
        rows: rows,
        endIndex: i - 1
    };
}

function looksLikeFlexibleTableHeader(cells, line, nextLine) {
    if (!Array.isArray(cells) || cells.length < 2) return false;
    var headerText = cells.join('|');
    if (/\u9636\u6bb5.*\u65e5\u5386\u65f6\u95f4.*\u5b66\u671f/.test(headerText)) return true;
    if (/\u79d1\u76ee.*\u4efb\u52a1/.test(headerText)) return true;
    return hasTabularSeparator(line) && parseFlexibleTableCells(nextLine).length >= 2;
}

function hasTabularSeparator(line) {
    var value = String(line || '');
    return value.indexOf('\t') !== -1 || value.indexOf('|') !== -1 || /\s{2,}/.test(value);
}

function parseFlexibleTableCells(line) {
    var value = String(line || '').trim();
    if (!value) return [];
    if (value.indexOf('|') !== -1) {
        return parseMarkdownTableRow(value).map(cleanTableContinuationText).filter(Boolean);
    }
    if (value.indexOf('\t') !== -1) {
        return value.split(/\t+/).map(cleanTableContinuationText).filter(Boolean);
    }
    if (/\s{2,}/.test(value)) {
        return value.split(/\s{2,}/).map(cleanTableContinuationText).filter(Boolean);
    }
    return [cleanTableContinuationText(value)].filter(Boolean);
}

function normalizeTableRow(cells, columnCount) {
    var row = cells.slice();
    if (row.length > columnCount) {
        row = row.slice(0, columnCount - 1).concat(row.slice(columnCount - 1).join(' '));
    }
    while (row.length < columnCount) row.push('');
    return row;
}

function hasTableContinuationAhead(lines, startIndex) {
    for (var i = startIndex; i < Math.min(lines.length, startIndex + 3); i++) {
        var line = String(lines[i] || '').trim();
        if (!line) continue;
        return parseFlexibleTableCells(line).length >= 2 || isLikelyTableContinuationLine(line);
    }
    return false;
}

function isLikelyTableContinuationLine(line) {
    var value = cleanTableContinuationText(line);
    if (!value) return false;
    if (value.length > 28) return false;
    if (/^(\*\*|__|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/.test(value)) return false;
    if (/[。！？!?；;]/.test(value)) return false;
    return true;
}

function cleanTableContinuationText(text) {
    return String(text || '')
        .replace(/^\s*\|\s*/, '')
        .replace(/\s*\|\s*$/, '')
        .trim();
}

function normalizeAiMessageRole(role) {
    var value = String(role || '').toLowerCase();
    return value === 'assistant' || value === 'ai' || value === 'model' ? 'ai' : 'user';
}

function isMarkdownTableRow(line) {
    var value = String(line || '').trim();
    return value.indexOf('|') !== -1 && /^\|?(.+\|)+.*\|?$/.test(value);
}

function isMarkdownTableSeparator(line) {
    if (!isMarkdownTableRow(line)) return false;
    var cells = parseMarkdownTableRow(line);
    return cells.length > 0 && cells.every(function (cell) {
        return /^:?-{3,}:?$/.test(cell.replace(/\s+/g, ''));
    });
}

function parseMarkdownTableRow(line) {
    var value = String(line || '').trim();
    if (value.charAt(0) === '|') value = value.slice(1);
    if (value.charAt(value.length - 1) === '|') value = value.slice(0, -1);
    return value.split('|').map(function (cell) { return cell.trim(); });
}

function parseMarkdownTableAlignments(line) {
    return parseMarkdownTableRow(line).map(function (cell) {
        var value = cell.replace(/\s+/g, '');
        if (value.charAt(0) === ':' && value.charAt(value.length - 1) === ':') return 'center';
        if (value.charAt(value.length - 1) === ':') return 'right';
        if (value.charAt(0) === ':') return 'left';
        return '';
    });
}

function shouldAppendTableContinuation(row, columnCount, rows) {
    if (!rows.length || !Array.isArray(row)) return false;
    if (row.length >= columnCount) return false;
    return row.filter(function (cell) { return !!cell; }).length <= 1;
}

function appendTableContinuation(lastRow, row) {
    var text = row.filter(function (cell) { return !!cell; }).join(' ').trim();
    if (!text) return;
    var targetIndex = Math.max(0, Math.min(lastRow.length - 1, lastNonEmptyCellIndex(lastRow)));
    lastRow[targetIndex] = lastRow[targetIndex] ? (lastRow[targetIndex] + '\n' + text) : text;
}

function lastNonEmptyCellIndex(row) {
    for (var i = row.length - 1; i >= 0; i--) {
        if (row[i]) return i;
    }
    return row.length - 1;
}

function renderMarkdownTable(headers, alignments, rows) {
    var columnCount = headers.length;
    var html = ['<div class="ai-md-table-wrap"><table><thead><tr>'];
    headers.forEach(function (cell, index) {
        html.push('<th' + renderMarkdownTableAlign(alignments[index]) + '>' + renderMarkdownTableCell(cell) + '</th>');
    });
    html.push('</tr></thead><tbody>');
    rows.forEach(function (row) {
        html.push('<tr>');
        for (var i = 0; i < columnCount; i++) {
            html.push('<td' + renderMarkdownTableAlign(alignments[i]) + '>' + renderMarkdownTableCell(row[i] || '') + '</td>');
        }
        html.push('</tr>');
    });
    html.push('</tbody></table></div>');
    return html.join('');
}

function renderMarkdownTableAlign(align) {
    return align ? ' style="text-align:' + align + '"' : '';
}

function renderMarkdownTableCell(cell) {
    return String(cell || '').split(/\n+|<br\s*\/?>/i).map(function (part) {
        var heading = String(part || '').trim().match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            var level = Math.min(6, heading[1].length);
            return '<div class="ai-md-table-heading ai-md-table-heading-' + level + '">' +
                renderInlineMarkdown(heading[2]) +
                '</div>';
        }
        return renderInlineMarkdown(part);
    }).join('<br>');
}

function renderInlineMarkdown(text) {
    var linkHtml = [];
    var tokenPrefix = '\u0001AILINK';
    var linked = String(text).replace(/\[([^\]\n]{1,200})]\(([^)\s]{1,1000})\)/g, function (match, label, href) {
        var safeHref = normalizeMarkdownHref(href);
        if (!safeHref) return label;
        var token = tokenPrefix + linkHtml.length + '\u0002';
        linkHtml.push(
            '<a href="' + escapeHtml(safeHref) + '" target="_blank" rel="noopener noreferrer">' +
            renderInlineBasicMarkdown(label) +
            '</a>'
        );
        return token;
    });

    var html = renderInlineBasicMarkdown(linked);
    linkHtml.forEach(function (link, index) {
        html = html.replace(tokenPrefix + index + '\u0002', link);
    });
    return html;
}

function renderInlineBasicMarkdown(text) {
    var html = escapeHtml(text);
    var codeHtml = [];
    html = html.replace(/`([^`]+)`/g, function (match, code) {
        var token = '\u0001AICODE' + codeHtml.length + '\u0002';
        codeHtml.push('<code>' + code + '</code>');
        return token;
    });
    html = html
        .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__([\s\S]+?)__/g, '<strong>$1</strong>')
        .replace(/~~([\s\S]+?)~~/g, '<del>$1</del>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
        .replace(/\*\*/g, '')
        .replace(/__/g, '');
    codeHtml.forEach(function (code, index) {
        html = html.replace('\u0001AICODE' + index + '\u0002', code);
    });
    return html;
}

function normalizeMarkdownHref(href) {
    var value = String(href || '').trim().replace(/^["']|["']$/g, '');
    if (/^(https?:\/\/|mailto:)/i.test(value)) {
        return value;
    }
    return '';
}

function wireAiMessageContextMenu() {
    var container = document.getElementById('aiMessages');
    if (!container) return;
    container.addEventListener('contextmenu', function (event) {
        var msg = event.target.closest('.ai-msg');
        if (!msg || msg.classList.contains('ai-welcome-msg')) return;
        event.preventDefault();
        openAiMessageMenu(event, msg);
    });
    document.addEventListener('click', closeAiMessageMenu);
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeAiMessageMenu();
    });
    window.addEventListener('resize', closeAiMessageMenu);
    window.addEventListener('scroll', closeAiMessageMenu, true);
}

function openAiMessageMenu(event, msg) {
    closeAiMessageMenu();
    var menu = document.createElement('div');
    menu.id = 'aiMessageContextMenu';
    menu.className = 'ai-message-menu';
    menu.innerHTML =
        '<button type="button" class="ai-message-menu-item" data-action="delete">删除消息</button>';
    document.body.appendChild(menu);

    var left = event.clientX;
    var top = event.clientY;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
        menu.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
    }
    if (rect.bottom > window.innerHeight - 8) {
        menu.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
    }

    menu.querySelector('[data-action="delete"]').addEventListener('click', function () {
        deleteAiMessage(msg.id);
    });
}

function closeAiMessageMenu() {
    var menu = document.getElementById('aiMessageContextMenu');
    if (menu) menu.remove();
}

async function deleteAiMessage(domId) {
    var msg = document.getElementById(domId);
    if (!msg) return;
    closeAiMessageMenu();
    var messageId = normalizeAiMessageId(msg.getAttribute('data-message-id'));
    try {
        if (messageId != null) {
            await api.delete('/ai/messages/' + encodeURIComponent(messageId));
        }
        removeMessage(domId);
        if (typeof showToast === 'function') showToast('消息已删除', 'success');
    } catch (e) {
        if (typeof showToast === 'function') {
            showToast(e.message || '删除失败', 'error');
        } else {
            alert(e.message || '删除失败');
        }
    }
}

async function openAiWikiDraftModal(revision) {
    if (!revision || !revision.id) return;
    ensureAiWikiDraftModal();
    var draft = await loadAiWikiDraftDetail(revision);
    _currentAiWikiDraft = draft;
    var modal = document.getElementById('aiWikiDraftModal');
    if (!modal) return;
    var title = document.getElementById('aiWikiDraftTitle');
    var type = document.getElementById('aiWikiDraftType');
    var content = document.getElementById('aiWikiDraftContent');
    if (title) title.value = draft.title || '对话整理';
    if (type) type.value = inferAiWikiDraftType(draft);
    if (content) content.value = draft.content || '';
    modal.classList.remove('hidden');
    setTimeout(function () {
        if (title) title.focus();
    }, 30);
    if (typeof showToast === 'function') {
        showToast('已生成知识 Wiki 草稿，可在弹窗中修改后写入', 'success');
    }
}

async function loadAiWikiDraftDetail(revision) {
    var fallback = {
        id: revision.id,
        pageId: revision.pageId || '',
        title: revision.title || '对话整理',
        content: revision.content || '',
        pageType: revision.pageType || ''
    };
    if (fallback.content) return fallback;
    try {
        var res = await api.get('/knowledge/revisions?status=PENDING');
        var rows = Array.isArray(res.data) ? res.data : [];
        var found = rows.find(function (row) {
            return String(row.id) === String(revision.id);
        });
        if (found) {
            return Object.assign({}, fallback, found);
        }
    } catch (e) {
        // The chat answer is still useful even if draft detail loading fails.
    }
    return fallback;
}

function ensureAiWikiDraftModal() {
    if (document.getElementById('aiWikiDraftModal')) return;
    var modal = document.createElement('div');
    modal.id = 'aiWikiDraftModal';
    modal.className = 'ai-wiki-draft-modal hidden';
    modal.innerHTML =
        '<div class="ai-wiki-draft-backdrop" data-ai-wiki-close></div>' +
        '<section class="ai-wiki-draft-panel" role="dialog" aria-modal="true" aria-labelledby="aiWikiDraftHeading">' +
        '  <header class="ai-wiki-draft-head">' +
        '    <div>' +
        '      <p>Knowledge Wiki</p>' +
        '      <h2 id="aiWikiDraftHeading">确认知识草稿</h2>' +
        '    </div>' +
        '    <button type="button" class="ai-wiki-draft-close" data-ai-wiki-close>&times;</button>' +
        '  </header>' +
        '  <div class="ai-wiki-draft-body">' +
        '    <label>标题<input id="aiWikiDraftTitle" maxlength="120" placeholder="例如：长期目标"></label>' +
        '    <label>类型<select id="aiWikiDraftType">' +
        '      <option value="GOAL">目标</option>' +
        '      <option value="PROJECT">计划</option>' +
        '      <option value="PREFERENCE">偏好</option>' +
        '      <option value="WEAKNESS">薄弱点</option>' +
        '      <option value="RESOURCE">资料</option>' +
        '      <option value="MEMORY">对话摘要</option>' +
        '      <option value="NOTE">备注</option>' +
        '    </select></label>' +
        '    <label>正文<textarea id="aiWikiDraftContent" rows="12" placeholder="AI 提炼出的知识内容"></textarea></label>' +
        '  </div>' +
        '  <footer class="ai-wiki-draft-actions">' +
        '    <button type="button" class="btn btn-default" id="aiWikiDraftReject">忽略</button>' +
        '    <button type="button" class="btn btn-default" data-ai-wiki-close>稍后</button>' +
        '    <button type="button" class="btn btn-primary" id="aiWikiDraftSave">写入知识 Wiki</button>' +
        '  </footer>' +
        '</section>';
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-ai-wiki-close]').forEach(function (el) {
        el.addEventListener('click', closeAiWikiDraftModal);
    });
    document.getElementById('aiWikiDraftSave')?.addEventListener('click', saveAiWikiDraftModal);
    document.getElementById('aiWikiDraftReject')?.addEventListener('click', rejectAiWikiDraftModal);
}

function closeAiWikiDraftModal() {
    var modal = document.getElementById('aiWikiDraftModal');
    if (modal) modal.classList.add('hidden');
}

async function saveAiWikiDraftModal() {
    if (!_currentAiWikiDraft || !_currentAiWikiDraft.id) return;
    var title = document.getElementById('aiWikiDraftTitle')?.value.trim() || '';
    var content = document.getElementById('aiWikiDraftContent')?.value.trim() || '';
    var pageType = document.getElementById('aiWikiDraftType')?.value || 'MEMORY';
    if (!title || !content) {
        if (typeof showToast === 'function') showToast('请填写标题和正文', 'warning');
        return;
    }
    await api.post('/knowledge/revisions/' + _currentAiWikiDraft.id + '/apply', {
        pageId: _currentAiWikiDraft.pageId || null,
        title: title,
        content: content,
        pageType: pageType,
        parentId: null,
        pinned: false
    });
    closeAiWikiDraftModal();
    if (typeof showToast === 'function') showToast('已写入知识 Wiki', 'success');
}

async function rejectAiWikiDraftModal() {
    if (!_currentAiWikiDraft || !_currentAiWikiDraft.id) return;
    await api.post('/knowledge/revisions/' + _currentAiWikiDraft.id + '/reject', {});
    closeAiWikiDraftModal();
    if (typeof showToast === 'function') showToast('已忽略知识草稿', 'success');
}

function inferAiWikiDraftType(row) {
    if (row && row.pageType) return row.pageType;
    var source = ((row && row.title) || '') + '\n' + ((row && row.content) || '');
    if (source.indexOf('目标') >= 0 || /goal/i.test(source)) return 'GOAL';
    if (source.indexOf('偏好') >= 0 || source.indexOf('习惯') >= 0 || /preference/i.test(source)) return 'PREFERENCE';
    if (source.indexOf('计划') >= 0 || /plan|project/i.test(source)) return 'PROJECT';
    if (source.indexOf('薄弱') >= 0 || source.indexOf('短板') >= 0 || /weakness/i.test(source)) return 'WEAKNESS';
    if (source.indexOf('资料') >= 0 || source.indexOf('笔记') >= 0 || /resource|material/i.test(source)) return 'RESOURCE';
    return 'MEMORY';
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
    clearLegacyAiState();
    loadAiWorkspace();
    loadAiModelsForChat();
    initAiDragDrop();
    wireAiMessageContextMenu();
    bindAiFeatureToggles();
    wireAiStatePersistence();
    restoreAiState();
    loadAiChatHistory();
    scrollAiToLatest(true);
});

async function loadAiModelsForChat() {
    var select = document.getElementById('aiModelSelect');
    if (!select) return;
    try {
        var res = await api.get('/ai/models');
        var data = res.data || {};
        setAiWebSearchAvailability(!!(data.webFetchAvailable || data.webSearchAvailable), !!data.webSearchAvailable);
        var rows = [];
        (data.systemModels || []).forEach(function (model) { rows.push(model); });
        (data.userModels || []).forEach(function (model) { rows.push(model); });
        select.innerHTML = '';
        if (!rows.length) {
            var empty = document.createElement('option');
            empty.value = '';
            empty.textContent = '未配置模型';
            select.appendChild(empty);
            if (window.refreshCustomSelects) window.refreshCustomSelects();
            return;
        }
        rows.forEach(function (model) {
            var option = document.createElement('option');
            option.value = String(model.id);
            option.textContent = cleanModelLabel(model.label || model.displayName || model.modelName, model.ownerType);
            if (String(model.id) === String(data.defaultModelId)) option.selected = true;
            select.appendChild(option);
        });
        _selectedAiModelId = select.value || null;
        if (window.refreshCustomSelects) window.refreshCustomSelects();
        select.addEventListener('change', function () {
            _selectedAiModelId = select.value || null;
            persistAiState();
        });
    } catch (e) {
        setAiWebSearchAvailability(true, false);
        select.innerHTML = '<option value="">模型读取失败</option>';
        if (window.refreshCustomSelects) window.refreshCustomSelects();
    }
}

function setAiWebSearchAvailability(available, searchProviderAvailable) {
    var btn = document.getElementById('aiWebSearchToggle');
    if (!btn) return;
    btn.disabled = !available;
    btn.title = searchProviderAvailable
        ? '联网搜索：先搜索候选链接，再读取网页正文'
        : '联网读取：可读取你提供的网页链接；未配置搜索源时不能全网搜索';
    if (!available) {
        btn.setAttribute('aria-pressed', 'false');
    }
}

function getSelectedAiModelId() {
    var select = document.getElementById('aiModelSelect');
    var value = select ? select.value : _selectedAiModelId;
    if (value == null || value === '') return null;
    var parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
}

function cleanModelLabel(label, ownerType) {
    var text = String(label || '默认模型').trim()
        .replace(/（我的）$/g, '')
        .replace(/\(我的\)$/g, '')
        .replace(/（系统）$/g, '')
        .replace(/\(系统\)$/g, '');
    return text + (ownerType === 'SYSTEM' ? '（系统）' : '（我的）');
}

function wireAiStatePersistence() {
    var input = document.getElementById('aiInput');
    if (input) {
        input.addEventListener('input', persistAiState);
    }
    window.addEventListener('beforeunload', markAiPageLeaving);
    window.addEventListener('pagehide', markAiPageLeaving);
}

function clearLegacyAiState() {
    try {
        AI_LEGACY_STATE_KEYS.forEach(function (key) {
            sessionStorage.removeItem(key);
        });
    } catch (e) {
        // ignore
    }
}

function markAiPageLeaving() {
    _aiPageLeaving = true;
    if (_activeAiStream && _activeAiStream.controller) {
        try {
            _activeAiStream.controller.abort();
        } catch (e) {
            // ignore
        }
    }
    persistAiState();
}
