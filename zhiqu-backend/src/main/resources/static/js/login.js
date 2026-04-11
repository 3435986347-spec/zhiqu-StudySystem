localStorage.removeItem('token');

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
    try {
        const res = await api.post('/auth/login', { username, password });
        if (res.data && res.data.token) {
            localStorage.setItem('token', res.data.token);
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
