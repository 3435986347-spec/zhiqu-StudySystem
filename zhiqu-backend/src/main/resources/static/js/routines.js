checkAuth();
renderNavbar('navbar');

function pad2(n) {
    return String(n).padStart(2, '0');
}

function dateInput(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function addDays(date, days) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + days);
    return d;
}

function escapeText(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function collectWeekdays() {
    return collectWeekdaysFrom('#weekday-picker');
}

function collectWeekdaysFrom(selector) {
    const values = [];
    document.querySelectorAll(selector + ' input:checked').forEach((input) => {
        values.push(parseInt(input.value, 10));
    });
    return values.length ? values : [1, 2, 3, 4, 5, 6, 7];
}

function daysLabel(days) {
    const names = {
        1: '周一',
        2: '周二',
        3: '周三',
        4: '周四',
        5: '周五',
        6: '周六',
        7: '周日'
    };
    if (!days || !days.length) return '每天';
    if (days.length === 7) return '每天';
    return days.map((d) => names[d] || d).join('、');
}

async function loadRoutines() {
    const list = document.getElementById('routine-list');
    if (!list) return;
    list.innerHTML = '<div class="routine-empty">正在载入...</div>';
    try {
        const res = await api.get('/routine/list');
        const routines = res.data || [];
        list.innerHTML = '';
        if (!routines.length) {
            list.innerHTML = '<div class="routine-empty">还没有例行计划。可以从 AI 助手生成，也可以在左侧手动新建。</div>';
            return;
        }
        routines.forEach((routine) => list.appendChild(renderRoutine(routine)));
    } catch (e) {
        list.innerHTML = '<div class="routine-empty">读取失败：' + escapeText(e.message || '') + '</div>';
    }
}

let sourceTasks = [];

async function loadRoutineSourceTasks() {
    const box = document.getElementById('routine-task-source-list');
    if (!box) return;
    box.innerHTML = '<div class="routine-empty">正在读取任务...</div>';
    try {
        const res = await api.get('/task/list?sortBy=updatedAt&sortOrder=desc');
        sourceTasks = res.data || [];
        renderRoutineSourceTasks();
    } catch (e) {
        box.innerHTML = '<div class="routine-empty">任务读取失败：' + escapeText(e.message || '') + '</div>';
    }
}

function renderRoutineSourceTasks() {
    const box = document.getElementById('routine-task-source-list');
    if (!box) return;
    const status = document.getElementById('routine-task-status')?.value || '';
    const rows = sourceTasks.filter((task) => status === '' || String(task.status) === status);
    box.innerHTML = rows.length ? rows.map((task) => (
        '<label class="routine-task-check">' +
        '<input type="checkbox" value="' + task.id + '">' +
        '<span><strong>' + escapeText(task.title || '未命名任务') + '</strong><em>' + statusLabel(task.status) + ' · ' + (task.deadline ? String(task.deadline).replace('T', ' ').slice(0, 16) : '无 DDL') + '</em></span>' +
        '</label>'
    )).join('') : '<div class="routine-empty">暂无符合条件的任务。</div>';
}

async function createRoutinesFromTasks() {
    const ids = Array.from(document.querySelectorAll('#routine-task-source-list input:checked')).map((input) => String(input.value));
    if (!ids.length) {
        showToast('请先勾选任务', 'warning');
        return;
    }
    const common = {
        frequency: document.getElementById('src-frequency').value,
        daysOfWeek: collectWeekdaysFrom('#source-weekday-picker'),
        startDate: document.getElementById('src-start').value,
        endDate: document.getElementById('src-end').value,
        preferredTime: document.getElementById('src-time').value || '08:00',
        durationMinutes: parseInt(document.getElementById('src-duration').value, 10) || 45,
        reminderEnabled: document.getElementById('src-reminder').value === 'true',
        reminderOffsets: [0]
    };
    try {
        for (const id of ids) {
            const task = sourceTasks.find((item) => String(item.id) === id);
            if (!task) continue;
            await api.post('/routine', {
                ...common,
                title: task.title,
                description: task.description || '',
                quadrant: task.quadrant || 2,
                priority: task.priority || 1,
                taskType: task.taskType || 'course',
                difficulty: task.difficulty || 3
            });
        }
        showToast('已生成 ' + ids.length + ' 个例行计划', 'success');
        await loadRoutines();
    } catch (e) {
        showToast(e.message || '生成失败', 'error');
    }
}

function renderRoutine(routine) {
    const row = document.createElement('article');
    row.className = 'routine-card';
    row.innerHTML =
        '<div class="routine-card-main">' +
        '<strong>' + escapeText(routine.title || '未命名') + '</strong>' +
        '<p>' + escapeText(routine.description || '无说明') + '</p>' +
        '<div class="routine-meta">' +
        '<span>' + escapeText(routine.frequency === 'WEEKLY' ? daysLabel(routine.daysOfWeek) : '每天') + '</span>' +
        '<span>' + escapeText((routine.startDate || '') + ' 至 ' + (routine.endDate || '长期')) + '</span>' +
        '<span>' + escapeText((routine.preferredTime || '08:00').substring(0, 5)) + '</span>' +
        '<span>' + escapeText((routine.durationMinutes || 45) + ' 分钟') + '</span>' +
        (routine.reminderEnabled ? '<span>早八提醒</span>' : '') +
        '</div>' +
        '</div>' +
        '<button type="button" class="routine-delete">删除</button>';
    row.querySelector('.routine-delete').addEventListener('click', async () => {
        if (!window.confirm('删除这个例行计划？')) return;
        try {
            await api.delete('/routine/' + routine.id);
            showToast('已删除例行计划', 'success');
            await loadRoutines();
        } catch (e) {
            showToast(e.message || '删除失败', 'error');
        }
    });
    return row;
}

document.getElementById('routine-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
        title: document.getElementById('rt-title').value.trim(),
        description: document.getElementById('rt-desc').value.trim(),
        frequency: document.getElementById('rt-frequency').value,
        daysOfWeek: collectWeekdays(),
        startDate: document.getElementById('rt-start').value,
        endDate: document.getElementById('rt-end').value,
        preferredTime: document.getElementById('rt-time').value || '08:00',
        durationMinutes: parseInt(document.getElementById('rt-duration').value, 10) || 45,
        quadrant: parseInt(document.getElementById('rt-quadrant').value, 10) || 2,
        priority: 1,
        taskType: 'course',
        difficulty: 3,
        reminderEnabled: document.getElementById('rt-reminder').checked,
        reminderOffsets: [0]
    };
    try {
        await api.post('/routine', body);
        showToast('例行计划已保存', 'success');
        e.target.reset();
        setDefaultDates();
        await loadRoutines();
    } catch (err) {
        showToast(err.message || '保存失败', 'error');
    }
});

document.getElementById('routine-refresh')?.addEventListener('click', loadRoutines);
document.getElementById('routine-task-status')?.addEventListener('change', renderRoutineSourceTasks);
document.getElementById('btn-refresh-routine-tasks')?.addEventListener('click', loadRoutineSourceTasks);
document.getElementById('btn-create-routines-from-tasks')?.addEventListener('click', createRoutinesFromTasks);

function setDefaultDates() {
    const start = document.getElementById('rt-start');
    const end = document.getElementById('rt-end');
    const sourceStart = document.getElementById('src-start');
    const sourceEnd = document.getElementById('src-end');
    const today = new Date();
    if (start) start.value = dateInput(today);
    if (end) end.value = dateInput(addDays(today, 29));
    if (sourceStart) sourceStart.value = dateInput(today);
    if (sourceEnd) sourceEnd.value = dateInput(addDays(today, 29));
}

document.addEventListener('DOMContentLoaded', () => {
    setDefaultDates();
    loadRoutines();
    loadRoutineSourceTasks();
});
