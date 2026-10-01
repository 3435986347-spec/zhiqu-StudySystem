checkAuth();
renderNavbar('navbar');

let adminTimer = null;
let adminEventSource = null;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const info = await api.get('/auth/info');
        if (!info.data || info.data.role !== 'ADMIN') {
            showToast('无权访问监管后台', 'error');
            setTimeout(() => {
                window.location.href = '/dashboard.html';
            }, 900);
            return;
        }
        startAdminEvents();
        await refreshAdmin();
        adminTimer = setInterval(refreshAdmin, 8000);
    } catch (e) {
        showToast(e.message || '监管后台加载失败', 'error');
    }
});

window.addEventListener('beforeunload', () => {
    if (adminTimer) clearInterval(adminTimer);
    if (adminEventSource) adminEventSource.close();
});

document.getElementById('btn-refresh-admin')?.addEventListener('click', refreshAdmin);
document.getElementById('issue-status')?.addEventListener('change', loadIssues);

async function refreshAdmin() {
    const [overview, issues] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/runtime-issues' + issueQuery())
    ]);
    renderMetrics(overview.data || {});
    renderTraffic((overview.data && overview.data.traffic) || {});
    renderRuntimeIssues(issues.data || []);
    const el = document.getElementById('admin-refresh-text');
    if (el) el.textContent = '已刷新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

async function loadIssues() {
    const res = await api.get('/admin/runtime-issues' + issueQuery());
    renderRuntimeIssues(res.data || []);
}

async function loadSharedPlanReviews() {
    const res = await api.get('/admin/shared-plans' + sharedPlanQuery());
    renderSharedPlanReviews(res.data || []);
}

function issueQuery() {
    const status = document.getElementById('issue-status')?.value || '';
    return status ? '?status=' + encodeURIComponent(status) : '';
}

function startAdminEvents() {
    if (!window.EventSource) return;
    try {
        adminEventSource = new EventSource('/api/admin/events');
        adminEventSource.addEventListener('admin', refreshAdmin);
        adminEventSource.addEventListener('shared-plan', refreshAdmin);
    } catch (e) {
        adminEventSource = null;
    }
}

function sharedPlanQuery() {
    const status = document.getElementById('shared-plan-status')?.value || '';
    return status ? '?status=' + encodeURIComponent(status) : '';
}

function renderMetrics(data) {
    const traffic = data.traffic || {};
    setText('metric-last-minute', traffic.lastMinute || 0);
    setText('metric-last-15', traffic.last15Minutes || 0);
    setText('metric-errors', traffic.errorCount || 0);
    setText('metric-latency', (traffic.averageLatencyMs || 0) + 'ms');
    setText('metric-users', data.userCount || 0);
    setText('metric-runtime', data.runtimeIssueOpenCount || 0);
}

function renderTraffic(traffic) {
    const bars = document.getElementById('traffic-bars');
    const buckets = traffic.minuteBuckets || {};
    const values = Object.values(buckets);
    const max = Math.max(1, ...values);
    if (bars) {
        bars.innerHTML = Object.keys(buckets).slice(-15).map((minute) => {
            const value = buckets[minute] || 0;
            const height = Math.max(8, Math.round((value / max) * 64));
            return '<div class="sparkline-bar" title="' + escapeHtml(minute + ' ' + value + ' 次') + '" style="height:' + height + 'px"></div>';
        }).join('') || '<div class="admin-subtle">暂无流量数据</div>';
    }

    const tbody = document.getElementById('traffic-tbody');
    const rows = traffic.recent || [];
    if (!tbody) return;
    tbody.innerHTML = rows.map((row) => {
        const statusClass = Number(row.status) >= 400 ? ' warn' : '';
        return '<tr>' +
            '<td><code>' + escapeHtml(shortTime(row.time)) + '</code></td>' +
            '<td><code>' + escapeHtml(row.method + ' ' + row.path) + '</code></td>' +
            '<td><span class="status-code' + statusClass + '">' + escapeHtml(row.status) + '</span></td>' +
            '<td><code>' + escapeHtml(row.durationMs) + 'ms</code></td>' +
            '<td><code>' + escapeHtml(row.ip || '-') + '</code></td>' +
            '</tr>';
    }).join('') || '<tr><td colspan="5" class="admin-subtle">暂无请求记录</td></tr>';
}

function renderRuntimeIssues(items) {
    const wrap = document.getElementById('issue-list');
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
            '<div class="feedback-meta"><span><code>' + escapeHtml(item.username || item.ipAddress || '-') + '</code></span></div>' +
            (closed ? '' : '<div class="feedback-actions"><button type="button" class="btn btn-default" data-close-issue="' + item.id + '">标记处理</button></div>') +
            '</div>';
    }).join('') || '<div class="admin-subtle">暂无运行异常</div>';
    wrap.querySelectorAll('[data-close-issue]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            await api.put('/admin/runtime-issues/' + btn.dataset.closeIssue + '/close');
            await refreshAdmin();
        });
    });
}

function renderSharedPlanReviews(items) {
    const wrap = document.getElementById('shared-review-list');
    if (!wrap) return;
    wrap.innerHTML = items.map((item) => {
        const status = item.status || 'PENDING';
        const pending = status === 'PENDING';
        return '<div class="feedback-item shared-review-item">' +
            '<div class="feedback-meta">' +
            '<span><strong>' + escapeHtml(item.title || '未命名模板') + '</strong> · <code>' + escapeHtml(shortDate(item.createdAt)) + '</code></span>' +
            '<span class="role-pill ' + (pending ? 'admin' : '') + '">' + escapeHtml(sharedPlanStatusLabel(status)) + '</span>' +
            '</div>' +
            '<p class="feedback-content">' + escapeHtml(item.description || '暂无说明') + '</p>' +
            '<div class="feedback-meta"><span>' + escapeHtml(item.category || 'GENERAL') + ' · 套用 ' + escapeHtml(item.applyCount || 0) + ' 次</span></div>' +
            (pending ? '<div class="feedback-actions">' +
                '<button type="button" class="btn btn-default" data-review-reject="' + item.id + '">驳回</button>' +
                '<button type="button" class="btn btn-primary" data-review-approve="' + item.id + '">通过</button>' +
                '</div>' : '') +
            '</div>';
    }).join('') || '<div class="admin-subtle">暂无共享计划记录</div>';
    wrap.querySelectorAll('[data-review-approve]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            await api.put('/admin/shared-plans/' + btn.dataset.reviewApprove + '/review?action=APPROVE');
            await loadSharedPlanReviews();
            showToast('已通过共享计划', 'success');
        });
    });
    wrap.querySelectorAll('[data-review-reject]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const note = window.prompt('驳回原因，可留空') || '';
            await api.put('/admin/shared-plans/' + btn.dataset.reviewReject + '/review?action=REJECT&note=' + encodeURIComponent(note));
            await loadSharedPlanReviews();
            showToast('已驳回共享计划', 'success');
        });
    });
}

function sharedPlanStatusLabel(status) {
    const map = {
        PENDING: '待审核',
        APPROVED: '已通过',
        REJECTED: '已驳回'
    };
    return map[status] || status || '未知';
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function shortDate(value) {
    if (!value) return '-';
    return String(value).replace('T', ' ').slice(0, 16);
}

function shortTime(value) {
    if (!value) return '-';
    return String(value).replace('T', ' ').slice(11, 19);
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
