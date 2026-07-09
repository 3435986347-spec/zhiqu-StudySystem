checkAuth();
renderNavbar('navbar');

let sharedReviewItems = [];
let selectedSharedPlan = null;
let sharedReviewEventSource = null;
let sharedReviewPoller = null;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const info = await api.get('/auth/info');
        if (!info.data || info.data.role !== 'ADMIN') {
            showToast('无权限访问共享计划审核', 'error');
            setTimeout(() => window.location.href = '/dashboard.html', 800);
            return;
        }
        bindSharedReviewEvents();
        startSharedReviewEvents();
        await loadSharedReviewItems();
        sharedReviewPoller = setInterval(loadSharedReviewItems, 8000);
    } catch (e) {
        showToast(e.message || '共享计划审核加载失败', 'error');
    }
});

window.addEventListener('beforeunload', () => {
    if (sharedReviewEventSource) sharedReviewEventSource.close();
    if (sharedReviewPoller) clearInterval(sharedReviewPoller);
});

function bindSharedReviewEvents() {
    ['shared-review-search', 'shared-review-status', 'shared-review-sort', 'shared-review-order'].forEach((id) => {
        document.getElementById(id)?.addEventListener(id === 'shared-review-search' ? 'input' : 'change', debounce(loadSharedReviewItems, 260));
    });
    document.getElementById('btn-refresh-shared-review')?.addEventListener('click', loadSharedReviewItems);
    document.querySelectorAll('[data-close-shared-review]').forEach((el) => el.addEventListener('click', closeSharedReviewModal));
    document.getElementById('btn-approve-shared-plan')?.addEventListener('click', () => reviewSelectedSharedPlan('APPROVE'));
    document.getElementById('btn-reject-shared-plan')?.addEventListener('click', () => reviewSelectedSharedPlan('REJECT'));
    document.getElementById('btn-delete-shared-plan')?.addEventListener('click', deleteSelectedSharedPlan);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeSharedReviewModal();
    });
}

function startSharedReviewEvents() {
    if (!window.EventSource) return;
    try {
        sharedReviewEventSource = new EventSource('/api/admin/events');
        sharedReviewEventSource.addEventListener('shared-plan', loadSharedReviewItems);
        sharedReviewEventSource.addEventListener('admin', loadSharedReviewItems);
    } catch (e) {
        sharedReviewEventSource = null;
    }
}

async function loadSharedReviewItems() {
    const params = new URLSearchParams();
    const q = valueOf('shared-review-search');
    const status = valueOf('shared-review-status');
    const sort = valueOf('shared-review-sort') || 'createdAt';
    const order = valueOf('shared-review-order') || 'desc';
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    params.set('sort', sort);
    params.set('order', order);
    const res = await api.get('/admin/shared-plans?' + params.toString());
    sharedReviewItems = res.data || [];
    renderSharedReviewList();
    setText('shared-review-refresh-text', '已同步 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
}

function renderSharedReviewList() {
    const box = document.getElementById('shared-review-admin-list');
    if (!box) return;
    box.innerHTML = sharedReviewItems.map((item) => {
        const creator = item.creator || {};
        return '<button type="button" class="shared-review-admin-row" data-id="' + item.id + '">' +
            '<span class="shared-review-row-main">' +
            '<strong>' + escapeHtml(item.title || '未命名模板') + '</strong>' +
            '<em>' + escapeHtml(statusLabel(item.status)) + ' · ' + escapeHtml(item.categoryName || item.category || '通用') + ' · ' + escapeHtml(shortDate(item.createdAt)) + '</em>' +
            '</span>' +
            '<span class="shared-review-row-side">' +
            '<span>' + escapeHtml(creator.nickname || creator.username || '匿名用户') + '</span>' +
            '<span>赞 ' + escapeHtml(item.likeCount || 0) + ' · 套用 ' + escapeHtml(item.applyCount || 0) + '</span>' +
            '</span>' +
            '</button>';
    }).join('') || '<div class="admin-subtle shared-review-empty">暂无共享计划</div>';
    box.querySelectorAll('[data-id]').forEach((button) => {
        button.addEventListener('click', () => openSharedReviewDetail(button.dataset.id));
    });
}

async function openSharedReviewDetail(id) {
    const res = await api.get('/admin/shared-plans/' + id);
    selectedSharedPlan = res.data || {};
    renderSharedReviewDetail(selectedSharedPlan);
    document.getElementById('shared-review-modal')?.classList.remove('hidden');
    document.body.classList.add('modal-open');
}

function closeSharedReviewModal() {
    document.getElementById('shared-review-modal')?.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function renderSharedReviewDetail(plan) {
    const creator = plan.creator || {};
    setText('shared-review-modal-title', plan.title || '计划详情');
    setText('shared-review-modal-kicker', (plan.categoryName || plan.category || '通用') + ' / ' + statusLabel(plan.status));
    const meta = document.getElementById('shared-review-modal-meta');
    if (meta) {
        meta.innerHTML =
            '<span>提交者：' + escapeHtml(creator.nickname || '匿名用户') + (creator.username ? '（' + escapeHtml(creator.username) + '）' : '') + '</span>' +
            '<span>赞数：' + escapeHtml(plan.likeCount || 0) + '</span>' +
            '<span>套用：' + escapeHtml(plan.applyCount || 0) + '</span>' +
            '<span>提交：' + escapeHtml(shortDate(plan.createdAt)) + '</span>';
    }
    const body = document.getElementById('shared-review-modal-body');
    if (!body) return;
    body.innerHTML =
        '<section><h3>概要</h3><p>' + escapeHtml(plan.description || '暂无说明') + '</p>' +
        (plan.targetAudience ? '<p><strong>适用对象：</strong>' + escapeHtml(plan.targetAudience) + '</p>' : '') +
        '</section>' +
        renderTemplateItems('一次性任务', plan.tasks || [], renderTaskRow) +
        renderTemplateItems('例行计划', plan.routines || [], renderRoutineRow) +
        renderReviews(plan.reviews || []);
    updateModalActions(plan.status);
}

function renderTemplateItems(title, items, rowRenderer) {
    if (!items.length) {
        return '<section><h3>' + title + '</h3><div class="admin-subtle">暂无</div></section>';
    }
    return '<section><div class="shared-review-section-head"><h3>' + title + '</h3><span>' + items.length + ' 项</span></div>' +
        '<div class="shared-review-detail-grid">' + items.map(rowRenderer).join('') + '</div></section>';
}

function renderTaskRow(task) {
    return '<article class="shared-review-detail-card">' +
        '<strong>' + escapeHtml(task.title || '未命名任务') + '</strong>' +
        '<p>' + escapeHtml(task.description || '') + '</p>' +
        '<span>截止 +' + escapeHtml(task.relativeDeadlineDay ?? '-') + ' 天 · ' + escapeHtml(task.preferredTime || '23:59') + '</span>' +
        '<span>提醒：' + escapeHtml((task.reminderOffsets || []).join(', ') || '自动') + '</span>' +
        '</article>';
}

function renderRoutineRow(routine) {
    return '<article class="shared-review-detail-card">' +
        '<strong>' + escapeHtml(routine.title || '未命名例行计划') + '</strong>' +
        '<p>' + escapeHtml(routine.description || '') + '</p>' +
        '<span>' + escapeHtml(routine.frequency || 'DAILY') + ' · +' + escapeHtml(routine.relativeStartDay || 0) + ' 至 +' + escapeHtml(routine.relativeEndDay ?? 29) + ' 天</span>' +
        '<span>' + escapeHtml(routine.preferredTime || '08:00') + ' · ' + escapeHtml(routine.durationMinutes || '-') + ' 分钟</span>' +
        '</article>';
}

function renderReviews(reviews) {
    if (!reviews.length) return '';
    return '<section><h3>审核记录</h3>' + reviews.map((review) =>
        '<div class="shared-review-log"><strong>' + escapeHtml(statusLabel(review.action)) + '</strong><span>' + escapeHtml(shortDate(review.createdAt)) + '</span><p>' + escapeHtml(review.note || '') + '</p></div>'
    ).join('') + '</section>';
}

function updateModalActions(status) {
    const pending = status === 'PENDING';
    document.getElementById('btn-approve-shared-plan')?.classList.toggle('hidden', !pending);
    document.getElementById('btn-reject-shared-plan')?.classList.toggle('hidden', !pending);
}

async function reviewSelectedSharedPlan(action) {
    if (!selectedSharedPlan?.id) return;
    let note = '';
    if (action === 'REJECT') {
        note = window.prompt('驳回原因，可留空') || '';
    }
    await api.put('/admin/shared-plans/' + selectedSharedPlan.id + '/review?action=' + action + '&note=' + encodeURIComponent(note));
    showToast(action === 'APPROVE' ? '已通过发布' : '已驳回', 'success');
    closeSharedReviewModal();
    await loadSharedReviewItems();
}

async function deleteSelectedSharedPlan() {
    if (!selectedSharedPlan?.id) return;
    const ok = await showConfirm('确认删除这个共享计划？删除后前台会实时下架。');
    if (!ok) return;
    await api.delete('/admin/shared-plans/' + selectedSharedPlan.id);
    showToast('已删除共享计划', 'success');
    closeSharedReviewModal();
    await loadSharedReviewItems();
}

function statusLabel(value) {
    const map = { PENDING: '待审核', APPROVED: '已发布', REJECTED: '已驳回' };
    return map[value] || value || '未知';
}

function valueOf(id) {
    return document.getElementById(id)?.value.trim() || '';
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function shortDate(value) {
    return value ? String(value).replace('T', ' ').slice(0, 16) : '-';
}

function debounce(fn, wait) {
    let timer = null;
    return function () {
        clearTimeout(timer);
        timer = setTimeout(fn, wait);
    };
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
