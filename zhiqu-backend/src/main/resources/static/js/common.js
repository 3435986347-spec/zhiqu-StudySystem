const BASE_URL = '/api';

(function applyThemeFromStorage() {
    if (localStorage.getItem('theme') === 'pixel') {
        localStorage.setItem('theme', 'modern');
    }
    document.body.classList.remove('pixel-theme');
})();

function getAuthToken() {
    return sessionStorage.getItem('token') || localStorage.getItem('token') || '';
}

function setAuthState(token, role) {
    sessionStorage.setItem('token', token);
    sessionStorage.setItem('role', role || 'USER');
    localStorage.removeItem('token');
    localStorage.removeItem('role');
}

function getAuthRole() {
    return sessionStorage.getItem('role') || localStorage.getItem('role') || '';
}

function clearAuthState() {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('role');
    localStorage.removeItem('token');
    localStorage.removeItem('role');
}

async function request(url, options = {}) {
    const token = getAuthToken();
    const headers = {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(options.headers || {})
    };
    if (options.body != null && options.body !== '') {
        if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json';
        }
    }

    let response;
    try {
        response = await fetch(BASE_URL + url, {
            ...options,
            headers,
            credentials: 'same-origin'
        });
    } catch (e) {
        reportRuntimeIssue({
            category: 'NETWORK_ERROR',
            message: e.message || '网络请求失败',
            detail: e.stack || '',
            apiPath: url
        });
        throw e;
    }

    if (response.status === 401 || response.status === 403) {
        clearAuthState();
        window.location.href = '/index.html';
        throw new Error('未登录或登录已过期');
    }

    let result;
    try {
        const text = await response.text();
        result = text ? JSON.parse(text) : {};
    } catch (e) {
        reportRuntimeIssue({
            category: 'RESPONSE_PARSE_ERROR',
            message: '响应解析失败',
            detail: e.stack || '',
            apiPath: url
        });
        throw new Error('响应解析失败');
    }

    if (result.code !== 200) {
        throw new Error(result.message || '请求失败');
    }

    return result;
}

const api = {
    get: (url) => request(url, { method: 'GET' }),
    post: (url, data, options = {}) => request(url, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: options.headers || {}
    }),
    put: (url, data, options = {}) =>
        request(url, {
            method: 'PUT',
            body: data !== undefined && data !== null ? JSON.stringify(data) : undefined,
            headers: options.headers || {}
        }),
    delete: (url) => request(url, { method: 'DELETE' }),
    upload: async (url, file, fields = {}) => {
        const token = getAuthToken();
        const formData = new FormData();
        formData.append('file', file);
        Object.entries(fields || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                formData.append(key, value);
            }
        });
        let response;
        try {
            response = await fetch(BASE_URL + url, {
                method: 'POST',
                headers: token ? { Authorization: 'Bearer ' + token } : {},
                body: formData,
                credentials: 'same-origin'
            });
        } catch (e) {
            reportRuntimeIssue({
                category: 'UPLOAD_NETWORK_ERROR',
                message: e.message || '上传请求失败',
                detail: e.stack || '',
                apiPath: url
            });
            throw e;
        }
        if (response.status === 401 || response.status === 403) {
            clearAuthState();
            window.location.href = '/index.html';
            throw new Error('未登录或登录已过期');
        }
        let result;
        try {
            result = await response.json();
        } catch (e) {
            reportRuntimeIssue({
                category: 'UPLOAD_RESPONSE_PARSE_ERROR',
                message: '上传响应解析失败',
                detail: e.stack || '',
                apiPath: url
            });
            throw new Error('上传响应解析失败');
        }
        if (result.code !== 200) {
            throw new Error(result.message || '上传失败');
        }
        return result;
    }
};

let runtimeIssueLastAt = 0;
const runtimeIssueFingerprints = new Map();

function sanitizeRuntimeText(value) {
    return String(value == null ? '' : value)
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/(authorization|cookie|api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[REDACTED]')
        .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[REDACTED]')
        .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[JWT_REDACTED]');
}

function reportRuntimeIssue(payload) {
    try {
        const now = Date.now();
        const message = sanitizeRuntimeText(payload.message || '运行异常').slice(0, 1000);
        const category = String(payload.category || 'CLIENT_RUNTIME').slice(0, 80);
        const fingerprint = category + ':' + message + ':' + (payload.apiPath || location.pathname);
        const previous = runtimeIssueFingerprints.get(fingerprint) || 0;
        if (now - previous < 30000 || now - runtimeIssueLastAt < 1200) {
            return;
        }
        runtimeIssueFingerprints.set(fingerprint, now);
        runtimeIssueLastAt = now;

        const token = getAuthToken();
        const body = {
            category: category,
            severity: payload.severity || 'ERROR',
            message: message,
            detail: sanitizeRuntimeText(payload.detail || '').slice(0, 8000),
            pageUrl: sanitizeRuntimeText(location.href),
            apiPath: sanitizeRuntimeText(payload.apiPath || '')
        };
        fetch(BASE_URL + '/runtime-issue/client', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: 'Bearer ' + token } : {})
            },
            body: JSON.stringify(body),
            credentials: 'same-origin',
            keepalive: true
        }).catch(() => {});
    } catch (ignored) {
        // Runtime reporting must stay invisible to the user.
    }
}

window.addEventListener('error', (event) => {
    reportRuntimeIssue({
        category: 'JS_ERROR',
        message: event.message || 'JavaScript 运行错误',
        detail: [
            event.filename || '',
            event.lineno ? 'line ' + event.lineno : '',
            event.colno ? 'col ' + event.colno : '',
            event.error && event.error.stack ? event.error.stack : ''
        ].filter(Boolean).join('\n')
    });
});

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    reportRuntimeIssue({
        category: 'UNHANDLED_PROMISE',
        message: reason && reason.message ? reason.message : String(reason || '未处理的 Promise 异常'),
        detail: reason && reason.stack ? reason.stack : ''
    });
});

function checkAuth() {
    const token = getAuthToken();
    if (!token) {
        fetch(BASE_URL + '/auth/info', { credentials: 'same-origin' })
            .then((response) => response.ok ? response.json() : Promise.reject(new Error('unauthorized')))
            .then((result) => {
                if (result.code !== 200) {
                    throw new Error('unauthorized');
                }
                sessionStorage.setItem('role', (result.data && result.data.role) || 'USER');
            })
            .catch(() => {
                clearAuthState();
                window.location.href = '/index.html';
            });
    }
}

function renderNavbar(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML =
        '<nav class="navbar">' +
        '<div class="navbar-brand">知趣·象限学习系统</div>' +
        '<div class="navbar-links">' +
        '<div class="nav-section nav-primary-group">' +
        '<a href="/dashboard.html" class="nav-link">看板</a>' +
        '<a href="/ai-assistant.html" class="nav-link">AI 助手</a>' +
        '<a href="/tasks.html" class="nav-link">任务</a>' +
        '<a href="/routines.html" class="nav-link">例行计划</a>' +
        '<a href="/shared-plans.html" class="nav-link">参考计划</a>' +
        '<a href="/knowledge-wiki.html" class="nav-link">知识 Wiki</a>' +
        '<a href="/profile.html" class="nav-link">个人中心</a>' +
        '</div>' +
        '<div class="nav-section nav-admin-group admin-only hidden">' +
        '<span class="nav-section-title">管理</span>' +
        '<a href="/admin.html" class="nav-link">监管后台</a>' +
        '<a href="/account-admin.html" class="nav-link">账号管理</a>' +
        '<a href="/feedback-admin.html" class="nav-link">反馈管理</a>' +
        '<a href="/shared-plan-admin.html" class="nav-link">共享计划审核</a>' +
        '</div>' +
        '</div></nav>';
    const currentPath = window.location.pathname;
    container.querySelectorAll('.nav-link').forEach((link) => {
        const href = link.getAttribute('href');
        if (href === currentPath || (currentPath.endsWith('/') && href === '/dashboard.html' && currentPath === '/')) {
            link.classList.add('active');
        }
    });
    const cachedRole = getAuthRole();
    if (cachedRole === 'ADMIN') {
        container.querySelectorAll('.admin-only').forEach((el) => el.classList.remove('hidden'));
    }
    api.get('/auth/info').then((res) => {
        const role = res.data && res.data.role ? res.data.role : 'USER';
        sessionStorage.setItem('role', role);
        container.querySelectorAll('.admin-only').forEach((el) => {
            el.classList.toggle('hidden', role !== 'ADMIN');
        });
    }).catch(() => {});
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
    const token = getAuthToken();
    fetch(BASE_URL + '/auth/logout', {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        credentials: 'same-origin'
    }).finally(() => {
        clearAuthState();
        window.location.href = '/index.html';
    });
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

(function initCustomSelects() {
    const enhancedSelects = new WeakSet();
    let openSelect = null;

    function isEligible(select) {
        return select &&
            select.tagName === 'SELECT' &&
            !select.multiple &&
            Number(select.size || 0) <= 1 &&
            !select.dataset.nativeSelect;
    }

    function getSelectedOption(select) {
        return select.options[select.selectedIndex] || select.options[0] || null;
    }

    function close(control) {
        if (!control) return;
        control.classList.remove('is-open');
        const trigger = control.querySelector('.custom-select-trigger');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        if (openSelect === control) openSelect = null;
    }

    function closeOpen() {
        close(openSelect);
    }

    function buildOptions(select, control, menu, syncLabel) {
        menu.innerHTML = '';
        Array.prototype.forEach.call(select.options, function (option) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'custom-select-option';
            item.setAttribute('role', 'option');
            item.textContent = option.textContent;
            item.dataset.value = option.value;
            if (option.disabled) {
                item.disabled = true;
                item.classList.add('is-disabled');
            }
            if (option.selected) {
                item.classList.add('is-selected');
                item.setAttribute('aria-selected', 'true');
            } else {
                item.setAttribute('aria-selected', 'false');
            }
            item.addEventListener('click', function (event) {
                event.stopPropagation();
                if (option.disabled) return;
                select.value = option.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                syncLabel();
                close(control);
            });
            menu.appendChild(item);
        });
    }

    function enhanceSelect(select) {
        if (!isEligible(select) || enhancedSelects.has(select)) return;
        enhancedSelects.add(select);
        select.classList.add('native-select-hidden');
        select.tabIndex = -1;

        const control = document.createElement('div');
        control.className = 'custom-select';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'custom-select-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        const value = document.createElement('span');
        value.className = 'custom-select-value';
        const menu = document.createElement('div');
        menu.className = 'custom-select-menu';
        menu.setAttribute('role', 'listbox');

        trigger.appendChild(value);
        control.appendChild(trigger);
        control.appendChild(menu);
        select.insertAdjacentElement('afterend', control);

        function syncLabel() {
            const option = getSelectedOption(select);
            value.textContent = option ? option.textContent : '';
            control.classList.toggle('is-disabled', select.disabled);
            Array.prototype.forEach.call(menu.querySelectorAll('.custom-select-option'), function (item) {
                const selected = item.dataset.value === select.value;
                item.classList.toggle('is-selected', selected);
                item.setAttribute('aria-selected', selected ? 'true' : 'false');
            });
        }

        function refresh() {
            buildOptions(select, control, menu, syncLabel);
            syncLabel();
        }

        select.__customSelectSync = syncLabel;
        select.__customSelectRefresh = refresh;
        refresh();

        trigger.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            if (select.disabled) return;
            if (openSelect && openSelect !== control) closeOpen();
            const willOpen = !control.classList.contains('is-open');
            control.classList.toggle('is-open', willOpen);
            trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
            openSelect = willOpen ? control : null;
            if (willOpen) refresh();
        });

        trigger.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                close(control);
                return;
            }
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
                event.preventDefault();
                trigger.click();
            }
        });

        select.addEventListener('change', syncLabel);
        new MutationObserver(refresh).observe(select, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['selected', 'disabled', 'label', 'value']
        });
    }

    function enhanceAll(root) {
        const scope = root || document;
        if (scope.matches && scope.matches('select')) enhanceSelect(scope);
        scope.querySelectorAll && scope.querySelectorAll('select').forEach(enhanceSelect);
    }

    function patchSelectValueSetter() {
        const proto = window.HTMLSelectElement && window.HTMLSelectElement.prototype;
        if (!proto || proto.__zhiquCustomSelectPatched) return;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (!descriptor || !descriptor.configurable || !descriptor.get || !descriptor.set) return;
        Object.defineProperty(proto, 'value', {
            configurable: true,
            enumerable: descriptor.enumerable,
            get: function () {
                return descriptor.get.call(this);
            },
            set: function (nextValue) {
                descriptor.set.call(this, nextValue);
                if (this.__customSelectSync) this.__customSelectSync();
            }
        });
        proto.__zhiquCustomSelectPatched = true;
    }

    patchSelectValueSetter();

    document.addEventListener('click', closeOpen);
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeOpen();
    });

    function startEnhancer() {
        enhanceAll(document);
        new MutationObserver(function (records) {
            records.forEach(function (record) {
                record.addedNodes.forEach(function (node) {
                    if (node.nodeType === 1) enhanceAll(node);
                });
            });
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startEnhancer);
    } else {
        startEnhancer();
    }

    window.refreshCustomSelects = function () {
        enhanceAll(document);
        document.querySelectorAll('select').forEach(function (select) {
            if (select.__customSelectRefresh) select.__customSelectRefresh();
            else if (select.__customSelectSync) select.__customSelectSync();
        });
    };
})();

(function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('/service-worker.js').catch(function () {});
    });
})();
