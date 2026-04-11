checkAuth();
renderNavbar('navbar');

let list = [];
let filter = 'all';
let highlightIds = new Set();

function levelLabel(points) {
    const p = Number(points) || 0;
    if (p < 50) return '青铜';
    if (p < 100) return '白银';
    return '黄金';
}

async function loadSummary() {
    const res = await api.get('/auth/info');
    const u = res.data || {};
    const pts = u.achievementPoints ?? 0;
    document.getElementById('ach-summary').textContent =
        '总成就点数：' + pts + '　当前等级：' + levelLabel(pts);
}

function formatUnlockedAt(v) {
    if (!v) return '';
    return formatDateTime(v);
}

function renderGrid() {
    const grid = document.getElementById('ach-grid');
    grid.innerHTML = '';
    const filtered = list.filter((a) => {
        if (filter === 'unlocked') return a.unlocked;
        if (filter === 'locked') return !a.unlocked;
        return true;
    });
    if (!filtered.length) {
        grid.innerHTML = '<p style="color:#909399">暂无成就</p>';
        return;
    }
    filtered.forEach((a) => {
        const card = document.createElement('div');
        card.className = 'ach-card' + (a.unlocked ? '' : ' locked');
        if (highlightIds.has(a.id)) card.classList.add('highlight');
        const tag = a.unlocked
            ? '<span class="tag tag-done">已解锁</span>'
            : '<span class="tag tag-priority-0">未解锁</span>';
        const when = a.unlocked && a.unlockedAt ? '<div style="margin-top:8px;font-size:12px;color:#909399">解锁时间：' + formatUnlockedAt(a.unlockedAt) + '</div>' : '';
        card.innerHTML =
            '<div class="ach-name"></div>' +
            '<div class="ach-desc"></div>' +
            '<div class="ach-foot"><span>积分：' +
            (a.points ?? 0) +
            '</span>' +
            tag +
            '</div>';
        card.querySelector('.ach-name').textContent = a.name || '';
        card.querySelector('.ach-desc').textContent = a.description || '';
        card.insertAdjacentHTML('beforeend', when);
        grid.appendChild(card);
    });
}

async function loadList() {
    const res = await api.get('/achievement/list');
    list = res.data || [];
    renderGrid();
}

document.getElementById('ach-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-f]');
    if (!btn) return;
    filter = btn.dataset.f;
    document.querySelectorAll('#ach-filters button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderGrid();
});

document.getElementById('btn-check').addEventListener('click', async () => {
    try {
        const res = await api.post('/achievement/check?trigger=manual', {});
        const unlocked = res.data || [];
        highlightIds = new Set(unlocked.map((x) => x.achievementId));
        if (unlocked.length) {
            showToast('新解锁 ' + unlocked.length + ' 项成就', 'success');
        } else {
            showToast('暂无新成就', 'info');
        }
        await loadSummary();
        await loadList();
        setTimeout(() => {
            highlightIds.clear();
            renderGrid();
        }, 4000);
    } catch (e) {
        showToast(e.message || '检测失败', 'error');
    }
});

document.addEventListener('DOMContentLoaded', () => {
    Promise.all([loadSummary(), loadList()]).catch((e) => showToast(e.message, 'error'));
});
