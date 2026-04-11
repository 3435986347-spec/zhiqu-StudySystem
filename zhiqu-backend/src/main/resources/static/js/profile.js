checkAuth();
renderNavbar('navbar');

function renderUser(u) {
    if (!u) return;
    document.getElementById('pf-username').value = u.username || '';
    document.getElementById('pf-nickname').value = u.nickname || '';

    const letterEl = document.getElementById('avatar-letter');
    const imgEl = document.getElementById('avatar-img');
    const nick = (u.nickname || u.username || '?').trim();
    letterEl.textContent = nick.charAt(0).toUpperCase();
    if (u.avatar) {
        imgEl.src = u.avatar;
        imgEl.classList.remove('hidden');
        letterEl.classList.add('hidden');
    } else {
        imgEl.classList.add('hidden');
        letterEl.classList.remove('hidden');
        imgEl.removeAttribute('src');
    }

    const stats = document.getElementById('profile-stats');
    stats.innerHTML =
        '<div class="stat-card"><div class="value">' +
        (u.achievementPoints ?? 0) +
        '</div><div class="label">成就点</div></div>' +
        '<div class="stat-card"><div class="value">' +
        (u.consecutiveDays ?? 0) +
        '</div><div class="label">连续学习天数</div></div>' +
        '<div class="stat-card"><div class="value">' +
        (u.totalStudyMinutes ?? 0) +
        '</div><div class="label">累计学习分钟</div></div>';
}

async function loadInfo() {
    const res = await api.get('/auth/info');
    renderUser(res.data);
}

document.getElementById('btn-avatar').addEventListener('click', () => {
    document.getElementById('avatar-file').click();
});

document.getElementById('avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
        await api.upload('/user/avatar', file);
        showToast('头像已更新', 'success');
        await loadInfo();
    } catch (err) {
        showToast(err.message || '上传失败', 'error');
    }
    e.target.value = '';
});

document.getElementById('btn-save-profile').addEventListener('click', async () => {
    const nickname = document.getElementById('pf-nickname').value.trim();
    if (!nickname) {
        showToast('昵称不能为空', 'warning');
        return;
    }
    try {
        await api.put('/user/profile', { nickname });
        showToast('已保存', 'success');
        await loadInfo();
    } catch (e) {
        showToast(e.message || '失败', 'error');
    }
});

document.getElementById('btn-save-pw').addEventListener('click', async () => {
    const oldPassword = document.getElementById('pf-old-pw').value;
    const newPassword = document.getElementById('pf-new-pw').value;
    if (!oldPassword || !newPassword) {
        showToast('请填写完整', 'warning');
        return;
    }
    try {
        await api.put('/user/password', { oldPassword, newPassword });
        showToast('密码已更新，请重新登录', 'success');
        localStorage.removeItem('token');
        setTimeout(() => {
            window.location.href = '/index.html';
        }, 800);
    } catch (e) {
        showToast(e.message || '失败', 'error');
    }
});

document.addEventListener('DOMContentLoaded', () => {
    loadInfo().catch((e) => showToast(e.message, 'error'));
});
