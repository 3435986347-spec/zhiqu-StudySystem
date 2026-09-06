checkAuth();
renderNavbar('navbar');

let accountPage = 1;
let accountSize = 20;
let accountPages = 1;
let selectedUser = null;
let currentAdminId = null;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const info = await api.get('/auth/info');
        if (!info.data || info.data.role !== 'ADMIN') {
            showToast('无权访问账号管理', 'error');
            setTimeout(() => {
                window.location.href = '/dashboard.html';
            }, 900);
            return;
        }
        currentAdminId = info.data.id;
        await loadAccounts();
    } catch (e) {
        showToast(e.message || '账号管理加载失败', 'error');
    }
});

document.getElementById('btn-account-search')?.addEventListener('click', () => {
    accountPage = 1;
    loadAccounts().catch((e) => showToast(e.message || '搜索失败', 'error'));
});

document.getElementById('account-keyword')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        accountPage = 1;
        loadAccounts().catch((e) => showToast(e.message || '搜索失败', 'error'));
    }
});

document.getElementById('btn-account-prev')?.addEventListener('click', () => {
    if (accountPage <= 1) return;
    accountPage -= 1;
    loadAccounts().catch((e) => showToast(e.message || '加载失败', 'error'));
});

document.getElementById('btn-account-next')?.addEventListener('click', () => {
    if (accountPage >= accountPages) return;
    accountPage += 1;
    loadAccounts().catch((e) => showToast(e.message || '加载失败', 'error'));
});

document.getElementById('account-feedback-status')?.addEventListener('change', () => {
    if (selectedUser) loadUserFeedback(selectedUser.id).catch((e) => showToast(e.message || '反馈加载失败', 'error'));
});

document.getElementById('account-issue-status')?.addEventListener('change', () => {
    if (selectedUser) loadUserIssues(selectedUser.id).catch((e) => showToast(e.message || '异常加载失败', 'error'));
});

document.getElementById('btn-delete-account')?.addEventListener('click', () => {
    deleteSelectedAccount().catch((e) => showToast(e.message || '删除账号失败', 'error'));
});

async function loadAccounts() {
    const keyword = document.getElementById('account-keyword')?.value.trim() || '';
    const params = new URLSearchParams({
        page: String(accountPage),
        size: String(accountSize)
    });
    if (keyword) params.set('keyword', keyword);
    const res = await api.get('/admin/users?' + params.toString());
    const data = res.data || {};
    accountPages = Math.max(1, Number(data.pages || 1));
    accountPage = Math.max(1, Math.min(Number(data.page || 1), accountPages));
    renderAccounts(data.records || []);
    setText('account-total-label', (data.total || 0) + ' 个账号');
    setText('account-page-label', accountPage + ' / ' + accountPages);
    const refreshText = document.getElementById('account-refresh-text');
    if (refreshText) refreshText.textContent = '已刷新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function renderAccounts(users) {
    const wrap = document.getElementById('account-list');
    if (!wrap) return;
    wrap.innerHTML = users.map((user) => {
        const role = user.role || 'USER';
        const active = selectedUser && selectedUser.id === user.id;
        return '<button type="button" class="account-row ' + (active ? 'active' : '') + '" data-user-id="' + user.id + '">' +
            '<span class="account-row-main">' +
            '<strong>' + escapeHtml(user.nickname || user.username || '-') + '</strong>' +
            '<code>' + escapeHtml(user.username || '-') + '</code>' +
            '</span>' +
            '<span class="account-row-side">' +
            '<span class="role-pill ' + (role === 'ADMIN' ? 'admin' : '') + '">' + escapeHtml(role) + '</span>' +
            '<span class="account-badges">' +
            '<span title="未处理反馈">' + escapeHtml(user.feedbackOpenCount || 0) + ' 反馈</span>' +
            '<span title="未处理异常">' + escapeHtml(user.runtimeIssueOpenCount || 0) + ' 异常</span>' +
            '</span>' +
            '</span>' +
            '</button>';
    }).join('') || '<div class="admin-subtle account-empty-inline">暂无账号</div>';

    wrap.querySelectorAll('[data-user-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const user = users.find((item) => String(item.id) === btn.dataset.userId);
            if (user) await selectUser(user);
        });
    });
}

async function selectUser(user) {
    selectedUser = user;
    const detail = await api.get('/admin/users/' + user.id);
    selectedUser = Object.keys(detail.data || {}).length ? detail.data : user;
    renderUserDetail(selectedUser);
    await Promise.all([
        loadUserFeedback(selectedUser.id),
        loadUserIssues(selectedUser.id)
    ]);
    await loadAccounts();
}

function renderUserDetail(user) {
    document.getElementById('account-empty')?.classList.add('hidden');
    document.getElementById('account-detail')?.classList.remove('hidden');
    setText('account-name', user.nickname || user.username || '-');
    setText('account-username', user.username || '-');
    setText('account-role', user.role || 'USER');
    document.getElementById('account-role')?.classList.toggle('admin', (user.role || 'USER') === 'ADMIN');
    const deleteButton = document.getElementById('btn-delete-account');
    if (deleteButton) {
        deleteButton.disabled = String(user.id) === String(currentAdminId);
        deleteButton.title = deleteButton.disabled ? '不能删除当前登录账号' : '软删除这个账号';
    }
    setText('account-study', user.totalStudyMinutes || 0);
    setText('account-streak', user.consecutiveDays || 0);
    setText('account-feedback-open', user.feedbackOpenCount || 0);
    setText('account-issue-open', user.runtimeIssueOpenCount || 0);
}

async function deleteSelectedAccount() {
    if (!selectedUser || !selectedUser.id) return;
    if (String(selectedUser.id) === String(currentAdminId)) {
        showToast('不能删除当前登录账号', 'warning');
        return;
    }
    const name = selectedUser.nickname || selectedUser.username || ('ID ' + selectedUser.id);
    const ok = window.confirm('确认删除账号「' + name + '」？\n\n这是软删除：账号将无法登录，但历史反馈、异常和学习数据会保留用于审计。');
    if (!ok) return;
    await api.delete('/admin/users/' + selectedUser.id);
    showToast('账号已删除', 'success');
    selectedUser = null;
    document.getElementById('account-detail')?.classList.add('hidden');
    document.getElementById('account-empty')?.classList.remove('hidden');
    await loadAccounts();
}

async function loadUserFeedback(userId) {
    const status = document.getElementById('account-feedback-status')?.value || '';
    const query = status ? '?status=' + encodeURIComponent(status) : '';
    const res = await api.get('/admin/users/' + userId + '/feedback' + query);
    renderFeedback(res.data || []);
}

async function loadUserIssues(userId) {
    const status = document.getElementById('account-issue-status')?.value || '';
    const query = status ? '?status=' + encodeURIComponent(status) : '';
    const res = await api.get('/admin/users/' + userId + '/runtime-issues' + query);
    renderIssues(res.data || []);
}

function renderFeedback(items) {
    const wrap = document.getElementById('account-feedback-list');
    if (!wrap) return;
    wrap.innerHTML = items.map((item) => {
        const closed = item.status === 'CLOSED';
        return '<div class="feedback-item ' + (closed ? 'closed' : '') + '">' +
            '<div class="feedback-meta">' +
            '<span><code>' + escapeHtml(shortDate(item.createdAt)) + '</code></span>' +
            '<span class="role-pill ' + (closed ? '' : 'admin') + '">' + escapeHtml(closed ? '已关闭' : '未处理') + '</span>' +
            '</div>' +
            '<p class="feedback-content">' + escapeHtml(item.content || '') + '</p>' +
            '<div class="feedback-meta"><span><code>' + escapeHtml(item.ipAddress || '-') + '</code></span></div>' +
            (closed ? '' : '<div class="feedback-actions"><button type="button" class="btn btn-default" data-close-feedback="' + item.id + '">标记处理</button></div>') +
            '</div>';
    }).join('') || '<div class="admin-subtle">这个账号暂无反馈</div>';
    wrap.querySelectorAll('[data-close-feedback]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            await api.put('/admin/feedback/' + btn.dataset.closeFeedback + '/close');
            await loadUserFeedback(selectedUser.id);
            selectedUser.feedbackOpenCount = Math.max(0, Number(selectedUser.feedbackOpenCount || 0) - 1);
            renderUserDetail(selectedUser);
        });
    });
}

function renderIssues(items) {
    const wrap = document.getElementById('account-issue-list');
    if (!wrap) return;
    wrap.innerHTML = items.map((item) => {
        const closed = item.status === 'CLOSED';
        const source = item.source || 'CLIENT';
        return '<div class="feedback-item issue-item ' + (closed ? 'closed' : '') + '" data-source="' + escapeHtml(source) + '">' +
            '<div class="feedback-meta">' +
            '<span><strong>' + escapeHtml(item.category || 'Runtime') + '</strong> · <code>' + escapeHtml(shortDate(item.createdAt)) + '</code></span>' +
            '<span class="role-pill ' + (closed ? '' : 'admin') + '">' + escapeHtml(source + ' · ' + (closed ? '已关闭' : '未处理')) + '</span>' +
            '</div>' +
            '<p class="issue-message">' + escapeHtml(item.message || '') + '</p>' +
            '<div class="feedback-meta"><span><code>' + escapeHtml(item.apiPath || item.pageUrl || '-') + '</code></span></div>' +
            (item.detail ? '<pre class="issue-detail">' + escapeHtml(item.detail) + '</pre>' : '') +
            (closed ? '' : '<div class="feedback-actions"><button type="button" class="btn btn-default" data-close-issue="' + item.id + '">标记处理</button></div>') +
            '</div>';
    }).join('') || '<div class="admin-subtle">这个账号暂无运行异常</div>';
    wrap.querySelectorAll('[data-close-issue]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            await api.put('/admin/runtime-issues/' + btn.dataset.closeIssue + '/close');
            await loadUserIssues(selectedUser.id);
            selectedUser.runtimeIssueOpenCount = Math.max(0, Number(selectedUser.runtimeIssueOpenCount || 0) - 1);
            renderUserDetail(selectedUser);
        });
    });
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function shortDate(value) {
    if (!value) return '-';
    return String(value).replace('T', ' ').slice(0, 16);
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
