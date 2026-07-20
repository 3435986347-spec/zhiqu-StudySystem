checkAuth();
renderNavbar('navbar');

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderUser(u) {
    if (!u) return;
    const isAdmin = (u.role || 'USER') === 'ADMIN';
    document.getElementById('pf-username').value = u.username || '';
    document.getElementById('pf-nickname').value = u.nickname || '';
    const feedbackSection = document.getElementById('feedback-section');
    if (feedbackSection) {
        feedbackSection.classList.toggle('hidden', isAdmin);
    }

    const letterEl = document.getElementById('avatar-letter');
    const imgEl = document.getElementById('avatar-img');
    const nick = (u.nickname || u.username || '?').trim();
    letterEl.textContent = nick.charAt(0).toUpperCase();
    if (u.avatar) {
        showAvatar(u.avatar);
    } else {
        showAvatarFallback();
    }

    const stats = document.getElementById('profile-stats');
    stats.innerHTML =
        renderProfileStatCard(u.achievementPoints ?? 0, '成就点', '查看成就', '/achievement.html') +
        renderProfileStatCard(u.consecutiveDays ?? 0, '连续学习天数', '个人节奏') +
        renderProfileStatCard(u.totalStudyMinutes ?? 0, '累计学习分钟', '查看统计', '/statistics.html');
}

function renderProfileStatCard(value, label, actionText, href) {
    const tag = href ? 'a' : 'div';
    const hrefAttr = href ? ' href="' + href + '"' : '';
    const actionClass = href ? 'profile-stat-action' : 'profile-stat-action muted';
    return '<' + tag + ' class="stat-card profile-stat-card' + (href ? ' is-clickable' : '') + '"' + hrefAttr + '>' +
        '<div class="profile-stat-main">' +
        '<div class="value">' + escapeHtml(value) + '</div>' +
        '<div class="profile-stat-copy">' +
        '<div class="label">' + escapeHtml(label) + '</div>' +
        '<div class="' + actionClass + '">' + escapeHtml(actionText) + '</div>' +
        '</div>' +
        '</div>' +
        '</' + tag + '>';
}

function withAvatarCacheBust(url) {
    if (!url) return '';
    const sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + 'v=' + Date.now();
}

function showAvatar(url) {
    const imgEl = document.getElementById('avatar-img');
    const letterEl = document.getElementById('avatar-letter');
    imgEl.onload = () => {
        imgEl.classList.remove('hidden');
        letterEl.classList.add('hidden');
    };
    imgEl.onerror = () => {
        showAvatarFallback();
    };
    imgEl.src = withAvatarCacheBust(url);
}

function showAvatarFallback() {
    const imgEl = document.getElementById('avatar-img');
    const letterEl = document.getElementById('avatar-letter');
    imgEl.classList.add('hidden');
    letterEl.classList.remove('hidden');
    imgEl.onload = null;
    imgEl.onerror = null;
    imgEl.removeAttribute('src');
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
        const res = await api.upload('/user/avatar', file);
        showToast('头像已更新', 'success');
        if (res.data && res.data.avatar) {
            showAvatar(res.data.avatar);
        } else {
            await loadInfo();
        }
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
        const token = getAuthToken();
        await fetch(BASE_URL + '/auth/logout', {
            method: 'POST',
            headers: token ? { Authorization: 'Bearer ' + token } : {},
            credentials: 'same-origin'
        }).catch(() => {});
        clearAuthState();
        setTimeout(() => {
            window.location.href = '/index.html';
        }, 800);
    } catch (e) {
        showToast(e.message || '失败', 'error');
    }
});

document.getElementById('btn-profile-logout')?.addEventListener('click', () => {
    logout();
});

document.getElementById('btn-send-feedback')?.addEventListener('click', async () => {
    const textarea = document.getElementById('feedback-content');
    const content = textarea ? textarea.value.trim() : '';
    if (!content) {
        showToast('请先写下反馈内容', 'warning');
        return;
    }
    if (content.length > 1000) {
        showToast('反馈内容不能超过 1000 字', 'warning');
        return;
    }
    try {
        await api.post('/feedback', { content });
        textarea.value = '';
        showToast('反馈已提交', 'success');
    } catch (e) {
        showToast(e.message || '反馈提交失败', 'error');
    }
});

document.addEventListener('DOMContentLoaded', () => {
    loadInfo().catch((e) => showToast(e.message, 'error'));
    loadAiModels();
    loadReminderSettings();
});

// ── AI 配置 ──

let editingAiModelId = null;

async function loadAiModels() {
    try {
        const res = await api.get('/ai/models');
        renderAiModels(res.data || {});
    } catch (e) {
        const list = document.getElementById('ai-model-list');
        if (list) list.innerHTML = '<div class="empty-line">暂未配置模型。</div>';
    }
}

document.getElementById('btn-save-ai')?.addEventListener('click', async () => {
    const displayName = document.getElementById('ai-display-name')?.value.trim();
    const providerType = document.getElementById('ai-provider-type')?.value || 'OPENAI_COMPATIBLE';
    const apiUrl    = document.getElementById('ai-api-url')?.value.trim();
    const apiKey    = document.getElementById('ai-api-key')?.value.trim();
    const modelName = document.getElementById('ai-model-name')?.value.trim();
    const capabilities = 'TEXT';

    try {
        const body = {
            displayName: displayName || modelName || '我的模型',
            providerType,
            apiUrl,
            apiKey:    apiKey,
            modelName,
            capabilities,
            enabled: true,
            isDefault: true
        };
        let saved;
        if (editingAiModelId) {
            saved = await api.put('/ai/models/' + editingAiModelId, body);
        } else {
            saved = await api.post('/ai/models', body);
        }
        showToast('AI 模型已保存', 'success');
        const savedId = saved && saved.data && saved.data.id;
        if (savedId && await showConfirm('是否立即测试模型能力？会消耗少量 token。')) {
            await probeAiModel(savedId);
        }
        // 清空 Key 输入框，刷新显示脱敏占位
        document.getElementById('ai-api-key').value = '';
        resetAiModelForm();
        await loadAiModels();
    } catch (e) {
        showToast('保存失败：' + (e.message || ''), 'error');
    }
});

document.getElementById('btn-reset-ai-form')?.addEventListener('click', resetAiModelForm);

function renderAiModels(data) {
    const list = document.getElementById('ai-model-list');
    if (!list) return;
    const rows = [
        ...(data.systemModels || []),
        ...(data.userModels || [])
    ];
    if (!rows.length) {
        list.innerHTML = '<div class="empty-line">还没有可用模型。添加一个 OpenAI-compatible、Anthropic 或 Ollama 模型即可开始。</div>';
        return;
    }
    list.innerHTML = rows.map((model) => (
        '<div class="ai-model-card ' + (model.ownerType === 'SYSTEM' ? 'system' : '') + '">' +
        '  <div class="ai-model-head">' +
        '    <div>' +
        '      <div class="ai-model-name">' + escapeHtml(cleanModelLabel(model.label || model.displayName || '未命名模型', model.ownerType)) + '</div>' +
        '      <div class="ai-model-subtitle">' + escapeHtml(model.modelName || '') + '</div>' +
        '    </div>' +
        '    <span class="ai-model-owner">' + escapeHtml(model.ownerType === 'SYSTEM' ? '系统' : '我的') + '</span>' +
        '  </div>' +
        '  <div class="ai-model-detail-grid">' +
        '    <div><span>Provider</span><strong>' + escapeHtml(model.providerType || '') + '</strong></div>' +
        '    <div><span>连通性</span><strong>' + renderProbeStatus(model.capabilityProbeStatus) + '</strong></div>' +
        '    <div><span>视觉</span><strong>' + renderProbeStatus(model.visionStatus) + '</strong></div>' +
        '    <div><span>深度思考</span><strong>' + renderProbeStatus(model.reasoningStatus) + '</strong></div>' +
        '    <div><span>Key</span><strong>' + escapeHtml(model.apiKeyMasked || '未配置') + '</strong></div>' +
        '  </div>' +
        '  <div class="ai-model-actions">' +
        (model.ownerType === 'USER' ? '<button class="btn btn-default btn-sm" onclick="editAiModel(' + model.id + ')">编辑</button>' : '') +
        '<button class="btn btn-default btn-sm" onclick="testAiModel(' + model.id + ')">测试</button>' +
        (model.ownerType === 'USER' ? '<button class="btn btn-default btn-sm" onclick="probeAiModel(' + model.id + ')">能力测试</button>' : '') +
        (model.ownerType === 'USER' ? '<button class="btn btn-danger btn-sm" onclick="deleteAiModel(' + model.id + ')">删除</button>' : '') +
        '  </div>' +
        '</div>'
    )).join('');
    window.__aiModels = rows;
}

function cleanModelLabel(label, ownerType) {
    const text = String(label || '模型').trim()
        .replace(/（我的）$/g, '')
        .replace(/\(我的\)$/g, '')
        .replace(/（系统）$/g, '')
        .replace(/\(系统\)$/g, '');
    return text + (ownerType === 'SYSTEM' ? '（系统）' : '（我的）');
}

function editAiModel(id) {
    const model = (window.__aiModels || []).find((item) => String(item.id) === String(id));
    if (!model || model.ownerType !== 'USER') return;
    editingAiModelId = model.id;
    document.getElementById('ai-display-name').value = model.displayName || '';
    document.getElementById('ai-provider-type').value = model.providerType || 'OPENAI_COMPATIBLE';
    document.getElementById('ai-api-url').value = model.apiUrl || '';
    document.getElementById('ai-api-key').value = '';
    document.getElementById('ai-api-key').placeholder = model.apiKeyMasked || '留空则不修改已保存 Key';
    document.getElementById('ai-model-name').value = model.modelName || '';
    if (window.refreshCustomSelects) window.refreshCustomSelects();
}

function resetAiModelForm() {
    editingAiModelId = null;
    ['ai-display-name', 'ai-api-url', 'ai-api-key', 'ai-model-name'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const provider = document.getElementById('ai-provider-type');
    if (provider) provider.value = 'OPENAI_COMPATIBLE';
    if (window.refreshCustomSelects) window.refreshCustomSelects();
}

function renderProbeStatus(status) {
    const normalized = String(status || 'UNTESTED').toUpperCase();
    const label = normalized === 'VERIFIED' ? '已验证'
        : normalized === 'UNSUPPORTED' ? '不支持'
        : normalized === 'FAILED' ? '失败'
        : '未测试';
    return '<span class="ai-probe-status ' + normalized.toLowerCase() + '">' + label + '</span>';
}

async function testAiModel(id) {
    try {
        const res = await api.post('/ai/models/' + id + '/test', {});
        showToast('模型连通正常：' + ((res.data && res.data.reply) || 'OK'), 'success');
    } catch (e) {
        showToast(e.message || '模型测试失败', 'error');
    }
}

async function probeAiModel(id) {
    try {
        showToast('正在测试模型能力，会消耗少量 token...', 'info');
        const res = await api.post('/ai/models/' + id + '/probe', {});
        const data = res.data || {};
        showToast('能力测试完成：连通性 ' + probeStatusText(data.capabilityProbeStatus) +
            '，视觉 ' + probeStatusText(data.visionStatus) +
            '，深度思考 ' + probeStatusText(data.reasoningStatus), data.ok ? 'success' : 'warning');
        await loadAiModels();
    } catch (e) {
        showToast(e.message || '能力测试失败', 'error');
    }
}

function probeStatusText(status) {
    const normalized = String(status || 'UNTESTED').toUpperCase();
    if (normalized === 'VERIFIED') return '已验证';
    if (normalized === 'UNSUPPORTED') return '不支持';
    if (normalized === 'FAILED') return '失败';
    return '未测试';
}

async function deleteAiModel(id) {
    const ok = await showConfirm('确定删除这个模型配置？删除后 API Key 无法恢复。');
    if (!ok) return;
    try {
        await api.delete('/ai/models/' + id);
        showToast('模型已删除', 'success');
        await loadAiModels();
    } catch (e) {
        showToast(e.message || '删除失败', 'error');
    }
}

// ── AI 记忆 ──

async function loadAiMemory() {
    try {
        const res = await api.get('/ai/memory');
        const data = res.data || {};
        const textEl = document.getElementById('ai-memory-text');
        const metaEl = document.getElementById('ai-memory-meta');
        if (textEl) textEl.value = data.memoryText || '';
        if (metaEl) metaEl.textContent = '短期对话记忆：' + ((data.messageCount ?? 0)) + ' 条';
    } catch (e) {
        // 未产生记忆时保持默认空状态
    }
}

document.getElementById('btn-save-memory')?.addEventListener('click', async () => {
    const memoryText = document.getElementById('ai-memory-text')?.value.trim() || '';
    try {
        await api.put('/ai/memory', { memoryText });
        showToast('AI 记忆已保存', 'success');
        await loadAiMemory();
    } catch (e) {
        showToast(e.message || '保存失败', 'error');
    }
});

// ── 个人知识库 ──

async function loadKnowledge() {
    await Promise.all([
        loadKnowledgePages(),
        loadKnowledgeRevisions()
    ]);
}

async function loadKnowledgePages() {
    const box = document.getElementById('knowledge-pages');
    if (!box) return;
    try {
        const res = await api.get('/knowledge/pages');
        const rows = res.data || [];
        box.innerHTML = rows.length ? rows.map((row) => (
            '<div class="knowledge-card">' +
            '  <div class="knowledge-title">' + escapeHtml(row.title || '') + '</div>' +
            '  <div class="knowledge-meta">' + escapeHtml(row.pageType || 'NOTE') + '</div>' +
            '  <p>' + escapeHtml(row.content || '') + '</p>' +
            '  <button class="btn btn-default btn-sm" onclick="deleteKnowledgePage(' + row.id + ',' + Number(row.version || 0) + ')">删除</button>' +
            '</div>'
        )).join('') : '<div class="empty-line">还没有已确认知识。</div>';
    } catch (e) {
        box.innerHTML = '<div class="empty-line">知识库读取失败。</div>';
    }
}

async function loadKnowledgeRevisions() {
    const box = document.getElementById('knowledge-revisions');
    if (!box) return;
    try {
        const res = await api.get('/knowledge/revisions');
        const rows = res.data || [];
        box.innerHTML = rows.length ? rows.map((row) => (
            '<div class="knowledge-card pending">' +
            '  <div class="knowledge-title">' + escapeHtml(row.title || '记忆建议') + '</div>' +
            '  <p>' + escapeHtml(row.content || '') + '</p>' +
            '  <div class="reminder-actions">' +
            '    <button class="btn btn-primary btn-sm" onclick="approveKnowledgeRevision(' + row.id + ')">确认</button>' +
            '    <button class="btn btn-default btn-sm" onclick="rejectKnowledgeRevision(' + row.id + ')">忽略</button>' +
            '  </div>' +
            '</div>'
        )).join('') : '<div class="empty-line">暂无待确认建议。</div>';
    } catch (e) {
        box.innerHTML = '<div class="empty-line">建议读取失败。</div>';
    }
}

document.getElementById('btn-save-knowledge')?.addEventListener('click', async () => {
    const title = document.getElementById('knowledge-title')?.value.trim();
    const pageType = document.getElementById('knowledge-type')?.value || 'NOTE';
    const content = document.getElementById('knowledge-content')?.value.trim();
    if (!title || !content) {
        showToast('请填写知识标题和内容', 'warning');
        return;
    }
    try {
        await api.post('/knowledge/pages', { title, pageType, content });
        document.getElementById('knowledge-title').value = '';
        document.getElementById('knowledge-content').value = '';
        showToast('知识已保存', 'success');
        await loadKnowledgePages();
    } catch (e) {
        showToast(e.message || '保存失败', 'error');
    }
});

async function approveKnowledgeRevision(id) {
    try {
        await api.post('/knowledge/revisions/' + id + '/approve', {});
        showToast('已写入知识库', 'success');
        await loadKnowledge();
    } catch (e) {
        showToast(e.message || '确认失败', 'error');
    }
}

async function rejectKnowledgeRevision(id) {
    try {
        await api.post('/knowledge/revisions/' + id + '/reject', {});
        showToast('已忽略', 'success');
        await loadKnowledgeRevisions();
    } catch (e) {
        showToast(e.message || '操作失败', 'error');
    }
}

async function deleteKnowledgePage(id, version) {
    const ok = await showConfirm('确定删除这条知识？');
    if (!ok) return;
    try {
        await api.delete('/knowledge/pages/' + id + '?version=' + encodeURIComponent(version));
        showToast('知识已删除', 'success');
        await loadKnowledgePages();
    } catch (e) {
        showToast(e.message || '删除失败', 'error');
    }
}

document.getElementById('btn-clear-memory')?.addEventListener('click', async () => {
    const ok = await showConfirm('确定清空 AI 长期记忆和短期对话历史？');
    if (!ok) return;
    try {
        await api.delete('/ai/memory');
        const textEl = document.getElementById('ai-memory-text');
        if (textEl) textEl.value = '';
        showToast('AI 记忆已清空', 'success');
        await loadAiMemory();
    } catch (e) {
        showToast(e.message || '清空失败', 'error');
    }
});

// ── 早八提醒设置 ──

async function loadReminderSettings() {
    try {
        const res = await api.get('/reminder/settings');
        const data = res.data || {};
        const enabledEl = document.getElementById('reminder-enabled');
        const channelEl = document.getElementById('reminder-channel');
        const webhookEl = document.getElementById('reminder-webhook');
        const appIdEl = document.getElementById('qq-app-id');
        const appSecretEl = document.getElementById('qq-app-secret');
        const groupEl = document.getElementById('qq-group-openid');
        const sandboxEl = document.getElementById('qq-sandbox');
        const pushplusEl = document.getElementById('pushplus-token');
        if (enabledEl) enabledEl.checked = !!data.enabled;
        if (channelEl) channelEl.value = data.channel || 'PUSHPLUS';
        if (webhookEl && data.webhookUrl) webhookEl.placeholder = data.webhookUrl;
        if (appIdEl) appIdEl.value = data.qqAppId || '';
        if (appSecretEl && data.qqAppSecret) appSecretEl.placeholder = data.qqAppSecret;
        if (groupEl) groupEl.value = data.qqGroupOpenid || '';
        if (sandboxEl) sandboxEl.checked = !!data.qqSandbox;
        if (pushplusEl && data.pushplusToken) pushplusEl.placeholder = data.pushplusToken;
        updateReminderChannelPanels();
    } catch (e) {
        // 未配置时保持默认空状态
        updateReminderChannelPanels();
    }
}

document.getElementById('btn-save-reminder')?.addEventListener('click', async () => {
    const enabled = !!document.getElementById('reminder-enabled')?.checked;
    const channel = document.getElementById('reminder-channel')?.value || 'PUSHPLUS';
    const webhookUrl = document.getElementById('reminder-webhook')?.value.trim();
    const qqAppId = document.getElementById('qq-app-id')?.value.trim();
    const qqAppSecret = document.getElementById('qq-app-secret')?.value.trim();
    const qqGroupOpenid = document.getElementById('qq-group-openid')?.value.trim();
    const qqSandbox = !!document.getElementById('qq-sandbox')?.checked;
    const pushplusToken = document.getElementById('pushplus-token')?.value.trim();
    try {
        const body = {
            channel: channel,
            enabled: enabled
        };
        if (webhookUrl) {
            body.webhookUrl = webhookUrl;
        }
        body.qqAppId = qqAppId || '';
        if (qqAppSecret) {
            body.qqAppSecret = qqAppSecret;
        }
        body.qqGroupOpenid = qqGroupOpenid || '';
        body.qqSandbox = qqSandbox;
        if (pushplusToken) {
            body.pushplusToken = pushplusToken;
        }
        await api.put('/reminder/settings', body);
        showToast('提醒设置已保存', 'success');
        const webhookEl = document.getElementById('reminder-webhook');
        if (webhookEl) webhookEl.value = '';
        const appSecretEl = document.getElementById('qq-app-secret');
        if (appSecretEl) appSecretEl.value = '';
        const pushplusEl = document.getElementById('pushplus-token');
        if (pushplusEl) pushplusEl.value = '';
        await loadReminderSettings();
    } catch (e) {
        showToast(e.message || '保存失败', 'error');
    }
});

document.getElementById('btn-test-reminder')?.addEventListener('click', async () => {
    try {
        await api.post('/reminder/test', {});
        showToast('测试提醒已发送', 'success');
    } catch (e) {
        showToast(e.message || '发送失败，请检查 Webhook', 'error');
    }
});

document.getElementById('reminder-channel')?.addEventListener('change', updateReminderChannelPanels);

function updateReminderChannelPanels() {
    const channel = document.getElementById('reminder-channel')?.value || 'PUSHPLUS';
    document.querySelectorAll('.reminder-channel-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.channel === channel);
    });
}
