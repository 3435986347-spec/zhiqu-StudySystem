checkAuth();
renderNavbar('navbar');

let allTasksFlat = [];
let dashboardOverview = null;
let currentWeekStart = getWeekStart(new Date());

function parseLocalDateTime(val) {
    if (!val) return null;
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoLocalDateTime(val) {
    if (!val) return null;
    const s = val.trim();
    if (!s) return null;
    return s.length === 16 ? s + ':00' : s;
}

function parseReminderOffsets(val) {
    if (!val || !val.trim()) return null;
    const list = val.split(',')
        .map((x) => parseInt(x.trim(), 10))
        .filter((x, idx, arr) => Number.isFinite(x) && x >= 0 && x <= 365 && arr.indexOf(x) === idx);
    return list.length ? list : null;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function dateKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function parseDateKey(value) {
    const d = new Date(String(value).substring(0, 10) + 'T00:00:00');
    return Number.isNaN(d.getTime()) ? new Date() : d;
}

function addDays(date, days) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + days);
    return d;
}

function getWeekStart(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return d;
}

function getWeekEnd(start) {
    return addDays(start, 6);
}

function sameDateKey(a, b) {
    return dateKey(a) === dateKey(b);
}

function formatShortDate(value) {
    const d = parseDateKey(value);
    return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
}

function formatDeadline(value) {
    if (!value) return '无截止';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function itemTime(item) {
    return item.time || (item.deadline ? formatDeadline(item.deadline).slice(-5) : '');
}

async function loadDashboardOverview() {
    const from = dateKey(currentWeekStart);
    const to = dateKey(getWeekEnd(currentWeekStart));
    const res = await api.get('/dashboard/overview?from=' + from + '&to=' + to);
    dashboardOverview = res.data || {};
    allTasksFlat = dashboardOverview.rangeTasks || [];
    setPomodoroTasks(allTasksFlat);
    renderDashboardOverview(dashboardOverview);
    checkReminders(allTasksFlat);
}

function renderDashboardOverview(data) {
    renderOverviewHeader(data);
    renderSummary(data.summary || {});
    renderTodayList(data);
    renderWeekBoard(data.days || []);
    renderUpcomingDeadlines(data.upcomingDeadlines || []);
    renderQuadrantSummary(data.quadrants || []);
}

function renderOverviewHeader(data) {
    const rangeEl = document.getElementById('week-range-label');
    if (rangeEl) {
        rangeEl.textContent = formatShortDate(data.from || dateKey(currentWeekStart)) + ' - ' +
            formatShortDate(data.to || dateKey(getWeekEnd(currentWeekStart)));
    }
    const todayEl = document.getElementById('today-label');
    if (todayEl) {
        const now = new Date();
        todayEl.textContent = now.getFullYear() + ' 年 ' + (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日';
    }
}

function renderSummary(summary) {
    setText('stat-today-tasks', summary.pendingToday || 0);
    setText('stat-overdue', summary.overdue || 0);
    setText('stat-reminders', summary.remindersToday || 0);
    const routineTotal = summary.routineTotal || 0;
    const routineDone = summary.routineDone || 0;
    setText('stat-routine-progress', routineTotal ? (routineDone + '/' + routineTotal) : '0/0');
    const pct = routineTotal ? Math.round((routineDone / routineTotal) * 100) : 0;
    const bar = document.getElementById('routine-progress-bar');
    if (bar) bar.style.width = pct + '%';
}

function renderTodayList(data) {
    const box = document.getElementById('today-action-list');
    if (!box) return;
    const today = String(data.today || dateKey(new Date()));
    const day = (data.days || []).find((row) => String(row.date) === today);
    const items = day ? day.items || [] : [];
    box.innerHTML = '';
    if (!items.length) {
        box.innerHTML = '<div class="empty-hint">今天没有安排，适合主动补一块长期任务。</div>';
        return;
    }
    items.slice(0, 8).forEach((item) => box.appendChild(renderDashboardItem(item, true)));
}

function renderWeekBoard(days) {
    const board = document.getElementById('week-board');
    if (!board) return;
    board.innerHTML = '';
    days.forEach((day) => {
        const col = document.createElement('section');
        col.className = 'week-day' + (day.today ? ' is-today' : '');
        col.innerHTML =
            '<div class="week-day-head">' +
            '<span class="week-day-name">' + escapeText(day.weekday || '') + '</span>' +
            '<strong>' + escapeText(String(day.day || '')) + '</strong>' +
            '</div>' +
            '<div class="week-day-items"></div>';
        const list = col.querySelector('.week-day-items');
        const items = day.items || [];
        if (!items.length) {
            list.innerHTML = '<div class="week-empty">空</div>';
        } else {
            items.slice(0, 5).forEach((item) => list.appendChild(renderWeekItem(item)));
            if (items.length > 5) {
                const more = document.createElement('div');
                more.className = 'week-more';
                more.textContent = '+' + (items.length - 5) + ' 项';
                list.appendChild(more);
            }
        }
        board.appendChild(col);
    });
}

function renderUpcomingDeadlines(items) {
    const box = document.getElementById('deadline-list');
    if (!box) return;
    box.innerHTML = '';
    if (!items.length) {
        box.innerHTML = '<div class="empty-hint">暂无临近 DDL。</div>';
        return;
    }
    items.forEach((item) => box.appendChild(renderDeadlineItem(item)));
}

function renderQuadrantSummary(quadrants) {
    const box = document.getElementById('quadrant-summary');
    if (!box) return;
    box.innerHTML = '';
    const names = {
        1: '重要且紧急',
        2: '重要不紧急',
        3: '紧急不重要',
        4: '不重要不紧急'
    };
    quadrants.forEach((q) => {
        const card = document.createElement('section');
        const qNum = q.quadrant || 0;
        card.className = 'quad-summary q' + qNum;
        card.innerHTML =
            '<div class="quad-summary-head">' +
            '<h3>' + (names[qNum] || '未分组') + '</h3>' +
            '<span>' + (q.total || 0) + ' 项</span>' +
            '</div>' +
            '<div class="quad-summary-list"></div>';
        const list = card.querySelector('.quad-summary-list');
        const items = q.items || [];
        if (!items.length) {
            list.innerHTML = '<div class="empty-hint">暂无待办</div>';
        } else {
            items.slice(0, 4).forEach((item) => list.appendChild(renderCompactTask(item)));
        }
        box.appendChild(card);
    });
}

function renderDashboardItem(item, allowActions) {
    const row = document.createElement('div');
    row.className = 'dash-item dash-item-' + String(item.kind || 'TASK').toLowerCase();
    row.innerHTML =
        '<div class="dash-item-time">' + escapeText(itemTime(item) || '--') + '</div>' +
        '<div class="dash-item-main">' +
        '<div class="dash-item-title">' + escapeText(item.title || '未命名') + '</div>' +
        '<div class="dash-item-meta">' + renderItemMeta(item) + '</div>' +
        '</div>' +
        '<div class="dash-item-actions"></div>';
    if (allowActions) {
        const actions = row.querySelector('.dash-item-actions');
        if (item.kind === 'ROUTINE') {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mini-action' + (item.completed ? ' is-done' : '');
            btn.textContent = item.completed ? '已完成' : '完成';
            btn.addEventListener('click', () => toggleRoutineCheckin(item));
            actions.appendChild(btn);
        } else if (item.kind === 'TASK' && item.status !== 2) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mini-action';
            btn.textContent = '完成';
            btn.addEventListener('click', () => completeTask(item.id));
            actions.appendChild(btn);
        }
    }
    return row;
}

function renderWeekItem(item) {
    const row = document.createElement('div');
    row.className = 'week-item week-item-' + String(item.kind || 'TASK').toLowerCase();
    row.innerHTML =
        '<span class="week-item-time">' + escapeText(itemTime(item) || '--') + '</span>' +
        '<span class="week-item-title">' + escapeText(item.title || '未命名') + '</span>';
    return row;
}

function renderDeadlineItem(item) {
    const row = document.createElement('div');
    row.className = 'deadline-item';
    row.innerHTML =
        '<div>' +
        '<strong>' + escapeText(item.title || '未命名') + '</strong>' +
        '<span>' + escapeText(formatDeadline(item.deadline)) + '</span>' +
        '</div>' +
        '<span class="' + priorityTagClass(item.priority) + '">' + priorityLabel(item.priority) + '</span>';
    return row;
}

function renderCompactTask(item) {
    const row = document.createElement('div');
    row.className = 'compact-task';
    row.innerHTML =
        '<span class="compact-task-dot"></span>' +
        '<div><strong>' + escapeText(item.title || '未命名') + '</strong><span>' +
        escapeText(item.deadline ? formatDeadline(item.deadline) : '无截止') +
        '</span></div>';
    return row;
}

function renderItemMeta(item) {
    if (item.kind === 'ROUTINE') {
        const done = item.completed ? '已完成' : '待打卡';
        const minutes = item.durationMinutes ? ' · ' + item.durationMinutes + ' 分钟' : '';
        return '<span class="soft-tag routine-tag">例行</span><span>' + done + minutes + '</span>';
    }
    const status = statusLabel(item.status);
    const due = item.deadline ? ' · 截止 ' + formatDeadline(item.deadline) : '';
    return '<span class="' + priorityTagClass(item.priority) + '">' + priorityLabel(item.priority) + '</span><span>' + status + due + '</span>';
}

async function toggleRoutineCheckin(item) {
    try {
        await api.post('/routine/' + item.routineId + '/checkin', {
            checkDate: item.date,
            completed: !item.completed
        });
        showToast(item.completed ? '已取消完成' : '已完成例行计划', 'success');
        await loadDashboardOverview();
    } catch (e) {
        showToast(e.message || '更新例行计划失败', 'error');
    }
}

async function completeTask(taskId) {
    try {
        await api.put('/task/' + taskId + '/status?status=2', null);
        showToast('任务已完成', 'success');
        await loadDashboardOverview();
    } catch (e) {
        showToast(e.message || '更新失败', 'error');
    }
}

function checkReminders(tasks) {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    const now = Date.now();
    tasks.forEach((task) => {
        if (task.status === 2) return;
        const key = 'reminded-task-' + task.id;
        if (localStorage.getItem(key)) return;
        let fire = false;
        const rem = parseLocalDateTime(task.reminderTime);
        if (rem && now >= rem.getTime()) {
            fire = true;
        } else if (!task.reminderTime && task.deadline) {
            const dl = parseLocalDateTime(task.deadline);
            if (dl) {
                const diff = dl.getTime() - now;
                if (diff > 0 && diff <= 30 * 60 * 1000) {
                    fire = true;
                }
            }
        }
        if (fire) {
            localStorage.setItem(key, '1');
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification('任务提醒', { body: task.title });
            } else {
                showToast('任务提醒：' + task.title, 'warning', 5000);
            }
        }
    });
}

function openTaskModal() {
    document.getElementById('task-modal').classList.remove('hidden');
    document.getElementById('form-new-task').reset();
}

function closeTaskModal() {
    document.getElementById('task-modal').classList.add('hidden');
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function escapeText(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

document.getElementById('btn-new-task')?.addEventListener('click', openTaskModal);
document.getElementById('week-prev')?.addEventListener('click', async () => {
    currentWeekStart = addDays(currentWeekStart, -7);
    await loadDashboardOverview();
});
document.getElementById('week-next')?.addEventListener('click', async () => {
    currentWeekStart = addDays(currentWeekStart, 7);
    await loadDashboardOverview();
});
document.getElementById('week-current')?.addEventListener('click', async () => {
    currentWeekStart = getWeekStart(new Date());
    await loadDashboardOverview();
});
document.getElementById('task-modal-close')?.addEventListener('click', closeTaskModal);
document.getElementById('task-modal-cancel')?.addEventListener('click', closeTaskModal);
document.getElementById('task-modal')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeTaskModal();
});

document.getElementById('form-new-task')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('nt-title').value.trim();
    const description = document.getElementById('nt-desc').value.trim() || null;
    const quadrant = parseInt(document.getElementById('nt-quadrant').value, 10);
    const priority = parseInt(document.getElementById('nt-priority').value, 10);
    const taskType = document.getElementById('nt-task-type').value;
    const difficulty = parseInt(document.getElementById('nt-difficulty').value, 10);
    const startTime = toIsoLocalDateTime(document.getElementById('nt-start-time').value);
    const deadline = toIsoLocalDateTime(document.getElementById('nt-deadline').value);
    const reminderTime = toIsoLocalDateTime(document.getElementById('nt-reminder').value);
    const reminderOffsets = parseReminderOffsets(document.getElementById('nt-reminder-offsets').value);
    const repeatRaw = document.getElementById('nt-repeat-weeks').value;
    const repeatWeeks = repeatRaw ? parseInt(repeatRaw, 10) : null;

    if (repeatWeeks && repeatWeeks > 1 && !startTime) {
        showToast('设置周期重复需要填写开始时间', 'warning');
        return;
    }

    const body = {
        title,
        description,
        quadrant,
        priority,
        taskType,
        difficulty,
        status: 0,
        startTime,
        deadline,
        reminderTime,
        reminderOffsets,
        repeatWeeks
    };
    try {
        let idempotencyKey = localStorage.getItem('zhiqu:dashboard-task-create:idempotency');
        if (!idempotencyKey) {
            idempotencyKey = 'dashboard-task-' + Date.now() + '-' + Math.random().toString(16).slice(2);
            localStorage.setItem('zhiqu:dashboard-task-create:idempotency', idempotencyKey);
        }
        if (repeatWeeks && repeatWeeks > 1) {
            await api.post('/task/create-with-repeat', body, {
                headers: { 'Idempotency-Key': idempotencyKey }
            });
            showToast('已创建 ' + repeatWeeks + ' 条周期任务', 'success');
        } else {
            await api.post('/task', body, {
                headers: { 'Idempotency-Key': idempotencyKey }
            });
            showToast('任务已创建', 'success');
        }
        localStorage.removeItem('zhiqu:dashboard-task-create:idempotency');
        closeTaskModal();
        await loadDashboardOverview();
    } catch (err) {
        showToast(err.message || '创建失败', 'error');
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    initPomodoro();
    try {
        await loadDashboardOverview();
    } catch (e) {
        showToast(e.message || '加载失败', 'error');
    }
});
