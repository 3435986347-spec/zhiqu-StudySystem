checkAuth();
renderNavbar('navbar');

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

const TASK_DRAFT_PREFIX = 'zhiqu:task-draft:';
const CREATE_DRAFT_FIELDS = [
    'ct-title', 'ct-desc', 'ct-quadrant', 'ct-priority', 'ct-task-type',
    'ct-difficulty', 'ct-deadline', 'ct-reminder', 'ct-reminder-offsets'
];
const EDIT_DRAFT_FIELDS = [
    'et-version', 'et-title', 'et-desc', 'et-quadrant', 'et-priority', 'et-status',
    'et-task-type', 'et-difficulty', 'et-deadline', 'et-reminder', 'et-reminder-offsets'
];
let activeCreateDraftKey = '';
let activeEditDraftKey = '';
let createDraftTouched = false;
let editDraftTouched = false;

function draftScope() {
    const token = getAuthToken();
    return token ? token.slice(-18) : 'anonymous';
}

function createDraftKey() {
    return TASK_DRAFT_PREFIX + draftScope() + ':create';
}

function editDraftKey(id) {
    return TASK_DRAFT_PREFIX + draftScope() + ':edit:' + id;
}

function createIdempotencyKey() {
    if (!activeCreateDraftKey) {
        activeCreateDraftKey = createDraftKey();
    }
    const key = activeCreateDraftKey + ':idempotency';
    let value = localStorage.getItem(key);
    if (!value) {
        value = 'task-create-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        localStorage.setItem(key, value);
    }
    return value;
}

function clearCreateIdempotencyKey() {
    if (activeCreateDraftKey) {
        localStorage.removeItem(activeCreateDraftKey + ':idempotency');
    }
}

function collectDraftValues(fieldIds) {
    const data = {};
    fieldIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) data[id] = el.value;
    });
    return data;
}

function applyDraftValues(fieldIds, data) {
    fieldIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el && Object.prototype.hasOwnProperty.call(data, id)) {
            el.value = data[id] == null ? '' : data[id];
        }
    });
}

function hasMeaningfulDraft(data) {
    return Object.values(data).some((value) => String(value || '').trim() !== '');
}

function saveDraft(key, fieldIds) {
    if (!key) return;
    const data = collectDraftValues(fieldIds);
    if (!hasMeaningfulDraft(data)) {
        localStorage.removeItem(key);
        return;
    }
    localStorage.setItem(key, JSON.stringify({
        savedAt: new Date().toISOString(),
        data
    }));
}

function restoreDraft(key, fieldIds, bannerId) {
    const banner = document.getElementById(bannerId);
    if (banner) banner.classList.add('hidden');
    if (!key) return false;
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return false;
        const draft = JSON.parse(raw);
        if (!draft || !draft.data) return false;
        applyDraftValues(fieldIds, draft.data);
        if (banner) banner.classList.remove('hidden');
        return true;
    } catch (e) {
        localStorage.removeItem(key);
        return false;
    }
}

function bindDraftAutosave(formId, keyGetter, fieldIds, markTouched) {
    const form = document.getElementById(formId);
    if (!form) return;
    const handler = () => {
        markTouched();
        saveDraft(keyGetter(), fieldIds);
    };
    form.addEventListener('input', handler);
    form.addEventListener('change', handler);
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
    document.getElementById('et-version').value = String(task.version == null ? 0 : task.version);
    document.getElementById('et-title').value = task.title || '';
    document.getElementById('et-desc').value = task.description || '';
    document.getElementById('et-quadrant').value = String(task.quadrant || 1);
    document.getElementById('et-priority').value = String(task.priority != null ? task.priority : 0);
    document.getElementById('et-status').value = String(task.status != null ? task.status : 0);
    document.getElementById('et-task-type').value = task.taskType || 'assignment';
    document.getElementById('et-difficulty').value = String(task.difficulty || 3);
    document.getElementById('et-reminder-offsets').value = '';
    document.getElementById('et-deadline').value = toDatetimeLocalValue(task.deadline);
    document.getElementById('et-reminder').value = toDatetimeLocalValue(task.reminderTime);
    activeEditDraftKey = editDraftKey(task.id);
    restoreDraft(activeEditDraftKey, EDIT_DRAFT_FIELDS, 'edit-draft-banner');
    editDraftTouched = false;
    document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEdit() {
    document.getElementById('edit-modal').classList.add('hidden');
}

function openCreate() {
    document.getElementById('form-create-task').reset();
    activeCreateDraftKey = createDraftKey();
    restoreDraft(activeCreateDraftKey, CREATE_DRAFT_FIELDS, 'create-draft-banner');
    createDraftTouched = false;
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
document.getElementById('create-draft-clear').addEventListener('click', () => {
    if (activeCreateDraftKey) localStorage.removeItem(activeCreateDraftKey);
    clearCreateIdempotencyKey();
    createDraftTouched = false;
    document.getElementById('create-draft-banner').classList.add('hidden');
    showToast('已清除新建草稿', 'success');
});
document.getElementById('edit-draft-clear').addEventListener('click', () => {
    if (activeEditDraftKey) localStorage.removeItem(activeEditDraftKey);
    editDraftTouched = false;
    document.getElementById('edit-draft-banner').classList.add('hidden');
    showToast('已清除编辑草稿', 'success');
});
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
        taskType: document.getElementById('et-task-type').value,
        difficulty: parseInt(document.getElementById('et-difficulty').value, 10),
        reminderOffsets: parseReminderOffsets(document.getElementById('et-reminder-offsets').value),
        deadline: toIsoLocalDateTime(document.getElementById('et-deadline').value),
        reminderTime: toIsoLocalDateTime(document.getElementById('et-reminder').value),
        version: parseInt(document.getElementById('et-version').value || '0', 10)
    };
    try {
        await api.put('/task/' + id, body);
        if (activeEditDraftKey) localStorage.removeItem(activeEditDraftKey);
        editDraftTouched = false;
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
        taskType: document.getElementById('ct-task-type').value,
        difficulty: parseInt(document.getElementById('ct-difficulty').value, 10),
        reminderOffsets: parseReminderOffsets(document.getElementById('ct-reminder-offsets').value),
        status: 0,
        deadline: toIsoLocalDateTime(document.getElementById('ct-deadline').value),
        reminderTime: toIsoLocalDateTime(document.getElementById('ct-reminder').value)
    };
    try {
        await api.post('/task', body, {
            headers: { 'Idempotency-Key': createIdempotencyKey() }
        });
        if (activeCreateDraftKey) localStorage.removeItem(activeCreateDraftKey);
        clearCreateIdempotencyKey();
        createDraftTouched = false;
        showToast('已创建', 'success');
        closeCreate();
        await loadTasks();
    } catch (err) {
        showToast(err.message || '失败', 'error');
    }
});

document.addEventListener('DOMContentLoaded', () => {
    bindDraftAutosave('form-create-task', () => activeCreateDraftKey, CREATE_DRAFT_FIELDS, () => {
        createDraftTouched = true;
    });
    bindDraftAutosave('form-edit-task', () => activeEditDraftKey, EDIT_DRAFT_FIELDS, () => {
        editDraftTouched = true;
    });
    loadTasks().catch((e) => showToast(e.message, 'error'));
});

window.addEventListener('beforeunload', () => {
    if (createDraftTouched) saveDraft(activeCreateDraftKey, CREATE_DRAFT_FIELDS);
    if (editDraftTouched) saveDraft(activeEditDraftKey, EDIT_DRAFT_FIELDS);
});
