checkAuth();
renderNavbar('navbar');

let sharedPlans = [];
let selectedPlanId = null;
let selectedPlanDetail = null;
let selectedApplyDate = today();
let datePickerMonth = monthStart(new Date());
let shareTasks = [];
let shareRoutines = [];
let sharedPlanEventSource = null;
let sharedPlanPoller = null;
const selectedShareTasks = new Map();
const selectedShareRoutines = new Map();

document.addEventListener('DOMContentLoaded', () => {
    bindSharedPlanEvents();
    loadPlanCategories();
    loadSharedPlans();
    startSharedPlanEvents();
});

function bindSharedPlanEvents() {
    document.getElementById('plan-category')?.addEventListener('change', loadSharedPlans);
    document.getElementById('plan-sort')?.addEventListener('change', loadSharedPlans);
    document.getElementById('plan-order')?.addEventListener('change', loadSharedPlans);
    document.getElementById('btn-refresh-plans')?.addEventListener('click', loadSharedPlans);
    document.getElementById('btn-open-share')?.addEventListener('click', () => toggleShareModal(true));
    document.getElementById('share-modal-close')?.addEventListener('click', () => toggleShareModal(false));
    document.getElementById('share-cancel')?.addEventListener('click', () => toggleShareModal(false));
    document.getElementById('share-plan-form')?.addEventListener('submit', submitSharedPlan);
    document.querySelectorAll('[data-share-task-status]').forEach((btn) => {
        btn.addEventListener('click', () => setShareTaskStatus(btn.dataset.shareTaskStatus || ''));
    });
    document.getElementById('btn-refresh-share-source')?.addEventListener('click', loadShareSources);

    document.getElementById('plan-detail-close')?.addEventListener('click', closePlanDetailModal);
    document.getElementById('detail-cancel')?.addEventListener('click', closePlanDetailModal);
    document.querySelector('[data-close-detail]')?.addEventListener('click', closePlanDetailModal);
    document.getElementById('btn-apply-plan')?.addEventListener('click', applySelectedPlan);
    document.getElementById('btn-like-plan')?.addEventListener('click', toggleSelectedPlanLike);
    document.getElementById('plan-date-trigger')?.addEventListener('click', toggleDatePicker);
    document.getElementById('plan-calendar-popover')?.addEventListener('click', handleCalendarClick);
    document.addEventListener('keydown', handleGlobalKeydown);
}

async function loadSharedPlans() {
    const category = document.getElementById('plan-category')?.value || '';
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    params.set('sort', document.getElementById('plan-sort')?.value || 'createdAt');
    params.set('order', document.getElementById('plan-order')?.value || 'desc');
    const res = await api.get('/shared-plans?' + params.toString());
    sharedPlans = res.data || [];
    selectedPlanId = sharedPlans.some((item) => Number(item.id) === Number(selectedPlanId)) ? selectedPlanId : null;
    renderSharedPlanList();
}

function renderSharedPlanList() {
    const list = document.getElementById('shared-plan-list');
    const count = document.getElementById('plan-count');
    if (count) count.textContent = sharedPlans.length + ' 个';
    if (!list) return;
    list.innerHTML = sharedPlans.map((plan, index) => (
        '<button type="button" class="shared-plan-card' + (Number(plan.id) === Number(selectedPlanId) ? ' active' : '') + '" data-id="' + plan.id + '">' +
        '<span class="shared-plan-number">' + String(index + 1).padStart(2, '0') + '</span>' +
        '<strong>' + escapeHtml(plan.title || '未命名计划') + '</strong>' +
        '<span class="shared-plan-arrow">♡ ' + escapeHtml(plan.likeCount || 0) + '</span>' +
        '</button>'
    )).join('') || '<div class="empty-line">暂无已审核计划模板。</div>';
    list.querySelectorAll('[data-id]').forEach((btn) => {
        btn.addEventListener('click', () => openSharedPlanDetail(btn.dataset.id));
    });
}

async function openSharedPlanDetail(id) {
    selectedPlanId = Number(id);
    renderSharedPlanList();
    const res = await api.get('/shared-plans/' + selectedPlanId);
    selectedPlanDetail = res.data || {};
    selectedApplyDate = today();
    datePickerMonth = monthStart(parseDate(selectedApplyDate));
    renderSharedPlanDetail(selectedPlanDetail);
    openPlanDetailModal();
}

function openPlanDetailModal() {
    document.getElementById('plan-detail-modal')?.classList.remove('hidden');
    document.body.classList.add('modal-open');
}

function closePlanDetailModal() {
    closeDatePicker();
    document.getElementById('plan-detail-modal')?.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function renderSharedPlanDetail(plan) {
    const tasks = plan.tasks || [];
    const routines = plan.routines || [];
    setText('detail-modal-title', plan.title || '计划详情');
    setText('detail-modal-kicker', categoryLabel(plan.category) + (plan.targetAudience ? ' / ' + plan.targetAudience : ''));
    renderPlanCreator(plan.creator);
    const meta = document.getElementById('detail-modal-meta');
    if (meta) {
        meta.innerHTML =
            '<span class="shared-pill">' + categoryLabel(plan.category) + '</span>' +
            '<span class="shared-pill">一次性任务 ' + tasks.length + '</span>' +
            '<span class="shared-pill">例行计划 ' + routines.length + '</span>' +
            '<span class="shared-pill">已套用 ' + escapeHtml(plan.applyCount || 0) + ' 次</span>' +
            (plan.targetAudience ? '<span class="shared-pill">' + escapeHtml(plan.targetAudience) + '</span>' : '');
    }
    renderLikeButton(plan);
    const body = document.getElementById('plan-detail-body');
    if (body) {
        body.innerHTML =
            '<section class="detail-section detail-summary">' +
            '<h3>概要</h3>' +
            '<p>' + escapeHtml(plan.description || '暂无说明') + '</p>' +
            '</section>' +
            detailTableSection('一次性任务', tasks, ['任务', '相对截止', '时间', '提醒'], renderTaskTemplateRow) +
            detailTableSection('例行计划', routines, ['计划', '周期', '日期范围', '时间'], renderRoutineTemplateRow);
    }
    renderApplyDate();
}

function renderLikeButton(plan) {
    const button = document.getElementById('btn-like-plan');
    if (!button) return;
    const liked = !!plan.liked;
    button.setAttribute('aria-pressed', liked ? 'true' : 'false');
    button.innerHTML =
        '<svg class="heart-icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M12 21s-6.9-4.4-9.5-8.5C.6 9.5 1.5 5.7 4.6 4.4c2-.9 4-.3 5.4 1.2L12 7.7l2-2.1c1.4-1.5 3.4-2.1 5.4-1.2 3.1 1.3 4 5.1 2.1 8.1C18.9 16.6 12 21 12 21z"></path>' +
        '</svg>' +
        '<span class="like-count">' + escapeHtml(plan.likeCount || 0) + '</span>';
}

async function toggleSelectedPlanLike() {
    if (!selectedPlanId) return;
    const res = await api.post('/shared-plans/' + selectedPlanId + '/like', {});
    selectedPlanDetail = Object.assign({}, selectedPlanDetail || {}, res.data || {});
    renderLikeButton(selectedPlanDetail);
    await loadSharedPlans();
}

async function loadPlanCategories() {
    try {
        const res = await api.get('/shared-plans/categories');
        const rows = res.data || [];
        fillCategorySelect('plan-category', rows, true);
        fillCategorySelect('share-category', rows, false);
    } catch (e) {
        // Keep existing options.
    }
}

function fillCategorySelect(id, rows, includeAll) {
    const select = document.getElementById(id);
    if (!select || !rows.length) return;
    const current = select.value;
    select.innerHTML = (includeAll ? '<option value="">全部</option>' : '') +
        rows.map((item) => '<option value="' + escapeHtml(item.key || '') + '">' + escapeHtml(item.name || item.key || '通用') + '</option>').join('');
    if ([...select.options].some((option) => option.value === current)) {
        select.value = current;
    }
}

function startSharedPlanEvents() {
    if (!window.EventSource) {
        sharedPlanPoller = setInterval(loadSharedPlans, 12000);
        return;
    }
    try {
        sharedPlanEventSource = new EventSource('/api/shared-plans/events');
        sharedPlanEventSource.addEventListener('shared-plan', loadSharedPlans);
        sharedPlanEventSource.onerror = function () {
            if (!sharedPlanPoller) sharedPlanPoller = setInterval(loadSharedPlans, 12000);
        };
    } catch (e) {
        sharedPlanPoller = setInterval(loadSharedPlans, 12000);
    }
}

window.addEventListener('beforeunload', function () {
    if (sharedPlanEventSource) sharedPlanEventSource.close();
    if (sharedPlanPoller) clearInterval(sharedPlanPoller);
});

function renderPlanCreator(creator) {
    const box = document.getElementById('detail-modal-creator');
    if (!box) return;
    const nickname = String(creator?.nickname || '匿名用户').trim() || '匿名用户';
    const avatar = String(creator?.avatar || '').trim();
    const avatarNode = avatar
        ? '<img src="' + escapeHtml(avatar) + '" alt="' + escapeHtml(nickname) + '">'
        : '<span aria-hidden="true">' + escapeHtml(creatorInitial(nickname)) + '</span>';
    box.innerHTML =
        '<div class="plan-creator-avatar">' + avatarNode + '</div>' +
        '<div class="plan-creator-copy">' +
        '<span>来自</span>' +
        '<strong>' + escapeHtml(nickname) + '</strong>' +
        '</div>';
}

function creatorInitial(value) {
    const chars = Array.from(String(value || '').trim());
    return chars.length ? chars[0].toUpperCase() : '知';
}

function detailTableSection(title, items, headers, rowRenderer) {
    if (!items.length) {
        return '<section class="detail-section"><h3>' + title + '</h3><div class="empty-line">暂无</div></section>';
    }
    return '<section class="detail-section">' +
        '<div class="detail-section-head"><h3>' + title + '</h3><span>' + items.length + ' 项</span></div>' +
        '<div class="detail-table-wrap"><table class="detail-template-table"><thead><tr>' +
        headers.map((item) => '<th>' + item + '</th>').join('') +
        '</tr></thead><tbody>' + items.map(rowRenderer).join('') + '</tbody></table></div>' +
        '</section>';
}

function renderTaskTemplateRow(task) {
    return '<tr>' +
        '<td><strong>' + escapeHtml(task.title || '未命名任务') + '</strong>' + renderDescription(task.description) + '</td>' +
        '<td>+' + escapeHtml(task.relativeDeadlineDay ?? '-') + ' 天</td>' +
        '<td>' + escapeHtml(task.preferredTime || '23:59') + '</td>' +
        '<td>' + offsetsText(task.reminderOffsets) + '</td>' +
        '</tr>';
}

function renderRoutineTemplateRow(routine) {
    return '<tr>' +
        '<td><strong>' + escapeHtml(routine.title || '未命名例行计划') + '</strong>' + renderDescription(routine.description) + '</td>' +
        '<td>' + frequencyLabel(routine.frequency) + '<br><span>' + weekDaysText(routine.daysOfWeek) + '</span></td>' +
        '<td>+' + escapeHtml(routine.relativeStartDay || 0) + ' 到 +' + escapeHtml(routine.relativeEndDay ?? 29) + ' 天</td>' +
        '<td>' + escapeHtml(routine.preferredTime || '08:00') + '</td>' +
        '</tr>';
}

function renderDescription(value) {
    return value ? '<p>' + escapeHtml(value) + '</p>' : '';
}

function renderApplyDate() {
    const trigger = document.getElementById('plan-date-trigger');
    if (trigger) {
        trigger.innerHTML =
            '<span>开始日期</span>' +
            '<strong>' + escapeHtml(selectedApplyDate) + '</strong>' +
            '<i aria-hidden="true">⌄</i>';
    }
    renderDatePicker();
}

function toggleDatePicker() {
    const popover = document.getElementById('plan-calendar-popover');
    if (!popover) return;
    const isHidden = popover.classList.contains('hidden');
    popover.classList.toggle('hidden', !isHidden);
    if (isHidden) renderDatePicker();
}

function closeDatePicker() {
    document.getElementById('plan-calendar-popover')?.classList.add('hidden');
}

function renderDatePicker() {
    const popover = document.getElementById('plan-calendar-popover');
    if (!popover) return;
    const year = datePickerMonth.getFullYear();
    const month = datePickerMonth.getMonth();
    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const cells = [];
    const todayText = today();
    for (let i = 0; i < 42; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const dateText = formatDate(d);
        const classes = [
            'calendar-day',
            d.getMonth() === month ? '' : 'muted',
            dateText === selectedApplyDate ? 'selected' : '',
            dateText === todayText ? 'today' : ''
        ].filter(Boolean).join(' ');
        cells.push('<button type="button" class="' + classes + '" data-calendar-date="' + dateText + '">' + d.getDate() + '</button>');
    }
    popover.innerHTML =
        '<div class="calendar-head">' +
        '<button type="button" data-calendar-action="prev">‹</button>' +
        '<strong>' + year + ' 年 ' + String(month + 1).padStart(2, '0') + ' 月</strong>' +
        '<button type="button" data-calendar-action="next">›</button>' +
        '</div>' +
        '<div class="calendar-weekdays"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>' +
        '<div class="calendar-grid">' + cells.join('') + '</div>' +
        '<div class="calendar-foot"><button type="button" data-calendar-action="today">回到今天</button></div>';
}

function handleCalendarClick(event) {
    const action = event.target.closest('[data-calendar-action]');
    if (action) {
        const type = action.dataset.calendarAction;
        if (type === 'prev') datePickerMonth.setMonth(datePickerMonth.getMonth() - 1);
        if (type === 'next') datePickerMonth.setMonth(datePickerMonth.getMonth() + 1);
        if (type === 'today') {
            selectedApplyDate = today();
            datePickerMonth = monthStart(parseDate(selectedApplyDate));
        }
        renderApplyDate();
        return;
    }
    const dateButton = event.target.closest('[data-calendar-date]');
    if (dateButton) {
        selectedApplyDate = dateButton.dataset.calendarDate;
        datePickerMonth = monthStart(parseDate(selectedApplyDate));
        renderApplyDate();
        closeDatePicker();
    }
}

function handleGlobalKeydown(event) {
    if (event.key !== 'Escape') return;
    if (!document.getElementById('plan-calendar-popover')?.classList.contains('hidden')) {
        closeDatePicker();
        return;
    }
    if (!document.getElementById('plan-detail-modal')?.classList.contains('hidden')) {
        closePlanDetailModal();
    }
}

async function applySelectedPlan() {
    if (!selectedPlanId) return;
    const ok = await showConfirm('确认把这个模板从 ' + selectedApplyDate + ' 开始套用到你的学习日历吗？');
    if (!ok) return;
    const res = await api.post('/shared-plans/' + selectedPlanId + '/apply', { startDate: selectedApplyDate });
    showToast('已生成 ' + (res.data.createdTasks || 0) + ' 个任务、' + (res.data.createdRoutines || 0) + ' 个例行计划', 'success');
    closePlanDetailModal();
    await loadSharedPlans();
}

async function submitSharedPlan(event) {
    event.preventDefault();
    const payload = {
        title: valueOf('share-title'),
        category: valueOf('share-category') || 'GENERAL',
        targetAudience: valueOf('share-audience'),
        description: valueOf('share-description'),
        shareConsent: document.getElementById('share-consent')?.checked === true,
        taskIds: Array.from(selectedShareTasks.keys()).map(Number),
        routineIds: Array.from(selectedShareRoutines.keys()).map(Number),
        itemsConfig: collectShareItemConfig()
    };
    if (!payload.taskIds.length && !payload.routineIds.length) {
        showToast('至少选择一个任务或例行计划', 'warning');
        return;
    }
    await api.post('/shared-plans/from-existing', payload);
    showToast('已提交审核，通过后会出现在参考计划里', 'success');
    document.getElementById('share-plan-form')?.reset();
    selectedShareTasks.clear();
    selectedShareRoutines.clear();
    renderShareSources();
    renderSelectedPreview();
    toggleShareModal(false);
}

async function loadShareSources() {
    try {
        const [taskRes, routineRes] = await Promise.all([
            api.get('/task/list?sortBy=updatedAt&sortOrder=desc'),
            api.get('/routine/list')
        ]);
        shareTasks = taskRes.data || [];
        shareRoutines = routineRes.data || [];
        renderShareSources();
        renderSelectedPreview();
    } catch (e) {
        showToast(e.message || '读取任务失败', 'error');
    }
}

function renderShareSources() {
    renderShareTaskList();
    renderShareRoutineList();
}

function renderShareTaskList() {
    const box = document.getElementById('share-task-list');
    if (!box) return;
    const status = currentShareTaskStatus();
    const rows = shareTasks.filter((task) => status === '' || String(task.status) === status);
    box.innerHTML = rows.length ? rows.map((task) => {
        const id = String(task.id);
        const checked = selectedShareTasks.has(id) ? 'checked' : '';
        return '<label class="share-check-row">' +
            '<input type="checkbox" data-share-task="' + id + '" ' + checked + '>' +
            '<span><strong>' + escapeHtml(task.title || '未命名任务') + '</strong><em>' + statusLabel(task.status) + ' · ' + (task.deadline ? shortDate(task.deadline) : '无 DDL') + '</em></span>' +
            '</label>';
    }).join('') : '<div class="empty-line">暂无任务。</div>';
    box.querySelectorAll('[data-share-task]').forEach((input) => {
        input.addEventListener('change', () => {
            const id = input.dataset.shareTask;
            if (input.checked) {
                selectedShareTasks.set(id, shareTasks.find((item) => String(item.id) === id));
            } else {
                selectedShareTasks.delete(id);
            }
            renderSelectedPreview();
        });
    });
}

function setShareTaskStatus(status) {
    document.querySelectorAll('[data-share-task-status]').forEach((btn) => {
        const active = (btn.dataset.shareTaskStatus || '') === String(status || '');
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    renderShareTaskList();
}

function currentShareTaskStatus() {
    return document.querySelector('[data-share-task-status].active')?.dataset.shareTaskStatus || '';
}

function renderShareRoutineList() {
    const box = document.getElementById('share-routine-list');
    if (!box) return;
    box.innerHTML = shareRoutines.length ? shareRoutines.map((routine) => {
        const id = String(routine.id);
        const checked = selectedShareRoutines.has(id) ? 'checked' : '';
        return '<label class="share-check-row">' +
            '<input type="checkbox" data-share-routine="' + id + '" ' + checked + '>' +
            '<span><strong>' + escapeHtml(routine.title || '未命名例行计划') + '</strong><em>' + frequencyLabel(routine.frequency) + ' · ' + (routine.preferredTime || '08:00') + '</em></span>' +
            '</label>';
    }).join('') : '<div class="empty-line">暂无例行计划。</div>';
    box.querySelectorAll('[data-share-routine]').forEach((input) => {
        input.addEventListener('change', () => {
            const id = input.dataset.shareRoutine;
            if (input.checked) {
                selectedShareRoutines.set(id, shareRoutines.find((item) => String(item.id) === id));
            } else {
                selectedShareRoutines.delete(id);
            }
            renderSelectedPreview();
        });
    });
}

function renderSelectedPreview() {
    const box = document.getElementById('share-selected-preview');
    if (!box) return;
    const taskRows = Array.from(selectedShareTasks.values()).filter(Boolean).map((task) => {
        const key = 'task-' + task.id;
        return '<div class="share-selected-row" data-selected-key="' + key + '">' +
            '<strong>' + escapeHtml(task.title || '未命名任务') + '</strong>' +
            '<div class="share-config-row">' +
            '<label>开始+<input data-config="relativeStartDay" value="0" type="number"></label>' +
            '<label>截止+<input data-config="relativeDeadlineDay" value="7" type="number"></label>' +
            '<label>时间<input data-config="preferredTime" value="' + escapeHtml(timeFromDate(task.deadline) || '23:59') + '"></label>' +
            '<label>提醒<input data-config="reminderOffsets" value="7,2"></label>' +
            '</div>' +
            '</div>';
    });
    const routineRows = Array.from(selectedShareRoutines.values()).filter(Boolean).map((routine) => {
        const key = 'routine-' + routine.id;
        return '<div class="share-selected-row" data-selected-key="' + key + '">' +
            '<strong>' + escapeHtml(routine.title || '未命名例行计划') + '</strong>' +
            '<div class="share-config-row">' +
            '<label>开始+<input data-config="relativeStartDay" value="0" type="number"></label>' +
            '<label>结束+<input data-config="relativeEndDay" value="29" type="number"></label>' +
            '<label>时间<input data-config="preferredTime" value="' + escapeHtml(routine.preferredTime || '08:00') + '"></label>' +
            '</div>' +
            '</div>';
    });
    box.innerHTML = taskRows.concat(routineRows).join('') || '<div class="empty-line">勾选任务或例行计划后，会在这里调整相对时间。</div>';
}

function collectShareItemConfig() {
    const result = {};
    document.querySelectorAll('[data-selected-key]').forEach((row) => {
        const key = row.dataset.selectedKey;
        const item = {};
        row.querySelectorAll('[data-config]').forEach((input) => {
            const name = input.dataset.config;
            if (name === 'reminderOffsets') {
                item[name] = parseOffsets(input.value || '');
            } else if (name.startsWith('relative')) {
                item[name] = parseNumber(input.value, 0);
            } else {
                item[name] = input.value;
            }
        });
        result[key] = item;
    });
    return result;
}

function toggleShareModal(show) {
    document.getElementById('share-modal')?.classList.toggle('hidden', !show);
    if (show) loadShareSources();
}

function categoryLabel(value) {
    const map = {
        EXAM: '考试备考',
        COMPUTER: '计算机学习',
        LANGUAGE: '语言学习',
        GENERAL: '通用规划'
    };
    return map[String(value || '').toUpperCase()] || '通用规划';
}

function frequencyLabel(value) {
    return String(value || 'DAILY').toUpperCase() === 'WEEKLY' ? '每周' : '每天';
}

function offsetsText(value) {
    const offsets = Array.isArray(value) ? value : [];
    return offsets.length ? offsets.map((item) => '提前' + item + '天').join(' / ') : '自动';
}

function weekDaysText(value) {
    const names = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };
    const days = Array.isArray(value) ? value : [];
    if (days.length === 7) return '每天';
    return days.map((day) => names[day] || day).join('、') || '按频率';
}

function parseOffsets(value) {
    return String(value || '')
        .split(',')
        .map((part) => parseNumber(part.trim(), null))
        .filter((item) => item !== null);
}

function parseNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
}

function valueOf(id) {
    return document.getElementById(id)?.value.trim() || '';
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function today() {
    return formatDate(new Date());
}

function parseDate(value) {
    const parts = String(value || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) return new Date();
    return new Date(parts[0], parts[1] - 1, parts[2]);
}

function monthStart(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function formatDate(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function shortDate(value) {
    return value ? String(value).replace('T', ' ').slice(0, 16) : '-';
}

function timeFromDate(value) {
    if (!value) return '';
    const text = String(value).replace('T', ' ');
    const match = text.match(/\s(\d{2}:\d{2})/);
    return match ? match[1] : '';
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
