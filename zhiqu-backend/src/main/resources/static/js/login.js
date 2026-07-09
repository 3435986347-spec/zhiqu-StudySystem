tryAutoLogin();

async function tryAutoLogin() {
    const token = getAuthToken();
    try {
        const response = await fetch(BASE_URL + '/auth/info', {
            headers: token ? { Authorization: 'Bearer ' + token } : {},
            credentials: 'same-origin'
        });
        if (!response.ok) return;
        const result = await response.json();
        if (result.code === 200) {
            sessionStorage.setItem('role', (result.data && result.data.role) || 'USER');
            window.location.href = '/dashboard.html';
        }
    } catch (ignored) {
        clearAuthState();
    }
}

function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === name);
    });
    document.getElementById('panel-login').classList.toggle('hidden', name !== 'login');
    document.getElementById('panel-register').classList.toggle('hidden', name !== 'register');
    document.getElementById('login-error').textContent = '';
    document.getElementById('register-error').textContent = '';
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    err.textContent = '';
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const rememberMe = document.getElementById('remember-me').checked;
    try {
        const res = await api.post('/auth/login', { username, password, rememberMe });
        if (res.data && res.data.token) {
            setAuthState(res.data.token, res.data.role || 'USER');
            window.location.href = '/dashboard.html';
        } else {
            err.textContent = '登录响应异常';
        }
    } catch (ex) {
        err.textContent = ex.message || '登录失败';
    }
});

document.getElementById('form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('register-error');
    err.textContent = '';
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirmPassword = document.getElementById('reg-confirm').value;
    if (password !== confirmPassword) {
        err.textContent = '两次密码不一致';
        return;
    }
    try {
        await api.post('/auth/register', { username, password, confirmPassword });
        showToast('注册成功，请登录', 'success');
        switchTab('login');
        document.getElementById('login-username').value = username;
        document.getElementById('login-password').value = '';
        document.getElementById('reg-password').value = '';
        document.getElementById('reg-confirm').value = '';
    } catch (ex) {
        err.textContent = ex.message || '注册失败';
    }
});
