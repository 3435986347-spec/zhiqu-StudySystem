checkAuth();
renderNavbar('navbar');

function toIsoLocalDateTime(val) {
    if (!val) return null;
    const s = val.trim();
    if (!s) return null;
    return s.length === 16 ? s + ':00' : s;
}

function buildQuery() {
    const params = new URLSearchParams();
    const q = document.getElementById('f-quadrant').value;
    const st = document.getElementById('f-status').value;
    const pr = document.getElementById('f-priority').value;
    const sortBy = document.getElementById('f-sortBy').value;
    const sortOrder = document.getElementById('f-sortOrder').value;
    if (q) params.set('quadrant', q);
    if (st !== '') params.set('status', st);
    if (pr !== '') params.set('priority', pr);
    if (sortBy) params.set('sortBy', sortBy);
    if (sortOrder) params.set('sortOrder', sortOrder);
    const qs = params.toString();
    return qs ? '/task/list?' + qs : '/task/list';
}

async function loadTasks() {
    const res = await api.get(buildQuery());
    const list = res.data || [];
    const tbody = document.getElementById('task-tbody');
    tbody.innerHTML = '';
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#909399">暂无数据</td></tr>';
        return;
    }
    list.forEach((task) => {
        const tr = document.createElement('tr');
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
                await loadTasks();
            } catch (e) {
                showToast(e.message || '失败', 'error');
                sel.value = String(task.status);
            }
        });
        const btnEdit = document.createElement('button');
        btnEdit.type = 'button';
        btnEdit.className = 'btn btn-default';
        btnEdit.style.marginRight = '6px';
        btnEdit.textContent = '编辑';
        btnEdit.addEventListener('click', () => openEdit(task));
        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'btn btn-danger';
        btnDel.textContent = '删除';
        btnDel.addEventListener('click', async () => {
            const ok = await showConfirm('确定删除此任务？');
            if (!ok) return;
            try {
                await api.delete('/task/' + task.id);
                showToast('已删除', 'success');
                await loadTasks();
            } catch (e) {
                showToast(e.message || '删除失败', 'error');
            }
        });

        tr.innerHTML =
            '<td></td><td></td><td></td><td></td><td></td><td></td><td></td>';
        const cells = tr.querySelectorAll('td');
        cells[0].textContent = task.title;
        cells[1].textContent = quadrantLabel(task.quadrant);
        cells[2].innerHTML = '<span class="' + priorityTagClass(task.priority) + '">' + priorityLabel(task.priority) + '</span>';
        cells[3].innerHTML = '<span class="' + statusTagClass(task.status) + '">' + statusLabel(task.status) + '</span>';
        cells[4].textContent = formatDateTime(task.deadline);
        cells[5].textContent = formatDateTime(task.reminderTime);
        cells[6].innerHTML = '';
        cells[6].appendChild(btnEdit);
        cells[6].appendChild(document.createTextNode(' '));
        cells[6].appendChild(sel);
        cells[6].appendChild(document.createElement('br'));
        cells[6].appendChild(btnDel);
        tbody.appendChild(tr);
    });
}

function openEdit(task) {
    document.getElementById('et-id').value = String(task.id);
    document.getElementById('et-title').value = task.title || '';
    document.getElementById('et-desc').value = task.description || '';
    document.getElementById('et-quadrant').value = String(task.quadrant || 1);
    document.getElementById('et-priority').value = String(task.priority != null ? task.priority : 0);
    document.getElementById('et-status').value = String(task.status != null ? task.status : 0);
    document.getElementById('et-deadline').value = toDatetimeLocalValue(task.deadline);
    document.getElementById('et-reminder').value = toDatetimeLocalValue(task.reminderTime);
    document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEdit() {
    document.getElementById('edit-modal').classList.add('hidden');
}

function openCreate() {
    document.getElementById('form-create-task').reset();
    document.getElementById('create-modal').classList.remove('hidden');
}

function closeCreate() {
    document.getElementById('create-modal').classList.add('hidden');
}

document.getElementById('btn-query').addEventListener('click', () => loadTasks().catch((e) => showToast(e.message, 'error')));
document.getElementById('btn-new').addEventListener('click', openCreate);
document.getElementById('edit-modal-close').addEventListener('click', closeEdit);
document.getElementById('edit-cancel').addEventListener('click', closeEdit);
document.getElementById('create-modal-close').addEventListener('click', closeCreate);
document.getElementById('create-cancel').addEventListener('click', closeCreate);
document.getElementById('edit-modal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeEdit();
});
document.getElementById('create-modal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeCreate();
});

document.getElementById('form-edit-task').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('et-id').value;
    const body = {
        title: document.getElementById('et-title').value.trim(),
        description: document.getElementById('et-desc').value.trim() || null,
        quadrant: parseInt(document.getElementById('et-quadrant').value, 10),
        priority: parseInt(document.getElementById('et-priority').value, 10),
        status: parseInt(document.getElementById('et-status').value, 10),
        deadline: toIsoLocalDateTime(document.getElementById('et-deadline').value),
        reminderTime: toIsoLocalDateTime(document.getElementById('et-reminder').value)
    };
    try {
        await api.put('/task/' + id, body);
        showToast('已保存', 'success');
        closeEdit();
        await loadTasks();
    } catch (err) {
        showToast(err.message || '失败', 'error');
    }
});

document.getElementById('form-create-task').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
        title: document.getElementById('ct-title').value.trim(),
        description: document.getElementById('ct-desc').value.trim() || null,
        quadrant: parseInt(document.getElementById('ct-quadrant').value, 10),
        priority: parseInt(document.getElementById('ct-priority').value, 10),
        status: 0,
        deadline: toIsoLocalDateTime(document.getElementById('ct-deadline').value),
        reminderTime: toIsoLocalDateTime(document.getElementById('ct-reminder').value)
    };
    try {
        await api.post('/task', body);
        showToast('已创建', 'success');
        closeCreate();
        await loadTasks();
    } catch (err) {
        showToast(err.message || '失败', 'error');
    }
});

document.addEventListener('DOMContentLoaded', () => {
    loadTasks().catch((e) => showToast(e.message, 'error'));
});
