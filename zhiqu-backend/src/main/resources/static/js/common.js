const BASE_URL = '/api';

(function applyThemeFromStorage() {
    if (localStorage.getItem('theme') === 'pixel') {
        document.body.classList.add('pixel-theme');
    } else {
        document.body.classList.remove('pixel-theme');
    }
})();

async function request(url, options = {}) {
    const token = localStorage.getItem('token');
    const headers = {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(options.headers || {})
    };
    if (options.body != null && options.body !== '') {
        if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json';
        }
    }

    const response = await fetch(BASE_URL + url, {
        ...options,
        headers
    });

    if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('token');
        window.location.href = '/index.html';
        throw new Error('未登录或登录已过期');
    }

    let result;
    try {
        const text = await response.text();
        result = text ? JSON.parse(text) : {};
    } catch (e) {
        throw new Error('响应解析失败');
    }

    if (result.code !== 200) {
        throw new Error(result.message || '请求失败');
    }

    return result;
}

const api = {
    get: (url) => request(url, { method: 'GET' }),
    post: (url, data) => request(url, { method: 'POST', body: JSON.stringify(data) }),
    put: (url, data) =>
        request(url, {
            method: 'PUT',
            body: data !== undefined && data !== null ? JSON.stringify(data) : undefined
        }),
    delete: (url) => request(url, { method: 'DELETE' }),
    upload: async (url, file) => {
        const token = localStorage.getItem('token');
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch(BASE_URL + url, {
            method: 'POST',
            headers: token ? { Authorization: 'Bearer ' + token } : {},
            body: formData
        });
        if (response.status === 401 || response.status === 403) {
            localStorage.removeItem('token');
            window.location.href = '/index.html';
            throw new Error('未登录或登录已过期');
        }
        const result = await response.json();
        if (result.code !== 200) {
            throw new Error(result.message || '上传失败');
        }
        return result;
    }
};

function checkAuth() {
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/index.html';
    }
}

function renderNavbar(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const themeLabel = localStorage.getItem('theme') === 'pixel' ? '现代风' : '像素风';
    container.innerHTML =
        '<nav class="navbar">' +
        '<div class="navbar-brand">知趣·象限学习系统</div>' +
        '<div class="navbar-links">' +
        '<a href="/dashboard.html" class="nav-link">看板</a>' +
        '<a href="/tasks.html" class="nav-link">任务</a>' +
        '<a href="/statistics.html" class="nav-link">统计</a>' +
        '<a href="/achievement.html" class="nav-link">成就</a>' +
        '<a href="/profile.html" class="nav-link">个人中心</a>' +
        '<button type="button" class="nav-btn theme-btn" onclick="toggleTheme()">' +
        themeLabel +
        '</button>' +
        '<button type="button" class="nav-btn logout-btn" onclick="logout()">退出</button>' +
        '</div></nav>';
    const currentPath = window.location.pathname;
    container.querySelectorAll('.nav-link').forEach((link) => {
        const href = link.getAttribute('href');
        if (href === currentPath || (currentPath.endsWith('/') && href === '/dashboard.html' && currentPath === '/')) {
            link.classList.add('active');
        }
    });
}

function toggleTheme() {
    const next = localStorage.getItem('theme') === 'pixel' ? 'modern' : 'pixel';
    localStorage.setItem('theme', next);
    document.body.classList.toggle('pixel-theme', next === 'pixel');
    const themeBtn = document.querySelector('.theme-btn');
    if (themeBtn) {
        themeBtn.textContent = next === 'pixel' ? '现代风' : '像素风';
    }
}

function logout() {
    localStorage.removeItem('token');
    window.location.href = '/index.html';
}

function showToast(message, type = 'info', duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
        el.remove();
    }, duration);
}

function showConfirm(message) {
    return new Promise((resolve) => {
        resolve(window.confirm(message));
    });
}

function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return (
        d.getFullYear() +
        '-' +
        pad(d.getMonth() + 1) +
        '-' +
        pad(d.getDate()) +
        ' ' +
        pad(d.getHours()) +
        ':' +
        pad(d.getMinutes()) +
        ':' +
        pad(d.getSeconds())
    );
}

function toDatetimeLocalValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return (
        d.getFullYear() +
        '-' +
        pad(d.getMonth() + 1) +
        '-' +
        pad(d.getDate()) +
        'T' +
        pad(d.getHours()) +
        ':' +
        pad(d.getMinutes())
    );
}

function quadrantLabel(q) {
    const map = {
        1: '重要且紧急',
        2: '重要不紧急',
        3: '紧急不重要',
        4: '不重要不紧急'
    };
    return map[q] || '—';
}

function statusLabel(s) {
    const map = { 0: '待办', 1: '进行中', 2: '已完成' };
    return map[s] != null ? map[s] : '—';
}

function statusTagClass(s) {
    if (s === 0) return 'tag tag-pending';
    if (s === 1) return 'tag tag-doing';
    if (s === 2) return 'tag tag-done';
    return 'tag';
}

function priorityLabel(p) {
    const map = { 0: '低', 1: '中', 2: '高', 3: '紧急' };
    return map[p] != null ? map[p] : '—';
}

function priorityTagClass(p) {
    return 'tag tag-priority-' + (p == null ? 0 : Math.min(3, Math.max(0, p)));
}
