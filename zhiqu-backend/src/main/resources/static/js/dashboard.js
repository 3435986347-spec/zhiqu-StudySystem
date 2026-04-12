checkAuth();
renderNavbar('navbar');

let allTasksFlat = [];

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

async function loadQuadrants() {
    const res = await api.get('/task/quadrant');
    const data = res.data || {};
    const keys = ['q1', 'q2', 'q3', 'q4'];
    allTasksFlat = [];
    keys.forEach((k) => {
        const list = data[k] || [];
        list.forEach((t) => allTasksFlat.push(t));
    });
    setPomodoroTasks(allTasksFlat);
    if (typeof refreshCalendar === 'function') refreshCalendar(allTasksFlat);

    for (let q = 1; q <= 4; q++) {
        const list = data['q' + q] || [];
        const ul = document.getElementById('quad-list-' + q);
        if (!ul) continue;
        ul.innerHTML = '';
        if (!list.length) {
            ul.innerHTML = '<li class="empty-hint">暂无任务</li>';
            continue;
        }
        list.forEach((task) => {
            ul.appendChild(renderTaskMini(task));
        });
    }
    checkReminders(allTasksFlat);
}

function renderTaskMini(task) {
    const li = document.createElement('li');
    li.className = 'task-mini';
    const dl = task.deadline ? formatDateTime(task.deadline) : '无截止';
    const rt = task.reminderTime ? formatDateTime(task.reminderTime) : '无提醒';
    li.innerHTML =
        '<div class="title"></div>' +
        '<div class="meta">' +
        '<span class="' +
        priorityTagClass(task.priority) +
        '">' +
        priorityLabel(task.priority) +
        '</span> ' +
        '<span class="' +
        statusTagClass(task.status) +
        '">' +
        statusLabel(task.status) +
        '</span><br>截止：' +
        dl +
        '<br>提醒：' +
        rt +
        '</div>';
    li.querySelector('.title').textContent = task.title;
    const sel = document.createElement('select');
    sel.className = 'status-select';
    [
        [0, '待办'],
        [1, '进行中'],
        [2, '已完成']
    ].forEach(([v, lab]) => {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = lab;
        if (task.status === v) o.selected = true;
        sel.appendChild(o);
    });
    sel.addEventListener('change', async () => {
        const st = parseInt(sel.value, 10);
        try {
            await api.put('/task/' + task.id + '/status?status=' + st, null);
            showToast('状态已更新', 'success');
            await loadQuadrants();
        } catch (e) {
            showToast(e.message || '更新失败', 'error');
            sel.value = String(task.status);
        }
    });
    li.appendChild(sel);
    return li;
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

document.getElementById('btn-new-task')?.addEventListener('click', openTaskModal);
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
    const deadline = toIsoLocalDateTime(document.getElementById('nt-deadline').value);
    const reminderTime = toIsoLocalDateTime(document.getElementById('nt-reminder').value);
    const body = {
        title,
        description,
        quadrant,
        priority,
        status: 0,
        deadline,
        reminderTime
    };
    try {
        await api.post('/task', body);
        showToast('任务已创建', 'success');
        closeTaskModal();
        await loadQuadrants();
    } catch (err) {
        showToast(err.message || '创建失败', 'error');
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof initCalendar === 'function') initCalendar();
    initPomodoro();
    try {
        await loadQuadrants();
    } catch (e) {
        showToast(e.message || '加载失败', 'error');
    }
});
