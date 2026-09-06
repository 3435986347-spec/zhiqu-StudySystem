checkAuth();
renderNavbar('navbar');

let allFeedback = [];
let feedbackTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const info = await api.get('/auth/info');
        if (!info.data || info.data.role !== 'ADMIN') {
            showToast('无权访问反馈管理', 'error');
            setTimeout(() => {
                window.location.href = '/dashboard.html';
            }, 900);
            return;
        }
        await refreshFeedback();
        feedbackTimer = setInterval(refreshFeedback, 12000);
    } catch (e) {
        showToast(e.message || '反馈管理加载失败', 'error');
    }
});

window.addEventListener('beforeunload', () => {
    if (feedbackTimer) clearInterval(feedbackTimer);
});

document.getElementById('btn-refresh-feedback')?.addEventListener('click', refreshFeedback);
document.getElementById('feedback-status')?.addEventListener('change', () => {
    renderFeedbackList(filteredFeedback());
});

async function refreshFeedback() {
    const res = await api.get('/admin/feedback');
    allFeedback = res.data || [];
    renderFeedbackMetrics(allFeedback);
    renderFeedbackList(filteredFeedback());
    const el = document.getElementById('feedback-refresh-text');
    if (el) el.textContent = '已刷新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function filteredFeedback() {
    const status = document.getElementById('feedback-status')?.value || '';
    if (!status) return allFeedback;
    return allFeedback.filter((item) => item.status === status);
}

function renderFeedbackMetrics(items) {
    const open = items.filter((item) => item.status !== 'CLOSED').length;
    const closed = items.filter((item) => item.status === 'CLOSED').length;
    setText('feedback-total', items.length);
    setText('feedback-open', open);
    setText('feedback-closed', closed);
}

function renderFeedbackList(items) {
    const wrap = document.getElementById('feedback-list');
    if (!wrap) return;
    wrap.innerHTML = items.map((item) => {
        const closed = item.status === 'CLOSED';
        const name = item.nickname || item.username || '未知用户';
        return '<div class="feedback-item ' + (closed ? 'closed' : '') + '">' +
            '<div class="feedback-meta">' +
            '<span><strong>' + escapeHtml(name) + '</strong> · <code>' + escapeHtml(shortDate(item.createdAt)) + '</code></span>' +
            '<span class="role-pill ' + (closed ? '' : 'admin') + '">' + escapeHtml(closed ? '已关闭' : '未处理') + '</span>' +
            '</div>' +
            '<p class="feedback-content">' + escapeHtml(item.content || '') + '</p>' +
            '<div class="feedback-meta">' +
            '<span><code>' + escapeHtml(item.username || '-') + '</code></span>' +
            '<span><code>' + escapeHtml(item.ipAddress || '-') + '</code></span>' +
            '</div>' +
            (closed ? '' : '<div class="feedback-actions"><button type="button" class="btn btn-default" data-close-feedback="' + item.id + '">标记处理</button></div>') +
            '</div>';
    }).join('') || '<div class="admin-subtle">暂无反馈</div>';

    wrap.querySelectorAll('[data-close-feedback]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            await api.put('/admin/feedback/' + btn.dataset.closeFeedback + '/close');
            await refreshFeedback();
            showToast('已标记处理', 'success');
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
