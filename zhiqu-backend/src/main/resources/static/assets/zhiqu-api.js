/* 知趣 · 新 UI 接口适配层
   只负责把 zhiqu-ui 静态页面接回现有 /api 接口，尽量不改变页面结构和视觉。 */
(function () {
  'use strict';

  var API = '/api';
  // 根路径 "/" 由 Spring 作为欢迎页返回 index.html（登录页），此时 pathname 为空，
  // 默认必须落到 index.html，否则 bootIndex 不执行、登录按钮无处理器。
  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var state = {
    user: null,
    tasks: [],
    routines: [],
    notebooks: [],
    notebookId: null,
    messages: [],
    pendingSources: [],
    reasoningExpanded: Object.create(null)
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (s) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s];
    });
  }
  function maintainShellCache() {
    if (!/^https?:$/.test(location.protocol)) return;
    // Old shell caches are removed exclusively by the active Service Worker's activate handler.
    // Keeping one owner avoids the page deleting a newly installed cache with a stale version constant.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js')
        .then(function (registration) { return registration.update().catch(function () {}); })
        .catch(function () {});
    }
  }
  function token() { return sessionStorage.getItem('token') || localStorage.getItem('token') || ''; }
  function role() { return sessionStorage.getItem('role') || localStorage.getItem('role') || ''; }
  function setAuth(data, remember) {
    if (data && data.token) {
      sessionStorage.setItem('token', data.token);
      sessionStorage.setItem('role', data.role || 'USER');
      if (remember) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('role', data.role || 'USER');
      } else {
        localStorage.removeItem('token');
        localStorage.removeItem('role');
      }
    }
  }
  function clearAuth() {
    sessionStorage.removeItem('token'); sessionStorage.removeItem('role');
    localStorage.removeItem('token'); localStorage.removeItem('role');
  }
  var redirecting = false;
  function redirectToLogin() {
    if (redirecting) return;
    clearAuth();
    if (page !== 'index.html') { redirecting = true; location.replace('index.html?login=1'); }
  }
  function isAuthFailure(json) {
    if (!json) return false;
    if (json.code === 401 || json.code === 403) return true;
    return /未登录|登录状态|登录已过期|请先登录|无权限/.test(json.message || '');
  }
  async function request(path, options) {
    var headers = Object.assign({}, options && options.headers || {});
    if (token()) headers.Authorization = 'Bearer ' + token();
    if (options && options.body != null && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    var res = await fetch(API + path, Object.assign({ credentials: 'same-origin' }, options || {}, { headers: headers }));
    if (res.status === 401 || res.status === 403) {
      redirectToLogin();
      throw new Error('未登录或无权限');
    }
    var text = await res.text();
    var json = text ? JSON.parse(text) : {};
    if (json.code !== 200) {
      if (isAuthFailure(json)) redirectToLogin();
      throw new Error(json.message || '请求失败');
    }
    return json.data;
  }
  var api = {
    get: function (p) { return request(p, { method: 'GET' }); },
    post: function (p, b, h) { return request(p, { method: 'POST', body: JSON.stringify(b || {}), headers: h || {} }); },
    put: function (p, b) { return request(p, { method: 'PUT', body: b == null ? undefined : JSON.stringify(b) }); },
    del: function (p) { return request(p, { method: 'DELETE' }); },
    upload: function (p, file, fields) {
      var fd = new FormData();
      fd.append('file', file);
      Object.keys(fields || {}).forEach(function (k) { if (fields[k] != null && fields[k] !== '') fd.append(k, fields[k]); });
      return request(p, { method: 'POST', body: fd });
    }
  };

  function toast(msg, kind) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;right:22px;top:22px;z-index:99999;max-width:360px;padding:10px 14px;border:1px solid var(--zq-border);border-radius:var(--zq-rs);background:var(--zq-card);box-shadow:var(--zq-sh2);color:' + (kind === 'error' ? 'var(--zq-bad)' : 'var(--zq-text)') + ';font-size:13px;font-weight:600;';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }
  // 右上角持久通知（Claude 弹窗风格）：notice('正在测试…') → {update(msg,{done}), close()}
  // update 传 {done:true} 时切换为完成态并在 2s 后自动消失
  function notice(msg) {
    var el = document.createElement('div');
    el.className = 'zq-notice';
    el.innerHTML = '<span class="zq-notice-dot"></span><span class="zq-notice-text"></span>';
    el.querySelector('.zq-notice-text').textContent = msg;
    document.body.appendChild(el);
    var closed = false;
    function close() { if (closed) return; closed = true; el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 220); }
    return {
      update: function (m, opts) {
        if (closed) return;
        el.querySelector('.zq-notice-text').textContent = m;
        if (opts && opts.done) { el.classList.add('zq-notice-done'); setTimeout(close, 2000); }
        if (opts && opts.error) { el.classList.add('zq-notice-error'); setTimeout(close, 3000); }
      },
      close: close
    };
  }
  // 可复用的 Claude 风格居中弹窗：openModal({title, bodyHtml, width, onMount(body,handle), onClose}) → {close, body, mask}
  function openModal(opts) {
    opts = opts || {};
    var mask = document.createElement('div');
    mask.className = 'zq-modal-mask';
    var w = opts.width ? ('width:' + opts.width + ';') : '';
    mask.innerHTML = '<div class="zq-modal" role="dialog" aria-modal="true" style="' + w + '">'
      + '<div class="zq-modal-head"><h3 class="zq-modal-title">' + esc(opts.title || '') + '</h3>'
      + '<button type="button" class="zq-modal-close" aria-label="关闭">×</button></div>'
      + '<div class="zq-modal-body"></div></div>';
    var body = mask.querySelector('.zq-modal-body');
    if (opts.bodyHtml != null) body.innerHTML = opts.bodyHtml;
    else if (opts.bodyNode) body.appendChild(opts.bodyNode);
    var closed = false;
    function close() {
      if (closed) return; closed = true;
      document.removeEventListener('keydown', onKey);
      mask.remove();
      if (!document.querySelector('.zq-modal-mask')) document.body.classList.remove('zq-modal-open');
      if (opts.onClose) { try { opts.onClose(); } catch (e) {} }
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.zq-modal-close').onclick = close;
    document.addEventListener('keydown', onKey);
    document.body.classList.add('zq-modal-open');
    document.body.appendChild(mask);
    var handle = { close: close, mask: mask, body: body };
    if (opts.onMount) { try { opts.onMount(body, handle); } catch (e) {} }
    var first = body.querySelector('input,textarea,select,button'); if (first) { try { first.focus(); } catch (e) {} }
    return handle;
  }
  // ── 弹窗版 prompt/confirm/alert（替换浏览器原生弹框，统一 Claude 风格） ──
  // askText({title,label,placeholder,value,textarea,okText}) → Promise<string|null>（取消返回 null）
  function askText(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      var field = opts.textarea
        ? '<textarea id="zq-ask-input" class="zq-textarea" style="min-height:100px;" placeholder="' + esc(opts.placeholder || '') + '">' + esc(opts.value || '') + '</textarea>'
        : '<input id="zq-ask-input" class="zq-input" placeholder="' + esc(opts.placeholder || '') + '" value="' + esc(opts.value || '') + '">';
      openModal({
        title: opts.title || '请输入',
        bodyHtml:
          '<div class="zq-field">' + (opts.label ? '<label class="zq-label">' + esc(opts.label) + '</label>' : '') + field + '</div>'
          + (opts.hint ? '<p style="margin:0 0 12px;font-size:12px;color:var(--zq-text3);line-height:1.6;">' + esc(opts.hint) + '</p>' : '')
          + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" data-ask="cancel">取消</button><button type="button" class="zq-btn" data-ask="ok">' + esc(opts.okText || '确定') + '</button></div>',
        onMount: function (b, h) {
          var input = $('#zq-ask-input', b);
          try { input.select(); } catch (e) {}
          function finish(v) { if (done) return; done = true; h.close(); resolve(v); }
          $('[data-ask="cancel"]', b).onclick = function () { finish(null); };
          $('[data-ask="ok"]', b).onclick = function () { finish(input.value); };
          if (!opts.textarea) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } });
        },
        onClose: function () { if (!done) { done = true; resolve(null); } }
      });
    });
  }
  // askConfirm({title,message,okText,danger}) → Promise<boolean>
  function askConfirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      openModal({
        title: opts.title || '确认操作',
        bodyHtml:
          '<p style="margin:0 0 16px;font-size:13.5px;line-height:1.7;color:var(--zq-text2);white-space:pre-wrap;">' + esc(opts.message || '确定继续吗？') + '</p>'
          + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" data-ask="cancel">取消</button><button type="button" class="zq-btn" data-ask="ok"' + (opts.danger ? ' style="background:var(--zq-bad);"' : '') + '>' + esc(opts.okText || '确定') + '</button></div>',
        onMount: function (b, h) {
          function finish(v) { if (done) return; done = true; h.close(); resolve(v); }
          $('[data-ask="cancel"]', b).onclick = function () { finish(false); };
          $('[data-ask="ok"]', b).onclick = function () { finish(true); };
        },
        onClose: function () { if (!done) { done = true; resolve(false); } }
      });
    });
  }
  // showInfo({title,message,html}) → Promise<void>
  function showInfo(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      openModal({
        title: opts.title || '提示',
        bodyHtml:
          (opts.html || '<p style="margin:0 0 16px;font-size:13.5px;line-height:1.7;color:var(--zq-text2);white-space:pre-wrap;">' + esc(opts.message || '') + '</p>')
          + '<div class="zq-modal-actions"><button type="button" class="zq-btn" data-ask="ok">知道了</button></div>',
        onMount: function (b, h) {
          $('[data-ask="ok"]', b).onclick = function () { if (done) return; done = true; h.close(); resolve(); };
        },
        onClose: function () { if (!done) { done = true; resolve(); } }
      });
    });
  }
  function empty(msg) { return '<div style="padding:18px;text-align:center;color:var(--zq-text3);font-size:12.5px;">' + esc(msg || '暂无数据') + '</div>'; }
  function fmtDate(v) { return v ? String(v).replace('T', ' ').slice(0, 16) : '—'; }
  function d10(v) { return v ? String(v).slice(0, 10) : ''; }
  function hm(v) { return v ? String(v).replace('T', ' ').slice(11, 16) : ''; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function weekRange(offset) {
    var now = new Date();
    var day = now.getDay() || 7;
    var mon = new Date(now); mon.setDate(now.getDate() - day + 1 + (offset || 0) * 7);
    var sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return [mon.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
  }
  function qLabel(q) { return ({ 1: '重要且紧急', 2: '重要不紧急', 3: '紧急不重要', 4: '不重要不紧急' })[q] || '未分类'; }
  function qKey(q) { return ({ 1: 'q1', 2: 'q2', 3: 'q3', 4: 'q4' })[q] || 'q4'; }
  function pLabel(p) { return ({ 0: '低', 1: '中', 2: '高', 3: '紧急' })[p] || '中'; }
  function sLabel(s) { return ({ 0: '待办', 1: '进行中', 2: '已完成' })[s] || '待办'; }
  function normalizeTask(t) {
    return Object.assign({}, t, {
      title: t.title || t.name || '未命名任务',
      description: t.description || '',
      quadrant: Number(t.quadrant || t.q || 2),
      priority: Number(t.priority == null ? 1 : t.priority),
      status: Number(t.status == null ? 0 : t.status)
    });
  }
  function renderInitError(err) {
    if (page === 'index.html') return;
    var main = $('.zq-main') || $('main') || document.body;
    if (!main) return;
    var message = err && err.message ? err.message : '页面数据加载失败';
    main.innerHTML = '<section class="zq-card" style="max-width:720px;margin:40px auto;padding:24px;">'
      + '<p class="zq-eyebrow">加载失败</p>'
      + '<h1 class="zq-h1" style="margin-bottom:10px;">页面接口暂时不可用</h1>'
      + '<p style="margin:0 0 16px;color:var(--zq-text2);font-size:13px;line-height:1.8;">'
      + esc(message)
      + '</p><button class="zq-btn" onclick="location.reload()">重新加载</button>'
      + '</section>';
  }
  async function safe(name, fn, options) {
    try { return await fn(); } catch (e) {
      if (redirecting) return;
      console.error('[zhiqu-api]', name, e);
      toast(e.message || name + '失败', 'error');
      if (options && options.renderError) renderInitError(e);
    }
  }

  async function initAuth() {
    if (page === 'index.html') return null;
    state.user = await api.get('/auth/info');
    updateSidebarUser(state.user);
    return state.user;
  }
  /**
   * 把本地存的角色对齐到服务端返回值。只更新**已经存在**的那个键 ——
   * 未勾选「记住登录状态」时 localStorage 里本来就没有 role，这里不能替它建一个。
   *
   * 目的是让下一次页面加载的首屏就画对：侧栏是同步渲染的，读的就是这个值，
   * 不同步的话，同一浏览器换账号登录后每次跳转都会闪一下「管理」组。
   */
  function syncStoredRole(r) {
    try {
      if (sessionStorage.getItem('role') !== null) sessionStorage.setItem('role', r);
      if (localStorage.getItem('role') !== null) localStorage.setItem('role', r);
    } catch (e) {}
  }
  function updateSidebarUser(u) {
    var r = (u && u.role) || role() || 'USER';
    // 服务端角色是唯一权威。buildSidebar 首屏用的是本地存的角色（客户端可改，也可能是
    // 上一个账号的残留），这里用 /auth/info 的结果做最终裁决，两个方向都走。
    // 它只决定**显示**——真正的拦截在后端 AdminGuard，每个 /api/admin/** 都回库查 role。
    syncStoredRole(r);
    try { if (window.ZQUI && window.ZQUI.setAdminNav) window.ZQUI.setAdminNav(r); } catch (e) {}
    var box = $('.zq-user');
    if (!box || !u) return;
    var name = u.nickname || u.username || '知趣用户';
    var avatar = u.avatar ? '<img src="' + esc(u.avatar) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">' : esc(name.slice(0, 1));
    box.innerHTML = '<div class="zq-avatar">' + avatar + '</div><div style="min-width:0;"><div style="font-size:12.5px;font-weight:600;color:var(--zq-sb-active-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(name) + '</div><div style="font-size:11px;color:var(--zq-text3);">' + esc(r === 'ADMIN' ? '管理员' : '普通用户') + '</div></div>';
  }

  var AUTH_FORM_HTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--zq-border-soft);margin-bottom:18px;">'
    + '<button type="button" data-authtab="login" style="height:38px;border:none;background:none;cursor:pointer;font-size:14px;font-weight:700;color:var(--zq-primary);border-bottom:2px solid var(--zq-primary);">登录</button>'
    + '<button type="button" data-authtab="register" style="height:38px;border:none;background:none;cursor:pointer;font-size:14px;font-weight:500;color:var(--zq-text2);border-bottom:2px solid transparent;">注册</button>'
    + '</div>'
    + '<form id="form-login" style="display:flex;flex-direction:column;gap:14px;" onsubmit="return false;">'
    + '<div class="zq-field"><label class="zq-label">用户名</label><input class="zq-input" placeholder="请输入用户名"></div>'
    + '<div class="zq-field"><label class="zq-label">密码</label><input class="zq-input" type="password" placeholder="请输入密码"></div>'
    + '<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--zq-text2);cursor:pointer;"><input type="checkbox" style="accent-color:var(--zq-primary);"><span>记住登录状态</span></label>'
    + '<button class="zq-btn" style="height:38px;">登 录</button>'
    + '</form>'
    + '<form id="form-reg" style="display:none;flex-direction:column;gap:14px;" onsubmit="return false;">'
    + '<div class="zq-field"><label class="zq-label">用户名</label><input class="zq-input" placeholder="请输入用户名"></div>'
    + '<div class="zq-field"><label class="zq-label">密码</label><input class="zq-input" type="password" placeholder="至少 6 位密码"></div>'
    + '<div class="zq-field"><label class="zq-label">确认密码</label><input class="zq-input" type="password" placeholder="再次输入密码"></div>'
    + '<button class="zq-btn" style="height:38px;">注 册</button>'
    + '</form>';
  function switchAuthTab(root, tab) {
    var lg = tab !== 'register';
    var fl = $('#form-login', root), fr = $('#form-reg', root);
    if (fl) fl.style.display = lg ? 'flex' : 'none';
    if (fr) fr.style.display = lg ? 'none' : 'flex';
    $all('[data-authtab]', root).forEach(function (t) {
      var on = t.getAttribute('data-authtab') === (lg ? 'login' : 'register');
      t.style.fontWeight = on ? '700' : '500';
      t.style.color = on ? 'var(--zq-primary)' : 'var(--zq-text2)';
      t.style.borderBottomColor = on ? 'var(--zq-primary)' : 'transparent';
    });
  }
  function wireAuthForms(root) {
    var login = $('#form-login', root), reg = $('#form-reg', root);
    $all('[data-authtab]', root).forEach(function (t) { t.onclick = function () { switchAuthTab(root, t.getAttribute('data-authtab')); }; });
    if (login) login.addEventListener('submit', function (e) {
      e.preventDefault();
      var ins = $all('input', login);
      var remember = !!(ins[2] && ins[2].checked);
      safe('登录', async function () {
        var data = await api.post('/auth/login', { username: ins[0].value.trim(), password: ins[1].value, rememberMe: remember });
        setAuth(data, remember);
        location.href = 'dashboard.html';
      });
    });
    if (reg) reg.addEventListener('submit', function (e) {
      e.preventDefault();
      var ins = $all('input', reg);
      if (ins[1].value !== ins[2].value) return toast('两次密码不一致', 'error');
      safe('注册', async function () {
        await api.post('/auth/register', { username: ins[0].value.trim(), password: ins[1].value, confirmPassword: ins[2].value });
        toast('注册成功，请登录');
        switchAuthTab(root, 'login');
      });
    });
  }
  function openAuthModal(tab) {
    return openModal({
      title: tab === 'register' ? '注册知趣账号' : '登录知趣',
      width: '400px',
      bodyHtml: AUTH_FORM_HTML,
      onMount: function (body) { wireAuthForms(body); switchAuthTab(body, tab || 'login'); }
    });
  }
  function bootIndex() {
    if (token()) { location.href = 'dashboard.html'; return; }
    $all('[data-auth]').forEach(function (b) { b.onclick = function () { openAuthModal(b.getAttribute('data-auth')); }; });
    var q = new URLSearchParams(location.search);
    if (q.get('login') != null) openAuthModal(q.get('login') === 'register' ? 'register' : 'login');
  }

  async function bootDashboard() {
    if (state.weekOffset == null) state.weekOffset = 0;
    var r = weekRange(state.weekOffset);
    var data = await api.get('/dashboard/overview?from=' + r[0] + '&to=' + r[1]);
    var sum = data.summary || {};
    var statNums = $all('.zq-stat-num');
    if (statNums[0]) statNums[0].textContent = sum.pendingToday == null ? sum.todayTasks || 0 : sum.pendingToday;
    if (statNums[1]) statNums[1].textContent = sum.overdue || 0;
    if (statNums[2]) statNums[2].textContent = sum.remindersToday || 0;
    if (statNums[3]) statNums[3].textContent = (sum.routineDone || 0) + '/' + (sum.routineTotal || 0);
    var headerDate = $('header span');
    var todayRow = (data.days || []).find(function (d) { return d.today; });
    if (headerDate) headerDate.textContent = today() + (todayRow && todayRow.weekday ? ' · ' + todayRow.weekday : '');
    renderWeek(data.days || []);
    renderToday((data.days || []).find(function (d) { return d.today; })?.items || []);
    renderQuadrants(data.quadrants || []);
    renderDeadlines(data.upcomingDeadlines || []);
    // 周历标题随范围更新
    var weekSection = $('#zq-week') && $('#zq-week').closest('section');
    var weekTitle = weekSection && weekSection.querySelector('.zq-h2');
    if (weekTitle) weekTitle.textContent = r[0].slice(5).replace('-', '/') + ' – ' + r[1].slice(5).replace('-', '/');
    $all('[data-week-nav]').forEach(function (b) {
      b.onclick = function () {
        var nav = b.dataset.weekNav;
        state.weekOffset = nav === 'today' ? 0 : (state.weekOffset + (nav === 'next' ? 1 : -1));
        bootDashboard();
      };
    });
    var add = $('header .zq-btn');
    if (add) add.onclick = function () { location.href = 'tasks.html'; };
    await populatePomoTasks();
    await updatePomoCount();
    if (window.zqApi) window.zqApi.afterRecord = function () { bootDashboard(); };
  }
  async function populatePomoTasks() {
    var sel = $('#zq-pomo-task'); if (!sel) return;
    try {
      var tasks = (await api.get('/task/list?status=0')).map(normalizeTask);
      sel.innerHTML = '<option value="">（不指定任务）</option>' + tasks.slice(0, 50).map(function (t) {
        return '<option value="' + t.id + '">' + esc(t.title) + '</option>';
      }).join('');
    } catch (e) { /* 忽略：下拉保持默认项 */ }
  }
  async function updatePomoCount() {
    var host = $('#zq-pomo-count'); if (!host) return;
    try {
      var recs = await api.get('/record/list');
      var t = today();
      var todays = (recs || []).filter(function (rec) { return d10(rec.studyDate) === t; });
      var mins = todays.reduce(function (a, rec) { return a + (rec.durationMinutes || 0); }, 0);
      host.textContent = '今日：' + todays.length + ' 个 ｜ ' + mins + ' 分钟';
    } catch (e) { /* 忽略 */ }
  }
  function renderWeek(days) {
    var host = $('#zq-week');
    if (!host) return;
    host.innerHTML = days.length ? days.map(function (d) {
      var items = (d.items || []).slice(0, 5).map(function (it) {
        return '<div style="display:grid;grid-template-columns:36px minmax(0,1fr);gap:6px;align-items:center;padding:6px 7px;border-radius:var(--zq-rs);background:' + (it.kind === 'ROUTINE' ? 'var(--zq-tint)' : 'var(--zq-card)') + ';border:1px solid var(--zq-border-soft);"><span class="zq-mono" style="color:var(--zq-primary);font-size:10.5px;font-weight:600;">' + esc(it.time || hm(it.deadline) || '') + '</span><span style="min-width:0;overflow:hidden;color:var(--zq-text);font-size:11.5px;font-weight:500;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.title) + '</span></div>';
      }).join('') || '<div style="padding:10px 0;text-align:center;color:var(--zq-text3);font-size:11.5px;">无安排</div>';
      return '<div style="min-height:225px;padding:10px;border:1px solid ' + (d.today ? 'var(--zq-primary)' : 'var(--zq-border-soft)') + ';border-radius:var(--zq-rs);background:' + (d.today ? 'var(--zq-tint)' : 'var(--zq-card-soft)') + ';"><div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;"><span style="color:' + (d.today ? 'var(--zq-primary)' : 'var(--zq-text2)') + ';font-size:11.5px;font-weight:700;">' + esc(d.weekday) + '</span><strong class="zq-mono" style="font-size:18px;color:' + (d.today ? 'var(--zq-primary)' : 'var(--zq-text)') + ';">' + esc(d.day) + '</strong></div><div style="display:flex;flex-direction:column;gap:7px;">' + items + '</div></div>';
    }).join('') : empty('暂无本周安排');
  }
  function renderToday(items) {
    var host = $('#zq-today');
    if (!host) return;
    host.innerHTML = items.length ? items.map(function (x) {
      var routine = x.kind === 'ROUTINE';
      var q = routine ? 'routine' : qKey(x.quadrant);
      var color = routine ? 'var(--zq-primary)' : 'var(--zq-' + q + ')';
      return '<div style="display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:12px;align-items:center;padding:8px 12px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:' + (routine ? 'var(--zq-tint)' : 'var(--zq-card)') + ';opacity:' + (x.status === 2 || x.completed ? .58 : 1) + ';"><span class="zq-mono" style="color:var(--zq-primary);font-size:12.5px;font-weight:600;">' + esc(x.time || hm(x.deadline) || '') + '</span><div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;line-height:1.35;">' + esc(x.title) + '</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;align-items:center;"><span class="zq-badge" style="background:var(--zq-tint);color:' + color + ';">' + esc(routine ? '例行' : qLabel(x.quadrant)) + '</span><span style="color:var(--zq-text2);font-size:11.5px;">' + esc(x.description || fmtDate(x.deadline)) + '</span></div></div><button class="zq-btn-ghost" data-task-done="' + esc(x.id || '') + '" data-kind="' + esc(x.kind || '') + '" style="height:28px;padding:0 11px;font-size:12px;">' + (x.status === 2 || x.completed ? '已完成' : '完成') + '</button></div>';
    }).join('') : empty('今天暂时没有安排');
    $all('[data-task-done]', host).forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute('data-task-done');
        if (!id) return;
        safe('完成', async function () {
          if (btn.getAttribute('data-kind') === 'ROUTINE') await api.post('/routine/' + id + '/checkin', { checkDate: today(), status: 'DONE' });
          else await api.put('/task/' + id + '/status?status=2');
          await bootDashboard();
        });
      };
    });
  }
  function renderQuadrants(rows) {
    var host = $('#zq-quad'); if (!host) return;
    host.innerHTML = rows.map(function (row) {
      var q = qKey(row.quadrant);
      var items = (row.items || []).map(function (x) { return '<div style="padding:7px 9px;border-radius:var(--zq-rs);background:var(--zq-' + q + '-bg);font-size:12px;font-weight:500;line-height:1.45;">' + esc(x.title) + '</div>'; }).join('') || '<div style="font-size:12px;color:var(--zq-text3);">暂无关键任务</div>';
      return '<div style="min-height:150px;padding:13px;border:1px solid var(--zq-' + q + '-border);border-radius:var(--zq-rs);background:var(--zq-card);border-top:3px solid var(--zq-' + q + ');"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;"><span style="font-size:12px;font-weight:700;color:var(--zq-' + q + ');white-space:nowrap;">' + qLabel(row.quadrant) + '</span><span class="zq-mono" style="font-size:12px;font-weight:600;color:var(--zq-text3);">' + (row.total || 0) + ' 项</span></div><div style="display:flex;flex-direction:column;gap:7px;">' + items + '</div></div>';
    }).join('');
  }
  function renderDeadlines(list) {
    var host = $('#zq-ddl'); if (!host) return;
    host.innerHTML = list.length ? list.map(function (d) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--zq-border-soft);"><div style="min-width:0;"><strong style="display:block;font-size:12.5px;line-height:1.35;font-weight:600;">' + esc(d.title) + '</strong><span style="display:block;margin-top:3px;color:var(--zq-text2);font-size:11.5px;">' + esc(fmtDate(d.deadline)) + '</span></div><span class="zq-badge zq-mono" style="flex:none;background:var(--zq-card-soft);color:var(--zq-text2);">DDL</span></div>';
    }).join('') : empty('暂无临近 DDL');
  }

  async function bootTasks() {
    var selects = $all('.zq-card .zq-select');
    var queryBtn = $all('.zq-card .zq-btn')[0], newBtn = $all('.zq-card .zq-btn')[1];
    if (queryBtn) queryBtn.onclick = loadTasks;
    if (newBtn) newBtn.onclick = createTaskPrompt;
    await loadTasks();
    async function loadTasks() {
      var params = new URLSearchParams();
      var q = selects[0] ? selects[0].selectedIndex : 0, s = selects[1] ? selects[1].selectedIndex : 0, p = selects[2] ? selects[2].selectedIndex : 0;
      if (q) params.set('quadrant', q);
      if (s) params.set('status', s - 1);
      if (p) params.set('priority', p - 1);
      params.set('sortBy', selects[3] && selects[3].selectedIndex === 1 ? 'deadline' : selects[3] && selects[3].selectedIndex === 2 ? 'priority' : 'updatedAt');
      params.set('sortOrder', selects[4] && selects[4].selectedIndex === 1 ? 'asc' : 'desc');
      state.tasks = (await api.get('/task/list?' + params.toString())).map(normalizeTask);
      renderTaskRows(state.tasks);
    }
  }
  function renderTaskRows(list) {
    var host = $('#zq-rows'); if (!host) return;
    host.innerHTML = list.length ? list.map(function (t) {
      var q = qKey(t.quadrant);
      return '<div style="display:grid;grid-template-columns:minmax(200px,2.2fr) 104px 64px 78px 118px 118px 108px;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--zq-border-soft);opacity:' + (t.status === 2 ? .55 : 1) + ';"><div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.title) + '</div><div style="font-size:11.5px;color:var(--zq-text3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.description || '—') + '</div></div><span><span class="zq-badge" style="background:var(--zq-' + q + '-bg);color:var(--zq-' + q + ');">' + qLabel(t.quadrant) + '</span></span><span style="font-size:12.5px;font-weight:600;">' + pLabel(t.priority) + '</span><span><button data-cycle-task="' + t.id + '" style="display:inline-flex;align-items:center;height:22px;padding:0 9px;border:1px solid var(--zq-border);border-radius:999px;background:var(--zq-card-soft);color:var(--zq-text2);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">' + sLabel(t.status) + '</button></span><span class="zq-mono" style="font-size:12px;color:var(--zq-text2);">' + esc(fmtDate(t.deadline)) + '</span><span class="zq-mono" style="font-size:12px;color:var(--zq-text2);">' + esc(fmtDate(t.reminderTime)) + '</span><span style="display:flex;justify-content:flex-end;gap:6px;"><button class="zq-btn-ghost" data-edit-task="' + t.id + '" style="height:26px;padding:0 10px;font-size:12px;">编辑</button><button class="zq-btn-ghost" data-del-task="' + t.id + '" style="height:26px;padding:0 10px;font-size:12px;">删除</button></span></div>';
    }).join('') : empty('暂无任务');
    var foot = $('.zq-table > div:last-child span');
    if (foot) foot.textContent = '共 ' + list.length + ' 条';
    $all('[data-cycle-task]', host).forEach(function (b) { b.onclick = function () { cycleTask(Number(b.dataset.cycleTask)); }; });
    $all('[data-del-task]', host).forEach(function (b) { b.onclick = function () { deleteTask(Number(b.dataset.delTask)); }; });
    $all('[data-edit-task]', host).forEach(function (b) { b.onclick = function () { editTaskPrompt(Number(b.dataset.editTask)); }; });
  }
  async function createTaskPrompt() {
    var title = await askText({ title: '新建任务', label: '任务标题', placeholder: '例如：数学二轮 · 重积分专题' }); if (!title || !title.trim()) return;
    await safe('创建任务', async function () {
      await api.post('/task', { title: title.trim(), description: '', quadrant: 2, priority: 1, status: 0 }, { 'Idempotency-Key': 'ui-' + Date.now() });
      toast('任务已创建'); await bootTasks();
    });
  }
  async function editTaskPrompt(id) {
    var t = state.tasks.find(function (x) { return x.id === id; }); if (!t) return;
    var title = await askText({ title: '修改任务', label: '任务标题', value: t.title }); if (!title || !title.trim()) return;
    await safe('修改任务', async function () {
      await api.put('/task/' + id, Object.assign({}, t, { title: title.trim() }));
      toast('任务已保存'); await bootTasks();
    });
  }
  async function deleteTask(id) {
    if (!await askConfirm({ title: '删除任务', message: '确定删除这个任务？删除后不可恢复。', okText: '删除', danger: true })) return;
    await safe('删除任务', async function () { await api.del('/task/' + id); await bootTasks(); });
  }
  async function cycleTask(id) {
    var t = state.tasks.find(function (x) { return x.id === id; }); if (!t) return;
    await safe('切换状态', async function () { await api.put('/task/' + id + '/status?status=' + ((t.status + 1) % 3)); await bootTasks(); });
  }

  async function bootRoutines() {
    await loadRoutineSources(0);
    await loadRoutines();
    var buttons = $all('button.zq-btn, button.zq-btn-ghost');
    var createBtn = buttons.find(function (b) { return /创建例行计划/.test(b.textContent); });
    if (createBtn) createBtn.onclick = createRoutineFromForm;
    var genBtn = buttons.find(function (b) { return /生成例行计划/.test(b.textContent); });
    if (genBtn) genBtn.onclick = generateRoutinesFromTasks;
    var genSection = $all('section').find(function (s) { return /从任务生成/.test(s.textContent); });
    if (genSection) {
      var filterSel = $('select', genSection);
      var refreshBtn = $all('button', genSection).find(function (b) { return /刷新/.test(b.textContent); });
      if (filterSel) filterSel.onchange = function () { loadRoutineSources(filterSel.selectedIndex); };
      if (refreshBtn) refreshBtn.onclick = function () { loadRoutineSources(filterSel ? filterSel.selectedIndex : 0); };
    }
    // 星期选择器接线（点亮/熄灭），仅前端状态，提交时读取
    $all('#zq-wd button').forEach(function (b) {
      if (b.dataset.wired) return; b.dataset.wired = '1';
      b.addEventListener('click', function () {
        b.dataset.on = b.dataset.on === '1' ? '0' : '1';
        var on = b.dataset.on === '1';
        b.style.borderColor = on ? 'var(--zq-primary)' : 'var(--zq-border)';
        b.style.background = on ? 'var(--zq-tint)' : 'var(--zq-card)';
        b.style.color = on ? 'var(--zq-primary)' : 'var(--zq-text2)';
      });
    });
  }
  async function loadRoutineSources(statusIdx) {
    var params = statusIdx === 1 ? '?status=0' : statusIdx === 2 ? '?status=1' : '';
    var tasks = (await api.get('/task/list' + params)).map(normalizeTask);
    renderRoutineSources(tasks);
  }
  function selectedWeekdays() {
    var days = [];
    $all('#zq-wd button').forEach(function (b, i) { if (b.dataset.on === '1') days.push(i + 1); });
    return days;
  }
  async function generateRoutinesFromTasks() {
    var genSection = $all('section').find(function (s) { return /从任务生成/.test(s.textContent); });
    if (!genSection) return;
    var checked = $all('#zq-src input[type="checkbox"]').filter(function (c) { return c.checked; });
    if (!checked.length) return toast('请先勾选要生成的任务', 'error');
    var selects = $all('select', genSection);
    var freqSel = selects[1], remindSel = selects[2];
    var frequency = freqSel && freqSel.selectedIndex === 1 ? 'WEEKLY' : 'DAILY';
    var duration = Number(($('input[type="number"]', genSection) || {}).value || 45);
    var pref = ($('input[type="time"]', genSection) || {}).value || '08:00';
    var reminderEnabled = !remindSel || remindSel.selectedIndex === 0;
    var days = selectedWeekdays();
    await safe('生成例行计划', async function () {
      for (var i = 0; i < checked.length; i++) {
        var label = checked[i].closest('label');
        var titleEl = label && label.querySelector('div > div');
        var title = titleEl ? titleEl.textContent : '例行计划';
        var payload = { title: title, frequency: frequency, durationMinutes: duration, preferredTime: pref, reminderEnabled: reminderEnabled, startDate: today() };
        if (frequency === 'WEEKLY' && days.length) payload.daysOfWeek = days;
        await api.post('/routine', payload);
      }
      toast('已生成 ' + checked.length + ' 个例行计划');
      await loadRoutines();
    });
  }
  function renderRoutineSources(tasks) {
    var host = $('#zq-src'); if (!host) return;
    host.innerHTML = tasks.slice(0, 20).map(function (t) {
      return '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card);cursor:pointer;"><input type="checkbox" value="' + t.id + '" style="accent-color:var(--zq-primary);"><div style="min-width:0;flex:1;"><div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.title) + '</div><div style="font-size:11.5px;color:var(--zq-text3);margin-top:2px;">' + esc(qLabel(t.quadrant) + ' · ' + sLabel(t.status)) + '</div></div></label>';
    }).join('') || empty('暂无可选择任务');
  }
  async function loadRoutines() {
    var host = $('#zq-rt'); if (!host) return;
    var list = await api.get('/routine/list');
    host.innerHTML = list.length ? list.map(function (r) {
      return '<div style="display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card);"><div class="zq-mono" style="flex:none;min-width:46px;height:32px;padding:0 8px;border-radius:var(--zq-rs);background:var(--zq-tint);color:var(--zq-primary);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;">' + esc((r.preferredTime || '08:00').slice(0, 5)) + '</div><div style="flex:1;min-width:0;"><div style="font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(r.title) + '</div><div style="font-size:11.5px;color:var(--zq-text2);margin-top:3px;">' + esc((r.frequency || 'DAILY') + ' · ' + (r.durationMinutes || 0) + ' 分钟') + '</div></div><button data-check-routine="' + r.id + '" class="zq-btn-ghost" style="height:28px;padding:0 11px;font-size:12px;">标记完成</button><button data-del-routine="' + r.id + '" class="zq-btn-ghost" style="height:28px;padding:0 11px;font-size:12px;">删除</button></div>';
    }).join('') : empty('暂无例行计划');
    $all('[data-check-routine]', host).forEach(function (b) { b.onclick = async function () { await api.post('/routine/' + b.dataset.checkRoutine + '/checkin', { checkDate: today(), status: 'DONE' }); await loadRoutines(); }; });
    $all('[data-del-routine]', host).forEach(function (b) { b.onclick = async function () { if (await askConfirm({ title: '删除例行计划', message: '删除这个例行计划？相关的未来提醒会一并停止。', okText: '删除', danger: true })) { await api.del('/routine/' + b.dataset.delRoutine); await loadRoutines(); } }; });
  }
  async function createRoutineFromForm() {
    var section = $all('section').find(function (s) { return /新建例行计划/.test(s.textContent); });
    if (!section) return;
    var title = $('input[placeholder*="英语单词"]', section).value.trim();
    if (!title) return toast('请输入标题', 'error');
    await safe('创建例行计划', async function () {
      await api.post('/routine', {
        title: title,
        description: $('textarea', section).value || '',
        frequency: $('select', section).selectedIndex === 0 ? 'DAILY' : 'WEEKLY',
        durationMinutes: Number($('input[type="number"]', section).value || 45),
        startDate: $('input[type="date"]', section).value || today(),
        endDate: $all('input[type="date"]', section)[1]?.value || '',
        preferredTime: '08:00',
        reminderEnabled: true
      });
      toast('例行计划已创建'); await loadRoutines();
    });
  }

  async function bootStatistics() {
    var stat = await api.get('/record/statistics');
    var nums = $all('.zq-stat-num');
    if (nums[0]) nums[0].textContent = stat.consecutiveDays || 0;
    if (nums[1]) nums[1].textContent = stat.totalMinutes || stat.totalStudyMinutes || 0;
    if (nums[2]) nums[2].textContent = stat.completedTasks || 0;
    if (nums[3]) nums[3].textContent = stat.totalTasks || 0;
    window.setTab = function (k) { highlightStatTab(k); paintTrend(k); };
    await paintTrend('day');
    highlightStatTab('day');
    await renderQuadrantDonut();
  }
  function highlightStatTab(k) {
    $all('#zq-tabs button').forEach(function (b) {
      var on = b.dataset.k === k;
      b.style.background = on ? 'var(--zq-primary)' : 'var(--zq-card)';
      b.style.color = on ? 'var(--zq-on-primary)' : 'var(--zq-text2)';
    });
  }
  async function renderQuadrantDonut() {
    var donut = $('#zq-donut'); if (!donut) return;
    var tasks = (await api.get('/task/list')).map(normalizeTask);
    var counts = [0, 0, 0, 0];
    tasks.forEach(function (t) { var q = Number(t.quadrant); if (q >= 1 && q <= 4) counts[q - 1]++; });
    var total = counts.reduce(function (a, b) { return a + b; }, 0);
    var C = 2 * Math.PI * 66, acc = 0;
    donut.innerHTML = total ? counts.map(function (n, i) {
      if (!n) return '';
      var len = n / total * C;
      var seg = '<circle cx="86" cy="86" r="66" fill="none" stroke="var(--zq-q' + (i + 1) + ')" stroke-width="22" stroke-dasharray="' + len.toFixed(1) + ' ' + (C - len).toFixed(1) + '" stroke-dashoffset="' + (-acc).toFixed(1) + '" transform="rotate(-90 86 86)"></circle>';
      acc += len; return seg;
    }).join('') : '<circle cx="86" cy="86" r="66" fill="none" stroke="var(--zq-card-soft)" stroke-width="22"></circle>';
    var wrap = donut.parentElement;
    var center = wrap && wrap.querySelector('.zq-mono');
    if (center) center.textContent = total;
    var legendHost = $('#zq-legend');
    if (legendHost) {
      var labels = ['重要且紧急', '重要不紧急', '紧急不重要', '不重要不紧急'];
      legendHost.innerHTML = counts.map(function (n, i) {
        var pct = total ? Math.round(n / total * 100) : 0;
        return '<div style="display:flex; align-items:center; gap:8px; font-size:12.5px;"><span style="width:10px; height:10px; flex:none; border-radius:3px; background:var(--zq-q' + (i + 1) + ');"></span><span style="flex:1; color:var(--zq-text2);">' + labels[i] + '</span><span class="zq-mono" style="font-weight:600;">' + n + ' 项 · ' + pct + '%</span></div>';
      }).join('');
    }
  }
  async function paintTrend(type) {
    var list = await api.get('/record/trend?type=' + encodeURIComponent(type));
    var vals = list.map(function (x) { return Number(x.minutes || x.totalMinutes || x.value || 0); });
    var labels = list.map(function (x) { return x.label || x.date || x.period || ''; });
    var max = Math.max.apply(null, vals.concat([1]));
    var host = $('#zq-bars'); if (!host) return;
    host.innerHTML = vals.map(function (v, i) {
      var h = Math.max(3, Math.round(v / max * 168));
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;height:100%;justify-content:flex-end;"><span class="zq-mono" style="font-size:10px;color:var(--zq-text3);">' + v + '</span><div style="width:100%;max-width:34px;height:' + h + 'px;border-radius:4px 4px 2px 2px;background:var(--zq-tint-strong);"></div><span style="font-size:10.5px;color:var(--zq-text3);white-space:nowrap;">' + esc(labels[i]) + '</span></div>';
    }).join('') || empty('暂无趋势数据');
  }

  async function bootAchievement() {
    var info = state.user || {};
    var list = await api.get('/achievement/list');
    state.achievements = list;
    var unlockedList = list.filter(function (x) { return x.unlocked || x.unlockedAt; });
    var nums = $all('.zq-stat-num');
    if (nums[0]) nums[0].textContent = unlockedList.length;
    if (nums[1]) nums[1].textContent = list.length;
    if (nums[2]) nums[2].textContent = info.achievementPoints || 0;
    // 「最近解锁」卡片（第 4 个 .zq-stat，无 .zq-stat-num）
    var lastCard = $all('.zq-stat')[3];
    if (lastCard) {
      var recent = unlockedList.slice().sort(function (a, b) {
        return String(b.unlockedAt || '').localeCompare(String(a.unlockedAt || ''));
      })[0];
      var strong = lastCard.querySelector('strong');
      var spans = lastCard.querySelectorAll('span');
      if (recent) {
        if (strong) strong.textContent = recent.name || recent.title || recent.achievementName || '成就';
        if (spans[1]) spans[1].textContent = recent.unlockedAt ? d10(recent.unlockedAt) + ' 解锁' : '已解锁';
      } else {
        if (strong) strong.textContent = '暂无';
        if (spans[1]) spans[1].textContent = '继续加油';
      }
    }
    window.setF = function (k) {
      $all('#zq-filters button').forEach(function (b) {
        var on = b.dataset.k === k;
        b.style.background = on ? 'var(--zq-primary)' : 'var(--zq-card)';
        b.style.color = on ? 'var(--zq-on-primary)' : 'var(--zq-text2)';
      });
      renderAchList(k);
    };
    renderAchList('all');
  }
  function renderAchList(filter) {
    var host = $('#zq-ach'); if (!host) return;
    var list = (state.achievements || []).filter(function (a) {
      var on = !!(a.unlocked || a.unlockedAt);
      return filter === 'all' ? true : (filter === 'on' ? on : !on);
    });
    host.innerHTML = list.map(function (a) {
      var on = !!(a.unlocked || a.unlockedAt);
      var name = a.name || a.title || a.achievementName || '成就';
      var desc = a.description || '';
      var points = a.points || a.score || 0;
      return '<article style="padding:16px;border:1px solid ' + (on ? 'var(--zq-ok-tint)' : 'var(--zq-border-soft)') + ';border-radius:var(--zq-rm);background:var(--zq-card);box-shadow:var(--zq-sh1);opacity:' + (on ? 1 : .82) + ';"><div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;"><div style="width:42px;height:42px;flex:none;border-radius:50%;background:' + (on ? 'var(--zq-ok-tint)' : 'var(--zq-card-soft)') + ';color:' + (on ? 'var(--zq-ok)' : 'var(--zq-text3)') + ';display:flex;align-items:center;justify-content:center;font-size:18px;">✪</div><div style="min-width:0;"><h3 style="margin:0;font-size:14.5px;font-weight:700;">' + esc(name) + '</h3><span style="font-size:11.5px;color:' + (on ? 'var(--zq-ok)' : 'var(--zq-text3)') + ';font-weight:600;">' + (on ? '已解锁' : '进行中') + '</span></div></div><p style="margin:0 0 10px;font-size:12.5px;color:var(--zq-text2);line-height:1.55;min-height:38px;">' + esc(desc) + '</p><div style="display:flex;justify-content:flex-end;font-size:11.5px;color:var(--zq-text3);"><span class="zq-mono">+' + points + ' 点</span></div></article>';
    }).join('') || empty('暂无成就');
  }

  async function bootProfile() {
    var u = state.user || {};
    var card = $('.zq-card-lg');
    if (card) {
      var av = card.querySelector('div[style*="76px"]');
      if (av) {
        var paintAvatar = function () {
          // 与侧边栏保持一致：有头像显示头像，否则显示昵称首字
          av.innerHTML = state.user && state.user.avatar
            ? '<img src="' + esc(state.user.avatar) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">'
            : esc((u.nickname || u.username || '知').slice(0, 1));
        };
        paintAvatar();
        av.style.cursor = 'pointer';
        av.title = '点击更换头像';
        av.onclick = function () {
          pickFile(function (file) {
            safe('上传头像', async function () {
              var r = await api.upload('/user/avatar', file);
              state.user.avatar = (r && r.avatar) || '';
              paintAvatar();
              updateSidebarUser(state.user);
              toast('头像已更新');
            });
          });
        };
      }
      var h = card.querySelector('.zq-h2'); if (h) h.textContent = u.nickname || u.username || '知趣用户';
      var badge = card.querySelector('.zq-badge'); if (badge) badge.textContent = (u.role === 'ADMIN' ? '管理员' : '普通用户');
      var nums = card.querySelectorAll('.zq-mono');
      if (nums[0]) nums[0].textContent = u.consecutiveDays || 0;
      if (nums[2]) nums[2].textContent = Math.round((u.totalStudyMinutes || 0) / 60 * 10) / 10 + 'h';
      safe('学习统计', async function () { var stat = await api.get('/record/statistics'); if (nums[1]) nums[1].textContent = stat.completedTasks || 0; });
    }
    var basic = $all('section').find(function (s) { return /基本资料/.test(s.textContent); });
    if (basic) {
      var ins = $all('input', basic);
      if (ins[0]) ins[0].value = u.username || '';
      if (ins[1]) ins[1].value = u.nickname || '';
      if (ins[2]) ins[2].value = u.school || '';
      if (ins[3]) ins[3].value = u.major || '';
      if (ins[4]) ins[4].value = u.email || '';
      var save = $('.zq-btn', basic);
      if (save) save.onclick = function () {
        safe('保存资料', async function () {
          var data = await api.put('/user/profile', { nickname: ins[1].value.trim(), school: ins[2] ? ins[2].value.trim() : '', major: ins[3] ? ins[3].value.trim() : '', email: ins[4] ? ins[4].value.trim() : '' });
          Object.assign(state.user, data);
          toast('资料已保存');
        });
      };
    }
    // 早八提醒开关 ↔ /reminder/settings
    var morning = $('#zq-morning');
    if (morning) {
      var settings = await safe('提醒设置', function () { return api.get('/reminder/settings'); });
      setMorningToggle(morning, settings && settings.enabled);
      morning.onclick = function () {
        var next = morning.dataset.on !== '1';
        safe('保存提醒', async function () {
          await api.put('/reminder/settings', { channel: (settings && settings.channel) || 'PUSHPLUS', enabled: next });
          setMorningToggle(morning, next);
          toast(next ? '早八提醒已开启' : '早八提醒已关闭');
        });
      };
    }
    // 账号与安全：真实最近登录
    var secu = $all('section').find(function (s) { return /账号与安全/.test(s.textContent); });
    if (secu) {
      safe('登录历史', async function () {
        var hist = await api.get('/user/login-history?limit=5');
        var latest = hist && hist[0];
        var container = secu.querySelector('h3 + div');
        var rows = container ? container.children : [];
        if (rows[0] && rows[0].children[1]) rows[0].children[1].textContent = latest ? (fmtDate(latest.loginAt) + (latest.ip ? ' · ' + latest.ip : '')) : '暂无记录';
        if (rows[1] && rows[1].children[1]) rows[1].children[1].textContent = latest && latest.userAgent ? shortUA(latest.userAgent) : '—';
      });
    }
    var logout = $('a[href="index.html"].zq-btn-ghost');
    if (logout) logout.onclick = function (e) { e.preventDefault(); safe('退出', async function () { await api.post('/auth/logout', {}); clearAuth(); location.href = 'index.html'; }); };
    var pw = $all('section').find(function (s) { return /修改密码/.test(s.textContent); });
    if (pw) {
      var pis = $all('input', pw), b = $('.zq-btn', pw);
      if (b) b.onclick = function () {
        if (pis[1].value !== pis[2].value) return toast('两次新密码不一致', 'error');
        safe('修改密码', async function () { await api.put('/user/password', { oldPassword: pis[0].value, newPassword: pis[1].value }); toast('密码已更新'); pis.forEach(function (i) { i.value = ''; }); });
      };
    }
    wireModelForm();
    await loadModels();
  }
  function setMorningToggle(btn, on) {
    btn.dataset.on = on ? '1' : '0';
    var knob = btn.firstElementChild;
    if (knob) knob.style.left = on ? '21px' : '3px';
    btn.style.background = on ? 'var(--zq-primary)' : 'var(--zq-border)';
  }
  function shortUA(ua) {
    ua = String(ua || '');
    var os = /Windows/.test(ua) ? 'Windows' : /Mac OS|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
    var br = /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '浏览器';
    return (br + (os ? ' · ' + os : '')) || ua.slice(0, 40);
  }
  var MODEL_PROVIDERS = ['OPENAI_COMPATIBLE', 'ANTHROPIC', 'OLLAMA', 'VLLM', 'GEMINI'];
  // /ai/models 返回的是对象 {systemModels, userModels, defaultModelId,...}，统一拍平成数组
  function normalizeModelList(data) {
    if (Array.isArray(data)) return data;
    if (!data) return [];
    var mine = (data.userModels || []).map(function (m) { return Object.assign({ ownerType: 'USER' }, m); });
    var sys = (data.systemModels || []).map(function (m) { return Object.assign({ ownerType: 'SYSTEM' }, m); });
    return mine.concat(sys);
  }
  // 后端实际取值：VERIFIED / FAILED / UNSUPPORTED / UNTESTED。注意先判 UNSUPPORT，否则会被 SUPPORT 误吞
  function probeText(s) { s = String(s || '').toUpperCase(); if (!s || s === 'UNTESTED') return '未测试'; if (/UNSUPPORT|NOT_SUPPORT|\bNO\b|FALSE/.test(s)) return '不支持'; if (/VERIFIED|PASS|OK|SUCCESS|SUPPORT|YES|TRUE/.test(s)) return '通过'; if (/FAIL|ERROR/.test(s)) return '失败'; if (/PROB|TESTING|RUNNING/.test(s)) return '测试中'; return s; }
  function probeColor(s) { s = String(s || '').toUpperCase(); if (/UNSUPPORT|NOT_SUPPORT/.test(s)) return 'var(--zq-text3)'; if (/VERIFIED|PASS|OK|SUCCESS|SUPPORT|YES|TRUE/.test(s)) return 'var(--zq-ok)'; if (/FAIL|ERROR/.test(s)) return 'var(--zq-bad)'; return 'var(--zq-text3)'; }
  function modelTile(k, v, c) { return '<div style="min-width:0;"><span style="display:block;font-size:10.5px;color:var(--zq-text3);">' + esc(k) + '</span><strong style="display:block;margin-top:3px;font-size:11.5px;font-weight:600;color:' + c + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(v) + '</strong></div>'; }
  async function loadModels() {
    var host = $('#zq-models'); if (!host) return;
    var modelData = await api.get('/ai/models');
    state.models = normalizeModelList(modelData);
    host.innerHTML = (state.models || []).map(function (m) {
      var mine = m.ownerType !== 'SYSTEM';
      return '<article style="border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card);padding:12px 14px;"><div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;"><div style="min-width:0;"><div style="font-size:13.5px;font-weight:700;">' + esc(m.label || m.displayName || m.name) + '</div><div class="zq-mono" style="font-size:11.5px;color:var(--zq-text3);margin-top:2px;">' + esc(m.modelName || '') + '</div></div><span class="zq-badge" style="background:var(--zq-tint);color:var(--zq-primary);font-weight:700;">' + esc(mine ? '我的' : '系统') + '</span></div>'
        + '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:11px;padding-top:11px;border-top:1px solid var(--zq-border-soft);">'
        + modelTile('Provider', m.providerType || '—', 'var(--zq-text2)')
        + modelTile('连通性', probeText(m.capabilityProbeStatus), probeColor(m.capabilityProbeStatus))
        + modelTile('视觉', probeText(m.visionStatus), probeColor(m.visionStatus))
        + modelTile('深度思考', probeText(m.reasoningStatus), probeColor(m.reasoningStatus))
        + '</div>'
        + '<div style="margin-top:9px;font-size:11.5px;color:var(--zq-text3);">Key：' + esc(m.apiKeyMasked || m.maskedApiKey || '—') + (m.lastProbeAt ? ' · 上次探测 ' + esc(fmtDate(m.lastProbeAt)) : '') + '</div>'
        + '<div style="display:flex;gap:6px;margin-top:11px;flex-wrap:wrap;">' + (mine ? '<button class="zq-btn-ghost" data-model-edit="' + m.id + '" style="height:26px;padding:0 11px;font-size:12px;">编辑</button>' : '') + '<button class="zq-btn-ghost" data-model-test="' + m.id + '" style="height:26px;padding:0 11px;font-size:12px;">测试连通</button><button class="zq-btn-ghost" data-model-probe="' + m.id + '" style="height:26px;padding:0 11px;font-size:12px;">能力测试</button>' + (mine ? '<button class="zq-btn-ghost" data-model-del="' + m.id + '" style="height:26px;padding:0 11px;font-size:12px;">删除</button>' : '') + '</div></article>';
    }).join('') || empty('暂无模型配置');
    $all('[data-model-edit]', host).forEach(function (b) { b.onclick = function () { editModel(Number(b.dataset.modelEdit)); }; });
    $all('[data-model-test]', host).forEach(function (b) { b.onclick = async function () { var n = notice('正在测试连通性…'); try { var r = await api.post('/ai/models/' + b.dataset.modelTest + '/test', {}); n.update('连通性测试完成：' + (r && (r.message || r.status || (r.ok ? '通过' : '完成')) || '完成'), { done: true }); await loadModels(); } catch (e) { n.update('连通性测试失败：' + (e.message || '未知错误'), { error: true }); } }; });
    $all('[data-model-probe]', host).forEach(function (b) { b.onclick = async function () { var n = notice('正在进行能力测试…'); try { await api.post('/ai/models/' + b.dataset.modelProbe + '/probe', {}); n.update('能力测试完成', { done: true }); await loadModels(); } catch (e) { n.update('能力测试失败：' + (e.message || '未知错误'), { error: true }); } }; });
    $all('[data-model-del]', host).forEach(function (b) { b.onclick = async function () { if (await askConfirm({ title: '删除模型', message: '删除该模型配置？已保存的 API Key 会一并移除。', okText: '删除', danger: true })) safe('删除模型', async function () { await api.del('/ai/models/' + b.dataset.modelDel); await loadModels(); }); }; });
  }
  function modelFormEls() {
    var section = $all('section').find(function (s) { return /AI 模型配置/.test(s.textContent); });
    if (!section) return null;
    var ins = $all('input', section);
    return { section: section, display: ins[0], modelName: ins[1], apiUrl: ins[2], apiKey: ins[3], provider: $('select', section) };
  }
  function clearModelForm(els) {
    els = els || modelFormEls(); if (!els) return;
    ['display', 'modelName', 'apiUrl', 'apiKey'].forEach(function (k) { if (els[k]) els[k].value = ''; });
    if (els.provider) els.provider.selectedIndex = 0;
  }
  function wireModelForm() {
    var els = modelFormEls(); if (!els) return;
    var saveBtn = $all('button', els.section).find(function (b) { return /保存模型/.test(b.textContent); });
    var newBtn = $all('button', els.section).find(function (b) { return /新建模型/.test(b.textContent); });
    if (newBtn) newBtn.onclick = function () { state.editingModelId = null; clearModelForm(els); toast('已切换到新建模型'); };
    if (saveBtn) saveBtn.onclick = function () {
      var body = {
        displayName: els.display ? els.display.value.trim() : '',
        providerType: MODEL_PROVIDERS[els.provider ? els.provider.selectedIndex : 0] || 'OPENAI_COMPATIBLE',
        modelName: els.modelName ? els.modelName.value.trim() : '',
        apiUrl: els.apiUrl ? els.apiUrl.value.trim() : ''
      };
      if (els.apiKey && els.apiKey.value.trim()) body.apiKey = els.apiKey.value.trim();
      if (!body.modelName) return toast('请填写模型名称', 'error');
      safe('保存模型', async function () {
        if (state.editingModelId) await api.put('/ai/models/' + state.editingModelId, body);
        else await api.post('/ai/models', body);
        toast('模型已保存'); state.editingModelId = null; clearModelForm(els); await loadModels();
      });
    };
  }
  function editModel(id) {
    var els = modelFormEls(); if (!els) return;
    var m = (state.models || []).find(function (x) { return x.id === id; }); if (!m) return;
    state.editingModelId = id;
    if (els.display) els.display.value = m.label || m.displayName || '';
    if (els.modelName) els.modelName.value = m.modelName || '';
    if (els.apiUrl) els.apiUrl.value = m.apiUrl || m.baseUrl || '';
    if (els.apiKey) els.apiKey.value = '';
    var idx = MODEL_PROVIDERS.indexOf(m.providerType);
    if (els.provider) els.provider.selectedIndex = idx >= 0 ? idx : 0;
    els.section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('正在编辑：' + (m.label || m.displayName || m.modelName || '模型'));
  }

  async function bootAdmin() {
    var overview = await api.get('/admin/overview');
    var traffic = overview.traffic || {};
    var metrics = [
      ['注册用户', overview.userCount || 0, '总量', 'var(--zq-text)'],
      ['开放反馈', overview.feedbackOpenCount || 0, '待处理', 'var(--zq-primary)'],
      ['运行异常', overview.runtimeIssueOpenCount || 0, '待处理', 'var(--zq-bad)'],
      ['今日请求', traffic.todayRequests || traffic.requestCount || 0, '实时', 'var(--zq-text)'],
      ['AI 调用', traffic.aiRequests || 0, '今日', 'var(--zq-text)'],
      ['限流拦截', traffic.rateLimited || 0, '今日', 'var(--zq-text)']
    ];
    var host = $('#zq-metrics');
    if (host) host.innerHTML = metrics.map(function (m) { return '<article class="zq-stat" style="padding:14px 16px;"><span class="zq-stat-label" style="font-size:11.5px;">' + esc(m[0]) + '</span><strong class="zq-mono" style="display:block;margin-top:7px;font-size:23px;line-height:1;color:' + m[3] + ';">' + esc(m[1]) + '</strong><span style="display:block;margin-top:5px;font-size:11px;color:var(--zq-text3);">' + esc(m[2]) + '</span></article>'; }).join('');
    renderTrafficChart(traffic.minuteBuckets || {});
    await bootAdminIssues();
    await bootAdminRag();
    var refresh = $('header button'); if (refresh) refresh.onclick = function () { safe('刷新后台', bootAdmin); };
  }
  function renderTrafficChart(buckets) {
    var host = $('#zq-traffic'); if (!host) return;
    var keys = Object.keys(buckets || {});
    if (!keys.length) { host.innerHTML = empty('近 15 分钟暂无请求'); return; }
    var vals = keys.map(function (k) { return Number(buckets[k]) || 0; });
    var max = Math.max.apply(null, vals.concat([1]));
    host.innerHTML = keys.map(function (k, i) {
      var h = Math.max(4, Math.round(vals[i] / max * 128));
      var last = i === keys.length - 1;
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;height:100%;justify-content:flex-end;min-width:0;"><span class="zq-mono" style="font-size:9.5px;color:var(--zq-text3);">' + vals[i] + '</span><div title="' + esc(k) + ' · ' + vals[i] + ' 次" style="width:100%;max-width:30px;height:' + h + 'px;border-radius:3px 3px 2px 2px;background:' + (last ? 'var(--zq-primary)' : 'var(--zq-tint-strong)') + ';"></div><span style="font-size:10px;color:var(--zq-text3);white-space:nowrap;">' + esc(k) + '</span></div>';
    }).join('');
  }
  async function bootAdminIssues() {
    var host = $('#zq-health');
    if (!host) return;
    var list = await api.get('/admin/runtime-issues?status=OPEN');
    host.innerHTML = list.slice(0, 8).map(function (i) {
      return '<div style="padding:9px 0;border-bottom:1px solid var(--zq-border-soft);"><div style="display:flex;justify-content:space-between;gap:10px;"><strong style="font-size:12.5px;">' + esc(i.category || i.severity || '异常') + '</strong><span class="zq-mono" style="font-size:11px;color:var(--zq-text3);">' + esc(fmtDate(i.createdAt)) + '</span></div><div style="margin-top:4px;font-size:12px;color:var(--zq-text2);line-height:1.45;">' + esc(i.message || '') + '</div></div>';
    }).join('') || empty('当前没有开放异常');
  }
  async function bootAdminRag() {
    var host = $('#zq-rag-status');
    if (!host) return;
    var status;
    try {
      status = await api.get('/admin/rag/status');
    } catch (error) {
      host.innerHTML = '<div class="zq-empty">RAG 状态读取失败：' + esc(error.message || '未知错误') + '</div>';
      return;
    }
    var sidecar = status.sidecar || {}, active = status.activeGeneration || {};
    var jobs = status.jobs || {}, metrics = status.metrics || {};
    var deadJobs = Number(jobs.DEAD || 0) ? await api.get('/admin/rag/jobs?status=DEAD') : [];
    var generations = (status.generations || []).slice(0, 6);
    var expected = Number(active.expectedSourceCount || 0);
    var progress = expected ? Math.round(Number(active.indexedSourceCount || 0) / expected * 100) : 0;
    host.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;">'
      + ragMetric('服务状态', status.enabled ? (sidecar.ready ? '可用' : '未就绪') : '未启用', sidecar.ready ? 'var(--zq-ok)' : 'var(--zq-warn)')
      + ragMetric('活动索引', active.indexVersion || '尚未启用', 'var(--zq-text)')
      + ragMetric('索引进度', active.id ? progress + '%' : '—', 'var(--zq-primary)')
      + ragMetric('任务积压', Number(jobs.PENDING || 0) + Number(jobs.RETRY || 0), Number(jobs.DEAD || 0) ? 'var(--zq-bad)' : 'var(--zq-text)')
      + '</div><div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;font-size:12px;color:var(--zq-text2);">'
      + '<span>查询 P50：<b class="zq-mono">' + esc(metrics.queryP50Ms == null ? '—' : metrics.queryP50Ms + ' ms') + '</b></span>'
      + '<span>查询 P95：<b class="zq-mono">' + esc(metrics.queryP95Ms == null ? '—' : metrics.queryP95Ms + ' ms') + '</b></span>'
      + '<span>关键词降级：<b class="zq-mono">' + esc(metrics.fallbackCount || 0) + '</b></span>'
      + '<span>越权候选丢弃：<b class="zq-mono">' + esc(metrics.crossScopeDrops || 0) + '</b></span>'
      + '<span>DEAD：<b class="zq-mono">' + esc(jobs.DEAD || 0) + '</b></span></div>'
      + (generations.length ? '<div style="margin-top:14px;border-top:1px solid var(--zq-border-soft);">' + generations.map(function (item) {
          var canActivate = item.status === 'READY' || item.status === 'RETIRED';
          var canDiscard = item.status === 'FAILED';
          return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--zq-border-soft);font-size:12px;">'
            + '<span class="zq-mono" style="width:32px;color:var(--zq-text3);">#' + esc(item.id) + '</span><strong style="min-width:76px;">' + esc(item.status) + '</strong>'
            + '<span style="flex:1;min-width:0;overflow-wrap:anywhere;color:var(--zq-text2);">' + esc(item.indexVersion || '') + ' · ' + esc(item.indexedSourceCount || 0) + '/' + esc(item.expectedSourceCount || 0) + '</span>'
            + (canActivate ? '<button type="button" class="zq-btn-ghost" data-rag-activate="' + item.id + '" style="height:26px;padding:0 9px;">' + (item.status === 'RETIRED' ? '回滚' : '启用') + '</button>' : '')
            + (canDiscard ? '<button type="button" class="zq-btn-ghost" data-rag-discard="' + item.id + '" style="height:26px;padding:0 9px;color:var(--zq-bad);">丢弃</button>' : '') + '</div>';
        }).join('') + '</div>' : '')
      + (deadJobs.length ? '<details style="margin-top:12px;"><summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--zq-bad);">失败任务（' + deadJobs.length + '）</summary><div>' + deadJobs.slice(0, 10).map(function (job) {
          return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--zq-border-soft);font-size:12px;"><span class="zq-mono">#' + esc(job.id) + '</span><span style="flex:1;min-width:0;overflow-wrap:anywhere;">' + esc(job.operation) + ' · ' + esc(job.lastError || '未知错误') + '</span><button type="button" class="zq-btn-ghost" data-rag-retry="' + job.id + '" style="height:26px;padding:0 9px;">重试</button></div>';
        }).join('') + '</div></details>' : '')
      + '<div style="display:flex;gap:8px;margin-top:14px;"><button type="button" class="zq-btn-ghost" id="zq-rag-refresh" style="height:30px;">刷新状态</button>'
      + '<button type="button" class="zq-btn-ghost" id="zq-rag-rebuild" style="height:30px;">新建重建代次</button></div>';
    var refresh = $('#zq-rag-refresh');
    if (refresh) refresh.onclick = function () { safe('刷新 RAG 状态', bootAdminRag); };
    var rebuild = $('#zq-rag-rebuild');
    if (rebuild) rebuild.onclick = async function () {
      if (!await askConfirm({ title: '重建语义索引', message: '系统会创建新索引代次，当前活动索引会继续提供服务。确认开始？', okText: '开始重建' })) return;
      safe('创建重建任务', async function () { await api.post('/admin/rag/rebuild', {}); toast('已创建重建代次'); await bootAdminRag(); });
    };
    $all('[data-rag-activate]', host).forEach(function (button) {
      button.onclick = function () { safe('启用索引代次', async function () { await api.post('/admin/rag/generations/' + button.dataset.ragActivate + '/activate', {}); toast('索引代次已启用'); await bootAdminRag(); }); };
    });
    $all('[data-rag-retry]', host).forEach(function (button) {
      button.onclick = function () { safe('重试索引任务', async function () { await api.post('/admin/rag/jobs/' + button.dataset.ragRetry + '/retry', {}); toast('任务已重新排队'); await bootAdminRag(); }); };
    });
    $all('[data-rag-discard]', host).forEach(function (button) {
      button.onclick = async function () {
        if (!await askConfirm({ title: '丢弃失败索引', message: '将删除该失败代次已生成的向量数据，且不能恢复。确认继续？', okText: '确认丢弃' })) return;
        safe('丢弃失败索引代次', async function () {
          await api.post('/admin/rag/generations/' + button.dataset.ragDiscard + '/discard', {});
          toast('失败索引已进入清理队列');
          await bootAdminRag();
        });
      };
    });
  }
  function ragMetric(label, value, color) {
    return '<div style="padding:10px 12px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);min-width:0;"><span style="display:block;font-size:11px;color:var(--zq-text3);">'
      + esc(label) + '</span><strong style="display:block;margin-top:5px;font-size:13px;color:' + color + ';overflow-wrap:anywhere;">' + esc(value) + '</strong></div>';
  }

  async function bootFeedbackAdmin() {
    state.feedback = await api.get('/admin/feedback');
    // 用真实状态（OPEN/CLOSED）重建筛选条，替换演示的三态筛选
    var bar = $('#zq-filters');
    if (bar) {
      var opts = [['all', '全部'], ['OPEN', '待处理'], ['CLOSED', '已关闭']];
      bar.innerHTML = opts.map(function (o, i) {
        return '<button type="button" data-fb="' + o[0] + '" style="height:30px;padding:0 14px;border:none;cursor:pointer;font-size:12.5px;font-weight:600;background:' + (i === 0 ? 'var(--zq-primary)' : 'var(--zq-card)') + ';color:' + (i === 0 ? 'var(--zq-on-primary)' : 'var(--zq-text2)') + ';">' + o[1] + '</button>';
      }).join('');
      $all('[data-fb]', bar).forEach(function (b) {
        b.onclick = function () {
          $all('[data-fb]', bar).forEach(function (x) {
            var on = x === b; x.style.background = on ? 'var(--zq-primary)' : 'var(--zq-card)'; x.style.color = on ? 'var(--zq-on-primary)' : 'var(--zq-text2)';
          });
          renderFeedbackList(b.dataset.fb);
        };
      });
    }
    window.setF = function () {};
    renderFeedbackList('all');
  }
  function renderFeedbackList(filter) {
    var host = $('#zq-list'); if (!host) return;
    var list = (state.feedback || []).filter(function (f) {
      var status = (f.status || 'OPEN').toUpperCase();
      return filter === 'all' ? true : status === filter;
    });
    host.innerHTML = list.map(function (f) {
      var open = (f.status || 'OPEN').toUpperCase() !== 'CLOSED';
      return '<article class="zq-card"><div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;"><span class="zq-badge" style="background:' + (open ? 'var(--zq-bad-tint)' : 'var(--zq-ok-tint)') + ';color:' + (open ? 'var(--zq-bad)' : 'var(--zq-ok)') + ';font-weight:700;">' + esc(open ? '待处理' : '已关闭') + '</span><span style="font-size:12.5px;font-weight:600;">' + esc(f.nickname || f.username || ('用户 #' + (f.userId || ''))) + '</span><span class="zq-mono" style="font-size:11.5px;color:var(--zq-text3);">' + esc(fmtDate(f.createdAt)) + '</span>' + (open ? '<span style="margin-left:auto;"><button data-close-feedback="' + f.id + '" class="zq-btn-ghost" style="height:26px;padding:0 11px;font-size:12px;">关闭</button></span>' : '') + '</div><p style="margin:0;font-size:13px;line-height:1.6;">' + esc(f.content || '') + '</p></article>';
    }).join('') || empty('暂无反馈');
    $all('[data-close-feedback]', host).forEach(function (b) { b.onclick = async function () { await api.put('/admin/feedback/' + b.dataset.closeFeedback + '/close'); await bootFeedbackAdmin(); }; });
  }

  async function bootAccountAdmin() {
    var header = $('.zq-main header') || $('header');
    var searchInput = header && $('input', header);
    var roleSel = header && $('select', header);
    var queryBtn = header && $all('button', header).find(function (b) { return /查询/.test(b.textContent); });
    if (queryBtn) queryBtn.onclick = function () { loadAccounts(searchInput ? searchInput.value.trim() : '', roleSel ? roleSel.selectedIndex : 0); };
    if (searchInput) searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (queryBtn) queryBtn.onclick(); } });
    await loadAccounts('', 0);
  }
  async function loadAccounts(keyword, roleIdx) {
    var host = $('#zq-rows'); if (!host) return;
    var qs = 'page=1&size=100';
    if (keyword) qs += '&keyword=' + encodeURIComponent(keyword);
    if (roleIdx === 1) qs += '&role=ADMIN';
    else if (roleIdx === 2) qs += '&role=USER';
    var list = await api.get('/admin/users?' + qs);
    var records = list.records || [];
    host.innerHTML = records.map(function (u) {
      var disabled = Number(u.status) === 0;
      return '<div style="display:grid;grid-template-columns:minmax(120px,1.1fr) minmax(150px,1.3fr) 74px 62px 102px 104px 128px;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--zq-border-soft);opacity:' + (disabled ? .6 : 1) + ';"><div style="display:flex;align-items:center;gap:9px;min-width:0;"><div style="width:28px;height:28px;flex:none;border-radius:50%;background:var(--zq-tint);color:var(--zq-primary);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">' + esc((u.nickname || u.username || '知').slice(0, 1)) + '</div><span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(u.nickname || u.username) + '</span></div><span style="font-size:12.5px;color:var(--zq-text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(u.email || u.username) + '</span><span><span class="zq-badge" style="background:' + (u.role === 'ADMIN' ? 'var(--zq-tint)' : 'var(--zq-card-soft)') + ';color:' + (u.role === 'ADMIN' ? 'var(--zq-primary)' : 'var(--zq-text2)') + ';">' + esc(u.role === 'ADMIN' ? '管理员' : '普通用户') + '</span></span><span style="font-size:12px;font-weight:600;color:' + (disabled ? 'var(--zq-bad)' : 'var(--zq-ok)') + ';">' + (disabled ? '已禁用' : '正常') + '</span><span class="zq-mono" style="font-size:12px;color:var(--zq-text2);">' + esc(u.achievementPoints || 0) + ' 点</span><span class="zq-mono" style="font-size:12px;color:var(--zq-text2);">' + esc(fmtDate(u.updatedAt || u.createdAt)) + '</span><span style="display:flex;justify-content:flex-end;gap:6px;"><button data-reset-user="' + u.id + '" class="zq-btn-ghost" style="height:26px;padding:0 8px;font-size:11.5px;">重置密码</button><button data-toggle-user="' + u.id + '" data-next="' + (disabled ? 1 : 0) + '" class="zq-btn-ghost" style="height:26px;padding:0 8px;font-size:11.5px;">' + (disabled ? '启用' : '禁用') + '</button><button data-delete-user="' + u.id + '" class="zq-btn-ghost" style="height:26px;padding:0 8px;font-size:11.5px;">删除</button></span></div>';
    }).join('') || empty('暂无账号');
    var foot = $('.zq-table > div:last-child');
    if (foot) foot.textContent = '共 ' + (list.total || records.length) + ' 个账号';
    var reload = function () { loadAccounts(keyword, roleIdx); };
    $all('[data-delete-user]', host).forEach(function (b) { b.onclick = async function () { if (await askConfirm({ title: '删除账号', message: '确认删除该账号？其数据将按软删除规则处理。', okText: '删除', danger: true })) safe('删除账号', async function () { await api.del('/admin/users/' + b.dataset.deleteUser); reload(); }); }; });
    $all('[data-toggle-user]', host).forEach(function (b) { b.onclick = function () { safe('更新状态', async function () { await api.put('/admin/users/' + b.dataset.toggleUser + '/status?status=' + b.dataset.next); reload(); }); }; });
    $all('[data-reset-user]', host).forEach(function (b) { b.onclick = async function () { if (await askConfirm({ title: '重置密码', message: '重置该账号密码为随机临时密码？原密码将立即失效。', okText: '重置' })) safe('重置密码', async function () { var res = await api.post('/admin/users/' + b.dataset.resetUser + '/reset-password', {}); var pw = res && res.tempPassword ? res.tempPassword : '(已重置)'; await showInfo({ title: '密码已重置', html: '<p style="margin:0 0 10px;font-size:13px;color:var(--zq-text2);">临时密码（请复制并转交用户，登录后尽快修改）：</p><div class="zq-mono" style="margin:0 0 16px;padding:10px 14px;border:1px solid var(--zq-border);border-radius:var(--zq-rs);background:var(--zq-card-soft);font-size:15px;font-weight:600;user-select:all;">' + esc(pw) + '</div>' }); }); }; });
  }

  var CAT_LABEL = { EXAM: '考试备考', COMPUTER: '计算机学习', LANGUAGE: '语言学习', GENERAL: '通用规划' };
  var CAT_KEY = { EXAM: 'q1', COMPUTER: 'q2', LANGUAGE: 'q3', GENERAL: 'q4' };
  async function bootSharedPlans() {
    var filterCard = $('.zq-card');
    var selects = filterCard ? $all('select', filterCard) : [];
    var submitBtn = $('header .zq-btn');
    if (submitBtn) submitBtn.onclick = submitPlanTemplate;
    var refreshBtn = filterCard && $all('button', filterCard).find(function (b) { return /刷新/.test(b.textContent); });
    var doLoad = function () {
      var cats = ['', 'EXAM', 'COMPUTER', 'LANGUAGE', 'GENERAL'];
      var category = selects[0] ? cats[selects[0].selectedIndex] : '';
      var sort = selects[1] && selects[1].selectedIndex === 1 ? 'likeCount' : 'time';
      var order = selects[2] && selects[2].selectedIndex === 1 ? 'asc' : 'desc';
      loadPlans(category, sort, order);
    };
    if (refreshBtn) refreshBtn.onclick = doLoad;
    selects.forEach(function (s) { s.onchange = doLoad; });
    await loadPlans('', 'time', 'desc');
  }
  async function loadPlans(category, sort, order) {
    var host = $('#zq-plans'); if (!host) return;
    var qs = [];
    if (category) qs.push('category=' + category);
    if (sort) qs.push('sort=' + sort);
    if (order) qs.push('order=' + order);
    var plans = await api.get('/shared-plans' + (qs.length ? '?' + qs.join('&') : ''));
    host.innerHTML = plans.map(function (p) {
      var cat = (p.category || 'GENERAL').toUpperCase();
      var k = CAT_KEY[cat] || 'q4';
      return '<article data-plan="' + p.id + '" style="padding:16px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rm);background:var(--zq-card);box-shadow:var(--zq-sh1);cursor:pointer;"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;"><span class="zq-badge" style="background:var(--zq-' + k + '-bg);color:var(--zq-' + k + ');font-weight:700;">' + esc(CAT_LABEL[cat] || '通用规划') + '</span><span class="zq-mono" style="font-size:12px;color:var(--zq-text3);">♡ ' + esc(p.likeCount || 0) + '</span></div><h3 style="margin:0 0 6px;font-size:15.5px;font-weight:700;">' + esc(p.title || p.name) + '</h3><p style="margin:0 0 10px;font-size:12.5px;color:var(--zq-text2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(p.description || '') + '</p><div style="display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--zq-text3);border-top:1px solid var(--zq-border-soft);padding-top:9px;"><span>' + esc(p.targetAudience || p.audience || '通用') + '</span><span>' + esc(p.creatorNickname || (p.creator && (p.creator.nickname || p.creator.username)) || '') + '</span></div></article>';
    }).join('') || empty('暂无参考计划');
    $all('[data-plan]', host).forEach(function (b) { b.onclick = function () { openPlan(Number(b.dataset.plan)); }; });
  }
  function submitPlanTemplate() {
    safe('加载我的任务', async function () {
      var tasks = ((await api.get('/task/list')) || []).map(normalizeTask).slice(0, 30);
      var routines = ((await api.get('/routine/list')) || []).slice(0, 30);
      if (!tasks.length && !routines.length) { toast('你还没有任务或例行计划，无法生成模板', 'error'); return; }
      function checkRow(kind, x) {
        return '<label style="display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);cursor:pointer;font-size:12.5px;"><input type="checkbox" data-pick="' + kind + '" value="' + x.id + '" checked style="accent-color:var(--zq-primary);flex:none;"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(x.title || x.name || '') + '</span></label>';
      }
      var taskList = tasks.map(function (t) { return checkRow('task', t); }).join('');
      var routineList = routines.map(function (r) { return checkRow('routine', r); }).join('');
      openModal({
        title: '分享我的计划',
        width: '520px',
        bodyHtml:
          '<div class="zq-field"><label class="zq-label">模板标题</label><input id="zq-spt-title" class="zq-input" placeholder="例如：408 暑期基础 30 天"></div>'
          + '<div class="zq-field"><label class="zq-label">分类</label><select id="zq-spt-cat" class="zq-select"><option value="EXAM">考试备考</option><option value="COMPUTER">计算机学习</option><option value="LANGUAGE">语言学习</option><option value="GENERAL" selected>通用规划</option></select></div>'
          + '<div class="zq-field"><label class="zq-label">简介（可留空）</label><textarea id="zq-spt-desc" class="zq-textarea" style="min-height:70px;" placeholder="一句话说明这套计划适合谁、怎么用"></textarea></div>'
          + '<div style="display:flex;align-items:center;justify-content:space-between;margin:2px 0 7px;"><span class="zq-label">勾选要分享的内容</span><span style="display:flex;gap:8px;"><button type="button" class="zq-btn-ghost" id="zq-spt-all" style="height:24px;padding:0 9px;font-size:11.5px;">全选</button><button type="button" class="zq-btn-ghost" id="zq-spt-none" style="height:24px;padding:0 9px;font-size:11.5px;">清空</button></span></div>'
          + '<div style="max-height:250px;overflow-y:auto;display:flex;flex-direction:column;gap:5px;margin-bottom:10px;">'
          + (taskList ? '<div style="font-size:11.5px;font-weight:700;color:var(--zq-text2);margin:3px 0 1px;">一次性任务 · ' + tasks.length + '</div>' + taskList : '')
          + (routineList ? '<div style="font-size:11.5px;font-weight:700;color:var(--zq-text2);margin:6px 0 1px;">例行计划 · ' + routines.length + '</div>' + routineList : '')
          + '</div>'
          + '<label style="display:flex;align-items:flex-start;gap:8px;margin:0 0 12px;font-size:12px;color:var(--zq-text2);line-height:1.6;cursor:pointer;"><input id="zq-spt-consent" type="checkbox" style="accent-color:var(--zq-primary);margin-top:2px;flex:none;"><span>我确认勾选的内容不含个人隐私信息，同意提交给管理员审核，通过后对所有用户可见。</span></label>'
          + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-spt-cancel">取消</button><button type="button" class="zq-btn" id="zq-spt-ok">提交审核</button></div>',
        onMount: function (b, h) {
          $('#zq-spt-cancel', b).onclick = h.close;
          $('#zq-spt-all', b).onclick = function () { $all('[data-pick]', b).forEach(function (c) { c.checked = true; }); };
          $('#zq-spt-none', b).onclick = function () { $all('[data-pick]', b).forEach(function (c) { c.checked = false; }); };
          $('#zq-spt-ok', b).onclick = function () {
            var title = $('#zq-spt-title', b).value.trim(); if (!title) return toast('请填写模板标题', 'error');
            var taskIds = $all('[data-pick="task"]:checked', b).map(function (c) { return Number(c.value); });
            var routineIds = $all('[data-pick="routine"]:checked', b).map(function (c) { return Number(c.value); });
            if (!taskIds.length && !routineIds.length) return toast('至少勾选一个任务或例行计划', 'error');
            // 隐私确认必须由用户显式勾选，不代签
            if (!$('#zq-spt-consent', b).checked) return toast('请先勾选隐私确认', 'error');
            var category = $('#zq-spt-cat', b).value, desc = $('#zq-spt-desc', b).value.trim();
            safe('提交计划模板', async function () {
              await api.post('/shared-plans/from-existing', { title: title, description: desc, category: category, taskIds: taskIds, routineIds: routineIds, shareConsent: true });
              h.close(); toast('已提交，等待管理员审核');
            });
          };
        }
      });
    });
  }
  async function openPlan(id) {
    await safe('计划详情', async function () {
      var p = await api.get('/shared-plans/' + id);
      var tasks = p.tasks || p.taskTemplates || [];
      var routines = p.routines || p.routineTemplates || [];
      var modal = $('#zq-modal');
      if (!modal) {
        await showInfo({ title: p.title || '参考计划', message: (p.description || '') + '\n\n任务：' + tasks.length + ' 个\n例行计划：' + routines.length + ' 个' });
        return;
      }
      $('#zm-title').textContent = p.title || '参考计划';
      $('#zm-meta').textContent = (p.creator && (p.creator.nickname || p.creator.username) ? '来自 ' + (p.creator.nickname || p.creator.username) + ' · ' : '') + (p.category || '未分类') + ' · 已审核';
      $('#zm-likes').textContent = (p.liked ? '♥ ' : '♡ ') + (p.likeCount || 0);
      $('#zm-desc').textContent = p.description || '';
      $('#zm-aud').textContent = '适用：' + (p.targetAudience || p.audience || '未注明');
      $('#zm-items').innerHTML = [
        '<strong style="font-size:12px;">一次性任务 ' + tasks.length + ' 个</strong>',
        tasks.map(function (x) { return '<div style="padding:8px 10px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);font-size:12.5px;">' + esc(x.title || x.name || '') + '</div>'; }).join(''),
        '<strong style="font-size:12px;margin-top:8px;">例行计划 ' + routines.length + ' 个</strong>',
        routines.map(function (x) { return '<div style="padding:8px 10px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);font-size:12.5px;">' + esc(x.title || x.name || '') + '</div>'; }).join('')
      ].join('');
      var buttons = $all('#zq-modal .zq-btn, #zq-modal .zq-btn-ghost');
      var applyBtn = buttons.find(function (b) { return /套用/.test(b.textContent); });
      if (applyBtn) applyBtn.onclick = async function () {
        var startDate = await askText({ title: '套用参考计划', label: '开始日期', value: today(), hint: '格式 YYYY-MM-DD，计划内任务将从该日期起排入你的日历。', okText: '套用' });
        if (!startDate || !startDate.trim()) return;
        await api.post('/shared-plans/' + id + '/apply', { startDate: startDate.trim() });
        toast('已套用到你的日历');
        modal.style.display = 'none';
      };
      $('#zm-likes').onclick = async function () {
        var res = await api.post('/shared-plans/' + id + '/like', {});
        $('#zm-likes').textContent = (res.liked ? '♥ ' : '♡ ') + (res.likeCount || 0);
        await bootSharedPlans();
      };
      $('#zm-likes').style.cursor = 'pointer';
      modal.style.display = 'flex';
    });
  }

  var SP_CAT = { EXAM: '考试备考', COMPUTER: '计算机学习', LANGUAGE: '语言学习', GENERAL: '通用规划' };
  async function bootSharedPlanAdmin() {
    var list = await api.get('/admin/shared-plans');
    var host = $('#zq-reviews');
    if (!host) return;
    var groups = { PENDING: [], APPROVED: [], OFFLINE: [], REJECTED: [] };
    (list || []).forEach(function (p) { (groups[String(p.status || '').toUpperCase()] || (groups.PENDING)).push(p); });
    var pendEl = $('#zq-pending');
    if (pendEl) pendEl.textContent = '待审核 ' + groups.PENDING.length + ' 个 · 已发布 ' + groups.APPROVED.length + ' 个';
    function creator(p) { return esc((p.creator && (p.creator.nickname || p.creator.username)) || p.creatorNickname || p.username || '匿名'); }
    function catName(p) { return esc(p.categoryName || SP_CAT[String(p.category || '').toUpperCase()] || p.category || '未分类'); }
    function card(p, actions, dim) {
      return '<article class="zq-card" style="' + (dim ? 'opacity:.72;' : '') + '">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;"><span class="zq-badge" style="background:var(--zq-tint);color:var(--zq-primary);">' + catName(p) + '</span><span class="zq-mono" style="font-size:11px;color:var(--zq-text3);">' + esc(fmtDate(p.createdAt)) + '</span></div>'
        + '<h3 data-sp-view="' + p.id + '" title="点击查看完整内容" style="margin:0 0 5px;font-size:15px;font-weight:700;cursor:pointer;">' + esc(p.title || p.name || '未命名') + ' <span style="font-size:11px;font-weight:500;color:var(--zq-primary);">查看 ›</span></h3>'
        + '<p style="margin:0 0 10px;font-size:12.5px;color:var(--zq-text2);line-height:1.55;">' + esc(p.description || '（无简介）') + '</p>'
        + '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:10px;border-top:1px solid var(--zq-border-soft);"><span style="font-size:12px;color:var(--zq-text3);">' + creator(p) + '</span><span style="display:flex;gap:6px;">' + actions + '</span></div></article>';
    }
    function section(title, items, render) {
      if (!items.length) return '';
      return '<div style="grid-column:1/-1;margin:8px 2px 0;font-size:12.5px;font-weight:700;color:var(--zq-text2);">' + title + ' · ' + items.length + '</div>' + items.map(render).join('');
    }
    var html = '';
    html += section('待审核', groups.PENDING, function (p) {
      return card(p, '<button data-sp-ok="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-ok);">通过</button><button data-sp-no="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-bad);">驳回</button>');
    });
    html += section('已发布', groups.APPROVED, function (p) {
      return card(p, '<button data-sp-edit="' + p.id + '" class="zq-btn-ghost" style="height:28px;">修改</button><button data-sp-down="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-warn);">下架</button>');
    });
    html += section('已下架', groups.OFFLINE, function (p) {
      return card(p, '<button data-sp-ok="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-ok);">重新发布</button><button data-sp-edit="' + p.id + '" class="zq-btn-ghost" style="height:28px;">修改</button><button data-sp-del="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-bad);">删除</button>', true);
    });
    html += section('已驳回', groups.REJECTED, function (p) {
      return card(p, '<button data-sp-ok="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-ok);">通过</button><button data-sp-del="' + p.id + '" class="zq-btn-ghost" style="height:28px;color:var(--zq-bad);">删除</button>', true);
    });
    host.innerHTML = html || empty('暂无共享计划');
    $all('[data-sp-ok]', host).forEach(function (b) { b.onclick = function () { safe('通过', async function () { await api.put('/admin/shared-plans/' + b.dataset.spOk + '/review?action=APPROVE'); toast('已通过发布'); await bootSharedPlanAdmin(); }); }; });
    $all('[data-sp-no]', host).forEach(function (b) { b.onclick = async function () { var note = await askText({ title: '驳回共享计划', label: '驳回原因（可选，将展示给提交者）', textarea: true, okText: '驳回' }); if (note === null) return; safe('驳回', async function () { await api.put('/admin/shared-plans/' + b.dataset.spNo + '/review?action=REJECT&note=' + encodeURIComponent(note || '')); toast('已驳回'); await bootSharedPlanAdmin(); }); }; });
    $all('[data-sp-down]', host).forEach(function (b) { b.onclick = function () { safe('下架', async function () { await api.put('/admin/shared-plans/' + b.dataset.spDown + '/review?action=TAKEDOWN'); toast('已下架'); await bootSharedPlanAdmin(); }); }; });
    $all('[data-sp-del]', host).forEach(function (b) { b.onclick = async function () { if (!await askConfirm({ title: '删除共享计划', message: '确定删除该共享计划？此操作不可恢复。', okText: '删除', danger: true })) return; safe('删除', async function () { await api.del('/admin/shared-plans/' + b.dataset.spDel); toast('已删除'); await bootSharedPlanAdmin(); }); }; });
    $all('[data-sp-edit]', host).forEach(function (b) { b.onclick = function () { editSharedPlan(b.dataset.spEdit); }; });
    $all('[data-sp-view]', host).forEach(function (t) { t.onclick = function () { viewSharedPlan(t.dataset.spView); }; });
  }
  function viewSharedPlan(id) {
    safe('计划详情', async function () {
      var d = await api.get('/admin/shared-plans/' + id);
      var itemRow = function (x, extra) {
        return '<div style="padding:8px 11px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);"><div style="font-size:12.5px;font-weight:600;">' + esc(x.title || '') + '</div>'
          + (x.description ? '<div style="font-size:11.5px;color:var(--zq-text2);margin-top:2px;line-height:1.5;">' + esc(x.description) + '</div>' : '')
          + '<div class="zq-mono" style="font-size:10.5px;color:var(--zq-text3);margin-top:3px;">' + esc(extra) + '</div></div>';
      };
      var tasks = (d.tasks || []).map(function (t) {
        return itemRow(t, '第' + (t.relativeStartDay == null ? 0 : t.relativeStartDay) + '天起 · 截止第' + (t.relativeDeadlineDay == null ? '—' : t.relativeDeadlineDay) + '天' + (t.preferredTime ? ' · ' + t.preferredTime : '') + (t.durationMinutes ? ' · ' + t.durationMinutes + '分钟' : ''));
      }).join('');
      var routines = (d.routines || []).map(function (r) {
        return itemRow(r, (r.frequency || 'DAILY') + (r.preferredTime ? ' · ' + r.preferredTime : '') + (r.durationMinutes ? ' · ' + r.durationMinutes + '分钟' : '') + ' · 第' + (r.relativeStartDay == null ? 0 : r.relativeStartDay) + '~' + (r.relativeEndDay == null ? '—' : r.relativeEndDay) + '天');
      }).join('');
      var reviews = (d.reviews || []).map(function (rv) {
        return '<div style="font-size:11.5px;color:var(--zq-text2);line-height:1.6;"><span class="zq-mono" style="color:var(--zq-text3);">' + esc(fmtDate(rv.createdAt)) + '</span> ' + esc(rv.action || '') + (rv.note ? ' · ' + esc(rv.note) : '') + '</div>';
      }).join('');
      function sec(t, body) { return body ? '<h4 style="margin:14px 0 7px;font-size:12.5px;font-weight:700;">' + t + '</h4><div style="display:flex;flex-direction:column;gap:6px;">' + body + '</div>' : ''; }
      openModal({
        title: (d.title || '共享计划') + ' · ' + esc(d.status || ''),
        width: '560px',
        bodyHtml:
          '<p style="margin:0 0 4px;font-size:13px;color:var(--zq-text2);line-height:1.7;">' + esc(d.description || '（无简介）') + '</p>'
          + '<div style="font-size:12px;color:var(--zq-text3);">' + esc(d.categoryName || d.category || '') + (d.targetAudience ? ' · 适用：' + esc(d.targetAudience) : '') + ' · ♡ ' + (d.likeCount || 0) + ' · 套用 ' + (d.applyCount || 0) + '</div>'
          + sec('一次性任务 · ' + (d.tasks || []).length, tasks || '')
          + sec('例行计划 · ' + (d.routines || []).length, routines || '')
          + sec('审核记录', reviews || '')
          + '<div class="zq-modal-actions" style="margin-top:16px;"><button type="button" class="zq-btn" data-view-close>关闭</button></div>',
        onMount: function (b, h) { $('[data-view-close]', b).onclick = h.close; }
      });
    });
  }
  function editSharedPlan(id) {
    safe('加载共享计划', async function () {
      var d = await api.get('/admin/shared-plans/' + id);
      var catOptions = Object.keys(SP_CAT).map(function (k) { return '<option value="' + k + '"' + (String(d.category || '').toUpperCase() === k ? ' selected' : '') + '>' + SP_CAT[k] + '</option>'; }).join('');
      openModal({
        title: '修改共享计划',
        width: '520px',
        bodyHtml:
          '<div class="zq-field"><label class="zq-label">标题</label><input id="zq-sp-title" class="zq-input" value="' + esc(d.title || '') + '"></div>'
          + '<div class="zq-field"><label class="zq-label">分类</label><select id="zq-sp-cat" class="zq-select">' + catOptions + '</select></div>'
          + '<div class="zq-field"><label class="zq-label">简介</label><textarea id="zq-sp-desc" class="zq-textarea" style="min-height:100px;">' + esc(d.description || '') + '</textarea></div>'
          + '<div class="zq-field"><label class="zq-label">适用人群（可选）</label><input id="zq-sp-aud" class="zq-input" value="' + esc(d.targetAudience || '') + '"></div>'
          + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-sp-cancel">取消</button><button type="button" class="zq-btn" id="zq-sp-save">保存</button></div>',
        onMount: function (bd, h) {
          $('#zq-sp-cancel', bd).onclick = h.close;
          $('#zq-sp-save', bd).onclick = function () {
            var title = $('#zq-sp-title', bd).value.trim(); if (!title) return toast('请填写标题', 'error');
            safe('保存共享计划', async function () {
              await api.put('/admin/shared-plans/' + id, { title: title, category: $('#zq-sp-cat', bd).value, description: $('#zq-sp-desc', bd).value, targetAudience: $('#zq-sp-aud', bd).value });
              h.close(); toast('已保存'); await bootSharedPlanAdmin();
            });
          };
        }
      });
    });
  }

  var WIKI_TYPE_MAP = { 目标: 'GOAL', 计划: 'PROJECT', 偏好: 'PREFERENCE', 薄弱点: 'WEAKNESS', 资料: 'RESOURCE', 对话摘要: 'MEMORY', index: 'INDEX', 规则: 'SCHEMA', log: 'LOG' };
  async function bootKnowledge() {
    state.wikiPages = flattenKnowledge((await api.get('/knowledge/document-tree')) || []);
    state.wikiCur = state.wikiPages[0] || null;
    state.wikiFilter = { q: '', type: '' };
    var header = $('.zq-main header') || $('header');
    (header ? $all('button', header) : []).forEach(function (b) {
      var t = b.textContent;
      if (/新建知识页/.test(t)) b.onclick = createWikiPage;
      else if (/导入来源/.test(t)) b.onclick = importWikiSource;
      else if (/健康检查/.test(t)) b.onclick = runWikiLint;
      else if (/图谱/.test(t)) b.onclick = showWikiGraph;
      else if (/导出/.test(t)) b.onclick = exportWikiMarkdown;
      else if (/待合入变更/.test(t)) { b.id = 'zq-patch-btn'; b.textContent = '待合入变更'; b.onclick = showWikiPatchSets; }
    });
    refreshWikiPatchBadge();
    var aside = $('#zq-tree') && $('#zq-tree').closest('aside');
    if (aside) {
      var searchInput = $('input', aside), typeSel = $('select', aside);
      if (searchInput) searchInput.oninput = function () { state.wikiFilter.q = searchInput.value.trim(); paintWikiTree(); };
      if (typeSel) typeSel.onchange = function () { state.wikiFilter.type = typeSel.selectedIndex === 0 ? '' : typeSel.options[typeSel.selectedIndex].text; paintWikiTree(); };
    }
    wireWikiEditor();
    paintWikiTree();
    if (state.wikiCur) paintWikiDoc(state.wikiCur);
  }
  function paintWikiTree() {
    var tree = $('#zq-tree'); if (!tree) return;
    // 目录页数：接真实数据（原“9 页”为静态占位），同时更新收起后的竖条标签
    var total = (state.wikiPages || []).length;
    var cntEl = $('#zq-tree-count'); if (cntEl) cntEl.textContent = total + ' 页';
    var toc = $('#zq-wiki-toc');
    if (toc) {
      var lbl = '目录 · ' + total + ' 页';
      toc.setAttribute('data-zq-label', lbl);
      var rl = $('.zq-rlabel', toc); if (rl) rl.textContent = lbl;
    }
    var f = state.wikiFilter || { q: '', type: '' };
    var wantType = f.type ? (WIKI_TYPE_MAP[f.type] || f.type.toUpperCase()) : '';
    var pages = (state.wikiPages || []).filter(function (p) {
      if (f.q && (p.title || '').toLowerCase().indexOf(f.q.toLowerCase()) < 0) return false;
      if (wantType && String(p.pageType || p.type || '').toUpperCase() !== wantType) return false;
      return true;
    });
    tree.innerHTML = pages.map(function (p) {
      var active = state.wikiCur && p.id === state.wikiCur.id;
      return '<a data-wiki="' + p.id + '" style="display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:var(--zq-rs);cursor:pointer;background:' + (active ? 'var(--zq-tint)' : 'transparent') + ';"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:' + (active ? 700 : 500) + ';color:var(--zq-text2);">' + esc(p.title) + '</span></a>';
    }).join('') || empty('无匹配页面');
    $all('[data-wiki]', tree).forEach(function (a) {
      var pageOf = function () { return (state.wikiPages || []).find(function (x) { return String(x.id) === a.dataset.wiki; }); };
      a.onclick = function () { var p = pageOf(); if (p) paintWikiDoc(p); };
      a.oncontextmenu = function (e) {
        e.preventDefault();
        var p = pageOf(); if (!p) return;
        var items = [{ label: '打开', onClick: function () { paintWikiDoc(p); } }];
        if (!isSystemWikiPage(p)) items.push({ label: '删除该页', danger: true, onClick: function () { deleteWikiPage(p); } });
        popMenu(e.clientX, e.clientY, items);
      };
    });
  }
  async function paintWikiDoc(p) {
    state.wikiCur = p;
    removeWikiActionBar();
    var doc = $('#zq-doc'), title = $('#zq-doc-title');
    if (title) title.textContent = p.title || '知识页';
    // document-tree 只给了折叠后的 summary，正文要按需拉完整内容
    if (!p._full && p.id != null) {
      var detail = await safe('知识页', function () { return api.get('/knowledge/pages/' + p.id); });
      if (detail) { p.content = detail.content; p.pageType = detail.pageType || p.pageType; p.parentId = detail.parentId; p.sortOrder = detail.sortOrder; p.pinned = detail.pinned; p.version = detail.version; p._full = true; }
    }
    if (state.wikiCur !== p) return;
    if (doc) {
      doc.dataset.editing = '0'; doc.dataset.source = '0';
      doc.contentEditable = 'false';
      doc.innerHTML = renderMarkdown(p.content || p.summary || '');
      renderMathIn(doc);
      wireWikiLinks(doc);
    }
    var insp = $('#zq-insp');
    if (insp) insp.innerHTML = '<div style="padding:12px 14px;font-size:12px;color:var(--zq-text2);line-height:1.6;">类型：' + esc(p.pageType || p.type || 'NOTE') + '<br>更新：' + esc(fmtDate(p.updatedAt)) + '<br><span style="color:var(--zq-text3);">点击正文即可编辑 · [[双链]]可跳转</span></div>';
    paintWikiTree();
  }
  function wireWikiLinks(doc) {
    $all('[data-wikilink]', doc).forEach(function (a) {
      a.onclick = function (e) {
        if (doc.dataset.editing === '1') return;
        e.preventDefault();
        e.stopPropagation(); // 阻止冒泡到正文容器，否则跳转后的目标页会立刻进入编辑态
        var t = a.getAttribute('data-wikilink');
        var target = (state.wikiPages || []).find(function (x) { return (x.title || '') === t; });
        if (target) paintWikiDoc(target); else toast('页面不存在：' + t, 'error');
      };
    });
  }
  function wireWikiEditor() {
    var doc = $('#zq-doc'); if (!doc) return;
    doc.style.cursor = 'text';
    // 点正文进入编辑，但链接/勾选框/按钮等正文内控件的点击不算（外链点击、双链跳转不应触发编辑）
    doc.onclick = function (e) {
      if (e.target && e.target.closest && e.target.closest('a,input,button')) return;
      if (state.wikiCur && doc.dataset.editing !== '1') enterWikiEdit();
    };
    // 右键菜单：编辑本页 / 删除本页；编辑态不拦截（保留浏览器原生菜单做粘贴等操作）
    doc.oncontextmenu = function (e) {
      if (doc.dataset.editing === '1' || !state.wikiCur) return;
      e.preventDefault();
      var p = state.wikiCur;
      var items = [{ label: '编辑本页', onClick: function () { enterWikiEdit(); } }];
      if (!isSystemWikiPage(p)) items.push({ label: '删除本页', danger: true, onClick: function () { deleteWikiPage(p); } });
      popMenu(e.clientX, e.clientY, items);
    };
    // 任务勾选框：勾选即切换删除线样式；未在编辑态则进入编辑态以便保存
    doc.addEventListener('change', function (e) {
      var cb = e.target;
      if (!cb || cb.type !== 'checkbox') return;
      var span = cb.nextElementSibling;
      if (span) { span.style.textDecoration = cb.checked ? 'line-through' : 'none'; span.style.color = cb.checked ? 'var(--zq-text3)' : 'var(--zq-text)'; }
      if (doc.dataset.editing !== '1') enterWikiEdit();
    });
    var section = doc.closest('section'); if (!section) return;
    $all('[data-wiki-cmd]', section).forEach(function (b) {
      b.onclick = function (e) { e.preventDefault(); wikiToolbar(b.getAttribute('data-wiki-cmd')); };
    });
    var blockSel = $('#zq-wiki-block', section);
    if (blockSel) blockSel.onchange = function () {
      if (!state.wikiCur) return; ensureWikiEditing();
      if (doc.dataset.source === '1') return;
      var v = blockSel.value;
      if (v === 'QUOTE') document.execCommand('formatBlock', false, 'BLOCKQUOTE');
      else if (v === 'CODE') document.execCommand('formatBlock', false, 'PRE');
      else if (v === 'UL') document.execCommand('insertUnorderedList');
      else if (v === 'OL') document.execCommand('insertOrderedList');
      else if (v === 'HR') document.execCommand('insertHorizontalRule');
      else if (v === 'TASK') document.execCommand('insertHTML', false, '<div class="zq-task-row" style="display:flex;gap:9px;align-items:flex-start;margin:7px 0;"><input type="checkbox" contenteditable="false" style="accent-color:var(--zq-primary);margin-top:5px;flex:none;"><span>待办事项</span></div>');
      else document.execCommand('formatBlock', false, v);
      blockSel.value = 'P';
    };
    // 标题点击改名（系统页 index/log/维护规则 除外）
    var titleEl = $('#zq-doc-title');
    if (titleEl) {
      titleEl.style.cursor = 'pointer';
      titleEl.title = '点击修改页面名称';
      titleEl.onclick = async function () {
        var p = state.wikiCur; if (!p) return;
        if (['INDEX', 'LOG', 'SCHEMA'].indexOf(String(p.pageType || '').toUpperCase()) >= 0) return toast('系统页不可改名', 'error');
        var name = await askText({ title: '修改页面名称', label: '页面名称', value: p._pendingTitle || p.title || '' });
        if (!name || !name.trim()) return;
        if (name.trim() === p.title) { p._pendingTitle = null; titleEl.textContent = p.title; return; }
        p._pendingTitle = name.trim();
        titleEl.textContent = p._pendingTitle;
        safe('修改名称', async function () {
          var updated = await api.put('/knowledge/pages/' + p.id, { title: p._pendingTitle, content: p.content, pageType: p.pageType, parentId: p.parentId, sortOrder: p.sortOrder, pinned: p.pinned, version: p.version });
          p.title = updated && updated.title ? updated.title : p._pendingTitle;
          p._pendingTitle = null;
          if (updated && updated.version != null) p.version = updated.version;
          titleEl.textContent = p.title;
          paintWikiTree(); toast('名称已更新');
        });
      };
    }
  }
  function ensureWikiEditing() { var doc = $('#zq-doc'); if (doc && doc.dataset.editing !== '1') enterWikiEdit(); }
  function enterWikiEdit() {
    var doc = $('#zq-doc'), p = state.wikiCur; if (!doc || !p || doc.dataset.editing === '1') return;
    doc.dataset.editing = '1'; doc.dataset.source = '0';
    doc.contentEditable = 'true'; doc.style.outline = 'none';
    doc.focus();
    showWikiActionBar();
  }
  function wikiToolbar(cmd) {
    ensureWikiEditing();
    var doc = $('#zq-doc');
    if (doc.dataset.source === '1' && cmd !== 'source') return;
    if (cmd === 'bold') document.execCommand('bold');
    else if (cmd === 'italic') document.execCommand('italic');
    else if (cmd === 'underline') document.execCommand('underline');
    else if (cmd === 'code') { var s = window.getSelection().toString(); if (s) document.execCommand('insertHTML', false, '<code style="background:var(--zq-card-soft);padding:1px 5px;border-radius:4px;">' + esc(s) + '</code>'); }
    else if (cmd === 'link') {
      // 弹窗会夺走 contentEditable 焦点，先存选区、恢复后再 createLink
      var sel0 = window.getSelection();
      var savedRange = sel0.rangeCount ? sel0.getRangeAt(0).cloneRange() : null;
      askText({ title: '插入链接', label: '链接地址', placeholder: 'https://…', okText: '插入' }).then(function (url) {
        if (!url || !url.trim()) return;
        doc.focus();
        if (savedRange) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
        document.execCommand('createLink', false, url.trim());
      });
    }
    else if (cmd === 'math') {
      var selM = window.getSelection();
      var savedM = selM.rangeCount ? selM.getRangeAt(0).cloneRange() : null;
      askText({ title: '插入公式块', label: 'LaTeX 公式', placeholder: '例如：\\int_a^b f(x)\\,dx', hint: '行内公式可直接在正文里写 $...$，保存后自动渲染。', okText: '插入' }).then(function (tex) {
        if (!tex || !tex.trim()) return;
        doc.focus();
        if (savedM) { var sm = window.getSelection(); sm.removeAllRanges(); sm.addRange(savedM); }
        document.execCommand('insertHTML', false, mathBlockHtml(tex.trim()) + '<p><br></p>');
        renderMathIn(doc);
      });
    }
    else if (cmd === 'ref') {
      var selR = window.getSelection();
      var savedR = selR.rangeCount ? selR.getRangeAt(0).cloneRange() : null;
      var m = openModal({
        title: '插入参考链接',
        bodyHtml:
          '<div class="zq-field"><label class="zq-label">显示标题</label><input id="zq-ref-title" class="zq-input" placeholder="例如：王道考研官网"></div>'
          + '<div class="zq-field" style="margin-top:12px;"><label class="zq-label">链接地址</label><input id="zq-ref-url" class="zq-input" placeholder="https://…"></div>'
          + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;"><button class="zq-btn-ghost" id="zq-ref-cancel" style="height:32px;">取消</button><button class="zq-btn" id="zq-ref-ok" style="height:32px;">插入</button></div>',
        onMount: function (body, handle) {
          body.querySelector('#zq-ref-cancel').onclick = handle.close;
          body.querySelector('#zq-ref-ok').onclick = function () {
            var t = body.querySelector('#zq-ref-title').value.trim();
            var u = body.querySelector('#zq-ref-url').value.trim();
            if (!u) return toast('请填写链接地址', 'error');
            if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
            handle.close();
            doc.focus();
            if (savedR) { var sr = window.getSelection(); sr.removeAllRanges(); sr.addRange(savedR); }
            document.execCommand('insertHTML', false, '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" style="color:var(--zq-primary);text-decoration:underline;text-underline-offset:3px;">' + esc(t || u) + '</a>&nbsp;');
          };
          body.querySelector('#zq-ref-title').focus();
        }
      });
    }
    else if (cmd === 'source') toggleWikiSource();
  }
  function toggleWikiSource() {
    var doc = $('#zq-doc'); if (!doc) return;
    if (doc.dataset.source === '1') {
      var ta = $('#zq-src-ta'); var md = ta ? ta.value : '';
      doc.dataset.source = '0'; doc.contentEditable = 'true';
      doc.innerHTML = renderMarkdown(md); renderMathIn(doc); doc.focus();
    } else {
      var md2 = htmlToMarkdown(doc);
      doc.dataset.source = '1'; doc.contentEditable = 'false';
      doc.innerHTML = '<textarea id="zq-src-ta" style="width:100%;min-height:360px;border:1px solid var(--zq-border);border-radius:var(--zq-rs);padding:12px;font-size:13px;line-height:1.7;font-family:var(--zq-fontM,monospace);background:var(--zq-input-bg);color:var(--zq-text);resize:vertical;box-sizing:border-box;"></textarea>';
      $('#zq-src-ta').value = md2;
    }
  }
  function showWikiActionBar() {
    removeWikiActionBar();
    var doc = $('#zq-doc'); if (!doc) return;
    var bar = document.createElement('div');
    bar.id = 'zq-wiki-actions';
    bar.style.cssText = 'display:flex;gap:8px;padding:10px 26px 18px;border-top:1px solid var(--zq-border-soft);background:var(--zq-card);';
    // 系统页（index/log/维护规则）不给删除入口，后端也会拦截
    var isSysPage = state.wikiCur && ['INDEX', 'LOG', 'SCHEMA'].indexOf(String(state.wikiCur.pageType || '').toUpperCase()) >= 0;
    bar.innerHTML = '<button class="zq-btn" id="zq-wiki-save" style="height:30px;">保存</button><button class="zq-btn-ghost" id="zq-wiki-cancel" style="height:30px;">取消</button>' + (isSysPage ? '' : '<button class="zq-btn-ghost" id="zq-wiki-del" style="height:30px;margin-left:auto;color:var(--zq-bad);">删除本页</button>');
    doc.parentNode.appendChild(bar);
    $('#zq-wiki-save').onclick = saveWikiEdit;
    $('#zq-wiki-cancel').onclick = function () { paintWikiDoc(state.wikiCur); };
    if ($('#zq-wiki-del')) $('#zq-wiki-del').onclick = function () { deleteWikiPage(state.wikiCur); };
  }
  function isSystemWikiPage(p) { return !!p && ['INDEX', 'LOG', 'SCHEMA'].indexOf(String(p.pageType || '').toUpperCase()) >= 0; }
  // 删除知识页：action bar 按钮与右键菜单共用（系统页由调用方隐藏入口，后端也会拦截）
  async function deleteWikiPage(p) {
    if (!p) return;
    if (await askConfirm({ title: '删除知识页', message: '删除「' + (p.title || '') + '」？它的直接子页会自动迁移到上级目录，指向它的双链会变成悬空链接。', okText: '删除', danger: true })) {
      safe('删除知识页', async function () { await api.del('/knowledge/pages/' + p.id + '?version=' + encodeURIComponent(p.version)); await bootKnowledge(); toast('已删除'); });
    }
  }
  function removeWikiActionBar() { var b = document.getElementById('zq-wiki-actions'); if (b) b.remove(); }
  function saveWikiEdit() {
    var doc = $('#zq-doc'), p = state.wikiCur; if (!doc || !p) return;
    var md = doc.dataset.source === '1' ? ($('#zq-src-ta') ? $('#zq-src-ta').value : '') : htmlToMarkdown(doc);
    safe('保存知识页', async function () {
      var updated = await api.put('/knowledge/pages/' + p.id, { title: p.title, content: md, pageType: p.pageType, parentId: p.parentId, sortOrder: p.sortOrder, pinned: p.pinned, version: p.version });
      p.content = updated && updated.content != null ? updated.content : md;
      if (updated && updated.version != null) p.version = updated.version;
      if (updated && updated.updatedAt) p.updatedAt = updated.updatedAt;
      paintWikiDoc(p);
      toast('已保存');
    });
  }
  // 导出整个知识 Wiki 为 Obsidian 风格 Markdown zip；优先让用户选保存位置
  async function exportWikiMarkdown() {
    var n = notice('正在打包知识 Wiki…');
    try {
      var headers = {}; if (token()) headers.Authorization = 'Bearer ' + token();
      var res = await fetch(API + '/knowledge/export/markdown', { headers: headers, credentials: 'same-origin' });
      var cd = res.headers.get('Content-Disposition') || '';
      var isAttachment = /attachment/i.test(cd);
      var ct = res.headers.get('Content-Type') || '';
      if (!res.ok || (!isAttachment && ct.indexOf('application/json') >= 0)) {
        var j = null; try { j = await res.json(); } catch (e) {}
        throw new Error((j && j.message) || ('导出失败(' + res.status + ')'));
      }
      var blob = await res.blob();
      var fname = 'zhiqu-wiki-markdown.zip';
      if (window.showSaveFilePicker) {
        try {
          var handle = await window.showSaveFilePicker({ suggestedName: fname, types: [{ description: 'Zip 压缩包', accept: { 'application/zip': ['.zip'] } }] });
          var writable = await handle.createWritable();
          await writable.write(blob); await writable.close();
          n.update('已导出：' + fname, { done: true });
          return;
        } catch (e2) {
          if (e2 && e2.name === 'AbortError') { n.close(); return; }
        }
      }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      n.update('已开始下载：' + fname, { done: true });
    } catch (e) {
      n.update('导出失败：' + (e.message || '未知错误'), { error: true });
    }
  }
  var WIKI_PAGE_TYPES = [['GOAL', '目标'], ['PROJECT', '计划'], ['PREFERENCE', '偏好'], ['WEAKNESS', '薄弱点'], ['RESOURCE', '资料'], ['MEMORY', '对话摘要'], ['NOTE', '备注']];
  // 按类型给初始骨架，对齐 claude design 模板各类型页面的结构
  function wikiSkeleton(type, title) {
    var body = ({
      GOAL: '## 目标\n\n\n## 阶段里程碑\n- [ ] \n\n## 风险与对策\n- ',
      PROJECT: '## 时间块安排\n- \n\n## 每周检查点\n- [ ] ',
      PREFERENCE: '## 作息偏好\n- \n\n## 提醒方式\n- ',
      WEAKNESS: '## 高频错误\n- \n\n## 待攻克专题\n- [ ] ',
      RESOURCE: '## 教材与讲义\n- \n\n## 题库\n- \n\n## 参考链接\n- ',
      MEMORY: '## 结论\n\n\n## 待办\n- [ ] '
    })[type] || '';
    return '# ' + title + '\n\n' + body + '\n';
  }
  function createWikiPage() {
    var parentOptions = '<option value="">（根节点）</option>' + (state.wikiPages || []).filter(function (p) {
      return ['INDEX', 'LOG', 'SCHEMA'].indexOf(String(p.pageType || '').toUpperCase()) < 0;
    }).map(function (p) { return '<option value="' + p.id + '">' + esc(p.title) + '</option>'; }).join('');
    var typeOptions = WIKI_PAGE_TYPES.map(function (t) { return '<option value="' + t[0] + '"' + (t[0] === 'NOTE' ? ' selected' : '') + '>' + t[1] + '（' + t[0] + '）</option>'; }).join('');
    openModal({
      title: '新建知识页',
      bodyHtml:
        '<div class="zq-field"><label class="zq-label">页面标题</label><input id="zq-np-title" class="zq-input" placeholder="例如：英语作文素材库"></div>'
        + '<div class="zq-field"><label class="zq-label">类型</label><select id="zq-np-type" class="zq-select">' + typeOptions + '</select></div>'
        + '<div class="zq-field"><label class="zq-label">父节点</label><select id="zq-np-parent" class="zq-select">' + parentOptions + '</select></div>'
        + '<p style="margin:0 0 12px;font-size:12px;color:var(--zq-text3);line-height:1.6;">将按类型生成初始结构（小节 / 任务项），创建后点正文即可继续编辑。</p>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-np-cancel">取消</button><button type="button" class="zq-btn" id="zq-np-ok">创建</button></div>',
      onMount: function (b, h) {
        $('#zq-np-cancel', b).onclick = h.close;
        $('#zq-np-ok', b).onclick = function () {
          var title = $('#zq-np-title', b).value.trim(); if (!title) return toast('请填写页面标题', 'error');
          var type = $('#zq-np-type', b).value;
          var parentId = $('#zq-np-parent', b).value;
          safe('新建知识页', async function () {
            var body = { title: title, content: wikiSkeleton(type, title), pageType: type };
            if (parentId) body.parentId = Number(parentId);
            await api.post('/knowledge/pages', body);
            h.close(); await bootKnowledge(); toast('已创建');
          });
        };
      }
    });
  }
  function importWikiSource() {
    openModal({
      title: '导入来源',
      bodyHtml:
        '<div class="zq-field"><label class="zq-label">来源标题</label><input id="zq-imp-title" class="zq-input" placeholder="例如：408 考试大纲"></div>'
        + '<div class="zq-field"><label class="zq-label">导入方式</label><select id="zq-imp-mode" class="zq-select"><option value="TEXT">粘贴文本 / 链接</option><option value="UPLOAD">上传文件解析</option></select></div>'
        + '<div id="zq-imp-text-box">'
        + '<div class="zq-field"><label class="zq-label">类型</label><select id="zq-imp-type" class="zq-select"><option value="NOTE">笔记 / 文本</option><option value="URL">网址链接</option><option value="FILE">资料摘录</option></select></div>'
        + '<div class="zq-field"><label class="zq-label">内容 / 链接</label><textarea id="zq-imp-content" class="zq-textarea" style="min-height:110px;" placeholder="粘贴文本，或填入 http/https 链接"></textarea></div>'
        + '</div>'
        + '<div id="zq-imp-file-box" style="display:none;">'
        + '<div class="zq-field"><label class="zq-label">选择文件</label><input id="zq-imp-file" type="file" class="zq-input" style="height:auto;padding:7px 12px;" accept=".pdf,.xlsx,.xls,.txt,.md,.csv,.json,.xml,.png,.jpg,.jpeg,.webp"></div>'
        + '<p style="margin:0 0 12px;font-size:12px;color:var(--zq-text3);line-height:1.6;">pdf / xlsx / txt / md / csv / json / xml 会自动解析正文；图片仅记录文件信息，暂不做内容识别。</p>'
        + '</div>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-imp-cancel">取消</button><button type="button" class="zq-btn" id="zq-imp-ok">导入</button></div>',
      onMount: function (b, h) {
        var modeSel = $('#zq-imp-mode', b);
        modeSel.onchange = function () {
          var up = modeSel.value === 'UPLOAD';
          $('#zq-imp-text-box', b).style.display = up ? 'none' : '';
          $('#zq-imp-file-box', b).style.display = up ? '' : 'none';
        };
        $('#zq-imp-cancel', b).onclick = h.close;
        $('#zq-imp-ok', b).onclick = function () {
          var title = $('#zq-imp-title', b).value.trim();
          if (modeSel.value === 'UPLOAD') {
            var file = $('#zq-imp-file', b).files[0];
            if (!file) return toast('请选择要上传的文件', 'error');
            var n = notice('正在上传并解析「' + (title || file.name) + '」…');
            h.close();
            safe('上传来源', async function () {
              try {
                await api.upload('/knowledge/sources/upload', file, title ? { title: title } : {});
                n.update('来源解析完成', { done: true });
              } catch (e) { n.update('解析失败：' + (e.message || '未知错误'), { error: true }); throw e; }
            });
            return;
          }
          var content = $('#zq-imp-content', b).value;
          var type = $('#zq-imp-type', b).value;
          if (!title) return toast('请填写来源标题', 'error');
          safe('导入来源', async function () {
            await api.post('/knowledge/sources', { title: title, content: content, sourceType: type });
            h.close(); toast('来源已导入');
          });
        };
      }
    });
  }
  async function runWikiLint() {
    await safe('健康检查', async function () {
      var report = await api.get('/knowledge/lint/report');
      var issues = (report && (report.issues || report.findings || report.items)) || [];
      if (!Array.isArray(issues)) issues = [];
      var count = issues.length || ((report && report.total) || 0);
      var listHtml = issues.slice(0, 20).map(function (it) {
        var text = typeof it === 'string' ? it : (it.message || it.title || it.description || JSON.stringify(it));
        return '<div style="display:flex;gap:8px;padding:7px 10px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);font-size:12.5px;line-height:1.55;"><span style="color:var(--zq-warn);flex:none;">⚠</span><span>' + esc(text) + '</span></div>';
      }).join('');
      await showInfo({
        title: '健康检查',
        html: count
          ? '<p style="margin:0 0 12px;font-size:13px;color:var(--zq-text2);">发现 ' + count + ' 个问题（如悬空链接等）：</p><div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;max-height:280px;overflow-y:auto;">' + listHtml + '</div>'
          : '<p style="margin:0 0 16px;font-size:13.5px;color:var(--zq-ok);font-weight:600;">✓ 未发现问题，知识库链接完好。</p>'
      });
    });
  }
  // 待合入变更按钮：显示真实的 PENDING patch-set 数量（预置的 “2” 是静态占位，已移除）
  async function refreshWikiPatchBadge() {
    var b = $('#zq-patch-btn'); if (!b) return;
    try {
      var list = await api.get('/knowledge/patch-sets?status=PENDING');
      var n = (list || []).length;
      b.textContent = n ? ('待合入变更 ' + n) : '待合入变更';
      b.style.display = '';
    } catch (e) { b.textContent = '待合入变更'; }
  }
  var WIKI_TYPE_COLOR = { GOAL: 'var(--zq-q2)', PROJECT: 'var(--zq-primary)', PREFERENCE: 'var(--zq-q4)', WEAKNESS: 'var(--zq-q1)', RESOURCE: 'var(--zq-q3)', MEMORY: 'var(--zq-accent)', INDEX: 'var(--zq-text3)', SCHEMA: 'var(--zq-text3)', LOG: 'var(--zq-text3)', NOTE: 'var(--zq-text2)' };
  async function showWikiGraph() {
    await safe('知识图谱', async function () {
      var g = await api.get('/knowledge/graph');
      var nodes = (g && g.nodes) || [];
      var links = (g && g.links) || [];
      if (!nodes.length) { await showInfo({ title: '知识图谱', message: '还没有知识页，先创建几页并用 [[双链]] 互相引用吧。' }); return; }
      // 环形布局：入度高的页放内圈
      var W = 560, H = 420, cx = W / 2, cy = H / 2;
      var sorted = nodes.slice().sort(function (a, b) { return (b.degree || 0) - (a.degree || 0); });
      var pos = {};
      sorted.forEach(function (n, i) {
        var ring = i === 0 ? 0 : (i <= 6 ? 1 : 2);
        var radius = ring === 0 ? 0 : ring === 1 ? 118 : 180;
        var ringIdx = ring === 0 ? 0 : ring === 1 ? i - 1 : i - 7;
        var ringCount = ring === 0 ? 1 : ring === 1 ? Math.min(6, sorted.length - 1) : Math.max(1, sorted.length - 7);
        var angle = (ringIdx / ringCount) * Math.PI * 2 - Math.PI / 2;
        pos[n.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
      });
      var edgesSvg = links.map(function (l) {
        var s = pos[l.sourcePageId], t = pos[l.targetPageId];
        if (!s) return '';
        if (!t) { // 悬空链接：画到外圈的虚线短线
          return '<line x1="' + s.x + '" y1="' + s.y + '" x2="' + (s.x + 26) + '" y2="' + (s.y - 26) + '" stroke="var(--zq-bad)" stroke-width="1" stroke-dasharray="3,3" opacity=".6"/>';
        }
        return '<line x1="' + s.x + '" y1="' + s.y + '" x2="' + t.x + '" y2="' + t.y + '" stroke="var(--zq-border)" stroke-width="1.2" opacity=".8"/>';
      }).join('');
      var nodesSvg = sorted.map(function (n) {
        var p = pos[n.id];
        var r = Math.min(16, 7 + (n.degree || 0) * 2);
        var color = WIKI_TYPE_COLOR[String(n.type || 'NOTE').toUpperCase()] || 'var(--zq-text2)';
        var label = String(n.title || '').length > 9 ? String(n.title).slice(0, 8) + '…' : String(n.title || '');
        return '<g data-graph-node="' + n.id + '" style="cursor:pointer;">'
          + '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="' + color + '" opacity=".88"><title>' + esc(n.title || '') + '</title></circle>'
          + '<text x="' + p.x + '" y="' + (p.y + r + 13) + '" text-anchor="middle" style="font-size:10.5px;fill:var(--zq-text2);">' + esc(label) + '</text></g>';
      }).join('');
      var legend = Object.keys(WIKI_TYPE_COLOR).filter(function (k) {
        return nodes.some(function (n) { return String(n.type || 'NOTE').toUpperCase() === k; });
      }).map(function (k) {
        return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--zq-text2);"><i style="width:9px;height:9px;border-radius:50%;background:' + WIKI_TYPE_COLOR[k] + ';display:inline-block;"></i>' + k + '</span>';
      }).join('');
      var missing = (g && g.missingTargets && g.missingTargets.length) || 0;
      openModal({
        title: '知识图谱 · ' + nodes.length + ' 页 / ' + links.length + ' 链接',
        width: '620px',
        bodyHtml:
          '<div style="border:1px solid var(--zq-border-soft);border-radius:var(--zq-rm);background:var(--zq-card-soft);overflow:hidden;"><svg viewBox="0 0 ' + W + ' ' + H + '" style="display:block;width:100%;height:auto;">' + edgesSvg + nodesSvg + '</svg></div>'
          + '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;">' + legend + '</div>'
          + (missing ? '<p style="margin:10px 0 0;font-size:12px;color:var(--zq-bad);">⚠ ' + missing + ' 个悬空链接（红色虚线），可运行「健康检查」查看明细。</p>' : '')
          + '<p style="margin:8px 0 0;font-size:11.5px;color:var(--zq-text3);">节点大小 = 被引用次数 · 点击节点跳转到对应页面</p>',
        onMount: function (b, h) {
          $all('[data-graph-node]', b).forEach(function (gn) {
            gn.onclick = function () {
              var target = (state.wikiPages || []).find(function (x) { return String(x.id) === gn.getAttribute('data-graph-node'); });
              if (target) { h.close(); paintWikiDoc(target); }
            };
          });
        }
      });
    });
  }
  async function showWikiPatchSets() {
    await safe('待合入变更', async function () {
      var list = await api.get('/knowledge/patch-sets?status=PENDING');
      var n = (list || []).length;
      await refreshWikiPatchBadge();
      if (!n) { await showInfo({ title: '待合入变更', message: '当前没有待合入的变更。AI 对知识库的修改建议会先出现在这里，确认后才写入正文。' }); return; }
      var SHOW_MAX = 10;
      var items = list.slice(0, SHOW_MAX).map(function (ps) {
        return '<div style="padding:9px 12px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);font-size:12.5px;line-height:1.6;"><strong>' + esc(ps.title || ps.summary || ('变更 #' + ps.id)) + '</strong>' + (ps.createdAt ? '<span class="zq-mono" style="float:right;font-size:11px;color:var(--zq-text3);">' + esc(fmtDate(ps.createdAt)) + '</span>' : '') + '</div>';
      }).join('');
      var more = n > SHOW_MAX ? '<div style="padding:7px 12px;font-size:12px;color:var(--zq-text3);text-align:center;">仅显示前 ' + SHOW_MAX + ' 条，还有 ' + (n - SHOW_MAX) + ' 条未展示</div>' : '';
      await showInfo({ title: '待合入变更 · ' + n + ' 组', html: '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;max-height:300px;overflow-y:auto;">' + items + more + '</div><p style="margin:0 0 14px;font-size:12px;color:var(--zq-text3);">逐条审阅与合入将在后续版本提供。</p>' });
    });
  }
  function flattenKnowledge(nodes) {
    var out = [];
    function walk(n) {
      (Array.isArray(n) ? n : [n]).forEach(function (x) {
        if (!x) return;
        out.push(x);
        walk(x.children || []);
      });
    }
    walk(nodes);
    return out;
  }
  // 公式块 HTML：data-tex 存源码（esc 后），KaTeX 就绪后由 renderMathIn 真渲染，否则显示样式化源码
  function mathBlockHtml(tex) {
    return '<div class="zq-math" data-tex="' + esc(tex) + '" contenteditable="false" style="margin:12px 0;padding:13px 16px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);text-align:center;overflow-x:auto;font-size:15px;"><span class="zq-mono" style="font-size:12.5px;color:var(--zq-text2);">' + esc(tex) + '</span></div>';
  }
  function inlineMathSpan(tex) {
    return '<span class="zq-math-i" data-tex="' + tex.replace(/"/g, '&quot;') + '" contenteditable="false" style="padding:0 2px;"><span class="zq-mono" style="font-size:.92em;color:var(--zq-text2);">' + tex + '</span></span>';
  }
  function mdInline(t) {
    t = esc(t);
    // 行内代码先抽成占位符：反引号里的 $、*、[ 等都是字面量，不参与公式/加粗/链接解析
    var codeSlots = [];
    t = t.replace(/`([^`]+)`/g, function (m, c) { codeSlots.push(c); return '\u0001' + (codeSlots.length - 1) + '\u0001'; });
    t = t
      .replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>')
      .replace(/\$\$([^$\n]{1,200}?)\$\$/g, function (m, tex) {
        // 行中出现的 $$…$$ 先于单 $ 处理，否则会被拆成 "$ + 行内公式 + $" 留下游离美元符
        if (!/[\\^_{}a-zA-Z]/.test(tex)) return m;
        return inlineMathSpan(tex);
      })
      .replace(/\$([^$\n]{1,200}?)\$/g, function (m, tex) {
        // 行内公式：要求含 LaTeX 特征字符，避免把"花了$5和$10"这类金额误判成公式
        if (!/[\\^_{}a-zA-Z]/.test(tex)) return m;
        return inlineMathSpan(tex);
      })
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // URL 支持一层配对括号（如维基百科的 Function_(mathematics)），不再截断在第一个 )
      .replace(/\[([^\]]+)\]\((https?:\/\/(?:[^()\s]|\([^()]*\))+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--zq-primary);text-decoration:underline;text-underline-offset:3px;">$1</a>')
      .replace(/\[\[([^\]]+)\]\]/g, '<a data-wikilink="$1" style="color:var(--zq-primary);cursor:pointer;border-bottom:1px dashed var(--zq-tint-strong);">$1</a>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return t.replace(/\u0001(\d+)\u0001/g, function (m, i) {
      return '<code style="background:var(--zq-card-soft);padding:1px 5px;border-radius:4px;font-size:.92em;">' + codeSlots[+i] + '</code>';
    });
  }
  // 完整块类型渲染，对齐 claude design 静态模板：标题/正文/列表/任务勾选/引用/代码块/分隔线/相关页面双链
  function renderMarkdown(md) {
    // 归一化 LaTeX 定界符：模型输出常用 \(...\) / \[...\]，统一转成 $ / $$ 再走块解析。
    // 必须绕开 ``` 围栏代码段，否则代码里的字面 \[..\] 会被改写，编辑保存后造成永久破坏
    function normalizeMathDelims(text) {
      // 行内代码里的 \(..\) / \[..\] 是字面量，先抽成占位符护住，替换完再还原
      var codeSpans = [];
      var t = text.replace(/`[^`\n]+`/g, function (m) { codeSpans.push(m); return '\u0002' + (codeSpans.length - 1) + '\u0002'; });
      t = t
        .replace(/\\\[([\s\S]+?)\\\]/g, function (m, tex) { return '\n$$\n' + tex.trim() + '\n$$\n'; })
        .replace(/\\\((.+?)\\\)/g, function (m, tex) { return '$' + tex.trim() + '$'; });
      return t.replace(/\u0002(\d+)\u0002/g, function (m, i) { return codeSpans[+i]; });
    }
    var rawLines = String(md || '').replace(/\r/g, '').split('\n');
    var segs = [], segBuf = [], fenced = false;
    rawLines.forEach(function (line) {
      if (/^```/.test(line.trim())) {
        segs.push({ code: fenced, text: segBuf.join('\n') }); segBuf = [];
        segs.push({ code: true, text: line });
        fenced = !fenced;
      } else { segBuf.push(line); }
    });
    segs.push({ code: fenced, text: segBuf.join('\n') });
    var src = segs.map(function (s) { return s.code ? s.text : normalizeMathDelims(s.text); }).join('\n');
    var lines = src.split('\n');
    var html = '', inUl = false, inOl = false, inCode = false, inMath = false, codeBuf = [], mathBuf = [], quoteBuf = [], tableBuf = [];
    var sizes = { 1: '20px;font-weight:800', 2: '17px;font-weight:700', 3: '15.5px;font-weight:700;border-bottom:1px solid var(--zq-border-soft);padding-bottom:6px', 4: '14px;font-weight:700' };
    function closeUl() { if (inUl) { html += '</ul>'; inUl = false; } }
    function closeOl() { if (inOl) { html += '</ol>'; inOl = false; } }
    function flushQuote() {
      if (!quoteBuf.length) return;
      html += '<blockquote style="margin:12px 0;padding:10px 16px;border-left:3px solid var(--zq-accent);background:var(--zq-card-soft);border-radius:0 var(--zq-rs) var(--zq-rs) 0;font-size:13px;line-height:1.7;color:var(--zq-text2);">' + quoteBuf.join('<br>') + '</blockquote>';
      quoteBuf = [];
    }
    function flushTable() {
      if (!tableBuf.length) return;
      var rows = tableBuf.map(function (l) {
        return l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
      });
      var cellCss = 'border:1px solid var(--zq-border-soft);padding:6px 10px;text-align:left;vertical-align:top;';
      var hasHeader = rows.length > 1 && rows[1].length && rows[1].every(function (c) { return c === '' || /^:?-{2,}:?$/.test(c); }) && rows[1].some(function (c) { return /-{2,}/.test(c); });
      var out = '<div style="overflow-x:auto;margin:12px 0;"><table style="border-collapse:collapse;width:100%;font-size:12.5px;line-height:1.6;">';
      if (hasHeader) {
        out += '<thead><tr>' + rows[0].map(function (c) { return '<th style="' + cellCss + 'background:var(--zq-card-soft);font-weight:700;">' + mdInline(c) + '</th>'; }).join('') + '</tr></thead>';
        rows = rows.slice(2);
      }
      out += '<tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td style="' + cellCss + '">' + mdInline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
      html += out;
      tableBuf = [];
    }
    function closeBlocks() { closeUl(); closeOl(); flushQuote(); flushTable(); }
    lines.forEach(function (line) {
      if (/^```/.test(line.trim())) {
        if (inCode) {
          html += '<pre style="margin:12px 0;padding:12px 14px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);overflow-x:auto;"><code class="zq-mono" style="font-size:12.5px;line-height:1.65;white-space:pre;">' + esc(codeBuf.join('\n')) + '</code></pre>';
          codeBuf = []; inCode = false;
        } else { closeBlocks(); inCode = true; }
        return;
      }
      if (inCode) { codeBuf.push(line); return; }
      // 公式块：$$…$$（支持单行 $$tex$$ 与多行围栏）
      var lt = line.trim();
      if (inMath) {
        if (/\$\$\s*$/.test(lt)) {
          var tail = lt.replace(/\$\$\s*$/, '').trim();
          if (tail) mathBuf.push(tail);
          html += mathBlockHtml(mathBuf.join('\n'));
          mathBuf = []; inMath = false;
        } else { mathBuf.push(line); }
        return;
      }
      if (/^\$\$(.+)\$\$$/.test(lt)) { closeBlocks(); html += mathBlockHtml(lt.slice(2, -2).trim()); return; }
      if (/^\$\$/.test(lt)) { closeBlocks(); inMath = true; var head = lt.slice(2).trim(); if (head) mathBuf.push(head); return; }
      if (/^\|.*\|\s*$/.test(line.trim())) { closeUl(); closeOl(); flushQuote(); tableBuf.push(line.trim()); return; }
      flushTable();
      var h = line.match(/^(#{1,4})\s+(.+)$/);
      var task = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
      var li = line.match(/^[-*]\s+(.+)$/);
      var ol = line.match(/^\d+[.)]\s+(.+)$/);
      var q = line.match(/^>\s?(.*)$/);
      if (h) { closeBlocks(); var lvl = h[1].length; html += '<h' + lvl + ' style="margin:14px 0 8px;font-size:' + sizes[lvl] + ';">' + mdInline(h[2]) + '</h' + lvl + '>'; }
      else if (task) {
        closeBlocks();
        var done = task[1].toLowerCase() === 'x';
        html += '<div class="zq-task-row" style="display:flex;gap:9px;align-items:flex-start;margin:7px 0;"><input type="checkbox" ' + (done ? 'checked ' : '') + 'contenteditable="false" style="accent-color:var(--zq-primary);margin-top:5px;flex:none;"><span style="text-decoration:' + (done ? 'line-through' : 'none') + ';color:' + (done ? 'var(--zq-text3)' : 'var(--zq-text)') + ';">' + mdInline(task[2]) + '</span></div>';
      }
      else if (li) { closeOl(); flushQuote(); if (!inUl) { html += '<ul style="margin:8px 0;padding-left:22px;">'; inUl = true; } html += '<li style="margin:4px 0;">' + mdInline(li[1]) + '</li>'; }
      else if (ol) { closeUl(); flushQuote(); if (!inOl) { html += '<ol style="margin:8px 0;padding-left:24px;">'; inOl = true; } html += '<li style="margin:4px 0;">' + mdInline(ol[1]) + '</li>'; }
      else if (q) { closeUl(); closeOl(); quoteBuf.push(mdInline(q[1])); }
      else if (/^(-{3,}|\*{3,})$/.test(line.trim())) { closeBlocks(); html += '<hr style="margin:16px 0;border:none;border-top:1px solid var(--zq-border-soft);">'; }
      else if (line.trim() === '') { closeBlocks(); }
      else { closeBlocks(); html += '<p style="margin:8px 0;">' + mdInline(line) + '</p>'; }
    });
    if (inCode) { html += '<pre style="margin:12px 0;padding:12px 14px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);overflow-x:auto;"><code class="zq-mono" style="font-size:12.5px;line-height:1.65;white-space:pre;">' + esc(codeBuf.join('\n')) + '</code></pre>'; }
    if (inMath && mathBuf.length) { html += mathBlockHtml(mathBuf.join('\n')); }
    closeBlocks();
    return '<div style="font-size:13.5px;line-height:1.75;">' + (html || '<p></p>') + '</div>';
  }
  // KaTeX 懒加载：页面出现公式节点时才注入本地 vendor 资源（不依赖外网 CDN，随 JAR 分发、SW 可缓存）。
  // JS 与 CSS 都就绪才开始排版——只成功一半（如 CSS 加载失败）时保留样式化源码降级，不显示裸 KaTeX DOM。
  var katexState = 0; // 0=未加载 1=加载中 2=就绪 3=失败
  var katexPending = [];
  function paintMath(nodes) {
    Array.prototype.forEach.call(nodes, function (el) {
      if (el.dataset.mathDone === '1') return;
      var tex = el.getAttribute('data-tex') || '';
      try {
        el.innerHTML = window.katex.renderToString(tex, { throwOnError: false, displayMode: el.classList.contains('zq-math') });
        el.dataset.mathDone = '1';
      } catch (e) { /* 渲染失败保留源码 */ }
    });
  }
  function renderMathIn(root) {
    if (!root) return;
    var nodes = root.querySelectorAll('[data-tex]');
    if (!nodes.length) return;
    if (katexState === 2 && window.katex) { paintMath(nodes); return; }
    if (katexState === 3) return;
    katexPending.push(root);
    if (katexState === 1) return;
    katexState = 1;
    var cssReady = false, jsReady = false;
    function maybeReady() {
      if (!cssReady || !jsReady || !window.katex) return;
      katexState = 2;
      katexPending.splice(0).forEach(function (r) { paintMath(r.querySelectorAll('[data-tex]')); });
    }
    function fail() { katexState = 3; katexPending = []; }
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'assets/vendor/katex/katex.min.css';
    link.onload = function () { cssReady = true; maybeReady(); };
    link.onerror = fail;
    document.head.appendChild(link);
    var s = document.createElement('script');
    s.src = 'assets/vendor/katex/katex.min.js';
    s.onload = function () { jsReady = true; maybeReady(); };
    s.onerror = fail;
    document.head.appendChild(s);
  }
  function htmlToMarkdown(root) {
    function walk(node) {
      var out = '';
      Array.prototype.forEach.call(node.childNodes, function (n) {
        if (n.nodeType === 3) { out += n.nodeValue.replace(/ /g, ' '); return; }
        if (n.nodeType !== 1) return;
        // 公式节点：不递归 KaTeX 生成的 DOM，直接还原 $$…$$ / $…$ 源码
        if (n.getAttribute && n.getAttribute('data-tex') !== null) {
          var tex = n.getAttribute('data-tex');
          out += (n.classList && n.classList.contains('zq-math')) ? '\n$$\n' + tex + '\n$$\n\n' : ('$' + tex + '$');
          return;
        }
        var tag = n.tagName.toUpperCase();
        if (tag === 'BR') { out += '\n'; return; }
        if (tag === 'HR') { out += '\n---\n\n'; return; }
        if (tag === 'INPUT') { if ((n.getAttribute('type') || '').toLowerCase() === 'checkbox') out += n.checked ? '- [x] ' : '- [ ] '; return; }
        var inner = walk(n);
        switch (tag) {
          case 'H1': out += '\n# ' + inner.trim() + '\n\n'; break;
          case 'H2': out += '\n## ' + inner.trim() + '\n\n'; break;
          case 'H3': out += '\n### ' + inner.trim() + '\n\n'; break;
          case 'H4': out += '\n#### ' + inner.trim() + '\n\n'; break;
          case 'STRONG': case 'B': out += '**' + inner + '**'; break;
          case 'EM': case 'I': out += '*' + inner + '*'; break;
          case 'U': out += '<u>' + inner + '</u>'; break;
          case 'PRE': { var codeTxt = (n.textContent || '').replace(/\n$/, ''); out += '\n```\n' + codeTxt + '\n```\n\n'; break; }
          case 'CODE': out += '`' + inner + '`'; break;
          case 'BLOCKQUOTE': out += '\n' + inner.trim().split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n'; break;
          case 'TABLE': {
            var md = '\n';
            Array.prototype.forEach.call(n.querySelectorAll('tr'), function (tr, ri) {
              var cells = Array.prototype.map.call(tr.querySelectorAll('th,td'), function (c) { return walk(c).replace(/\n+/g, ' ').trim(); });
              md += '| ' + cells.join(' | ') + ' |\n';
              if (ri === 0 && tr.querySelector('th')) md += '|' + cells.map(function () { return ' --- '; }).join('|') + '|\n';
            });
            out += md + '\n';
            break;
          }
          case 'A': { var wl = n.getAttribute('data-wikilink'); var href = n.getAttribute('href'); if (wl) out += '[[' + wl + ']]'; else if (href) out += '[' + (inner || href) + '](' + href + ')'; else out += inner; break; }
          case 'LI': out += (n.parentNode && n.parentNode.tagName === 'OL' ? '1. ' : '- ') + inner.trim() + '\n'; break;
          case 'UL': case 'OL': out += '\n' + inner + '\n'; break;
          case 'P': case 'DIV': out += inner.trim() + '\n\n'; break;
          default: out += inner;
        }
      });
      return out;
    }
    return walk(root).replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  async function bootAiAssistant() {
    setAiToggleState('web', false);
    setAiToggleState('think', false);
    var webBtn = $('#zq-web'), thinkBtn = $('#zq-think'), sendBtn = $('#zq-send'), draft = $('#zq-draft');
    if (webBtn) webBtn.onclick = function () { aiToggle('web'); };
    if (thinkBtn) thinkBtn.onclick = function () { aiToggle('think'); };
    if (sendBtn) sendBtn.onclick = sendAiMessage;
    if (draft) {
      draft.addEventListener('input', growDraft);
      draft.addEventListener('keydown', function (event) {
        // ⌘/Ctrl + 回车发送，单独回车换行 —— 与多数聊天工具一致。
        // 旧行为是「回车发送、Shift+回车换行」，而那时 #zq-draft 还是 <input>：
        // Shift+回车那一半从来就没生效过，input 根本装不下换行符。
        // 换成 textarea 之后「换行」才第一次真的可用，所以发送键位一并让出去。
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          sendAiMessage();
        }
      });
    }

    // 先确定当前 Notebook，聊天记录按 Notebook 隔离加载。
    await Promise.all([loadAiNotebooks(), loadAiModelSelect()]);
    await loadAiMessages();
    await renderAgentPanels();

    var sourceUpload = $('#zq-source-upload');
    if (sourceUpload) sourceUpload.onclick = function () {
      chooseAiFiles(function (files) { uploadAiFiles(files, false); });
    };
    var chatUpload = $('#zq-chat-upload');
    if (chatUpload) chatUpload.onclick = function () {
      chooseAiFiles(function (files) { uploadAiFiles(files, true); });
    };
    bindAiDropZone();

    var addUrlBtn = $('#zq-add-url');
    if (addUrlBtn) addUrlBtn.onclick = async function () { if (!state.notebookId) return toast('请先选择 Notebook', 'error'); var url = await askText({ title: '添加 URL 资料', label: '资料网址', placeholder: 'https://…', hint: '添加后将自动抓取网页内容并解析进当前 Notebook。', okText: '添加' }); if (!url || !url.trim()) return; safe('添加 URL', async function () { await api.post('/ai/notebooks/' + state.notebookId + '/sources', { url: url.trim() }); toast('已添加，正在抓取解析'); await loadAiSources(); }); };
    var newNbBtn = $('#zq-new-notebook');
    if (newNbBtn) newNbBtn.onclick = function () {
      openModal({
        title: '新建 Notebook',
        bodyHtml:
          '<div class="zq-field"><label class="zq-label">名称</label><input id="zq-nb-name" class="zq-input" placeholder="例如：考研数学资料" value="新资料本"></div>'
          + '<div class="zq-field"><label class="zq-label">说明（可选）</label><textarea id="zq-nb-desc" class="zq-textarea" style="min-height:70px;" placeholder="这个资料本用来收集什么"></textarea></div>'
          + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-nb-cancel">取消</button><button type="button" class="zq-btn" id="zq-nb-ok">创建</button></div>',
        onMount: function (b, h) {
          var name = $('#zq-nb-name', b); try { name.select(); } catch (e) {}
          $('#zq-nb-cancel', b).onclick = h.close;
          $('#zq-nb-ok', b).onclick = function () {
            var title = name.value.trim(); if (!title) return toast('请填写名称', 'error');
            var description = $('#zq-nb-desc', b).value.trim();
            safe('新建 Notebook', async function () {
              var nb = await api.post('/ai/notebooks', { title: title, description: description });
              state.notebookId = nb && nb.id ? nb.id : state.notebookId;
              h.close(); await loadAiNotebooks(); await loadAiMessages(); toast('已新建 Notebook');
            });
          };
        }
      });
    };
  }

  function pickFile(cb) {
    var input = document.createElement('input'); input.type = 'file';
    input.onchange = function () { if (input.files[0]) cb(input.files[0]); };
    input.click();
  }

  function chooseAiFiles(cb) {
    if (!state.notebookId) {
      toast('请先新建或选择 Notebook，再上传资料', 'error');
      return;
    }
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.pdf,.xlsx,.xls,.csv,.txt,.md,.json,.docx,.png,.jpg,.jpeg,.webp';
    input.onchange = function () {
      var files = Array.prototype.slice.call(input.files || []);
      if (files.length) cb(files);
    };
    input.click();
  }

  function setAiToggleState(kind, on) {
    var button = document.getElementById(kind === 'web' ? 'zq-web' : 'zq-think');
    if (!button) return;
    button.dataset.on = on ? '1' : '0';
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.style.border = '1px solid ' + (on ? 'var(--zq-tint-strong)' : 'var(--zq-border)');
    button.style.background = on ? 'var(--zq-tint)' : 'var(--zq-card)';
    button.style.color = on ? 'var(--zq-primary)' : 'var(--zq-text2)';
    button.style.fontWeight = '600';
  }

  function aiToggle(k) {
    var button = document.getElementById(k === 'web' ? 'zq-web' : 'zq-think');
    if (!button) return;
    setAiToggleState(k, button.dataset.on !== '1');
  }

  function setAiDropState(text, mode) {
    var zone = $('#zq-drop-zone'), status = $('#zq-drop-status');
    if (status && text) status.textContent = text;
    if (!zone) return;
    zone.classList.toggle('is-uploading', mode === 'uploading');
    zone.classList.toggle('is-error', mode === 'error');
  }

  function bindAiDropZone() {
    var zone = $('#zq-drop-zone');
    if (!zone) return;
    ['dragenter', 'dragover'].forEach(function (name) {
      zone.addEventListener(name, function (event) {
        event.preventDefault();
        event.stopPropagation();
        zone.classList.add('is-dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      zone.addEventListener(name, function (event) {
        event.preventDefault();
        event.stopPropagation();
        zone.classList.remove('is-dragging');
      });
    });
    zone.addEventListener('drop', function (event) {
      var files = Array.prototype.slice.call(event.dataTransfer && event.dataTransfer.files || []);
      if (files.length) uploadAiFiles(files, true);
    });
    zone.addEventListener('click', function () {
      chooseAiFiles(function (files) { uploadAiFiles(files, true); });
    });
    zone.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        chooseAiFiles(function (files) { uploadAiFiles(files, true); });
      }
    });
  }

  function clearPendingSources() {
    state.pendingSources = [];
    renderAiAttachments();
  }

  function clearUsedPendingSources(ids) {
    var used = (ids || []).map(Number);
    state.pendingSources = state.pendingSources.filter(function (item) {
      return used.indexOf(Number(item.id)) < 0;
    });
    renderAiAttachments();
  }

  function addPendingSource(source) {
    if (!source || !source.id || String(source.status || '').toUpperCase() !== 'READY') return;
    if (!state.pendingSources.some(function (item) { return Number(item.id) === Number(source.id); })) {
      state.pendingSources.push(source);
    }
    renderAiAttachments();
  }

  function renderAiAttachments() {
    var host = $('#zq-attachments');
    if (!host) return;
    host.hidden = !state.pendingSources.length;
    host.innerHTML = state.pendingSources.map(function (source) {
      return '<span class="zq-ai-attachment"><span class="zq-ai-attachment-type">' + esc(srcTypeInfo(source.sourceType)[0]) + '</span><span title="' + esc(source.title || '资料') + '">' + esc(source.title || '资料') + '</span><button type="button" data-remove-source="' + source.id + '" aria-label="移除附件">×</button></span>';
    }).join('');
    $all('[data-remove-source]', host).forEach(function (button) {
      button.onclick = function () {
        var id = Number(button.dataset.removeSource);
        state.pendingSources = state.pendingSources.filter(function (item) { return Number(item.id) !== id; });
        renderAiAttachments();
      };
    });
  }

  async function uploadAiFiles(files, attachToNextMessage) {
    if (!state.notebookId) {
      toast('请先新建或选择 Notebook，再上传资料', 'error');
      return;
    }
    var notebookId = state.notebookId;
    var list = Array.prototype.slice.call(files || []).filter(Boolean);
    if (!list.length) return;
    setAiDropState('正在上传 0 / ' + list.length + '…', 'uploading');
    var readyCount = 0, archiveCount = 0, errorCount = 0;
    for (var i = 0; i < list.length; i++) {
      setAiDropState('正在上传 ' + (i + 1) + ' / ' + list.length + '：' + list[i].name, 'uploading');
      try {
        var source = await api.upload('/ai/notebooks/' + notebookId + '/sources/upload', list[i]);
        var status = String(source && source.status || '').toUpperCase();
        if (status === 'READY') {
          readyCount++;
          if (attachToNextMessage && notebookId === state.notebookId) addPendingSource(source);
        } else if (status === 'UPLOADED') {
          archiveCount++;
        } else {
          errorCount++;
        }
      } catch (error) {
        errorCount++;
      }
    }
    if (notebookId === state.notebookId) {
      await loadAiNotebooks();
    }
    var summary = readyCount + ' 份可用于问答';
    if (archiveCount) summary += '，' + archiveCount + ' 份仅存档';
    if (errorCount) summary += '，' + errorCount + ' 份失败';
    setAiDropState(summary, errorCount && !readyCount ? 'error' : 'done');
    toast('上传完成：' + summary, errorCount && !readyCount ? 'error' : undefined);
  }
  async function loadAiModelSelect() {
    var sel = $('#zq-model'); if (!sel) return;
    try {
      var models = normalizeModelList(await api.get('/ai/models'));
      sel.innerHTML = '<option value="">默认模型</option>' + (models || []).map(function (m) {
        return '<option value="' + m.id + '">' + esc(m.label || m.displayName || m.modelName) + '</option>';
      }).join('');
    } catch (e) { /* 保持默认项 */ }
  }
  function renderSteps(steps) {
    var host = $('#zq-steps'); if (!host) return;
    host.innerHTML = steps.length ? steps.map(function (s, i) {
      var status = (s.status || 'DONE').toUpperCase();
      var color = status === 'DONE' || status === 'COMPLETED' ? 'var(--zq-ok)' : status === 'FAILED' ? 'var(--zq-bad)' : 'var(--zq-text3)';
      var last = i === steps.length - 1;
      var stepName = s.publicSummary || s.title || s.name || s.agentType || ('步骤 ' + (i + 1));
      var metaLine = (s.agentType && s.publicSummary ? s.agentType + ' · ' : '') + status;
      return '<div style="display:flex;gap:9px;padding:5px 0;"><div style="display:flex;flex-direction:column;align-items:center;flex:none;width:10px;"><span style="width:8px;height:8px;border-radius:50%;background:' + color + ';margin-top:4px;"></span>' + (last ? '' : '<span style="flex:1;width:1px;background:var(--zq-border-soft);margin-top:2px;"></span>') + '</div><div style="min-width:0;padding-bottom:6px;"><div style="font-size:11.5px;font-weight:600;line-height:1.45;">' + esc(stepName) + '</div><div class="zq-mono" style="font-size:10px;color:' + color + ';margin-top:1px;">' + esc(metaLine) + '</div></div></div>';
    }).join('') : empty('暂无执行记录');
  }

  function artifactTypeLabel(type) {
    return ({
      CITATION: '资料引用',
      FAILED_SOURCE: '抓取失败',
      PLAN_DRAFT: '计划草稿',
      TASK_DRAFT: '任务草稿',
      ROUTINE_DRAFT: '例行计划草稿',
      WIKI_DRAFT: 'Wiki 草稿',
      NOTE_DRAFT: '笔记草稿'
    })[String(type || '').toUpperCase()] || '其他产物';
  }

  function artifactStatusLabel(status) {
    return ({
      DRAFT: '待确认',
      PENDING: '待确认',
      CONFIRMED: '已确认',
      DISCARDED: '已忽略',
      FAILED: '失败'
    })[String(status || '').toUpperCase()] || (status || '');
  }

  function normalizeArtifact(raw) {
    var source = raw && raw.artifact ? raw.artifact : (raw || {});
    return Object.assign({}, source, {
      id: source.id || source.artifactId || (raw && raw.artifactId),
      artifactType: source.artifactType || source.type || (raw && raw.artifactType),
      title: source.title || (raw && raw.title),
      status: source.status || (raw && raw.status)
    });
  }

  function artifactContent(artifact) {
    return artifact && artifact.content && typeof artifact.content === 'object' ? artifact.content : {};
  }

  function artifactTextPreview(artifact) {
    var content = artifactContent(artifact);
    var text = artifact.preview || content.preview || content.snippet || content.content || content.description || content.reason || content.error || '';
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (text.length > 190) text = text.slice(0, 187) + '…';
    return text;
  }

  function artifactItemTitles(artifact) {
    if (Array.isArray(artifact.itemTitles)) return artifact.itemTitles.map(String);
    var content = artifactContent(artifact), titles = [];
    ['tasks', 'routines', 'items', 'pages'].forEach(function (key) {
      if (!Array.isArray(content[key])) return;
      content[key].forEach(function (item) {
        var title = item && (item.title || item.name || item.content);
        if (title && titles.length < 8) titles.push(String(title));
      });
    });
    return titles;
  }

  function groupArtifacts(artifacts) {
    var output = [], citationGroups = Object.create(null);
    (artifacts || []).map(normalizeArtifact).forEach(function (artifact) {
      if (String(artifact.artifactType || '').toUpperCase() !== 'CITATION') {
        output.push(artifact);
        return;
      }
      var content = artifactContent(artifact);
      var sourceId = content.sourceId != null ? content.sourceId : artifact.sourceId;
      var sourceUrl = content.url || artifact.url;
      var key = sourceId != null ? 'source:' + sourceId
        : sourceUrl ? 'url:' + sourceUrl
          : 'title:' + (artifact.title || content.title || artifact.id);
      if (!citationGroups[key]) {
        citationGroups[key] = Object.assign({}, artifact, { _citationParts: [] });
        output.push(citationGroups[key]);
      }
      citationGroups[key]._citationParts.push(artifact);
    });
    return output;
  }

  function artifactDetailsHtml(artifact) {
    var type = String(artifact.artifactType || '').toUpperCase();
    if (type === 'CITATION') {
      var parts = artifact._citationParts || [artifact];
      return parts.map(function (part, index) {
        var content = artifactContent(part);
        var chunkIndex = content.chunkIndex != null ? content.chunkIndex : part.chunkIndex;
        var label = chunkIndex != null ? '片段 ' + (Number(chunkIndex) + 1) : '命中片段 ' + (index + 1);
        var snippet = content.content || content.snippet || part.preview || '暂无片段预览';
        return '<div class="zq-artifact-part"><strong>' + esc(label) + '</strong><span>' + esc(snippet) + '</span></div>';
      }).join('');
    }
    var content = artifactContent(artifact);
    var safeJson = Object.keys(content).length ? JSON.stringify(content, null, 2) : JSON.stringify({
      title: artifact.title || '',
      preview: artifact.preview || '',
      itemCount: artifact.itemCount || 0,
      itemTitles: artifact.itemTitles || []
    }, null, 2);
    return '<pre class="zq-artifact-json">' + esc(safeJson) + '</pre>';
  }

  // ── AI 计划草稿确认弹窗 ────────────────────────────────────────────────
  // 计划不会自动进日历：AI 生成后先落成 DRAFT 产物，弹窗让用户 忽略/修改/确认，
  // 只有「确认」才调 /ai/artifacts/{id}/confirm 真正写入任务与例行计划。
  var PLAN_DRAFT_TYPES = ['PLAN_DRAFT', 'TASK_DRAFT', 'ROUTINE_DRAFT'];
  var shownPlanModals = Object.create(null); // 已弹过的产物 id，避免同一草稿反复打扰

  function isPlanDraft(artifact) {
    var type = String(artifact.artifactType || '').toUpperCase();
    var status = String(artifact.status || '').toUpperCase();
    return PLAN_DRAFT_TYPES.indexOf(type) >= 0 && (status === 'DRAFT' || status === 'PENDING');
  }

  // 取出草稿里的条目副本；保留原始字段（象限/时长/提醒等），弹窗只覆盖用户改过的字段后原样回传
  function planDraftItems(artifact) {
    var content = artifactContent(artifact);
    var type = String(artifact.artifactType || '').toUpperCase();
    var tasks = Array.isArray(content.tasks) ? content.tasks
      : Array.isArray(content.suggestedTasks) ? content.suggestedTasks : [];
    var routines = Array.isArray(content.routines) ? content.routines
      : Array.isArray(content.suggestedRoutines) ? content.suggestedRoutines : [];
    if (!tasks.length && type === 'TASK_DRAFT' && content.title) tasks = [content];
    if (!routines.length && type === 'ROUTINE_DRAFT' && content.title) routines = [content];
    var copy = function (item) { return Object.assign({}, item); };
    return { tasks: tasks.map(copy), routines: routines.map(copy) };
  }

  function planTaskMeta(item) {
    var bits = [];
    if (item.deadline) bits.push('截止 ' + item.deadline);
    if (item.startTime) bits.push('开始 ' + item.startTime);
    if (item.durationMinutes) bits.push(item.durationMinutes + ' 分钟');
    var q = item.quadrant || item.suggestedQuadrant;
    if (q) bits.push('第 ' + q + ' 象限');
    return bits.join(' · ');
  }
  function planRoutineMeta(item) {
    var bits = [];
    if (item.frequency) bits.push(String(item.frequency));
    if (item.preferredTime) bits.push(item.preferredTime);
    if (item.durationMinutes) bits.push(item.durationMinutes + ' 分钟');
    if (item.startDate) bits.push(item.startDate + (item.endDate ? ' → ' + item.endDate : ''));
    return bits.join(' · ');
  }

  function openPlanConfirmModal(artifact) {
    var data = planDraftItems(artifact);
    if (!data.tasks.length && !data.routines.length) return null;
    shownPlanModals[artifact.id] = true;
    var editing = false;
    var picked = {
      tasks: data.tasks.map(function () { return true; }),
      routines: data.routines.map(function () { return true; })
    };
    var handle = openModal({ title: 'AI 生成的学习计划', width: 640, bodyHtml: '<div class="zq-plan-confirm"></div>' });
    var root = handle.body.querySelector('.zq-plan-confirm');

    function rowHtml(kind, item, index, metaFn) {
      var whenValue = kind === 'tasks'
        ? (item.deadline || item.startTime || '')
        : (item.preferredTime || '');
      var inner = editing
        ? '<input class="zq-plan-title" data-kind="' + kind + '" data-i="' + index + '" value="' + esc(String(item.title || '')) + '">'
          + '<input class="zq-plan-when" data-kind="' + kind + '" data-i="' + index + '" value="' + esc(String(whenValue)) + '"'
          + ' placeholder="' + (kind === 'tasks' ? '截止时间，如 2026-07-15 23:59:59' : '时间，如 08:00') + '">'
        : '<div class="zq-plan-name">' + esc(String(item.title || '未命名')) + '</div>'
          + (metaFn(item) ? '<div class="zq-plan-meta">' + esc(metaFn(item)) + '</div>' : '');
      return '<label class="zq-plan-row">'
        + '<input type="checkbox" data-pick="' + kind + '" data-i="' + index + '"' + (picked[kind][index] ? ' checked' : '') + '>'
        + '<div class="zq-plan-row-body">' + inner + '</div></label>';
    }

    function paint() {
      var html = '<p class="zq-plan-hint">' + (editing
        ? '勾选要写入的条目，并可直接修改标题与时间。'
        : 'AI 建议了以下安排，<strong>确认后才会写入你的日历</strong>。') + '</p>';
      if (data.tasks.length) {
        html += '<div class="zq-plan-group"><h4>任务 · ' + data.tasks.length + '</h4>'
          + data.tasks.map(function (t, i) { return rowHtml('tasks', t, i, planTaskMeta); }).join('') + '</div>';
      }
      if (data.routines.length) {
        html += '<div class="zq-plan-group"><h4>例行计划 · ' + data.routines.length + '</h4>'
          + data.routines.map(function (r, i) { return rowHtml('routines', r, i, planRoutineMeta); }).join('') + '</div>';
      }
      html += '<div class="zq-plan-actions">'
        + '<button type="button" class="zq-btn-ghost" data-plan="ignore">忽略</button>'
        + '<button type="button" data-plan="edit">' + (editing ? '完成修改' : '修改') + '</button>'
        + '<button type="button" class="zq-btn-primary" data-plan="ok">确认写入</button>'
        + '</div>';
      root.innerHTML = html;
      wire();
    }

    function wire() {
      $all('[data-pick]', root).forEach(function (cb) {
        cb.onchange = function () { picked[cb.dataset.pick][Number(cb.dataset.i)] = cb.checked; };
      });
      $all('.zq-plan-title', root).forEach(function (inp) {
        inp.oninput = function () { data[inp.dataset.kind][Number(inp.dataset.i)].title = inp.value; };
      });
      $all('.zq-plan-when', root).forEach(function (inp) {
        inp.oninput = function () {
          var item = data[inp.dataset.kind][Number(inp.dataset.i)];
          if (inp.dataset.kind !== 'tasks') { item.preferredTime = inp.value; return; }
          // 原来用哪个字段表达时间，就改回哪个，避免把 startTime 计划误写成 deadline
          if (!item.deadline && item.startTime) item.startTime = inp.value; else item.deadline = inp.value;
        };
      });
      $('[data-plan="edit"]', root).onclick = function () { editing = !editing; paint(); };
      $('[data-plan="ignore"]', root).onclick = function () {
        safe('忽略计划', async function () {
          await api.post('/ai/artifacts/' + artifact.id + '/discard', {});
          handle.close(); toast('已忽略该计划'); await renderAgentPanels();
        });
      };
      $('[data-plan="ok"]', root).onclick = function () {
        var tasks = data.tasks.filter(function (_, i) { return picked.tasks[i]; });
        var routines = data.routines.filter(function (_, i) { return picked.routines[i]; });
        if (!tasks.length && !routines.length) { toast('请至少勾选一项，或点「忽略」'); return; }
        safe('确认计划', async function () {
          // 始终回传当前条目（可能已勾选/编辑过），后端据此覆盖草稿再落库
          await api.post('/ai/artifacts/' + artifact.id + '/confirm', { tasks: tasks, routines: routines });
          handle.close(); toast('已写入日历'); await renderAgentPanels();
        });
      };
    }
    paint();
    return handle;
  }

  function renderArtifacts(artifacts) {
    var host = $('#zq-artifacts'); if (!host) return;
    var grouped = groupArtifacts(artifacts);
    host.innerHTML = grouped.length ? grouped.map(function (artifact) {
      var type = String(artifact.artifactType || '').toUpperCase();
      var status = String(artifact.status || '').toUpperCase();
      var draft = ['PLAN_DRAFT', 'TASK_DRAFT', 'ROUTINE_DRAFT', 'WIKI_DRAFT', 'NOTE_DRAFT'].indexOf(type) >= 0
        && (status === 'DRAFT' || status === 'PENDING');
      var content = artifactContent(artifact);
      var parts = artifact._citationParts || [];
      var hitCount = parts.length || Number(artifact.hitCount || 0);
      var sourceType = content.sourceType || artifact.sourceType || '';
      var sourceInfo = type === 'CITATION'
        ? ((sourceType ? srcTypeInfo(sourceType)[0] + ' · ' : '') + (hitCount || 1) + ' 个命中片段')
        : '';
      var titles = artifactItemTitles(artifact);
      var itemCount = Number(artifact.itemCount || titles.length || 0);
      var draftInfo = itemCount ? itemCount + ' 个项目' : '';
      var meta = sourceInfo || draftInfo;
      var preview = artifactTextPreview(parts[0] || artifact);
      var url = content.url || artifact.url || '';
      var title = artifact.title || content.title || artifactTypeLabel(type);
      var titleHtml = /^https?:\/\//i.test(url)
        ? '<a class="zq-artifact-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>'
        : esc(title);
      var itemHtml = titles.length ? '<ul class="zq-artifact-items">' + titles.slice(0, 5).map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') + '</ul>' : '';
      return '<article class="zq-artifact-card">'
        + '<div class="zq-artifact-head"><span>' + esc(artifactTypeLabel(type)) + '</span><em>' + esc(artifactStatusLabel(status)) + '</em></div>'
        + '<div class="zq-artifact-title">' + titleHtml + '</div>'
        + (meta ? '<div class="zq-artifact-meta">' + esc(meta) + '</div>' : '')
        + (preview ? '<p class="zq-artifact-preview">' + esc(preview) + '</p>' : '')
        + itemHtml
        + '<details class="zq-artifact-details"><summary>展开详情</summary>' + artifactDetailsHtml(artifact) + '</details>'
        + (draft ? '<div class="zq-artifact-actions">'
            // 计划类草稿：优先走弹窗（可逐条勾选/修改），点这里可随时切回完整视图重看
            + (isPlanDraft(artifact) ? '<button data-art-view="' + artifact.id + '">查看并确认</button>' : '<button data-art-ok="' + artifact.id + '">确认</button>')
            + '<button data-art-no="' + artifact.id + '" class="zq-btn-ghost">忽略</button></div>' : '')
        + '</article>';
    }).join('') : empty('暂无产物');
    $all('[data-art-view]', host).forEach(function (b) {
      b.onclick = function () {
        var target = grouped.filter(function (a) { return String(a.id) === String(b.dataset.artView); })[0];
        if (target) openPlanConfirmModal(target);
      };
    });
    $all('[data-art-ok]', host).forEach(function (b) { b.onclick = function () { safe('确认产物', async function () { await api.post('/ai/artifacts/' + b.dataset.artOk + '/confirm', {}); toast('已确认'); await renderAgentPanels(); }); }; });
    $all('[data-art-no]', host).forEach(function (b) { b.onclick = function () { safe('忽略产物', async function () { await api.post('/ai/artifacts/' + b.dataset.artNo + '/discard', {}); toast('已忽略'); await renderAgentPanels(); }); }; });
  }
  async function renderAgentPanels() {
    if (!$('#zq-steps') && !$('#zq-artifacts')) return;
    var nbId = state.notebookId;
    var runs = await safe('执行轨迹', function () { return api.get('/ai/agent-runs' + (nbId ? '?notebookId=' + nbId : '')); });
    if (!nbId && Array.isArray(runs)) {
      // 空 Notebook 工作区只展示真正不绑定 Notebook 的普通聊天 Run，
      // 避免已删除 Notebook 的历史轨迹重新出现在右侧。
      runs = runs.filter(function (run) { return run.notebookId == null; });
    }
    var latest = runs && runs.length ? runs[0] : null;
    var detail = latest ? await safe('执行详情', function () { return api.get('/ai/agent-runs/' + latest.id); }) : null;
    if (nbId !== state.notebookId) return; // 响应期间已切换 notebook,丢弃过期数据
    renderSteps((detail && (detail.steps || detail.stepList)) || []);
    var artifacts = (detail && (detail.artifacts || detail.artifactList)) || [];
    renderArtifacts(artifacts);
    // 新生成的计划草稿主动弹窗：右侧产物卡片容易被忽略，而计划要用户确认后才写入日历，
    // 不弹的话用户会以为"什么都没发生"。每个草稿只弹一次，之后可从卡片「查看并确认」重开。
    var freshPlan = groupArtifacts(artifacts).filter(function (a) {
      return isPlanDraft(a) && !shownPlanModals[a.id];
    })[0];
    if (freshPlan) openPlanConfirmModal(freshPlan);
  }
  async function loadAiMessages() {
    // 聊天记录按 notebook 隔离:后端会话 key = notebook-{id},切换 notebook 时重新拉取
    var nbId = state.notebookId;
    var list = await api.get('/ai/messages?limit=50' + (nbId ? '&notebookId=' + nbId : ''));
    if (nbId !== state.notebookId) return; // 响应期间已切换 notebook,防止慢响应覆盖新窗口
    state.messages = list || [];
    var sync = $('#zq-sync-count'); if (sync) sync.textContent = '已同步 ' + state.messages.length + ' 条历史消息';
    renderAiMessages();
  }
  // 历史坏数据修复：早期流式链路会丢弃纯换行增量，整条消息被压成一行。
  // 只对"记号多、换行几乎为零"的消息做启发式回填换行，健康消息原样返回。
  function reflowFlatMarkdown(text) {
    var s = String(text || '');
    var newlines = (s.match(/\n/g) || []).length;
    var headingHits = (s.match(/#{2,4}/g) || []).length;
    if (newlines >= 3 || s.length < 120 || (headingHits < 2 && !/\|\s*:?-{3,}/.test(s))) return s;
    return s
      .replace(/\|\s+\|/g, '|\n|')
      .replace(/\s*(#{2,6})\s*/g, '\n\n$1 ')
      .replace(/(#{2,6}[^|\n]*?)\s+\|/g, '$1\n\n|')
      .replace(/([^|:\-\n])(-{3,})(?!-)(?!\s*\|)/g, '$1\n\n---\n\n')
      .replace(/([。：；！？])\s*\|/g, '$1\n|')
      .replace(/([^\n\d-])- (?=\S)/g, '$1\n- ')
      .replace(/([。；！？])\s*(\d+)[.、]\s+(?=\S)/g, '$1\n$2. ');
  }
  function renderAiMessages(opts) {
    var host = $('#zq-chat'); if (!host) return;
    var keepScroll = opts && opts.keepScroll, prevScroll = host.scrollTop;
    $all('details[data-reason-key]', host).forEach(function (details) {
      state.reasoningExpanded[details.dataset.reasonKey] = details.open;
    });
    host.innerHTML = state.messages.map(function (m, i) {
      var me = m.role === 'user';
      var name = me ? '我' : 'AI';
      var reasoningMode = String(m.reasoningMode || 'OFF').toUpperCase();
      var reasoningText = m.reasoningSummary || m.reasoning || '';
      var reasonKey = String(m._clientKey || m.id || m.requestId || ('assistant-' + i));
      var reason = (!me && reasoningMode !== 'OFF' && reasoningText)
        ? '<details class="zq-ai-reasoning" data-reason-key="' + esc(reasonKey) + '"' + (state.reasoningExpanded[reasonKey] ? ' open' : '') + '><summary>思考摘要</summary><span>' + esc(reasoningText) + '</span></details>'
        : '';
      // 流式中的内容换行完好且可能只收到半截,跳过压平回填,防止启发式误触
      var body = m.content ? renderMarkdown((me || m.status === 'STREAMING') ? m.content : reflowFlatMarkdown(m.content)) : (m.status === 'STREAMING' ? '<span style="color:var(--zq-text3);">正在生成…</span>' : '');
      return '<div data-msg-idx="' + i + '" style="display:flex;gap:10px;flex-direction:' + (me ? 'row-reverse' : 'row') + ';"><div style="width:30px;height:30px;flex:none;border-radius:50%;background:' + (me ? 'var(--zq-card-soft)' : 'var(--zq-primary)') + ';color:' + (me ? 'var(--zq-text2)' : 'var(--zq-on-primary)') + ';display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">' + name + '</div><div style="max-width:72%;padding:11px 14px;border-radius:var(--zq-rm);background:' + (me ? 'var(--zq-tint)' : 'var(--zq-card)') + ';border:1px solid ' + (me ? 'var(--zq-tint-strong)' : 'var(--zq-border-soft)') + ';font-size:13.5px;line-height:1.65;">' + reason + body + '</div></div>';
    }).join('');
    $all('details[data-reason-key]', host).forEach(function (details) {
      details.ontoggle = function () {
        state.reasoningExpanded[details.dataset.reasonKey] = details.open;
      };
    });
    // 右键删除消息:仅真实历史消息(有 id)可删;流式中的临时消息尚未入库,不弹菜单
    if (state.messages.length) $all('[data-msg-idx]', host).forEach(function (d) {
      d.oncontextmenu = function (e) {
        var m = state.messages[Number(d.dataset.msgIdx)];
        if (!m || !m.id) return;
        e.preventDefault();
        popMenu(e.clientX, e.clientY, [{
          label: '删除消息', danger: true,
          onClick: async function () {
            if (!await askConfirm({ title: '删除消息', message: '删除这条消息？删除后不可恢复。', okText: '删除', danger: true })) return;
            safe('删除消息', async function () {
              await api.del('/ai/messages/' + m.id);
              state.messages = state.messages.filter(function (x) { return x !== m; });
              toast('已删除');
              renderAiMessages({ keepScroll: true });
            });
          }
        }]);
      };
    });
    renderMathIn(host);
    // 删除消息等场景保持原滚动位置;其余(加载/流式)跟随到底部
    host.scrollTop = keepScroll ? prevScroll : host.scrollHeight;
  }
  async function loadAiNotebooks() {
    var list = await api.get('/ai/notebooks');
    state.notebooks = list || [];
    if (!state.notebooks.length) {
      state.notebookId = null;
      clearPendingSources();
      renderNotebooks();
      await loadAiSources();
      renderSteps([]);
      renderArtifacts([]);
      return;
    }
    var selectedStillExists = state.notebooks.some(function (item) { return Number(item.id) === Number(state.notebookId); });
    if (!selectedStillExists) state.notebookId = state.notebooks[0].id;
    renderNotebooks();
    await loadAiSources();
  }
  function renderCurrentNotebookLabel() {
    var label = $('#zq-current-notebook');
    if (!label) return;
    var current = (state.notebooks || []).find(function (item) {
      return Number(item.id) === Number(state.notebookId);
    });
    label.textContent = current ? '当前 Notebook：' + (current.title || '未命名') : '普通聊天（未选择 Notebook）';
  }
  // 右键浮出菜单（资料删除 / notebook 改名共用），点击别处自动关闭
  function popMenu(x, y, items) {
    var old = document.getElementById('zq-popmenu'); if (old) old.remove();
    var menu = document.createElement('div');
    menu.id = 'zq-popmenu';
    menu.style.cssText = 'position:fixed;z-index:9500;min-width:120px;padding:5px;background:var(--zq-card);border:1px solid var(--zq-border);border-radius:var(--zq-rm);box-shadow:0 12px 36px rgba(0,0,0,.2);';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.label;
      b.style.cssText = 'display:block;width:100%;padding:8px 12px;border:none;border-radius:var(--zq-rs);background:transparent;color:' + (it.danger ? 'var(--zq-bad)' : 'var(--zq-text)') + ';font-size:12.5px;text-align:left;cursor:pointer;';
      b.onmouseenter = function () { b.style.background = 'var(--zq-tint)'; };
      b.onmouseleave = function () { b.style.background = 'transparent'; };
      b.onclick = function () { menu.remove(); it.onClick(); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
    setTimeout(function () {
      document.addEventListener('mousedown', function once(e) {
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', once); }
      });
    }, 0);
  }
  function renameNotebook(nb) {
    askText({ title: '重命名 Notebook', label: '名称', value: nb.title || '' }).then(function (name) {
      if (!name || !name.trim() || name.trim() === nb.title) return;
      safe('重命名', async function () {
        await api.put('/ai/notebooks/' + nb.id, { title: name.trim() });
        toast('已重命名'); await loadAiNotebooks();
      });
    });
  }
  function renderNotebooks() {
    var host = $('#zq-notebooks'); if (!host) return;
    renderCurrentNotebookLabel();
    host.innerHTML = (state.notebooks || []).map(function (nb) {
      var active = nb.id === state.notebookId;
      return '<div data-notebook="' + nb.id + '" style="padding:9px 11px;border:1px solid ' + (active ? 'var(--zq-tint-strong)' : 'var(--zq-border-soft)') + ';border-radius:var(--zq-rs);background:' + (active ? 'var(--zq-tint)' : 'var(--zq-card)') + ';cursor:pointer;"><div data-nb-name="' + nb.id + '" title="' + (active ? '点击重命名' : '') + '" style="font-size:12.5px;font-weight:600;">' + esc(nb.title || 'Notebook') + '</div><div style="font-size:11px;color:var(--zq-text3);margin-top:2px;">' + esc(nb.sourceCount != null ? nb.sourceCount + ' 份资料' : '资料工作区') + '</div></div>';
    }).join('') || '<div class="zq-ai-empty-notebook"><strong>暂无 Notebook</strong><span>普通聊天仍可使用；上传资料前请先新建。</span></div>';
    $all('[data-notebook]', host).forEach(function (d) {
      var id = Number(d.dataset.notebook);
      var nb = (state.notebooks || []).find(function (x) { return x.id === id; });
      d.onclick = function (e) {
        // 已选中的 notebook 再点名字 → 改名；否则点击切换
        if (id === state.notebookId && e.target.closest('[data-nb-name]')) { renameNotebook(nb); return; }
        state.notebookId = id;
        clearPendingSources();
        state.messages = [];
        renderNotebooks();
        renderAiMessages();
        renderSteps([]);
        renderArtifacts([]);
        loadAiSources();
        renderAgentPanels();
        safe('加载聊天记录', loadAiMessages);
      };
      d.oncontextmenu = function (e) {
        e.preventDefault();
        popMenu(e.clientX, e.clientY, [
          { label: '重命名', onClick: function () { renameNotebook(nb); } },
          {
            label: '删除 Notebook', danger: true,
            onClick: async function () {
              if (!await askConfirm({ title: '删除 Notebook', message: '删除「' + (nb.title || 'Notebook') + '」？其中的聊天记录、上传资料与 URL 将一并删除，且不可恢复。', okText: '删除', danger: true })) return;
              safe('删除 Notebook', async function () {
                await api.del('/ai/notebooks/' + nb.id);
                // 删的是当前选中项时必须清掉,让 loadAiNotebooks 回落到剩余的第一个
                if (state.notebookId === nb.id) {
                  state.notebookId = null;
                  state.messages = [];
                  clearPendingSources();
                  renderAiMessages();
                  renderSteps([]);
                  renderArtifacts([]);
                }
                toast('已删除');
                await loadAiNotebooks();
                await loadAiMessages();
                await renderAgentPanels();
              });
            }
          }
        ]);
      };
    });
  }
  // 资料类型 → 文字标注 + 底色（固定色相，不随主题象限色漂移；整块铺满卡片）
  function srcTypeInfo(type) {
    var t = String(type || '').toUpperCase();
    var map = {
      PDF: ['PDF 文档', '#c2574f'],
      EXCEL: ['表格文件', '#3f8f63'],
      SHEET: ['表格文件', '#3f8f63'],
      TEXT: ['文本文件', '#3f6fae'],
      WEB_URL: ['网页链接', '#4a5fc1'],
      MANUAL_NOTE: ['手动笔记', '#b07d3c'],
      IMAGE: ['图片文件', '#7e5fb0']
    };
    return map[t] || [t || '资料', '#6b7280'];
  }
  function srcStatusLabel(s) {
    return ({
      READY: '已解析，可用于问答',
      PARSING: '正在解析，暂不可用',
      UPLOADED: '仅存档，暂未进入问答',
      ERROR: '解析失败，暂不可用'
    })[String(s || '').toUpperCase()] || (s || '');
  }
  function srcIndexStatusLabel(source) {
    if (String(source && source.status || '').toUpperCase() !== 'READY') return '';
    var status = String(source && source.indexStatus || 'NOT_INDEXED').toUpperCase();
    return ({
      PENDING: '语义索引中',
      INDEXED: '语义检索可用',
      ERROR: '索引失败，当前使用关键词检索',
      NOT_INDEXED: '当前使用关键词检索'
    })[status] || '当前使用关键词检索';
  }
  // 点击卡片下载：优先 showSaveFilePicker 让用户选保存位置，否则走浏览器默认下载
  async function downloadAiSource(sid, title) {
    var n = notice('正在准备下载「' + title + '」…');
    try {
      var headers = {}; if (token()) headers.Authorization = 'Bearer ' + token();
      var res = await fetch(API + '/ai/notebooks/' + state.notebookId + '/sources/' + sid + '/download', { headers: headers, credentials: 'same-origin' });
      // 附件优先：带 Content-Disposition: attachment 的都是正常文件（含 .json 原件）；
      // 只有"无附件头 + JSON"才是 GlobalExceptionHandler 包装的业务错误（HTTP 200）
      var cd = res.headers.get('Content-Disposition') || '';
      var isAttachment = /attachment/i.test(cd);
      var ct = res.headers.get('Content-Type') || '';
      if (!res.ok || (!isAttachment && ct.indexOf('application/json') >= 0)) {
        var j = null; try { j = await res.json(); } catch (e) {}
        throw new Error((j && j.message) || ('下载失败(' + res.status + ')'));
      }
      var blob = await res.blob();
      var m = cd.match(/filename\*=UTF-8''([^;]+)/i);
      var fname = m ? decodeURIComponent(m[1]) : (title || '资料');
      if (window.showSaveFilePicker) {
        try {
          var handle = await window.showSaveFilePicker({ suggestedName: fname });
          var writable = await handle.createWritable();
          await writable.write(blob); await writable.close();
          n.update('已保存：' + fname, { done: true });
          return;
        } catch (e2) {
          if (e2 && e2.name === 'AbortError') { n.close(); return; } // 用户取消选位置
          // 其他失败回退到浏览器默认下载
        }
      }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      n.update('已开始下载：' + fname, { done: true });
    } catch (e) {
      n.update('下载失败：' + (e.message || '未知错误'), { error: true });
    }
  }
  async function loadAiSources() {
    var host = $('#zq-sources'); if (!host) return;
    if (!state.notebookId) {
      host.innerHTML = '<div class="zq-ai-source-empty"><strong>尚未选择 Notebook</strong><span>新建 Notebook 后即可上传资料。</span></div>';
      return;
    }
    var nbId = state.notebookId;
    var list = await api.get('/ai/notebooks/' + nbId + '/sources');
    if (nbId !== state.notebookId) return; // 响应期间已切换 notebook,丢弃过期资料列表
    host.innerHTML = (list || []).length ? '<div class="zq-src-grid">' + list.map(function (s) {
      var info = srcTypeInfo(s.sourceType);
      var title = s.title || s.url || '资料';
      var status = String(s.status || '').toUpperCase();
      var indexText = srcIndexStatusLabel(s);
      var statusText = srcStatusLabel(status) + (status === 'ERROR' && s.parseError ? '：' + s.parseError : '')
        + (indexText ? ' · ' + indexText : '');
      return '<div class="zq-src-tile" data-source="' + s.id + '" data-source-title="' + esc(title) + '" data-source-url="' + esc(s.url || '') + '" style="--srcc:' + info[1] + ';" title="' + esc(statusText) + '">'
        + '<span class="zq-src-type">' + esc(info[0]) + '</span>'
        + '<span class="zq-src-dl">↓</span>'
        + '<div class="zq-src-glass">'
        + '<div class="zq-src-title">' + esc(title) + '</div>'
        + '<div class="zq-src-meta"><span style="width:6px;height:6px;border-radius:50%;flex:none;background:' + (status === 'READY' ? 'var(--zq-ok)' : status === 'ERROR' ? 'var(--zq-bad)' : 'var(--zq-text3)') + ';"></span><span>' + esc(srcStatusLabel(status)) + '</span></div>'
        + (indexText ? '<div class="zq-src-meta" style="margin-top:4px;"><span style="width:6px;height:6px;border-radius:50%;flex:none;background:' + (String(s.indexStatus || '').toUpperCase() === 'INDEXED' ? 'var(--zq-primary)' : String(s.indexStatus || '').toUpperCase() === 'ERROR' ? 'var(--zq-warn)' : 'var(--zq-text3)') + ';"></span><span>' + esc(indexText) + '</span></div>' : '')
        + '</div></div>';
    }).join('') + '</div>' : empty('暂无资料');
    $all('[data-source]', host).forEach(function (d) {
      var sid = d.dataset.source, sTitle = d.dataset.sourceTitle, sUrl = d.dataset.sourceUrl;
      d.onclick = function () { downloadAiSource(sid, sTitle); };
      d.oncontextmenu = function (e) {
        e.preventDefault();
        var items = [{ label: '下载到本地', onClick: function () { downloadAiSource(sid, sTitle); } }];
        // 仅放行 http/https，抓取失败留下的畸形 URL 不给打开入口
        if (sUrl && /^https?:\/\//i.test(sUrl)) items.push({ label: '打开原网址', onClick: function () { window.open(sUrl, '_blank', 'noopener'); } });
        items.push({
          label: '删除该资料', danger: true,
          onClick: async function () {
            if (!await askConfirm({ title: '删除资料', message: '删除「' + sTitle + '」？其解析内容将从 Notebook 中移除。', okText: '删除', danger: true })) return;
            safe('删除资料', async function () { await api.del('/ai/notebooks/' + state.notebookId + '/sources/' + sid); toast('已删除'); await loadAiNotebooks(); });
          }
        });
        popMenu(e.clientX, e.clientY, items);
      };
    });
  }
  async function streamAiChat(body, handlers) {
    var headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    var res = await fetch(API + '/ai/chat/stream', { method: 'POST', credentials: 'same-origin', headers: headers, body: JSON.stringify(body) });
    if (res.status === 401 || res.status === 403) { redirectToLogin(); throw new Error('未登录或无权限'); }
    if (!res.ok || !res.body) throw new Error('流式连接失败(' + res.status + ')');
    var reader = res.body.getReader(), decoder = new TextDecoder('utf-8'), buf = '';
    // 业务终止事件(done/error)送达后,个别容器/代理收尾时不发终止 chunk,读取器会报 network error;
    // 此时流在语义上已完整,按正常结束处理,不让收尾噪声打断发送方后续流程
    var terminalSeen = false;
    while (true) {
      var chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (terminalSeen) break;
        throw e;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      // SSE 帧边界:规范允许 LF/CRLF/CR 三种行尾,空行即帧结束
      var m;
      while ((m = /\r\n\r\n|\n\n|\r\r/.exec(buf))) {
        var frame = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
        var event = 'message', dataLines = [];
        frame.split(/\r\n|\n|\r/).forEach(function (l) {
          if (l.indexOf('event:') === 0) event = l.slice(6).trim();
          // SSE 规范:多条 data: 行以 \n 连接还原;只剥一个可选前导空格,不 trim(防止破坏换行/空白)
          else if (l.indexOf('data:') === 0) dataLines.push(l.slice(5).replace(/^ /, ''));
        });
        var dataStr = dataLines.join('\n');
        var data = {};
        if (dataStr) { try { data = JSON.parse(dataStr); } catch (e) { data = { text: dataStr }; } }
        handlers(event, data);
        if (event === 'done' || event === 'error') terminalSeen = true;
      }
    }
  }
  function upsertAgentStep(raw, done) {
    var step = raw.step || raw;
    var id = step.id || step.stepId || step.title || (state.agentSteps.length + 1);
    var existing = state.agentSteps.find(function (s) { return s._id === id; });
    if (existing) { existing.status = done ? 'DONE' : (step.status || existing.status); if (step.title) existing.title = step.title; }
    else state.agentSteps.push({ _id: id, title: step.title || step.name || step.stepType || ('步骤 ' + (state.agentSteps.length + 1)), status: done ? 'DONE' : (step.status || 'RUNNING') });
    renderSteps(state.agentSteps);
  }
  /** 单行时的高度，与同排按钮对齐；也是清空后要回到的高度。 */
  var DRAFT_BASE_HEIGHT = 32;
  /**
   * 输入框自适应高度。先置 auto 再读 scrollHeight —— 不置的话 scrollHeight 会被
   * 当前高度撑住，内容变少时收不回去。
   */
  function growDraft() {
    var el = $('#zq-draft');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(DRAFT_BASE_HEIGHT, Math.min(el.scrollHeight, 120)) + 'px';
  }
  async function sendAiMessage() {
    if (state.aiSending) return; // 发送中保护:双击/回车连发只算一次
    var inp = $('#zq-draft'), txt = inp && inp.value.trim();
    if (!txt) return;
    inp.value = '';
    inp.style.height = DRAFT_BASE_HEIGHT + 'px'; // 收回单行，否则清空后仍撑着上一条的高度
    state.aiSending = true;
    var sendButton = $('#zq-send');
    if (sendButton) { sendButton.disabled = true; sendButton.textContent = '生成中'; }
    var reasoningMode = ($('#zq-think') && $('#zq-think').dataset.on === '1') ? 'DEEP' : 'OFF';
    var selectedSourceIds = state.pendingSources
      .filter(function (source) { return String(source.status || '').toUpperCase() === 'READY'; })
      .map(function (source) { return Number(source.id); });
    var clientKey = 'stream-' + Date.now();
    var assistant = {
      role: 'assistant',
      content: '',
      reasoningSummary: '',
      reasoningMode: reasoningMode,
      status: 'STREAMING',
      _clientKey: clientKey
    };
    state.messages.push({ role: 'user', content: txt, _clientKey: clientKey + '-user' }, assistant);
    renderAiMessages();
    state.agentSteps = []; state.agentArtifacts = [];
    renderSteps([]); renderArtifacts([]);
    var modelSel = $('#zq-model');
    var body = {
      message: txt,
      modelConfigId: modelSel && modelSel.value ? Number(modelSel.value) : null,
      enableWebSearch: !!($('#zq-web') && $('#zq-web').dataset.on === '1'),
      reasoningMode: reasoningMode,
      notebookId: state.notebookId || null,
      agentMode: 'AUTO',
      contextOptions: {
        includeWiki: true,
        selectedSourceIds: selectedSourceIds
      }
    };
    // SSE 回调期间用户可能切换 notebook:快照发送时的 id,不再渲染/改写新窗口的全局流式状态
    var sentNb = state.notebookId;
    var sameNb = function () { return sentNb === state.notebookId; };
    // 后端 done 事件带 dropped/CANCELED:notebook 在流式期间被删除(可能来自其他标签页/API),
    // 本轮问答未入库——不能把已收到的回答当成功结果留在页面上
    var dropped = false;
    var completed = false;
    // 本轮以 SSE error 收场。注意它与 catch(e) 那条路不同：error 事件是**流正常结束**，
    // 不抛异常，所以下面的收尾照跑 —— 这正是错误文案被冲掉的原因，见末尾。
    var failed = false;
    try {
      await safe('AI 发送', async function () {
      try {
        await streamAiChat(body, function (event, data) {
          if (event === 'message.delta') { assistant.content += (data.text || data.delta || data.content || ''); if (sameNb()) renderAiMessages(); }
          else if (event === 'reasoning.delta' && reasoningMode !== 'OFF') {
            assistant.reasoningSummary += (data.text || data.delta || '');
            if (sameNb()) renderAiMessages();
          }
          else if (event === 'agent.step.start') { if (sameNb()) upsertAgentStep(data, false); }
          else if (event === 'agent.step.done') { if (sameNb()) upsertAgentStep(data, true); }
          else if (event === 'artifact.created') {
            if (sameNb()) {
              var incoming = normalizeArtifact(data);
              var existingIndex = state.agentArtifacts.findIndex(function (item) {
                return Number(normalizeArtifact(item).id) === Number(incoming.id);
              });
              if (existingIndex >= 0) state.agentArtifacts[existingIndex] = incoming;
              else state.agentArtifacts.push(incoming);
              renderArtifacts(state.agentArtifacts);
            }
          }
          else if (event === 'done') {
            if (data && (data.dropped || data.status === 'CANCELED')) {
              dropped = true;
              assistant.status = '';
              toast(data.message || 'Notebook 已删除，本轮回答未保存', 'error');
            } else {
              if (data && data.content && !assistant.content) assistant.content = data.content;
              if (reasoningMode !== 'OFF' && data && data.reasoningSummary) {
                assistant.reasoningSummary = data.reasoningSummary;
              }
              if (data && data.assistantMessageId) assistant.id = data.assistantMessageId;
              if (data && data.requestId) assistant.requestId = data.requestId;
              assistant.status = '';
              completed = true;
              if (sameNb()) renderAiMessages();
            }
          }
          else if (event === 'error') {
            failed = true;
            assistant.status = '';
            assistant.content = assistant.content || ('（出错：' + (data.message || '未知错误') + '）');
            if (sameNb()) renderAiMessages();
          }
        });
      } catch (e) {
        assistant.status = ''; if (!assistant.content) assistant.content = '（连接中断，可稍后刷新查看）'; renderAiMessages();
        throw e;
      }
      if (dropped) {
        // 当前会话若还挂在已删 notebook 上,回落到默认选择(与右键删除 notebook 的刷新流程一致);
        // 重新拉列表+消息会自然清掉未保存的临时问答
        if (sameNb()) state.notebookId = null;
        await loadAiNotebooks();
        await loadAiMessages();
        await renderAgentPanels();
        return;
      }
      assistant.status = '';
      if (completed && sameNb()) clearUsedPendingSources(selectedSourceIds);
      renderAiMessages();
      // 出错时**不能**重新拉取。streamChatInternal 的四道前置检查（requireModel / 空消息 /
      // 深度思考支持 / 联网搜索可用）全部跑在落库之前，任一道抛 BusinessException 就是
      // 一条也没入库；而 /ai/messages 找不到会话会返回空列表，
      // state.messages = list || [] 会把本地这两条连同上面那句错误原因一起清空。
      // 用户看到的就是「闪一下两条，然后什么都没有」—— 而唯一说明"为什么不行"的那句话，
      // 恰好被这一步删掉了，于是他连去查什么都不知道。
      // 实测（未修时，全新用户无模型配置）：SSE 返回
      //   {"message":"请先在个人中心配置可用的 AI 模型","nonRetryable":true}
      // 随后 /ai/messages 返回 []，页面消息节点归零。
      if (!failed) await loadAiMessages();
      await renderAgentPanels();
      });
    } finally {
      state.aiSending = false;
      if (sendButton) { sendButton.disabled = false; sendButton.textContent = '发送'; }
    }
  }

  function revealContent() { try { document.documentElement.classList.remove('zq-booting'); } catch (e) {} }
  var DENIED_FLAG = 'zq.deniedAdminPage';
  /**
   * 落地后补一句「为什么被送回来」。
   *
   * <p>不能在跳转前直接 toast：toast 是 2.6 秒后自删的 DOM 节点，而 location.replace 一走
   * 它就随旧文档消失，用户看到的仍是一次无声跳转 —— 而这一步治的恰恰是观感。
   * 所以用 sessionStorage 传一次性标记，落地页取走并清掉。
   *
   * <p>toast 是 position:fixed 挂 body 的，而 zq-booting 只压 .zq-main
   * （zhiqu-ui.css:615），所以它在首屏遮罩期间照样可见，不必等 revealContent。
   */
  function flushDeniedNotice() {
    var denied;
    // catch 只圈住存储访问（隐私模式下 sessionStorage 会抛），**不圈 toast** ——
    // 圈进去的话，toast 一旦出错就是「标记已被删掉 + 异常被吞 + 用户什么都没看到」，
    // 而这一步存在的全部意义就是别让用户面对一次无声的跳转。
    try {
      denied = sessionStorage.getItem(DENIED_FLAG);
      if (denied) sessionStorage.removeItem(DENIED_FLAG);
    } catch (e) { return; }
    if (denied) toast('无权访问该页面，已返回看板', 'error');
  }
  function currentUserIsAdmin() {
    return String((state.user && state.user.role) || '').toUpperCase() === 'ADMIN';
  }
  function route() {
    maintainShellCache();
    flushDeniedNotice();
    safe('初始化', async function () {
      // 跳转已经发起时不要揭示内容：location.replace 不中断 JS，下面的 finally 照样会跑，
      // 摘掉 zq-booting 会让后台骨架淡入 180ms（zhiqu-ui.css:616 的过渡）才被导航打断。
      var leaving = false;
      try {
        if (page === 'index.html' || $('#form-login')) { revealContent(); return bootIndex(); }
        await initAuth();

        // 非管理员直达后台页 → 劝返。**这一步不改变安全边界**：后端 AdminController 的
        // 29 个端点每个都 requireAdmin()、回库查 sys_user.role，本来就顶得住。
        // 它治的是观感 —— 此前普通用户敲 URL 或从历史记录进来，会拿到完整的后台外壳
        // 再吃一串 403 toast，看上去像「坏了」而不是像「在保护」。
        //
        // 位置是承重的，两边都挪不得：
        //   往前挪到 initAuth 之前 → 只剩本地存储里那个可绕过的角色可用；
        //   往后挪到 boots 之后   → 后台数据请求已经发出去了。
        // 插在这里时服务端角色已在手，而 zq-booting 要到下面 finally 才摘，
        // 所以跳转发生时 .zq-main 仍是 opacity:0，没有闪烁可言。
        //
        // 页面集合问 ZQUI.isAdminPage()，它从 NAV.admin 派生 —— 不在这里抄第二份文件名。
        if (window.ZQUI && window.ZQUI.isAdminPage && window.ZQUI.isAdminPage(page) && !currentUserIsAdmin()) {
          leaving = true;
          try { sessionStorage.setItem(DENIED_FLAG, '1'); } catch (e) {}
          // replace 而不是 href：不留历史条目，否则用户按「后退」会再弹回来一次。
          location.replace('dashboard.html');
          return;
        }

        var boots = { 'dashboard.html': bootDashboard, 'tasks.html': bootTasks, 'routines.html': bootRoutines, 'statistics.html': bootStatistics, 'achievement.html': bootAchievement, 'profile.html': bootProfile, 'admin.html': bootAdmin, 'feedback-admin.html': bootFeedbackAdmin, 'account-admin.html': bootAccountAdmin, 'shared-plans.html': bootSharedPlans, 'shared-plan-admin.html': bootSharedPlanAdmin, 'knowledge-wiki.html': bootKnowledge, 'ai-assistant.html': bootAiAssistant };
        if (boots[page]) await boots[page]();
      } finally {
        // 卡死不了：zhiqu-ui.js:31 那个 2.5s 无条件兜底仍会摘遮罩，
        // 所以万一导航没成行，页面也不会永远停在空白。
        if (!leaving) revealContent();
      }
    }, { renderError: true });
  }

  window.zqApi = { api: api, reload: route };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', route); else route();
})();
