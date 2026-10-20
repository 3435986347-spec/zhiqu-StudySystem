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
    reasoningExpanded: Object.create(null),
    // 聊天区是否「跟随到底部」。只有用户本来就在底部时才跟随 ——
    // 他往上翻着读的时候把他拽回来，是这次要修的那个毛病。
    chatFollow: true,
    streamPollTimer: null,
    // 拿满一页就说明可能还有更早的。点「加载更早」若返回空，就翻到头了。
    chatHasMore: false,
    chatLoadingMore: false,
    // 知识 Wiki 的标签页。每个标签有自己的浏览历史（和 Obsidian、和浏览器标签一样）——
    // 共享一份历史的话，在 A 标签里翻了几页再切到 B 点返回，会跳到 A 的历史里去。
    // 形状：[{ id, title, back: [id...], fwd: [id...] }]，id 为 null 表示空标签。
    wikiTabs: [],
    wikiTabIdx: -1
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  /** 图标（zhiqu-ui.js 的 ICONS，第四十二轮）：给 SVG 字符串；zhiqu-ui.js 没加载时给空串 */
  function icon(name) { return window.ZQUI && window.ZQUI.icon ? window.ZQUI.icon(name) : ''; }
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
      if (token() !== data.token) revokePrivateMedia();
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
    revokePrivateMedia();
    sessionStorage.removeItem('token'); sessionStorage.removeItem('role');
    localStorage.removeItem('token'); localStorage.removeItem('role');
  }
  // ── 同一个浏览器会话里的标签页共享登录（第二十五轮，用户 2026-10-03 定）────────────────
  // 没勾「记住登录状态」时令牌只在 sessionStorage 里，按标签页隔离：新开一个标签页就要重新登录（第二十三轮走主流程撞到）。
  // 现在新标签页没有令牌时，先问同一个浏览器里开着的其它标签页要（BroadcastChannel 只在同源之间通）；
  // 关掉最后一个标签页，sessionStorage 跟着没了 —— 「不记住」的意思仍然成立。「记住」照旧走 localStorage、管跨重启。
  // 退出、改密码换了令牌也告诉别的标签页：退出了别的页不该还登着，改了密码旧令牌已经作废。
  // 只动和自己手里同一张令牌的那些页（同一个浏览器里两个标签页登的可能是两个人）。行为判据：auth-share-check.js 两个「标签页」真的互相问。
  var authChannel = null;
  try { authChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('zq-auth') : null; } catch (e) { authChannel = null; }
  if (authChannel) {
    authChannel.onmessage = function (e) {
      var m = e.data || {}, mine = sessionStorage.getItem('token');
      if (m.type === 'ask' && mine) {
        authChannel.postMessage({ type: 'token', nonce: m.nonce, token: mine, role: sessionStorage.getItem('role') || 'USER' });
      } else if (m.type === 'logout' && mine && mine === m.token) {
        revokePrivateMedia();
        sessionStorage.removeItem('token'); sessionStorage.removeItem('role');
        if (page !== 'index.html') location.replace('index.html');
      } else if (m.type === 'refresh' && mine && mine === m.old && m.token) {
        revokePrivateMedia();
        sessionStorage.setItem('token', m.token);
      }
    };
  }
  /** 这一页没有令牌：问其它标签页要，最多等 400 毫秒（没人应就照旧去登录）。拿到了返回 true。 */
  function borrowToken() {
    return new Promise(function (resolve) {
      if (!authChannel || token()) { resolve(false); return; }
      var nonce = Math.random().toString(36).slice(2), done = false;
      function finish(ok) { if (done) return; done = true; clearTimeout(timer); authChannel.removeEventListener('message', onReply); resolve(ok); }
      function onReply(e) {
        var m = e.data || {};
        if (m.type !== 'token' || m.nonce !== nonce || !m.token) return;
        sessionStorage.setItem('token', m.token);
        sessionStorage.setItem('role', m.role || 'USER');
        finish(true);
      }
      var timer = setTimeout(function () { finish(false); }, 400);
      authChannel.addEventListener('message', onReply);
      authChannel.postMessage({ type: 'ask', nonce: nonce });
    });
  }
  function announceLogout(oldToken) { if (authChannel && oldToken) authChannel.postMessage({ type: 'logout', token: oldToken }); }
  function announceNewToken(oldToken, fresh) { if (authChannel && oldToken && fresh) authChannel.postMessage({ type: 'refresh', old: oldToken, token: fresh }); }
  // ── 共享登录到此 ──────────────────────────────────────────────────────────────

  // ── 页面里的提醒（第二十五轮，用户 2026-10-03 定「做」）────────────────────────────
  // 页面开着时：番茄钟到点、任务的提醒时间 / 截止前提醒到点，响一声、弹浏览器通知（授权过的话）、页面里再提示一句。
  // 第三方推送（PushPlus / 企业微信 / QQ）管离开电脑的时候，两条路互不依赖 —— 没配渠道时页面里照样提醒。
  // 通知权限只在用户自己点了东西时请求（开始番茄钟、保存带提醒的任务）：浏览器不许无故弹授权框，无缘无故弹的也只会被点「拒绝」。
  // 拒绝了就只剩响一声、标签页标题和页面内提示，不再问。
  // 桌面应用（WKWebView）里网页的 Notification 授权一请求就是「拒绝」（实测）—— 外壳给了一座桥，走 macOS 原生通知（PageView.swift）
  function desktopBridge() {
    try { return window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.zqNotify || null; } catch (e) { return null; }
  }
  /** 迷你番茄钟的桥（第五十一轮）：桌面应用的外壳给的，浏览器里没有 —— 看板上的「缩小到桌面」只在有它时出现，胶囊上的「展开」有它就交给外壳 */
  function miniBridge() {
    try { return window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.zqMini || null; } catch (e) { return null; }
  }
  function askNotifyPermission() {
    var bridge = desktopBridge();
    if (bridge) { try { bridge.postMessage({ action: 'authorize' }); } catch (e) {} return; }
    try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
  }
  var chimeCtx = null;
  function chime() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      chimeCtx = chimeCtx || new AC();
      [0, 0.22].forEach(function (at, i) {
        var o = chimeCtx.createOscillator(), g = chimeCtx.createGain(), t = chimeCtx.currentTime + at;
        o.frequency.value = i ? 1046.5 : 784; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        o.connect(g); g.connect(chimeCtx.destination); o.start(t); o.stop(t + 0.55);
      });
    } catch (e) {}
  }
  function pageNotify(title, body, tag) {
    chime();
    var bridge = desktopBridge();
    try {
      if (bridge) bridge.postMessage({ action: 'notify', title: title, body: body, tag: tag || title });
      else if (window.Notification && Notification.permission === 'granted') new Notification(title, { body: body, tag: tag || title, icon: 'assets/icons/icon-192.png' });
    } catch (e) {}
    toast(title + '：' + body);
  }
  /**
   * 该提醒的有哪些（纯函数，reminder-notify-check.js 直接跑它）：时间到了、过去不到 15 分钟（刚打开页面也补一次，太久的就不翻旧账了）、
   * 这台浏览器还没提醒过（seen：id → 提醒的时刻，几个标签页、刷新都共用一份）。
   */
  var REMIND_LATE_MS = 15 * 60000;
  function dueReminders(list, now, seen) {
    return (list || []).filter(function (r) {
      var at = serverTime(r.scheduledAt);
      return r && r.id != null && !isNaN(at) && at <= now && now - at < REMIND_LATE_MS && !(seen && seen[r.id]);
    });
  }
  function reminderText(r) {
    return String(r.title || '任务') + (r.type === 'AUTO' && r.deadline ? '（截止 ' + fmtDate(r.deadline) + '）' : '');
  }
  var upcomingReminders = [], reminderWatched = false;
  function seenKey() { return 'zq.reminded.' + ((state.user && state.user.id) || 'anon'); }
  function readSeen() { try { return JSON.parse(localStorage.getItem(seenKey()) || '{}') || {}; } catch (e) { return {}; } }
  function writeSeen(seen) {
    var cutoff = nowMs() - 2 * 86400000, kept = {};
    Object.keys(seen).forEach(function (k) { if (seen[k] > cutoff) kept[k] = seen[k]; });
    try { localStorage.setItem(seenKey(), JSON.stringify(kept)); } catch (e) {}
  }
  async function refreshUpcomingReminders() {
    try { upcomingReminders = (await api.get('/reminder/upcoming')) || []; } catch (e) { /* 拿不到就等下一次 */ }
  }
  /**
   * 几个标签页同时到点：「读已提醒 → 记下 → 提醒」这一串用浏览器的锁排队（第四十七轮 review：两个标签页的 30 秒刚好对上时，
   * 两边都读到「没提醒过」，响两遍、弹两个通知）。没有 Web Locks 的浏览器照旧直接做（最多偶尔响两遍）。
   */
  function checkDueReminders() {
    var locks = null;
    try { locks = navigator.locks && navigator.locks.request ? navigator.locks : null; } catch (e) { locks = null; }
    // 锁里那一趟出的错落在 request 返回的 promise 上：接住就好，不要再直接做一遍（那就成了提醒两次）
    if (locks) { locks.request('zq-reminder-check', checkDueRemindersNow).catch(function () {}); return; }
    checkDueRemindersNow();
  }
  function checkDueRemindersNow() {
    var seen = readSeen(), now = nowMs();
    var due = dueReminders(upcomingReminders, now, seen);
    if (!due.length) return;
    due.forEach(function (r) { seen[r.id] = now; });
    writeSeen(seen);   // 先记下再提醒：另一个标签页这时候读到的就是「已提醒」
    due.forEach(function (r) { pageNotify('任务提醒', reminderText(r), 'zq-reminder-' + r.id); });
  }
  function watchReminders() {
    if (reminderWatched) return; reminderWatched = true;
    refreshUpcomingReminders().then(checkDueReminders);
    setInterval(function () { refreshUpcomingReminders().then(checkDueReminders); }, 10 * 60000);
    setInterval(checkDueReminders, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshUpcomingReminders().then(checkDueReminders); });
  }
  // ── 页面里的提醒到此 ──────────────────────────────────────────────────────────

  var redirecting = false;
  function redirectToLogin() {
    if (redirecting) return;
    clearAuth();
    // 迷你番茄钟（第五十轮）：一个胶囊里塞不下登录页，也不该自己换成登录页 —— 写一句「在主窗口登录后再用」（mini.html 里那一行，样式表按这个类亮出来）
    if (page === 'mini.html') { redirecting = true; document.documentElement.classList.add('zq-signed-out'); return; }
    // 带上原来那一页：登录之后回到这里（第十五轮：原来一律回看板，在哪一页、打了什么都没了 —— 打的字由草稿接住，见 drafts）
    // 地址里的弹窗也带上（第三十轮）：命令行打印的 #settings/cli?harness=… 在没登录的浏览器里打开，登录完要回到那个确认框
    if (page !== 'index.html') { redirecting = true; location.replace('index.html?login=1&next=' + encodeURIComponent(page + location.search + (isDialogHash(location.hash) ? location.hash : ''))); }
  }
  /** 登录之后的首页（第二十六轮：定位改成 AI 办公助手，AI 助手放第一位；原来是看板）。 */
  var HOME_PAGE = 'ai-assistant.html';
  /**
   * 登录之后去哪：只认本站的「xxx.html」加查询串 —— 不是本站的（//别处、https:、javascript:、../）一律回首页，
   * 否则 index.html?login=1&next=https://钓鱼站 就是一个开放跳转。后面可以跟设置 / 成就弹窗的地址（只认那几种写法）。
   */
  function safeNext(raw) {
    var next = String(raw || '');
    if (/^[a-z0-9_-]+\.html(\?[^#\s\\]*)?(#settings(\/[a-z]+)?(\?harness=[A-Za-z0-9-]{8,9})?|#achievements)?$/i.test(next) && !/^index\.html/i.test(next) && next.indexOf('//') < 0) return next;
    return HOME_PAGE;
  }
  function isAuthFailure(json) {
    if (!json) return false;
    if (json.code === 401 || json.code === 403) return true;
    return /未登录|登录状态|登录已过期|请先登录|无权限/.test(json.message || '');
  }
  // ── 请求：超时、只在安全时重试、看不懂的响应要说人话 ────────────────────
  //
  // 原来 fetch 没有超时：服务器挂住时页面永远转圈。没有重试：一个 429（限流 180/60s，开几个标签页就可能撞上）
  // 落在页面启动时，renderInitError 会把整块主区域换成错误页。代理回的是 HTML 错误页（502）时，
  // JSON.parse 抛出「Unexpected token <」—— 用户看到的是一句看不懂的话。
  //
  // 重试只在安全的时候：GET 遇到断网 / 超时 / 502 / 503 / 504 / 429 重来两次。写操作带着幂等键（见下面的 request）：
  // 同一个键服务器只做一次、再来拿回上次的结果，所以断网、超时、502 也能用同一个键重来；「上一次还在处理」（409）等一下再来。
  // 不带键的写（上传、登录注册）只在 429 时重来 —— 429 是限流过滤器在进业务之前拒的，肯定没处理；别的可能已经生效了，重来会写两遍。
  // 行为判据：src/test/resources/js/request-check.js（直接跑这里发布的实现）。
  var REQUEST_TIMEOUT_MS = 30000;
  var UPLOAD_TIMEOUT_MS = 180000;
  var RETRY_WAITS_MS = [700, 2000];
  var RETRYABLE_STATUS = [429, 502, 503, 504];
  // 请求层抛出的错误都带 userFacing：它的 message 是写给用户看的（「网络连接失败…」、服务器回的业务提示），
  // 没接住时 reportUnhandled 可以原样说出来；别的错误（代码里的 TypeError）不是
  function requestError(message, extra) {
    var e = new Error(message);
    e.userFacing = true;
    Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  function waitMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function requestOnce(path, options, timeoutMs) {
    var headers = Object.assign({}, options && options.headers || {});
    if (token()) headers.Authorization = 'Bearer ' + token();
    if (options && options.body != null && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
    var res, text;
    try {
      res = await fetch(API + path, Object.assign({ credentials: 'same-origin' }, options || {}, { headers: headers, signal: ctrl ? ctrl.signal : undefined }));
      text = await res.text();
    } catch (e) {
      var timedOut = !!(ctrl && ctrl.signal.aborted);
      throw requestError(timedOut
        ? '服务器 ' + Math.round(timeoutMs / 1000) + ' 秒没有回应，请稍后再试'
        : '网络连接失败，请检查网络后重试', { retryable: true, network: true,
        why: timedOut ? '服务器 ' + Math.round(timeoutMs / 1000) + ' 秒没有回应' : '网络连接断了' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      redirectToLogin();
      throw requestError('未登录或无权限', { auth: true });
    }
    if (RETRYABLE_STATUS.indexOf(res.status) >= 0) {
      throw requestError(res.status === 429 ? '请求过于频繁，请稍后再试' : '服务器暂时不可用（HTTP ' + res.status + '），请稍后再试',
        { retryable: true, status: res.status, why: '服务器暂时不可用（HTTP ' + res.status + '）' });
    }
    var json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (e) {
      throw requestError('服务器返回了看不懂的内容（HTTP ' + res.status + '），请稍后再试', { status: res.status });
    }
    if (json.code === 409) {
      // 同一个幂等键的上一次还在处理（IdempotencyService）：不是失败，等一下用同一个键再来
      throw requestError(json.message || '上一次提交还在处理，请稍后再试', { retryable: true, inProgress: true });
    }
    if (json.code !== 200) {
      var authFailed = isAuthFailure(json);
      if (authFailed) redirectToLogin();
      throw requestError(json.message || '请求失败', authFailed ? { auth: true } : null);
    }
    return json.data;
  }
  // 同一个写请求（方法、地址、内容、请求头都一样）还没回来时又发一次：不再发，两边拿同一个结果。
  // 双击「创建」、连按回车、等得不耐烦又点，原来各建一份 —— 服务器没法替它去重，两次都是合法的新建
  //（第十四轮真浏览器实测：双击「创建例行计划」建出两个）。回来之后再点就是新的一次，照常发。
  // GET 不走这里（本来就能重来）；上传的内容没法比，也不走。
  //
  // 回应丢在路上（第二十二轮）：服务器已经做完了，回应断了。原来页面说「网络连接失败，请检查网络后重试」，学生照着再点 ——
  // 例行计划、Notebook、Wiki 页、反馈、番茄钟、任务全是两份，删除的第二下说「任务不存在」（真浏览器里掐掉回应实测）。
  // 现在每个写请求带一个幂等键，服务器同一个键只做一次（IdempotentWriteAspect）：回应丢了就用同一个键自动重来；
  // 重来也不行，就照实说「不确定有没有保存上 —— 再点一次不会重复保存」，并把键留着 —— 内容一模一样的下一次（照着提示再点）
  // 还用它，做过了服务器就把上次的结果交回来。键留 10 分钟（服务器存结果 15 分钟，比这长 —— 放弃之前自动重来的那几轮也算在里面）；这期间同一块数据（地址第一段相同）
  // 有别的写成功了就作废：打卡没弄清 → 撤销打卡 → 再打卡，再打卡是新的一次，拿旧键只会拿回旧结果、什么都没做。
  // 宁可偶尔多一份（看得见、删得掉），不能说做了其实没做。
  // 调用方自己带了键的（套用参考计划）照它的来；/auth/ 下的（登录注册，没有登录的用户，服务器不认键）不带、不重来。
  // 慢网下点了保存，回应要几秒才回来：原来这几秒里页面上什么都不变（第二十二轮 3 秒延迟实测：按钮、页面都看不出在保存），
  // 学生以为没点上又点。现在写请求 0.6 秒还没回来，页面顶上说「正在保存…」；刚点的那个按钮标成忙（aria-busy：变淡、光标转圈）。
  // 按钮不禁用：禁用由各处自己管（套用参考计划、发送），这里一碰就可能和它们打架；再点也不会写两遍（上面说的幂等键）。
  var SAVING_DELAY_MS = 600;
  var writesInFlight = 0, savingTimer = null, lastClick = null;
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button') : null;
      lastClick = b ? { el: b, at: Date.now() } : null;
    }, true);
  }
  /** 一个写请求开始了；返回「它结束了」要调的函数（调几次都只算一次）。 */
  function writeStarted(method) {
    if (typeof document === 'undefined' || !document.getElementById) return function () {};
    writesInFlight++;
    var btn = lastClick && Date.now() - lastClick.at < 1000 ? lastClick.el : null;
    if (btn) btn.setAttribute('aria-busy', 'true');
    if (!savingTimer) savingTimer = setTimeout(function () { savingTimer = null; if (writesInFlight > 0) showSaving(method); }, SAVING_DELAY_MS);
    var ended = false;
    return function () {
      if (ended) return;
      ended = true;
      writesInFlight = Math.max(0, writesInFlight - 1);
      if (btn) btn.removeAttribute('aria-busy');
      if (!writesInFlight) {
        if (savingTimer) { clearTimeout(savingTimer); savingTimer = null; }
        var el = document.getElementById('zq-saving');
        if (el) el.hidden = true;
      }
    };
  }
  function showSaving(method) {
    var el = document.getElementById('zq-saving');
    if (!el) {
      el = document.createElement('div');
      el.id = 'zq-saving';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = method === 'DELETE' ? '正在删除…' : '正在保存…';
    el.hidden = false;
  }
  var inflightWrites = {};
  var uncertainWrites = {};
  var UNCERTAIN_KEY_MS = 10 * 60 * 1000;
  function writeKey() {
    return 'ui-' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
  }
  function writeArea(path) { return String(path).split(/[/?]/)[1] || ''; }
  // 服务器不替它们去重的写：/auth/ 下的（没有登录的用户）、改密码（回应里带 Cookie）—— 见 IdempotentWriteAspect.covers 与
  // IdempotentWriteIntegrationTest.不接的只有这些。它们不带键、断网 / 超时 / 502 不自动重来：改密码第一下已经生效、回应丢了的话，
  // 重来那一下拿的是已经作废的旧令牌（被踢回登录页）或者旧密码对不上（说「原密码错误」），而页面还说着「再点一次不会重复保存」。
  // 那张清单里多了一个页面会调的写接口，这里也要跟着加。
  var UNKEYED_WRITE = /^\/auth\/|^\/user\/password(?:[?#]|$)/;
  function request(path, options) {
    var method = String((options && options.method) || 'GET').toUpperCase();
    var upload = !!(options && typeof FormData !== 'undefined' && options.body instanceof FormData);
    if (method === 'GET') return requestWithRetry(path, options, method, upload, false);
    if (upload) {
      // ZIP 确认导入持有同一个幂等键：回应丢失时只重放结果，不再导入第二份。
      var uploaded = requestWithRetry(path, options, method, upload,
        !!(options.headers && options.headers['Idempotency-Key']));
      var endUpload = writeStarted(method);
      uploaded.then(endUpload, endUpload);
      return uploaded;
    }
    var sig = method + ' ' + path + '\n' + (options.body == null ? '' : options.body) + '\n' + JSON.stringify(options.headers || {});
    if (inflightWrites[sig]) return inflightWrites[sig];
    var headers = Object.assign({}, options.headers || {});
    var ownKey = !headers['Idempotency-Key'] && !UNKEYED_WRITE.test(path);
    if (ownKey) {
      var kept = uncertainWrites[sig];
      headers['Idempotency-Key'] = kept && Date.now() - kept.at < UNCERTAIN_KEY_MS ? kept.key : writeKey();
    }
    var area = writeArea(path);
    var pending = requestWithRetry(path, Object.assign({}, options, { headers: headers }), method, false, !!headers['Idempotency-Key'])
      .then(function (data) {
        Object.keys(uncertainWrites).forEach(function (s) { if (uncertainWrites[s].area === area) delete uncertainWrites[s]; });
        return data;
      }, function (e) {
        if (ownKey) {
          if (e.uncertain) uncertainWrites[sig] = { key: headers['Idempotency-Key'], at: Date.now(), area: area };
          else delete uncertainWrites[sig];
        }
        throw e;
      });
    inflightWrites[sig] = pending;
    var ended = writeStarted(method);
    var settle = function () { ended(); if (inflightWrites[sig] === pending) delete inflightWrites[sig]; };
    pending.then(settle, settle);
    return pending;
  }
  async function requestWithRetry(path, options, method, upload, keyed) {
    var timeoutMs = upload ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    // 有没有哪一下可能已经到了服务器、做了（断网、超时、502…、还在处理）—— 429 不算。要看每一下，不只看最后一下：
    // 第一下超时（其实做了）、最后一下 429，原来就按「确定没做」把键扔了，学生再点拿新键，又做一遍
    var maybeDone = false;
    for (var attempt = 0; ; attempt++) {
      try {
        return await requestOnce(path, options, timeoutMs);
      } catch (e) {
        if (e.retryable && e.status !== 429) maybeDone = true;
        var safe = e.retryable && (method === 'GET' || keyed || e.status === 429);
        if (!safe || attempt >= RETRY_WAITS_MS.length) throw keyed ? uncertain(e, method, maybeDone) : e;
        await waitMs(RETRY_WAITS_MS[attempt]);
      }
    }
  }
  async function download(path) {
    if (!/^\/[a-z0-9/_?=&%.-]+$/i.test(path) || path.startsWith('//')) throw requestError('下载地址无效');
    for (var attempt = 0; ; attempt++) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
      try {
        var headers = {};
        if (token()) headers.Authorization = 'Bearer ' + token();
        var res = await fetch(API + path, { method: 'GET', credentials: 'same-origin', headers: headers,
          signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' });
        if (res.status === 401 || res.status === 403) { redirectToLogin(); throw requestError('未登录或无权限', { auth: true }); }
        if (RETRYABLE_STATUS.indexOf(res.status) >= 0) throw requestError('下载暂时不可用（HTTP ' + res.status + '）', { retryable: true, status: res.status });
        var type = res.headers.get('Content-Type') || '';
        if (!res.ok || /application\/json/i.test(type)) {
          var error = null;
          try { error = await res.json(); } catch (ignored) {}
          throw requestError((error && error.message) || '下载失败（HTTP ' + res.status + '）');
        }
        var disposition = res.headers.get('Content-Disposition') || '';
        var encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        var plain = disposition.match(/filename="?([^";]+)"?/i);
        var filename = plain ? plain[1] : '';
        // A malformed optional filename must not turn an already successful body into a retry.
        if (encoded) { try { filename = decodeURIComponent(encoded[1]); } catch (ignored) {} }
        filename = filename.replace(/[\\/\r\n]/g, '-');
        return { blob: await res.blob(), filename: filename };
      } catch (e) {
        if (e.userFacing && !e.retryable) throw e;
        if (attempt >= RETRY_WAITS_MS.length) throw e.userFacing ? e : requestError('网络连接失败，请稍后再试');
        await waitMs(RETRY_WAITS_MS[attempt]);
      } finally { if (timer) clearTimeout(timer); }
    }
  }
  /**
   * 带键的写，重来几次都没拿到回应：服务器可能做了、也可能没做 —— 照实说，并告诉学生再点一次是安全的（同一个键）。
   * 业务上拒了的是确定没做；每一下都被限流（429，进业务之前就拒了）也是确定没做 —— 原样说。
   */
  function uncertain(e, method, maybeDone) {
    if (!e.retryable || !maybeDone) return e;
    var del = method === 'DELETE';
    var message = e.inProgress
      ? '上一次提交还在处理，稍等一下再点一次' + (del ? '' : '（不会重复保存）')
      : (e.status === 429 ? '请求过于频繁' : e.why) + (del ? '，不确定有没有删掉 —— 再点一次就好' : '，不确定有没有保存上 —— 再点一次不会重复保存');
    return requestError(message, { uncertain: true, network: !!e.network, status: e.status });
  }
  var api = {
    get: function (p) { return request(p, { method: 'GET' }); },
    download: download,
    post: function (p, b, h) { return request(p, { method: 'POST', body: JSON.stringify(b || {}), headers: h || {} }); },
    put: function (p, b) { return request(p, { method: 'PUT', body: b == null ? undefined : JSON.stringify(b) }); },
    del: function (p) { return request(p, { method: 'DELETE' }); },
    upload: function (p, file, fields, headers) {
      var fd = new FormData();
      fd.append('file', file);
      Object.keys(fields || {}).forEach(function (k) { if (fields[k] != null && fields[k] !== '') fd.append(k, fields[k]); });
      return request(p, { method: 'POST', body: fd, headers: headers || {} });
    }
  };

  function toast(msg, kind, ms) {
    var el = document.createElement('div');
    el.textContent = msg;
    // 样子在样式表（.zq-toast，第八十轮：原来内联、贴在 top:22px，正好盖住每页右上角的按钮）
    el.className = kind === 'error' ? 'zq-toast is-error' : 'zq-toast';
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, ms || 2600);
  }
  // 事件处理里没接住的失败（onclick 里 await api.post 却没有 catch）：原来页面上什么都不显示，控制台里一行
  // Uncaught (in promise) —— 用户以为没点上，接着点（第十四轮真浏览器：套用参考计划填错日期，一个字都没有）。
  // 这里兜底说出来。显式处理（safe、try/catch）照旧优先：接住了的失败到不了这里。返回是否说了。
  function reportUnhandled(reason) {
    if (redirecting || !reason) return false;
    if (reason.name === 'AbortError') return false;       // 用户自己取消的（停止生成、取消选文件）
    if (reason.userFacing && reason.message) {
      toast(reason.message, 'error');
    } else {
      console.error('[zhiqu-api] 没接住的错误', reason);
      toast('操作没有完成（页面出了错），请刷新后重试', 'error');
    }
    return true;
  }
  window.addEventListener('unhandledrejection', function (e) { reportUnhandled(e.reason); });
  // 持久通知（底部中间，提示的上面；Claude 弹窗风格）：notice('正在测试…') → {update(msg,{done}), close()}
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
  var modalScrollState = null;
  function restoreModalScroll() {
    if (modalScrollState && (window.scrollX !== modalScrollState.x || window.scrollY !== modalScrollState.y)) {
      window.scrollTo(modalScrollState.x, modalScrollState.y);
    }
  }
  function lockModalScroll() {
    if (modalScrollState) return;
    var body = document.body;
    var width = body.clientWidth;
    var padding = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
    modalScrollState = { x: window.scrollX, y: window.scrollY, paddingRight: body.style.paddingRight };
    body.classList.add('zq-modal-open');
    // root.clientWidth 在 Chromium 隐藏滚动条后仍会变大，即使 gutter 已保留；只补 body 实际增加的布局宽度。
    var gap = Math.max(0, body.clientWidth - width);
    if (gap) body.style.paddingRight = (padding + gap) + 'px';
  }
  function unlockModalScroll() {
    if (!modalScrollState || document.querySelector('.zq-modal-mask')) return;
    document.body.classList.remove('zq-modal-open');
    document.body.style.paddingRight = modalScrollState.paddingRight;
    restoreModalScroll();
    modalScrollState = null;
  }
  function lastOf(list) { return list.length ? list[list.length - 1] : null; }
  function openModal(opts) {
    opts = opts || {};
    var mask = document.createElement('div');
    mask.className = 'zq-modal-mask';
    var w = opts.width ? ('width:' + opts.width + ';') : '';
    mask.innerHTML = '<div class="zq-modal" role="dialog" aria-modal="true" style="' + w + '">'
      + '<div class="zq-modal-head"><h3 class="zq-modal-title">' + esc(opts.title || '') + '</h3>'
      + '<button type="button" class="zq-modal-close" aria-label="关闭">' + icon('x') + '</button></div>'
      + '<div class="zq-modal-body"></div></div>';
    var body = mask.querySelector('.zq-modal-body');
    if (opts.bodyHtml != null) body.innerHTML = opts.bodyHtml;
    else if (opts.bodyNode) body.appendChild(opts.bodyNode);
    var closed = false;
    function close() {
      if (closed) return; closed = true;
      document.removeEventListener('keydown', onKey);
      mask.remove();
      unlockModalScroll();
      if (opts.onClose) { try { opts.onClose(); } catch (e) {} }
    }
    // 只关最上面那一层：设置弹窗里点「删除模型」叠出来的确认框，按 Esc 不该把底下的设置一起关掉
    function onKey(e) { if (e.key === 'Escape' && mask === lastOf(document.querySelectorAll('.zq-modal-mask'))) close(); }
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.zq-modal-close').onclick = close;
    document.addEventListener('keydown', onKey);
    lockModalScroll();
    document.body.appendChild(mask);
    var handle = { close: close, mask: mask, body: body };
    if (opts.onMount) { try { opts.onMount(body, handle); } catch (e) {} }
    // 先给标了 autofocus 的（参考计划详情：第一个能聚焦的是「点赞」，一按回车就赞上了 —— 第五十七轮），没有就第一个能输入 / 能点的
    var first = body.querySelector('[autofocus]') || body.querySelector('input,textarea,select,button'); if (first) { try { first.focus({ preventScroll: true }); } catch (e) { try { first.focus(); } catch (ignored) {} } }
    restoreModalScroll();
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
  /**
   * 本地日历日期（YYYY-MM-DD）。
   *
   * <b>不能用 toISOString().slice(0,10)</b> —— 那是 UTC。东八区凌晨 0 点到 8 点之间，
   * 它给出的是<b>昨天</b>，而后端的业务日期是 Asia/Shanghai（BusinessClock）。此前的后果：
   * 看板标题显示昨天；例行打卡的 checkDate 记成昨天，连续天数因此断掉；
   * 新建例行的开始日期是昨天；套用共享计划默认从昨天开始；番茄钟的学习时长记到昨天。
   *
   * 实测：2026-09-21 01:40（东八区）时，旧写法返回 "2026-09-20"，看板标题就是这么显示的。
   */
  function localDate(d) {
    d = d || new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  // ── 业务时钟（第二十一轮）────────────────────────────────────────────────────
  // localDate 是<b>浏览器所在时区</b>的日历日，只给「把某个 Date 按本机日历写出来」用。「今天」是另一回事：
  // 服务端的业务日期（BusinessClock，默认 Asia/Shanghai），而且按服务器的钟。原来 today() = localDate()，又被当成数据发回去 ——
  // 打卡的 checkDate、番茄钟记到哪天、新建例行计划的开始日期。真浏览器实测：UTC+14 的浏览器给今天列表里「周一三五」的例行计划打卡，
  // 发的是周二，服务器拒了、页面一声不吭；比东八区晚的浏览器过了北京时间零点，打卡成功地记到了昨天，今天的那一条还是没打。
  // 看板标题是浏览器的日期拼服务端的星期：「2026-09-29 · 周一」。
  // 每个页面启动时都先取 /auth/info（initAuth），它带回 clock：{ zone, today, now, offsetMinutes }；回来之前用默认值、本机的钟。
  var clock = { zone: 'Asia/Shanghai', skew: 0, offsetMinutes: 480 };
  var zoneFormat = null;
  function applyServerClock(c, sentAt, receivedAt) {
    if (!c) return;
    try { zoneFormat = new Intl.DateTimeFormat('en-US', { timeZone: c.zone, year: 'numeric', month: '2-digit', day: '2-digit' }); clock.zone = c.zone; } catch (e) { zoneFormat = null; }
    // 本机时钟和服务器差多少：服务器的 now 落在请求发出和收到之间，取中点
    if (typeof c.now === 'number' && sentAt && receivedAt) clock.skew = c.now - (sentAt + receivedAt) / 2;
    if (typeof c.offsetMinutes === 'number') clock.offsetMinutes = c.offsetMinutes;
  }
  /** 一个按 UTC 构造的 Date 的日历日（addDays 之类只在日历上算的地方用；不是「今天」）。 */
  function ymdUTC(d) {
    var m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  /** 此刻（毫秒），按服务器的钟 —— 本机时钟快了慢了不影响算出来的日期。 */
  function nowMs() { return Date.now() + clock.skew; }
  /** 某一时刻（毫秒，默认此刻）在业务时区里是哪一天。 */
  function businessDate(ms) {
    var d = new Date(ms == null ? nowMs() : ms);
    try {
      if (!zoneFormat) zoneFormat = new Intl.DateTimeFormat('en-US', { timeZone: clock.zone, year: 'numeric', month: '2-digit', day: '2-digit' });
      var parts = {};
      zoneFormat.formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
      return parts.year + '-' + parts.month + '-' + parts.day;
    } catch (e) {
      // 没有时区数据的浏览器：按服务端给的偏移算
      return ymdUTC(new Date(d.getTime() + clock.offsetMinutes * 60000));
    }
  }
  function today() { return businessDate(); }
  /** 服务端不带时区的时间（"2026-09-28T22:51:47"，业务时区的钟面）→ 时刻（毫秒）。原来 Date.parse 按浏览器时区解释。 */
  function serverTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
    if (!m) return NaN;
    return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - clock.offsetMinutes * 60000;
  }
  /** 日历日加减天数：只在日历上算，不经过任何时区（夏令时那天也不会差一天）。 */
  function addDays(ymd, n) {
    var p = String(ymd).split('-');
    return ymdUTC(new Date(Date.UTC(+p[0], p[1] - 1, +p[2] + n)));
  }
  /** 业务日期所在的那一周（周一到周日），offset 周之后。 */
  function weekRange(offset) {
    var t = today(), p = t.split('-');
    var dow = new Date(Date.UTC(+p[0], p[1] - 1, +p[2])).getUTCDay() || 7;
    var mon = addDays(t, 1 - dow + (offset || 0) * 7);
    return [mon, addDays(mon, 6)];
  }
  /** 浏览器的钟面和业务时区不一样时（在国外、时区设错），日期旁边说一句是按哪里的时间。 */
  function zoneNote() {
    if (-new Date(nowMs()).getTimezoneOffset() === clock.offsetMinutes) return '';
    return clock.zone === 'Asia/Shanghai' ? '（北京时间）' : '（' + clock.zone + ' 时间）';
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
  // 同一处连着查了几次（来回切「日 / 周 / 月」、改筛选条件、点刷新、写完之后的重载）：响应可能乱序回来，只认最后一次的。
  // 原来先发的那次要是后回来，就把它的结果画在后点的那个标签 / 筛选条件下面（第十四轮）。
  // 用法：var current = latestOnly('trend'); var list = await api.get(…); if (!current()) return;
  var latestSeq = {};
  function latestOnly(key) {
    var mine = (latestSeq[key] = (latestSeq[key] || 0) + 1);
    return function () { return latestSeq[key] === mine; };
  }
  // ── 打了一半的字：刷新、关页、登录过期、断网之后还在（第十五轮） ──────────────────
  //
  // 一处存：localStorage「zq.draft.<用户 id>.<键>」→ {text, at, …}。按用户分开（公用电脑上换个人登录看不到上一个人的）；
  // 空了就删；太长（DRAFT_MAX_CHARS）、存储满了、被禁用（隐私模式）就不存 —— 不报错，功能照常，只是没有草稿；
  // DRAFT_TTL_MS 之后当没有。主动退出时删掉这个人的全部草稿；登录过期不删。
  var DRAFT_PREFIX = 'zq.draft.';
  var DRAFT_MAX_CHARS = 200000;
  var DRAFT_TTL_MS = 14 * 24 * 3600 * 1000;
  var DRAFT_SAVE_DELAY_MS = 400;
  function draftStorageKey(key) {
    var uid = state.user && state.user.id;
    return uid == null || !key ? null : DRAFT_PREFIX + uid + '.' + key;
  }
  var drafts = {
    save: function (key, text, extra) {
      var k = draftStorageKey(key); if (!k) return false;
      try {
        var t = text == null ? '' : String(text);
        if (!t.trim()) { localStorage.removeItem(k); return true; }
        if (t.length > DRAFT_MAX_CHARS) return false;
        localStorage.setItem(k, JSON.stringify(Object.assign({}, extra || {}, { text: t, at: Date.now() })));
        return true;
      } catch (e) { return false; }
    },
    load: function (key) {
      var k = draftStorageKey(key); if (!k) return null;
      try {
        var v = JSON.parse(localStorage.getItem(k) || 'null');
        if (!v || typeof v.text !== 'string') return null;
        if (!(Date.now() - (v.at || 0) <= DRAFT_TTL_MS)) { localStorage.removeItem(k); return null; }
        return v;
      } catch (e) { return null; }
    },
    clear: function (key) {
      var k = draftStorageKey(key); if (!k) return;
      try { localStorage.removeItem(k); } catch (e) {}
    },
    /** 只在存着的还是这段字时才删 —— 发出去之后用户又打了新的一句，那句不能跟着删。 */
    clearIf: function (key, text) {
      var d = drafts.load(key);
      if (d && d.text.trim() === String(text || '').trim()) drafts.clear(key);
    },
    clearUser: function () {
      var uid = state.user && state.user.id; if (uid == null) return;
      try {
        var mine = DRAFT_PREFIX + uid + '.';
        Object.keys(localStorage).filter(function (k) { return k.indexOf(mine) === 0; }).forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
    }
  };
  /**
   * 一个输入框的草稿。keyFn 给出此刻该存在哪个键（聊天框跟着 Notebook 变）。框是空的而有草稿就填回去；
   * 打字之后 DRAFT_SAVE_DELAY_MS 存一次、离开页面时马上存 —— 只存用户打过字的（程序把框清空不算，
   * 否则发出去之后一刷新，空框会把还没确认送达的那句从草稿里抹掉）。
   */
  function keepDraft(el, keyFn, onRestore) {
    if (!el) return { flush: function () {}, reload: function () {}, clear: function () {}, key: function () { return null; } };
    var keyOf = typeof keyFn === 'function' ? keyFn : function () { return keyFn; };
    var shownKey = keyOf();
    var timer = null;
    var dirty = false;
    function flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!dirty) return;
      dirty = false;
      drafts.save(shownKey, el.value);
    }
    function show() {
      var d = drafts.load(shownKey);
      if (d && !el.value) { el.value = d.text; if (onRestore) onRestore(); }
    }
    show();
    el.addEventListener('input', function () {
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DRAFT_SAVE_DELAY_MS);
    });
    window.addEventListener('pagehide', flush);
    return {
      flush: flush,
      /** 换了键（换 Notebook）：先把这边打的存到原来的键，再换成那边的草稿。 */
      reload: function () {
        flush();
        shownKey = keyOf();
        el.value = '';
        show();
        if (onRestore) onRestore();
      },
      clear: function (key) {
        if (timer) { clearTimeout(timer); timer = null; }
        dirty = false;
        drafts.clear(key || shownKey);
      },
      key: function () { return shownKey; }
    };
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
    var sentAt = Date.now();
    state.user = await api.get('/auth/info');
    applyServerClock(state.user && state.user.clock, sentAt, Date.now());
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
    if (!box || !u || !window.ZQUI || !window.ZQUI.paintUser) return;
    // 画法在 zhiqu-ui.js（下一页打开时先用这次记下的画上，不用等 /auth/info）
    window.ZQUI.paintUser(box, { name: u.nickname || u.username || '知趣用户', account: u.username || '', avatar: u.avatar || '', admin: r === 'ADMIN' });
  }

  var AUTH_FORM_HTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--zq-border-soft);margin-bottom:18px;">'
    + '<button type="button" data-authtab="login" style="height:38px;border:none;background:none;cursor:pointer;font-size:14px;font-weight:var(--zq-fw-medium);color:var(--zq-primary);border-bottom:2px solid var(--zq-primary);">登录</button>'
    + '<button type="button" data-authtab="register" style="height:38px;border:none;background:none;cursor:pointer;font-size:14px;font-weight:var(--zq-fw-regular);color:var(--zq-text2);border-bottom:2px solid transparent;">注册</button>'
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
        location.href = safeNext(new URLSearchParams(location.search).get('next'));
      });
    });
    if (reg) reg.addEventListener('submit', function (e) {
      e.preventDefault();
      var ins = $all('input', reg);
      if (ins[1].value !== ins[2].value) return toast('两次密码不一致', 'error');
      safe('注册', async function () {
        var username = ins[0].value.trim(), password = ins[1].value;
        await api.post('/auth/register', { username: username, password: password, confirmPassword: ins[2].value });
        // 注册完直接登录（2026-10-03 走主流程：原来注册成功之后还要把密码再输一遍）。登录没成（比如撞了登录限流）就退回登录页、用户名填好
        try {
          var data = await api.post('/auth/login', { username: username, password: password, rememberMe: false });
          setAuth(data, false);
          location.href = safeNext(new URLSearchParams(location.search).get('next'));
        } catch (err) {
          toast('注册成功，请登录');
          switchAuthTab(root, 'login');
          var loginName = login && $all('input', login)[0];
          if (loginName) loginName.value = username;
        }
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
    if (token()) { location.href = safeNext(new URLSearchParams(location.search).get('next')); return; }
    $all('[data-auth]').forEach(function (b) { b.onclick = function () { openAuthModal(b.getAttribute('data-auth')); }; });
    var q = new URLSearchParams(location.search);
    if (q.get('login') != null) openAuthModal(q.get('login') === 'register' ? 'register' : 'login');
  }

  async function updatePomoCount() {
    // 看板有「今日：N 个」和「今天第 N 轮」两块，迷你番茄钟（第五十轮）只有后一块：各自有就各自填
    var host = $('#zq-pomo-count'), round = $('#zq-pomo-round');
    if (!host && !round) return;
    var waiting = pendingPomodoros().length;
    var tail = waiting ? ' ｜ 另有 ' + waiting + ' 个还没传上去（连上网自动补记）' : '';
    try {
      var t = today();
      var recs = await api.get('/record/list?from=' + t + '&to=' + t);
      var todays = (recs || []).filter(function (rec) { return d10(rec.studyDate) === t; });
      var mins = todays.reduce(function (a, rec) { return a + (rec.durationMinutes || 0); }, 0);
      if (host) host.textContent = '今日：' + todays.length + ' 个 ｜ ' + mins + ' 分钟' + tail;
      // 原来是设计稿写死的「第 3 轮 · 专注阶段」，新账号一个没做也是第 3 轮（2026-10-01 排查参考计划假数字时一起查出）
      if (round) round.textContent = '今天第 ' + (todays.length + 1) + ' 轮';
    } catch (e) {
      if (tail && host) host.textContent = tail.slice(3);
    }
  }

  // ── 番茄钟的待补记（第二十二轮）────────────────────────────────────
  //
  // 专注完的那一刻网断了（地铁里、电梯里、Wi-Fi 切 4G）：原来说「这个番茄钟没记上：网络连接失败」，25 分钟就没了 ——
  // 页面上也没有能「再点一次」的东西。现在先记在这台设备上（localStorage），连上网、再打开哪一页时自动补记。
  // 每一条带自己的幂等键：补记几次、回应又丢了、两个标签页同时补，都只记一份（IdempotentWriteAspect）。
  // 跨了天才补上的，带上完成那天的日期（不带就记到了补记那天）；当天补上的不带 —— 服务端定（第二十一轮）。
  // 各人的只由各人补：同一个浏览器换了账号，别的账号的留着，等那个账号登录。
  // 行为判据：src/test/resources/js/pomo-outbox-check.js（直接跑这里发布的实现）。
  var POMO_OUTBOX = 'zq-pomo-outbox';
  var pomoFlushing = null;
  function readPomoOutbox() {
    try { var v = JSON.parse(localStorage.getItem(POMO_OUTBOX) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function writePomoOutbox(list) {
    try { if (list.length) localStorage.setItem(POMO_OUTBOX, JSON.stringify(list)); else localStorage.removeItem(POMO_OUTBOX); } catch (e) { /* 存不下：照旧只能当场发 */ }
  }
  function dropPomodoro(key) { writePomoOutbox(readPomoOutbox().filter(function (x) { return x.key !== key; })); }
  function pomoOwner() { return state.user && state.user.id != null ? String(state.user.id) : ''; }
  function pendingPomodoros() { var me = pomoOwner(); return readPomoOutbox().filter(function (x) { return x.user === me; }); }
  function postPomodoro(x) {
    var body = { taskId: x.taskId, durationMinutes: x.durationMinutes, note: x.note };
    if (x.day && x.day < today()) body.studyDate = x.day;
    return api.post('/record', body, { 'Idempotency-Key': x.key });
  }
  /** 补记这个人待补的番茄钟。返回 { sent, failed: [原因…], waiting }；同一时间只跑一趟。 */
  function flushPomodoros() {
    if (pomoFlushing) return pomoFlushing;
    pomoFlushing = (async function () {
      var result = { sent: 0, failed: [], waiting: 0 };
      var list = pendingPomodoros();
      for (var i = 0; i < list.length; i++) {
        var x = list[i];
        try {
          await postPomodoro(x);
          dropPomodoro(x.key);
          result.sent++;
        } catch (e) {
          // 还连不上 / 服务器不确定 / 登录过期了：留着，下次再补（后面的也先不试）
          if (e.uncertain || e.retryable || e.network || e.auth) { result.waiting = list.length - i; break; }
          dropPomodoro(x.key);             // 服务器明确拒了：留着也补不上，说出来
          result.failed.push(e.message);
        }
      }
      return result;
    })();
    var clear = function () { pomoFlushing = null; };
    pomoFlushing.then(clear, clear);
    return pomoFlushing;
  }
  /**
   * 专注完了：先落在这台设备上，再发。说清楚是记上了、先存着、还是真的没记上。
   * rec.key：番茄钟这一次专注的 id（第四十九轮）—— 两个标签页都记了，清单里也只有一条、服务端也只记一份；rec.day：结束的那一天（一页都没开着时到点、下次打开才补上的）。
   */
  async function recordPomodoro(rec) {
    var item = { key: rec.key || writeKey(), user: pomoOwner(), day: rec.day || today(), taskId: rec.taskId == null ? null : rec.taskId, durationMinutes: rec.durationMinutes, note: rec.note || '' };
    var list = readPomoOutbox();
    if (!list.some(function (x) { return x.key === item.key; })) list.push(item);
    writePomoOutbox(list);
    var kept = function () { return readPomoOutbox().some(function (x) { return x.key === item.key; }); };
    var r;
    if (!kept()) {
      // 这台设备存不下（存储满了、被禁用了）：补记那一趟是从设备上读清单的，读不到这一条 —— 照旧当场发，没记上就说出来。
      // 原来这里什么都不发、什么都不说，25 分钟悄悄没了
      r = { sent: 0, failed: [], waiting: 0 };
      try { await postPomodoro(item); r.sent = 1; } catch (e) { r.failed.push(e.message); }
    } else {
      r = await flushPomodoros();
      // 正在跑的是之前开始的那一趟（打开页面、网回来时的补记）：它开始时这一条还不在清单里。网是通的就再补一趟
      if (kept() && !r.waiting) r = await flushPomodoros();
    }
    if (r.failed.length) toast('这个番茄钟没记上：' + r.failed[0], 'error', 6000);
    else if (kept()) {
      toast('网络断了：这个番茄钟先存在这台设备上，连上网会自动补记', 'error', 6000);
    }
    if (r.sent && window.zqApi && window.zqApi.afterRecord) window.zqApi.afterRecord();
    else updatePomoCount();
    return r;
  }
  /** 打开页面、网回来了、每分钟（有待补的时候）：补一趟，补上了说一声。 */
  async function catchUpPomodoros() {
    if (!pendingPomodoros().length) return;
    // 正在发的那一趟（刚专注完的那一个、另一路补记）自己说结果：等它发完再看还剩什么。原来和它共用结果 —— 关着页面时到点的番茄钟，
    // 打开页面那一刻「记它」和「打开页面的补记」撞在一起，刚记的这一个被说成「补记了 1 个番茄钟（专注完的时候网断了）」（第四十九轮真浏览器）
    if (pomoFlushing) {
      await pomoFlushing;
      if (!pendingPomodoros().length) return;
    }
    var r = await flushPomodoros();
    if (r.sent) {
      toast('补记了 ' + r.sent + ' 个番茄钟（专注完的时候网断了）');
      if (window.zqApi && window.zqApi.afterRecord) window.zqApi.afterRecord();
    }
    if (r.failed.length) toast('有 ' + r.failed.length + ' 个番茄钟补记不上：' + r.failed[0], 'error', 6000);
  }

  // ── 番茄钟：全站共用一个钟（第四十九轮，迷你番茄钟第 1 步）────────────────────────
  //
  // 原来番茄钟是看板页的一段内联脚本，状态在那一页的内存里：开始之后切到别的页，它就没了（不记这一次、到点也不提醒）；两个看板标签页各算各的。
  // 迷你番茄钟（docs/mini-pomodoro-plan.md）的迷你窗和主窗口要看同一个钟 —— 状态存在 localStorage（按人分开），每一页登录之后都看着它。
  // 一次专注一个 id：在跑的记结束时刻 endAt（按结束时刻倒数，后台标签页、合上笔记本也不停 —— 第二十一轮），暂停的记还剩几秒 left，
  // 做完的留着（别的页挂标题、看板写「已完成」）。改它都在浏览器的锁里「读 → 看还是不是那一个 → 写」，rev 每写一次加一：
  // 到点只有一页标得上「做完」，只有它记录、提醒；记录的幂等键就是 id —— 没有 Web Locks 的浏览器里两页都记了，服务端也只记一份。
  // 一页都没开着时到点了（关了浏览器、合了盖子）：下次打开哪一页都补上，记到结束的那一天；过了 POMO_LATE_MS 才发现的不响、不弹，只说一句。
  // 关掉页面不再等于放弃这一次专注 —— 要放弃按「重置」。
  // 行为判据：src/test/resources/js/pomo-shared-check.js（直接跑这里发布的实现）。
  var POMO_PREFIX = 'zq.pomo.';
  var POMO_LATE_MS = 15 * 60000;
  var POMO_JUMP_MS = 1500;
  var POMO_PHASES = /^(running|paused|done)$/;
  var pomoLocal = null;      // 存不进 localStorage（隐私模式、存满了）：这一页自己记着 —— 和原来一样只活在这一页，但照样能用
  var pomoObs = null;        // 这一页上一跳看到的：{ id, rev, phase, recorded, at, mono }
  var pomoMine = {};         // 这一页记录的那几次（自己已经刷新过看板，别人标「记上了」时不再刷一遍）
  var pomoListeners = [];
  var pomoBadgeTip = null;
  var pomoClockWatched = false;
  function pomoKey() { var uid = state.user && state.user.id; return uid == null ? null : POMO_PREFIX + uid; }
  function readPomo() {
    var k = pomoKey(); if (!k) return null;
    var v = null;
    if (pomoLocal) v = pomoLocal.key === k ? pomoLocal.value : null;
    else { try { v = JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { v = null; } }
    return v && typeof v.id === 'string' && v.total > 0 && POMO_PHASES.test(v.phase) ? v : null;
  }
  function writePomo(v) {
    var k = pomoKey(); if (!k) return;
    if (!pomoLocal) {
      try { if (v) localStorage.setItem(k, JSON.stringify(v)); else localStorage.removeItem(k); return; } catch (e) { pomoLocal = { key: k, value: null }; }
    }
    pomoLocal.key = k; pomoLocal.value = v;
  }
  /** 此刻（毫秒）按这一页的单调时钟 —— 真钟往回拨了它不跟着拨 */
  function pomoMono() { try { return performance.now(); } catch (e) { return Date.now(); } }
  /**
   * 改番茄钟：在浏览器的锁里读出此刻存着的、交给 fn，fn 返回要写的（undefined = 不写，null = 删掉）。
   * 几个标签页（以后还有迷你窗）同时改，排着队来；没有 Web Locks 的浏览器直接做。返回的 promise 给出写了没有。
   */
  function changePomo(fn) {
    var run = function () {
      var cur = readPomo(), next = fn(cur);
      if (next === undefined) return false;
      if (next) next.rev = (cur && cur.id === next.id ? cur.rev || 0 : 0) + 1;
      writePomo(next);
      return true;
    };
    var locks = null;
    try { locks = navigator.locks && navigator.locks.request ? navigator.locks : null; } catch (e) { locks = null; }
    var done = locks ? locks.request('zq-pomodoro', run) : new Promise(function (ok) { ok(run()); });
    return done.then(function (changed) { if (changed) pomoTick(); return changed; }, function () { return false; });
  }
  /** 给页面画的样子：phase 是 idle / running / paused / done，left 还剩几秒（没在跑的是整段） */
  function pomoView() {
    var s = readPomo(), now = Date.now();
    if (!s) return { phase: 'idle', left: 0, total: 0, taskId: null, taskTitle: '' };
    var left = s.phase === 'running' ? Math.max(0, Math.ceil((s.endAt - now) / 1000)) : s.phase === 'paused' ? s.left : s.total;
    // 做完的过了一阵就只是「待开始」（时长、任务留着，下一次照着来）
    var phase = s.phase === 'done' && !(now - s.endedAt < POMO_LATE_MS) ? 'idle' : s.phase;
    return { phase: phase, id: s.id, total: s.total, left: left, taskId: s.taskId == null ? null : s.taskId, taskTitle: s.taskTitle || '' };
  }
  function pomoClock(secs) { return String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0'); }
  /** 某一时刻（本机的钟）在业务时区的钟面：今天的写「HH:mm」，别的日子带上「MM/DD」 */
  function pomoEndText(ms) {
    var d = new Date(ms + clock.skew + clock.offsetMinutes * 60000), day = ymdUTC(d), hh = d.getUTCHours(), mm = d.getUTCMinutes();
    return (day === today() ? '' : day.slice(5).replace('-', '/') + ' ') + (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  /** 到点了：只有标得上「做完」的那一页记录、提醒（别的页在 pomoTick 里看到「做完了」只挂标题） */
  function finishPomo(id) {
    var ended = null;
    return changePomo(function (cur) {
      if (!cur || cur.id !== id || cur.phase !== 'running' || cur.endAt > Date.now()) return undefined;
      ended = cur;
      return { id: cur.id, phase: 'done', total: cur.total, endedAt: cur.endAt, taskId: cur.taskId, taskTitle: cur.taskTitle };
    }).then(function (changed) {
      if (!changed || !ended) return;
      var late = !(Date.now() - ended.endAt < POMO_LATE_MS);
      pomoMine[ended.id] = true;
      // 不带日期的话记到服务端的「今天」：结束在昨天、今天才补上的，带上结束那天（补记那一步只在跨了天时才发日期）
      recordPomodoro({ key: ended.id, day: businessDate(ended.endAt + clock.skew), taskId: ended.taskId, durationMinutes: Math.round(ended.total / 60), note: '番茄钟专注时段' })
        .then(function (r) { if (r && r.sent) markPomoRecorded(ended.id); })
        .catch(function (e) { toast('这个番茄钟没记上：' + ((e && e.message) || '出错了'), 'error'); });
      // 响一声、弹通知（授权过的话；桌面应用走原生通知）、页面里提示一句（第二十五轮）。太久之前到点的不响不弹
      if (!late) pageNotify('专注结束', '记进今天的时长了，休息一下', 'zq-pomodoro');
      else toast('番茄钟在 ' + pomoEndText(ended.endAt) + ' 到点了（那时一页都没开着），记进那天的专注时长');
    });
  }
  /** 记上了：告诉别的页（看板要刷新今天的个数） */
  function markPomoRecorded(id) {
    return changePomo(function (cur) {
      if (!cur || cur.id !== id || cur.phase !== 'done' || cur.recorded) return undefined;
      return Object.assign({}, cur, { recorded: true });
    });
  }
  /** 钟往回拨了：结束时刻往回挪 back 毫秒 —— 只挪 seen 那一份（rev 对得上）；别的标签页先挪了、暂停了，就不动 */
  function shiftPomo(seen, back) {
    return changePomo(function (cur) {
      if (!cur || cur.id !== seen.id || cur.rev !== seen.rev || cur.phase !== 'running') return undefined;
      return Object.assign({}, cur, { endAt: cur.endAt - back });
    });
  }
  // 结束了要让人知道（2026-10-03 走主流程：在别的标签页专注时，25 分钟到了页面上一点动静都没有）。
  // 标签页标题挂上「✓ 专注结束」，直到切回这一页 —— 每一个开着的页都挂（不知道人在看哪一页）；响和通知只有记录的那一页发
  function markPomoTitle() {
    var title = document.title.replace(/^✓ 专注结束 — /, '');
    document.title = '✓ 专注结束 — ' + title;
    function restore() { if (document.hidden) return; setTimeout(function () { document.title = title; }, 4000); document.removeEventListener('visibilitychange', restore); }
    document.addEventListener('visibilitychange', restore); restore();
  }
  /** 侧栏头像上面那一行「专注中 18:42」（看板本页不显示：卡片就在那） */
  function renderPomoBadge(v) {
    var el = document.querySelector('#zq-side .zq-side-pomo'); if (!el) return;
    var on = page !== 'dashboard.html' && (v.phase === 'running' || v.phase === 'paused');
    el.hidden = !on;
    if (!on) return;
    var label = v.phase === 'running' ? '专注中' : '已暂停';
    var text = el.querySelector('.zq-side-pomo-label'), time = el.querySelector('.zq-side-pomo-time');
    if (text && text.textContent !== label) text.textContent = label;
    if (time) time.textContent = pomoClock(v.left);
    el.classList.toggle('is-paused', v.phase === 'paused');
    var tip = label + (v.taskTitle ? '：' + v.taskTitle : '') + '（点开看板）';
    if (tip !== pomoBadgeTip) { pomoBadgeTip = tip; el.title = tip; }
  }
  /** 一跳：看别的页改了什么、钟有没有往回拨、到没到点，再画 */
  function pomoTick() {
    var s = readPomo(), now = Date.now(), mono = pomoMono(), prev = pomoObs;
    pomoObs = s ? { id: s.id, rev: s.rev, phase: s.phase, recorded: !!s.recorded, at: now, mono: mono } : null;
    var same = !!(s && prev && prev.id === s.id);
    if (same && prev.phase === 'running' && s.phase === 'done' && now - s.endedAt < POMO_LATE_MS) markPomoTitle();
    if (same && !prev.recorded && s.recorded && !pomoMine[s.id]) {
      if (window.zqApi && window.zqApi.afterRecord) window.zqApi.afterRecord(); else updatePomoCount();
    }
    if (s && s.phase === 'running') {
      // 钟往回拨了（校时、手动改时间）：按这一页的单调时钟，此刻本该是 prev.at + 过去的毫秒数，真钟慢出来多少、结束时刻就往回挪多少 ——
      // 剩下的时间不会变多、也不会卡住不走（第二十一轮）。只认上一跳以来没人写过的（rev 没变）：别的页挪过了，这一页看到的已经是挪过的
      var back = same && prev.rev === s.rev ? prev.at + (mono - prev.mono) - now : 0;
      if (back > POMO_JUMP_MS) shiftPomo(s, back);
      else if (s.endAt <= now) finishPomo(s.id);
    }
    var v = pomoView();
    renderPomoBadge(v);
    pomoListeners.slice().forEach(function (fn) { try { fn(v); } catch (e) { /* 一个页面画坏了不挡别的 */ } });
  }
  /** 每一页登录之后：一秒一跳；别的页（迷你窗）改了马上跟上；切回来、笔记本醒来马上按真实时间刷一次 */
  function watchPomo() {
    if (pomoClockWatched) return; pomoClockWatched = true;
    pomoTick();
    setInterval(pomoTick, 1000);
    window.addEventListener('storage', function (e) { if (e.key == null || e.key === pomoKey()) pomoTick(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) pomoTick(); });
  }
  /** 给页面（看板的卡片，以后的迷你窗）用的：画什么问 view，按钮交给这几样 */
  var pomo = {
    view: pomoView,
    clock: pomoClock,
    /** 开始；暂停着的就接着走。到点要弹通知：在点「开始」的这一下里问授权（浏览器只在用户点了东西时才肯弹授权框） */
    start: function (opts) {
      opts = opts || {};
      askNotifyPermission();
      return changePomo(function (cur) {
        var now = Date.now();
        if (cur && cur.phase === 'running') return undefined;   // 别的页刚点了开始
        if (cur && cur.phase === 'paused') return { id: cur.id, phase: 'running', total: cur.total, endAt: now + cur.left * 1000, taskId: cur.taskId, taskTitle: cur.taskTitle };
        var mins = Math.min(180, Math.max(1, Math.round(Number(opts.minutes) || 25)));
        return { id: writeKey(), phase: 'running', total: mins * 60, endAt: now + mins * 60000, taskId: opts.taskId == null ? null : opts.taskId, taskTitle: opts.taskTitle || '' };
      });
    },
    pause: function () {
      pomoTick();   // 先按真实时间看一眼（钟往回拨了先挪、到点了先做完）—— 排在暂停前面
      return changePomo(function (cur) {
        if (!cur || cur.phase !== 'running') return undefined;
        var left = Math.ceil((cur.endAt - Date.now()) / 1000);
        if (left <= 0) return undefined;   // 已经到点：交给到点那一步（记录、提醒）
        return { id: cur.id, phase: 'paused', total: cur.total, left: left, taskId: cur.taskId, taskTitle: cur.taskTitle };
      });
    },
    reset: function () { return changePomo(function (cur) { return cur ? null : undefined; }); },
    /** 专注到一半换关联的任务：记的时候算新的那个（原来是到点那一刻下拉框里选的那个） */
    setTask: function (taskId, taskTitle) {
      return changePomo(function (cur) {
        if (!cur || cur.phase === 'done') return undefined;
        return Object.assign({}, cur, { taskId: taskId == null ? null : taskId, taskTitle: taskTitle || '' });
      });
    },
    subscribe: function (fn) { pomoListeners.push(fn); fn(pomoView()); }
  };
  /** 周期给人看的样子（第十九轮）：列表、参考计划、AI 草稿原来直接显示 DAILY / WEEKLY。星期按 ISO：1 是周一。 */
  function freqLabel(frequency, daysOfWeek) {
    var f = String(frequency || 'DAILY').toUpperCase();
    if (f === 'DAILY') return '每天';
    if (f !== 'WEEKLY') return String(frequency);
    var names = ['一', '二', '三', '四', '五', '六', '日'];
    var days = (Array.isArray(daysOfWeek) ? daysOfWeek : String(daysOfWeek || '').split(','))
      .map(Number).filter(function (d) { return d >= 1 && d <= 7; });
    return days.length ? '每周' + days.map(function (d) { return names[d - 1]; }).join('、') : '每周';
  }

  // ── 任务表单（2026-10-01）──────────────────────────────────────────────────
  // 原来「新建任务」只问一个标题、「编辑」也只改标题：截止时间、提醒时间、象限、优先级在任务页上都设置不了 ——
  // 列表里明明有这几列，只能靠 AI 草稿去填。表单把服务端收的字段摆出来，新建和编辑共用一份。
  // 时间用 datetime-local：它的值是不带时区的钟面（"2026-10-08T22:00"），和服务端存的一样按业务时区理解，
  // 原样发过去、不经过 Date —— 浏览器在别的时区也不会挪。
  var TASK_REMIND = { DEFAULT: 'default', NONE: 'none', CUSTOM: 'custom' };
  /** 业务时区此刻的钟面，"YYYY-MM-DDTHH:mm:ss"（和 datetime-local 的值、服务端的时间同一种写法，能直接按字符串比先后）。 */
  function businessNowText() {
    var d = new Date(nowMs() + clock.offsetMinutes * 60000);
    var hh = d.getUTCHours(), mm = d.getUTCMinutes(), ss = d.getUTCSeconds();
    return ymdUTC(d) + 'T' + (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }
  /** 服务端的时间 → datetime-local 的值（只要到分钟）。 */
  function toLocalInput(v) {
    var m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(v || ''));
    return m ? m[1] + 'T' + m[2] : '';
  }
  /**
   * 表单里填的 → 发给服务端的。纯函数：task-form-check.js 直接跑这一份。
   * f：表单原样的字符串；now：businessNowText()；before：编辑前的任务（新建时为 null）。
   * 返回 { error } 或 { url, method, body }。拿不准的一律拒绝并说清楚，不悄悄改掉用户填的东西。
   */
  function taskFormPayload(f, now, before) {
    var title = String(f.title || '').trim();
    if (!title) return { error: '请填写任务标题' };
    var bad = null;
    function when(v, label) {
      v = String(v || '').trim();
      if (!v) return null;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return v + ':00';
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) return v;
      bad = bad || label + '的格式不对，请重新选一下';
      return null;
    }
    function int(v, lo, hi) {
      v = String(v == null ? '' : v).trim();
      if (!/^\d+$/.test(v)) return NaN;
      var n = Number(v);
      return n >= lo && n <= hi ? n : NaN;
    }
    var start = when(f.startTime, '开始时间'), deadline = when(f.deadline, '截止时间'), reminder = when(f.reminderTime, '提醒时间');
    if (bad) return { error: bad };
    var quadrant = int(f.quadrant, 1, 4), priority = int(f.priority, 0, 3);
    if (isNaN(quadrant)) return { error: '请选择象限' };
    if (isNaN(priority)) return { error: '请选择优先级' };
    if (start && deadline && deadline < start) return { error: '截止时间早于开始时间' };
    // 已经过去的提醒时间服务端不会建提醒（不报错）—— 说出来。编辑时原样没动的旧时间（早就提醒过了）不拦
    var beforeReminder = before && before.reminderTime ? when(toLocalInput(before.reminderTime), '') : null;
    if (reminder && reminder <= now && reminder !== beforeReminder) {
      return { error: '提醒时间已经过去了，到时候不会再提醒 —— 换一个以后的时间，或者清空它' };
    }
    var duration = null;
    if (String(f.durationMinutes || '').trim()) {
      duration = int(f.durationMinutes, 1, 1440);
      if (isNaN(duration)) return { error: '预计时长写 1 到 1440 之间的分钟数' };
    }
    var offsets = null;   // null = 服务端按默认（截止前几天的早上 8 点）
    if (f.remindMode === TASK_REMIND.NONE) offsets = [];
    else if (f.remindMode === TASK_REMIND.CUSTOM) {
      var parts = String(f.remindDays || '').split(/[,，、\s]+/).filter(Boolean);
      if (!parts.length) return { error: '自定义的截止前提醒至少写一个天数，例如 7,3,1' };
      offsets = [];
      for (var i = 0; i < parts.length; i++) {
        var d = int(parts[i], 0, 365);
        if (isNaN(d)) return { error: '「截止前提醒」写天数（0 到 365，0 是截止当天），用逗号隔开，例如 7,3,1' };
        if (offsets.indexOf(d) < 0) offsets.push(d);
      }
      if (offsets.length > 10) return { error: '截止前提醒最多 10 个（这次是 ' + offsets.length + ' 个）' };
      if (!deadline) return { error: '「截止前提醒」按截止时间算，请先填截止时间' };
      offsets.sort(function (a, b) { return b - a; });
    }
    var fields = {
      title: title, description: String(f.description || '').trim(), quadrant: quadrant, priority: priority,
      startTime: start, durationMinutes: duration, deadline: deadline, reminderTime: reminder, reminderOffsets: offsets
    };
    // 编辑：其余字段（版本号、状态、任务类型、难度）照旧带上 —— 服务端的整份更新会把没带的清空
    if (before) return { url: '/task/' + before.id, method: 'put', body: Object.assign({}, before, fields) };
    var weeks = 1;
    if (String(f.repeatWeeks || '').trim()) {
      weeks = int(f.repeatWeeks, 1, 52);
      if (isNaN(weeks)) return { error: '每周重复写 1 到 52 之间的周数' };
    }
    if (weeks > 1 && !start) return { error: '每周重复要先填开始时间：每一周在同一时间各建一条' };
    var body = Object.assign({ status: 0 }, fields);
    if (weeks > 1) { body.repeatWeeks = weeks; return { url: '/task/create-with-repeat', method: 'post', body: body }; }
    return { url: '/task', method: 'post', body: body };
  }
  function taskFormHtml(t, remind, isNew) {
    function opts(labels, current, from) {
      return labels.map(function (label, i) { var v = i + from; return '<option value="' + v + '"' + (v === current ? ' selected' : '') + '>' + label + '</option>'; }).join('');
    }
    function field(id, label, control) { return '<div class="zq-field"><label class="zq-label" for="' + id + '">' + label + '</label>' + control + '</div>'; }
    function dt(id, v) { return '<input id="' + id + '" type="datetime-local" class="zq-input" value="' + esc(toLocalInput(v)) + '">'; }
    return field('zq-tf-title', '任务标题', '<input id="zq-tf-title" class="zq-input" maxlength="200" placeholder="例如：数学二轮 · 重积分专题" value="' + esc(t.title || '') + '">')
      + field('zq-tf-desc', '说明（可留空）', '<textarea id="zq-tf-desc" class="zq-textarea" style="min-height:60px;">' + esc(t.description || '') + '</textarea>')
      + '<div class="zq-form-grid">'
      + field('zq-tf-q', '象限', '<select id="zq-tf-q" class="zq-select">' + opts(['重要且紧急', '重要不紧急', '紧急不重要', '不重要不紧急'], Number(t.quadrant || 2), 1) + '</select>')
      + field('zq-tf-p', '优先级', '<select id="zq-tf-p" class="zq-select">' + opts(['低', '中', '高', '紧急'], Number(t.priority == null ? 1 : t.priority), 0) + '</select>')
      + field('zq-tf-start', '开始时间（可留空）', dt('zq-tf-start', t.startTime))
      + field('zq-tf-dur', '预计时长（分钟，可留空）', '<input id="zq-tf-dur" type="number" min="1" max="1440" step="1" class="zq-input" value="' + esc(t.durationMinutes == null ? '' : t.durationMinutes) + '">')
      + field('zq-tf-deadline', '截止时间（可留空）', dt('zq-tf-deadline', t.deadline))
      + field('zq-tf-remind', '提醒时间（可留空）', dt('zq-tf-remind', t.reminderTime))
      + '</div>'
      + field('zq-tf-mode', '截止前提醒', '<div style="display:flex;gap:8px;"><select id="zq-tf-mode" class="zq-select" style="flex:none;">'
        + '<option value="' + TASK_REMIND.DEFAULT + '"' + (remind.mode === TASK_REMIND.DEFAULT ? ' selected' : '') + '>默认</option>'
        + '<option value="' + TASK_REMIND.CUSTOM + '"' + (remind.mode === TASK_REMIND.CUSTOM ? ' selected' : '') + '>自定义天数</option>'
        + '<option value="' + TASK_REMIND.NONE + '"' + (remind.mode === TASK_REMIND.NONE ? ' selected' : '') + '>不提醒</option></select>'
        + '<input id="zq-tf-days" class="zq-input" style="flex:1;min-width:0;" placeholder="提前几天，例如 7,3,1" value="' + esc(remind.days || '') + '"' + (remind.mode === TASK_REMIND.CUSTOM ? '' : ' hidden') + '></div>')
      + '<p style="margin:-4px 0 13px;font-size:12px;color:var(--zq-text3);line-height:1.6;">「提醒时间」到点提醒一次；「截止前提醒」在截止前那几天的早上 8 点提醒（默认按任务难度提前几天，0 是截止当天）。都发到「设置 → 提醒」里的推送渠道。</p>'
      + '<p id="zq-tf-remind-warn" hidden style="margin:-6px 0 13px;padding:8px 10px;border-radius:var(--zq-rs);background:var(--zq-q1-bg);color:var(--zq-q1);font-size:12px;line-height:1.6;"></p>'
      + (isNew ? field('zq-tf-weeks', '每周重复（周，可留空）', '<input id="zq-tf-weeks" type="number" min="1" max="52" step="1" class="zq-input" placeholder="填 2 以上：从开始时间起每周建一条，最多 52 周">') : '')
      + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-tf-cancel">取消</button><button type="button" class="zq-btn" id="zq-tf-ok">' + (isNew ? '创建' : '保存') + '</button></div>';
  }
  /** 编辑时「截止前提醒」显示成现在真的排着的那几天（服务端不单独存这个设置，只存排好的提醒）；查不到就按默认。 */
  async function currentRemind(id) {
    try {
      var list = (await api.get('/task/' + id + '/reminders')) || [];
      var days = [];
      list.forEach(function (r) {
        if (r.reminderType === 'AUTO' && r.status === 'PENDING' && r.offsetDays != null && days.indexOf(r.offsetDays) < 0) days.push(r.offsetDays);
      });
      days.sort(function (a, b) { return b - a; });
      return days.length ? { mode: TASK_REMIND.CUSTOM, days: days.join(',') } : { mode: TASK_REMIND.DEFAULT };
    } catch (e) {
      return { mode: TASK_REMIND.DEFAULT };
    }
  }
  /** 提醒为什么发不出去（发得出去时为 null）。和后端 ReminderServiceImpl.isEnabled 同一个条件：开关开着、渠道凭据齐全。 */
  async function reminderBlocker() {
    try {
      var settings = (await api.get('/reminder/settings')) || {};
      if (!reminderChannelReady(settings)) return '还没填推送渠道的凭据';
      if (!settings.enabled) return '「提醒推送」没有打开';
      return null;
    } catch (e) {
      return null;
    }
  }
  /** onSaved：保存之后刷新什么（任务页传自己的 bootTasks，看板上的「新增任务」传 bootDashboard）—— 第三十四轮任务页挪进模块之后壳里不再有默认值。 */
  async function openTaskForm(id, onSaved) {
    var before = id == null ? null : state.tasks.find(function (x) { return x.id === id; });
    if (id != null && !before) return;
    var remind = before ? await currentRemind(id) : { mode: TASK_REMIND.DEFAULT };
    openModal({
      title: before ? '编辑任务' : '新建任务',
      width: '560px',
      bodyHtml: taskFormHtml(before || {}, remind, !before),
      onMount: function (b, h) {
        var modeSel = $('#zq-tf-mode', b), days = $('#zq-tf-days', b), ok = $('#zq-tf-ok', b);
        modeSel.onchange = function () { days.hidden = modeSel.value !== TASK_REMIND.CUSTOM; if (!days.hidden) days.focus(); };
        // 提醒发不出去要当场说（2026-10-03 走主流程）：原来没配推送渠道时照样让人设提醒时间，到点服务端记一条
        // 「提醒渠道未启用或未配置」，界面上哪里都看不出来 —— 用户以为会被提醒。查不到设置就不说（不拦着建任务）
        reminderBlocker().then(function (why) {
          var warn = $('#zq-tf-remind-warn', b);
          if (!why || !warn) return;
          warn.innerHTML = '提醒现在还发不出去：' + esc(why) + '。<a href="#settings/reminders" style="color:inherit;font-weight:var(--zq-fw-medium);">去设置 →</a>';
          warn.hidden = false;
        });
        // 新建时打的字：弹窗被遮罩点掉、刷新、登录过期都还在（第十五轮）；建好了才删
        var keep = before ? [] : [keepDraft($('#zq-tf-title', b), 'task.new.title'), keepDraft($('#zq-tf-desc', b), 'task.new.desc')];
        $('#zq-tf-cancel', b).onclick = h.close;
        ok.onclick = function () {
          if (ok.disabled) return;
          var weeks = $('#zq-tf-weeks', b);
          var plan = taskFormPayload({
            title: $('#zq-tf-title', b).value, description: $('#zq-tf-desc', b).value,
            quadrant: $('#zq-tf-q', b).value, priority: $('#zq-tf-p', b).value,
            startTime: $('#zq-tf-start', b).value, durationMinutes: $('#zq-tf-dur', b).value,
            deadline: $('#zq-tf-deadline', b).value, reminderTime: $('#zq-tf-remind', b).value,
            remindMode: modeSel.value, remindDays: days.value, repeatWeeks: weeks ? weeks.value : ''
          }, businessNowText(), before);
          if (plan.error) return toast(plan.error, 'error');
          if (plan.body.reminderTime || plan.body.deadline) askNotifyPermission();   // 页面开着时到点弹通知（第二十五轮）；在点击里问，浏览器才肯弹授权框
          // 幂等键交给 request()：原来这里每次点击生成一个新键 —— 回应丢了、学生照着「网络连接失败」再点一次，拿的是新键，
          // 服务器当成新的一次，建出两份（第二十二轮实测）。request() 在「不确定有没有保存上」之后，内容一样的下一次沿用同一个键。
          ok.disabled = true;
          safe(before ? '保存任务' : '创建任务', async function () {
            var res = await api[plan.method](plan.url, plan.body);
            keep.forEach(function (k) { k.clear(); });
            refreshUpcomingReminders();   // 刚设的提醒马上进页面里的提醒清单，不等 10 分钟那一趟
            h.close();
            toast(before ? '任务已保存' : (res && res.created ? '已创建 ' + res.created + ' 条（每周一条）' : '任务已创建'));
            if (onSaved) await onSaved();
          }).finally(function () { ok.disabled = false; });
        };
      }
    });
  }
  // /ai/models 返回的是对象 {systemModels, userModels, defaultModelId,...}，统一拍平成数组
  function normalizeModelList(data) {
    if (Array.isArray(data)) return data;
    if (!data) return [];
    var mine = (data.userModels || []).map(function (m) { return Object.assign({ ownerType: 'USER' }, m); });
    var sys = (data.systemModels || []).map(function (m) { return Object.assign({ ownerType: 'SYSTEM' }, m); });
    return mine.concat(sys);
  }
  // 参考计划的分类（第二十六轮改成办公方向）：[key, 名字, 配色]。同一份清单在 V40 迁移和 SharedPlanServiceImpl.CATEGORY_NAMES 里，
  // PlanCategoryListTest 核对三处一致 —— 原来这里散着五份（筛选、卡片、提交、审核列表、审核编辑），各写各的。
  var PLAN_CATEGORIES = [
    ['PROJECT', '项目推进', 'q1'], ['MEETING', '会议与汇报', 'q2'], ['ROUTINE', '日常事务', 'q3'],
    ['COMPUTER', '技能提升', 'q2'], ['LANGUAGE', '外语', 'q3'], ['EXAM', '考证与培训', 'q1'], ['GENERAL', '通用规划', 'q4']
  ];
  function planCategory(key) {
    var k = String(key || '').toUpperCase();
    return PLAN_CATEGORIES.find(function (c) { return c[0] === k; }) || null;
  }
  function planCategoryOptions(selected, withAll) {
    var k = String(selected || '').toUpperCase();
    return (withAll ? '<option value="">全部</option>' : '') + PLAN_CATEGORIES.map(function (c) {
      return '<option value="' + c[0] + '"' + (c[0] === k ? ' selected' : '') + '>' + c[1] + '</option>';
    }).join('');
  }
  function mathBlockHtml(tex) {
    return '<div class="zq-math" data-tex="' + esc(tex) + '" contenteditable="false"><span class="zq-mono">' + esc(tex) + '</span></div>';
  }
  function inlineMathSpan(tex) {
    return '<span class="zq-math-i" data-tex="' + tex.replace(/"/g, '&quot;') + '" contenteditable="false"><span class="zq-mono">' + tex + '</span></span>';
  }
  // Preserve embed syntax on the wrapper: preview content is never copied into the parent note on save.
  function markdownImage(raw, target, alt, width, height, wiki) {
    var fragmentAt = target.indexOf('#');
    var path = fragmentAt < 0 ? target : target.slice(0, fragmentAt);
    var fragment = fragmentAt < 0 ? '' : target.slice(fragmentAt + 1);
    var privateImage = /^\/api\/knowledge\/images\/[1-9]\d*$/.test(path);
    var privateAttachment = /^\/api\/knowledge\/attachments\/[1-9]\d*$/.test(path);
    var externalImage = /^https?:\/\/[^\s<>"']+$/i.test(target);
    var style = width ? ' style="max-width:min(100%,' + width + 'px)' + (height ? ';width:' + width + 'px;height:' + height + 'px;object-fit:contain' : '') + '"' : '';
    var dimensions = width ? ' width="' + width + '"' + (height ? ' height="' + height + '"' : '') : '';
    var label = alt || path.split('/').pop() || '附件';
    if (privateAttachment) return '<span class="zq-embed zq-attachment-embed" data-embed-markdown="' + esc(raw)
      + '" data-zq-attachment="' + esc(path) + '" data-embed-fragment="' + esc(fragment)
      + '" contenteditable="false"><span class="zq-embed-status">正在加载附件…</span></span>';
    // Extensionless Wiki targets and .md targets are notes, including #heading / #^block anchors.
    var knownTitle = typeof state !== 'undefined' && (state.wikiPages || []).some(function (page) {
      return String(page.title || '') === path.replace(/\.md$/i, '');
    });
    var note = wiki && !privateImage && !externalImage && !/^\w+:/.test(path)
      && (knownTitle || !/\.[^/.]+$/.test(path) || /\.md$/i.test(path));
    if (note) return '<span class="zq-embed zq-note-embed" data-embed-markdown="' + esc(raw)
      + '" data-zq-note-embed="' + esc(target) + '" contenteditable="false"><span class="zq-embed-status">正在加载知识页：' + esc(label) + '</span></span>';
    if (!privateImage && !externalImage) return '<span class="zq-md-image zq-md-image-missing" data-image-markdown="'
      + esc(raw) + '" contenteditable="false">文件未找到：' + esc(label) + '</span>';
    var source = privateImage ? ' data-zq-private-image="' + esc(path) + '"' : ' src="' + esc(target) + '"';
    return '<span class="zq-md-image" data-image-markdown="' + esc(raw) + '" contenteditable="false">'
      + '<img alt="' + esc(label) + '"' + source + style + dimensions + ' loading="lazy" decoding="async"></span>';
  }
  // Extract an Obsidian section without treating headings / block IDs inside fenced code as anchors.
  function wikiEmbedSection(markdown, anchor) {
    var text = String(markdown || '').replace(/\r/g, '');
    if (!anchor) return text;
    try { anchor = decodeURIComponent(anchor); } catch (ignored) {}
    var lines = text.split('\n'), fenced = false, visible = [];
    lines.forEach(function (line, i) {
      if (/^\s*(`{3,}|~{3,})/.test(line)) { fenced = !fenced; visible[i] = false; }
      else visible[i] = !fenced;
    });
    if (anchor.charAt(0) === '^') {
      var id = anchor.slice(1);
      for (var i = 0; i < lines.length; i++) {
        if (!visible[i]) continue;
        var marker = lines[i].match(/(?:^|\s)\^([\w-]+)\s*$/);
        if (!marker || marker[1] !== id) continue;
        var first = i;
        while (first > 0 && visible[first - 1] && lines[first - 1].trim() && !/^#{1,6}\s/.test(lines[first - 1])) first--;
        return lines.slice(first, i + 1).join('\n').replace(/(?:^|\s)\^[\w-]+\s*$/, '').trim();
      }
      return null;
    }
    var start = -1, level = 0;
    for (var j = 0; j < lines.length; j++) {
      var h = visible[j] && lines[j].match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
      if (!h) continue;
      var title = h[2].replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2$1').replace(/[*_`]/g, '').trim();
      if (start < 0 && title === anchor) { start = j; level = h[1].length; }
      else if (start >= 0 && h[1].length <= level) return lines.slice(start, j).join('\n').trim();
    }
    return start < 0 ? null : lines.slice(start).join('\n').trim();
  }
  function markdownFileLink(raw, path, label) {
    return '<span class="zq-file-link" data-embed-markdown="' + esc(raw) + '" data-zq-attachment-probe="' + esc(path) + '"><a href="' + esc(path)
      + '" data-zq-private-download="' + esc(path) + '" data-zq-private-preview="1">' + mdInline(label, true) + '</a></span>';
  }
  // Bare links are extracted before formatting so URL stars / underscores cannot become emphasis.
  // Keep their original source separately: saving an unchanged link must not add [label](url) syntax.
  function markdownAutolinks(text, protect, noAutolinks, restoreCodeSource) {
    // Scan formulas and URLs together: $ inside a URL is literal, a URL inside $…$ stays a formula.
    return text.replace(/\$\$([^$\n]{1,200}?)\$\$|\$([^$\n]{1,200}?)\$|<https?:\/\/[^\s<>"'`\u0000-\u001f]+>|https?:\/\/[^\s<>"'`\u0000-\u001f，。；：！？、（）【】《》“”‘’]+/gi, function (raw, displayTex, inlineTex, offset, original) {
      var tex = displayTex == null ? inlineTex : displayTex;
      if (tex != null) return /[\\^_{}a-zA-Z]/.test(tex) ? protect(inlineMathSpan(esc(restoreCodeSource(tex)))) : raw;
      if (noAutolinks) return raw;
      var angle = raw.charAt(0) === '<';
      if (!angle && /[a-z0-9_@]/i.test(original.charAt(offset - 1))) return raw;
      var target = angle ? raw.slice(1, -1) : raw;
      if (!angle) {
        var counts = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 }, pairs = { ')': '(', ']': '[', '}': '{' };
        for (var i = 0; i < target.length; i++) { var ch = target.charAt(i); if (counts[ch] != null) counts[ch]++; }
        var end = target.length;
        while (end) {
          var last = target.charAt(end - 1), opener = pairs[last];
          if (/[.,:;!?*]/.test(last)) end--;
          else if (opener && counts[last] > counts[opener]) { counts[last]--; end--; }
          else break;
        }
        target = target.slice(0, end);
      }
      try { var url = new URL(target); if (!/^https?:$/.test(url.protocol) || !url.hostname) return raw; } catch (ignored) { return raw; }
      var source = angle ? raw : target;
      return protect('<a href="' + esc(target) + '" target="_blank" rel="noopener noreferrer" data-autolink-markdown="' + esc(source) + '">' + esc(target) + '</a>')
        + (angle ? '' : raw.slice(target.length));
    });
  }
  function mdInline(t, noAutolinks) {
    // 行内代码先抽成占位符：反引号里的 $、*、[ 等都是字面量，不参与公式/加粗/链接解析
    var codeSlots = [];
    var imageSlots = [];
    var sourceSlots = [];
    function protect(html, source) { imageSlots.push(html); sourceSlots.push(source); return '\u0003' + (imageSlots.length - 1) + '\u0003'; }
    function restoreCodeSource(value) {
      return value == null ? value : String(value).replace(/\u0001(\d+)\u0001/g, function (_marker, i) { return '`' + codeSlots[+i] + '`'; });
    }
    function restoreInlineSource(value) {
      return restoreCodeSource(String(value).replace(/\u0003(\d+)\u0003/g, function (_marker, i) { return sourceSlots[+i]; }));
    }
    t = String(t == null ? '' : t).replace(/`([^`]+)`/g, function (m, c) { codeSlots.push(c); return '\u0001' + (codeSlots.length - 1) + '\u0001'; });
    t = t.replace(/!\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\)/g, function (raw, wiki, alt, standardTarget) {
      raw = restoreCodeSource(raw); wiki = restoreCodeSource(wiki); alt = restoreCodeSource(alt); standardTarget = restoreCodeSource(standardTarget);
      var parts = wiki ? wiki.split('|') : [];
      var target = wiki ? parts[0] : standardTarget;
      var size = wiki && parts.length > 1 && /^[1-9]\d{0,3}(?:x[1-9]\d{0,3})?$/.test(parts[parts.length - 1]) ? parts[parts.length - 1].split('x') : null;
      if (/^<[^<>]+>$/.test(target)) target = target.slice(1, -1);
      return protect(markdownImage(raw, target.trim(), wiki && !size ? parts.slice(1).join('|') : alt,
        size ? Math.min(2400, Number(size[0])) : null, size && size[1] ? Math.min(2400, Number(size[1])) : null, !!wiki), raw);
    });
    // Private file wrappers contain original Markdown attributes. Protect them from subsequent italic/link parsing.
    t = t.replace(/\[([^\]]+)\]\((\/api\/knowledge\/attachments\/[1-9]\d*)\)|\[\[([^\]\n]+)\]\]/g, function (raw, label, path, wikiFile) {
      if (wikiFile) {
        var parts = wikiFile.split('|');
        var match = parts[0].match(/^(\/api\/knowledge\/(?:images|attachments)\/[1-9]\d*)(?:#.*)?$/);
        if (!match) {
          return protect('<a data-wikilink="' + esc(restoreCodeSource(wikiFile)) + '">' + mdInline(restoreCodeSource(parts[1] || parts[0]), true) + '</a>', restoreCodeSource(raw));
        }
        path = match[1]; label = parts[1] || parts[0];
      }
      return protect(markdownFileLink(restoreCodeSource(raw), path, restoreCodeSource(label)), restoreCodeSource(raw));
    });
    t = t
      // URL 支持一层配对括号（如维基百科的 Function_(mathematics)），不再截断在第一个 )
      .replace(/\[([^\]]+)\]\((https?:\/\/(?:[^()\s]|\([^()]*\))+)\)/gi, function (_raw, label, target) {
        return protect('<a href="' + esc(restoreInlineSource(target)) + '" target="_blank" rel="noopener noreferrer">' + mdInline(restoreInlineSource(label), true) + '</a>', restoreInlineSource(_raw));
      });
    t = markdownAutolinks(t, protect, noAutolinks, restoreCodeSource);
    t = esc(t).replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return t.replace(/\u0001(\d+)\u0001/g, function (m, i) { return '<code>' + esc(codeSlots[+i]) + '</code>'; })
      .replace(/\u0003(\d+)\u0003/g, function (m, i) { return imageSlots[+i]; });
  }
  // 完整块类型渲染，对齐 claude design 静态模板：标题/正文/列表/任务勾选/引用/代码块/分隔线/相关页面双链

  // ── 代码块着色 ────────────────────────────────────────────────────────────
  //
  // 自己写的小分词器，不引 highlight.js：它 100KB 起步，会拖慢每个页面的首屏，
  // 而在聊天里读一段代码，需要分开的只有「注释 / 字符串 / 关键字 / 数字」四类。
  //
  // 安全上真正load-bearing 的只有一条不变量：
  //   **每段 token 文本恰好走一次 esc()，分词器自己从不产出标记。**
  // 满足它，输出对任意输入都安全；破坏它（少转义、多转义、吞字符）都会被
  // 「剥掉着色 span 后必须与直接 esc 整段逐字相同」这条判据抓到。
  //
  // 顺序（先分词、后转义）另有原因，但**不是**安全：分词器要看到原始的
  // " 和 < 才能认出字符串；先整段转义的话 " 变成 &quot;，字符串就再也识别不出来，
  // 结果只是不着色 —— 实测过，不会长出标签。别把它当成安全边界来记。

  var CODE_KEYWORDS = ('abstract,assert,async,await,bool,boolean,break,byte,case,catch,char,class,const,'
    + 'continue,def,default,del,delete,do,double,elif,else,enum,except,export,extends,final,finally,float,'
    + 'for,from,func,function,go,goto,if,impl,implements,import,in,instanceof,int,interface,is,lambda,let,'
    + 'long,match,new,not,or,package,pass,print,private,protected,public,raise,return,select,self,short,'
    + 'static,struct,super,switch,synchronized,this,throw,throws,trait,try,type,typeof,use,var,void,'
    + 'volatile,while,with,yield,true,false,null,None,True,False,nil,undefined,'
    + 'SELECT,FROM,WHERE,INSERT,UPDATE,DELETE,JOIN,GROUP,ORDER,BY,HAVING,LIMIT').split(',');
  var CODE_KEYWORD_SET = Object.create(null);
  CODE_KEYWORDS.forEach(function (k) { CODE_KEYWORD_SET[k] = 1; });

  // 只有这些语言里 # 才是行注释。不分语言的话，JS 的私有字段 this.#x
  // 会让整行被涂成注释色 —— 语言未知时宁可不着色，也不要涂错。
  var HASH_COMMENT_LANGS = { python: 1, py: 1, sh: 1, bash: 1, shell: 1, zsh: 1, ruby: 1, rb: 1,
    yaml: 1, yml: 1, r: 1, perl: 1, makefile: 1, make: 1, toml: 1, ini: 1, conf: 1, dockerfile: 1 };

  /** 把源码切成 [类型, 文本] 段；类型只有 c/s/k/n 四种，其余是普通文本。 */
  function tokenizeCode(src, lang) {
    var hashIsComment = !!HASH_COMMENT_LANGS[String(lang || '').toLowerCase()];
    var out = [], i = 0, plain = '';
    function flush() { if (plain) { out.push(['', plain]); plain = ''; } }
    while (i < src.length) {
      var two = src.substr(i, 2);
      if (two === '/*') {                                       // 块注释
        var be = src.indexOf('*/', i + 2);
        be = be < 0 ? src.length : be + 2;
        flush(); out.push(['c', src.slice(i, be)]); i = be; continue;
      }
      if (two === '//' || (hashIsComment && src[i] === '#')) {   // 行注释
        var nl = src.indexOf('\n', i);
        if (nl < 0) nl = src.length;
        flush(); out.push(['c', src.slice(i, nl)]); i = nl; continue;
      }
      if (src[i] === '"' || src[i] === "'" || src[i] === '`') {  // 字符串（含 \ 转义）
        var q = src[i], j = i + 1;
        while (j < src.length && src[j] !== q) { j += (src[j] === '\\' ? 2 : 1); }
        j = Math.min(j + 1, src.length);
        flush(); out.push(['s', src.slice(i, j)]); i = j; continue;
      }
      if (src[i] >= '0' && src[i] <= '9' && !/[\w.]/.test(src[i - 1] || '')) {   // 数字
        var k = i;
        while (k < src.length && /[0-9a-fA-FxXbo._]/.test(src[k])) k++;
        flush(); out.push(['n', src.slice(i, k)]); i = k; continue;
      }
      if (/[A-Za-z_$]/.test(src[i])) {                          // 标识符 → 可能是关键字
        var w = i;
        while (w < src.length && /[\w$]/.test(src[w])) w++;
        var word = src.slice(i, w);
        flush(); out.push([CODE_KEYWORD_SET[word] ? 'k' : '', word]); i = w; continue;
      }
      plain += src[i++];
    }
    flush();
    return out;
  }

  var CODE_COLORS = { c: 'var(--zq-text3)', s: 'var(--zq-q4)', k: 'var(--zq-q2)', n: 'var(--zq-q3)' };

  /** 着色后的 HTML。每段单独 esc()，见上面关于顺序的说明。 */
  function highlightCode(src, lang) {
    return tokenizeCode(String(src == null ? '' : src), lang).map(function (t) {
      var safe = esc(t[1]);
      var color = CODE_COLORS[t[0]];
      return color ? '<span style="color:' + color + ';">' + safe + '</span>' : safe;
    }).join('');
  }

  /** 着色的分段（第七十三轮：知识 Wiki 新编辑器里的代码块用同一套颜色）：[{ text, color }]，color 为 null 的不着色 */
  function codeTokens(src, lang) {
    return tokenizeCode(String(src == null ? '' : src), lang).map(function (t) { return { text: t[1], color: CODE_COLORS[t[0]] || null }; });
  }

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
    var html = '', inCode = false, inMath = false, codeBuf = [], codeLang = '', mathBuf = [], quoteBuf = [], tableBuf = [];
    // 列表是一摞（第七十一轮认嵌套；原来只认顶格的，缩进的子项显示成文字「- 子项」）：每层记缩进和种类（ul / ol / task）。
    // 比上一层多缩进两格以上是嵌套，退到父项那一档才收掉更深的层；任务项照旧画成 .zq-task-row，它下面的子项放进 .zq-task-children。
    // 空行之后不缩进的行收掉整摞（顶层隔空行照旧是两段 —— 旧编辑器保存时靠它写回空行），编号从几开始写在 start 上。
    var lists = [], listBlank = false;
    function indentOf(text) {
      var n = 0;
      for (var i = 0; i < text.length; i++) {
        var c = text.charAt(i);
        if (c === ' ') n++; else if (c === '\t') n += 4 - n % 4; else break;
      }
      return n;
    }
    function closeList() {
      var top = lists.pop();
      if (top.kind !== 'task') html += '</li></' + top.kind + '>';
      else if (top.children) html += '</div>';
    }
    function closeLists() { while (lists.length) closeList(); listBlank = false; }
    function taskChildren(top) { if (!top.children) { html += '<div class="zq-task-children">'; top.children = true; } }
    function listItem(indent, kind, itemHtml, start) {
      listBlank = false;
      // 缩进比这一层浅、但还在父项下面（比父项多两格以上）：缩进不齐的同一层，不另起；顶层的项不管缩进多少都是同一段
      while (lists.length > 1 && indent < lists[lists.length - 1].indent && indent < lists[lists.length - 2].indent + 2) closeList();
      var top = lists[lists.length - 1];
      if (top && indent < top.indent + 2) {
        if (top.kind === kind && kind !== 'task') { html += '</li><li>' + itemHtml; return; }
        indent = top.indent; closeList(); top = lists[lists.length - 1];
      }
      if (top && top.kind === 'task') taskChildren(top);
      if (kind === 'task') html += itemHtml;
      else html += '<' + kind + (kind === 'ol' && start !== 1 ? ' start="' + start + '"' : '') + '><li>' + itemHtml;
      lists.push({ kind: kind, indent: indent });
    }
    function listText(indent, text) {
      var popped = false;
      while (lists.length > 1 && indent < lists[lists.length - 1].indent + 2) { closeList(); popped = true; }
      var top = lists[lists.length - 1];
      if (top.kind === 'task') { taskChildren(top); html += '<p>' + mdInline(text) + '</p>'; }
      else html += listBlank || popped ? '<p>' + mdInline(text) + '</p>' : '<br>' + mdInline(text);
      listBlank = false;
    }
    function flushQuote() {
      if (!quoteBuf.length) return;
      html += '<blockquote>' + quoteBuf.join('<br>') + '</blockquote>';
      quoteBuf = [];
    }
    function flushTable() {
      if (!tableBuf.length) return;
      var rows = tableBuf.map(function (l) {
        return l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
      });
      // 只有横线（第四十四轮；原来每一格四面描边、表头灰底，一张表像一张格子纸），表头的线深一档 —— 样子在 zhiqu-ui.css 的 .zq-md table
      var hasHeader = rows.length > 1 && rows[1].length && rows[1].every(function (c) { return c === '' || /^:?-{2,}:?$/.test(c); }) && rows[1].some(function (c) { return /-{2,}/.test(c); });
      var out = '<div class="zq-md-table"><table>';
      if (hasHeader) {
        out += '<thead><tr>' + rows[0].map(function (c) { return '<th>' + mdInline(c) + '</th>'; }).join('') + '</tr></thead>';
        rows = rows.slice(2);
      }
      out += '<tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
      html += out;
      tableBuf = [];
    }
    function closeBlocks() { closeLists(); flushQuote(); flushTable(); }
    lines.forEach(function (line) {
      if (/^```/.test(line.trim())) {
        if (inCode) {
          html += '<pre><code class="zq-mono">' + highlightCode(codeBuf.join('\n'), codeLang) + '</code></pre>';
          codeBuf = []; inCode = false;
        } else { closeBlocks(); inCode = true; codeLang = line.trim().slice(3).trim(); }
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
      if (/^\|.*\|\s*$/.test(line.trim())) { closeLists(); flushQuote(); tableBuf.push(line.trim()); return; }
      flushTable();
      var indent = indentOf(line);
      if (listBlank && lt !== '' && indent < lists[0].indent + 2) closeLists();
      var h = line.match(/^(#{1,6})\s+(.+)$/);
      var task = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/);
      var li = line.match(/^(\s*)[-*]\s+(.+)$/);
      var ol = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
      var q = line.match(/^>\s?(.*)$/);
      if (h) { closeBlocks(); var lvl = h[1].length; html += '<h' + lvl + '>' + mdInline(h[2]) + '</h' + lvl + '>'; }
      else if (task) {
        flushQuote();
        var done = task[2].toLowerCase() === 'x';
        // 勾上了的划掉、变淡：样式表按 input:checked 画（第五十五轮；原来渲染时写死在 span 上，点一下勾选框样子不跟着变）
        listItem(indent, 'task', '<div class="zq-task-row"><input type="checkbox" ' + (done ? 'checked ' : '') + 'contenteditable="false"><span>' + mdInline(task[3]) + '</span></div>');
      }
      else if (li) { flushQuote(); listItem(indent, 'ul', mdInline(li[2])); }
      else if (ol) { flushQuote(); listItem(indent, 'ol', mdInline(ol[3]), parseInt(ol[2], 10)); }
      else if (q) { closeLists(); quoteBuf.push(mdInline(q[1])); }
      else if (/^(-{3,}|\*{3,})$/.test(line.trim())) { closeBlocks(); html += '<hr>'; }
      else if (lt === '') { if (lists.length) listBlank = true; else closeBlocks(); }
      else if (lists.length && indent >= lists[0].indent + 2) listText(indent, lt);
      else { closeBlocks(); html += '<p>' + mdInline(line) + '</p>'; }
    });
    if (inCode) { html += '<pre><code class="zq-mono">' + highlightCode(codeBuf.join('\n'), codeLang) + '</code></pre>'; }
    if (inMath && mathBuf.length) { html += mathBlockHtml(mathBuf.join('\n')); }
    closeBlocks();
    // 样子全在 zhiqu-ui.css 的 .zq-md（第五十五轮：原来每个标签带一串内联样式 —— 编辑器插进去的标题、列表没有这些，和渲染出来的不一样；
    // 知识 Wiki 的正文另加 .zq-prose 放大、限行宽）
    return '<div class="zq-md">' + (html || '<p></p>') + '</div>';
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
  var privateMedia = new Map();
  var privateViews = new Set();
  var privatePreviewSerial = 0;
  // 私有图片下载回来的字节留一份（第七十四轮 review：新编辑器里图片滚出可视区，CodeMirror 把那块 DOM 拆了，滚回来是一个新的 img，
  // 原来每次都重新下载一遍）。按登录分开，最多 48 MiB、最久没用的先丢；换登录、退出时清空。
  var PRIVATE_IMAGE_CACHE_BYTES = 48 * 1024 * 1024;
  var privateImageBlobs = new Map(), privateImageBytes = 0;
  function cachedPrivateImage(url, auth) {
    var hit = privateImageBlobs.get(url);
    if (!hit || hit.auth !== auth) return null;
    privateImageBlobs.delete(url); privateImageBlobs.set(url, hit);
    return hit.blob;
  }
  function keepPrivateImage(url, auth, blob) {
    var old = privateImageBlobs.get(url);
    if (old) { privateImageBytes -= old.blob.size; privateImageBlobs.delete(url); }
    if (!(blob.size > 0) || blob.size > PRIVATE_IMAGE_CACHE_BYTES / 4) return;
    privateImageBlobs.set(url, { auth: auth, blob: blob }); privateImageBytes += blob.size;
    privateImageBlobs.forEach(function (entry, key) {
      if (privateImageBytes > PRIVATE_IMAGE_CACHE_BYTES && key !== url) { privateImageBytes -= entry.blob.size; privateImageBlobs.delete(key); }
    });
  }
  /** 同一张图、同一个登录只下载一次：有留着的字节就用，正在下载就共用那一趟（同一页上两处一样的图、编辑器在下载途中把图拆了重画） */
  var privateImageLoads = new Map();
  function loadPrivateImage(url, auth) {
    var cached = cachedPrivateImage(url, auth);
    if (cached) return Promise.resolve(cached);
    var pending = privateImageLoads.get(url);
    if (pending && pending.auth === auth) return pending.promise;
    var promise = api.download(url.slice(API.length)).then(function (result) {
      if (!/^image\/(png|jpeg|gif|webp|bmp)$/i.test(result.blob.type || '')) throw requestError('图片格式无效');
      if (token() === auth) keepPrivateImage(url, auth, result.blob);
      return result.blob;
    });
    var entry = { auth: auth, promise: promise };
    function settled() { if (privateImageLoads.get(url) === entry) privateImageLoads.delete(url); }
    privateImageLoads.set(url, entry); promise.then(settled, settled);
    return promise;
  }
  function revokePrivateMedia() {
    privateImageBlobs.clear(); privateImageBytes = 0; privateImageLoads.clear();
    privateMedia.forEach(function (url, media) {
      if (media.getAttribute('src') === url || String(media.getAttribute('src') || '').indexOf(url + '#') === 0) media.removeAttribute('src');
      if (media.pause) media.pause();
      URL.revokeObjectURL(url);
      media.removeAttribute('data-zq-loaded');
    });
    privateMedia.clear();
    privateViews.forEach(function (view) {
      view.innerHTML = '<span class="zq-embed-status">登录后查看嵌入内容</span>';
      delete view.dataset.zqLoaded; delete view.dataset.zqLoading; delete view.dataset.zqPreviewId;
    });
    privateViews.clear();
  }
  function preserveEmbedViewport(view, mutate) {
    var doc = view.closest && view.closest('#zq-doc');
    var md = doc && doc.querySelector('.zq-md');
    var anchor = md && Array.from(md.children || []).find(function (child) {
      var rect = child.getBoundingClientRect(); return rect.height && rect.bottom > doc.getBoundingClientRect().top;
    });
    var before = anchor && anchor.getBoundingClientRect().top;
    mutate();
    if (anchor && anchor.isConnected) doc.scrollTop += anchor.getBoundingClientRect().top - before;
  }
  function previewIsCurrent(element, auth, serial) {
    return element.isConnected && token() === auth && !!auth && element.dataset.zqPreviewId === serial;
  }
  function canvasPreviewHtml(data) {
    var originals = data && Array.isArray(data.nodes) ? data.nodes : [];
    var nodes = originals.slice(0, 50).map(function (node, index) {
      function finite(value, fallback, min, max) { return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback; }
      return { id: String(node.id || index), x: finite(node.x, index * 220, -10000, 10000), y: finite(node.y, 0, -10000, 10000),
        width: finite(node.width, 200, 80, 2000), height: finite(node.height, 120, 60, 2000),
        label: String(node.text || node.file || node.label || node.url || node.type || '节点').slice(0, 320), type: node.type };
    });
    if (!nodes.length) return '<span class="zq-embed-status">Canvas 暂无节点</span>';
    var left = Math.min.apply(null, nodes.map(function (n) { return n.x; })) - 24;
    var top = Math.min.apply(null, nodes.map(function (n) { return n.y; })) - 24;
    var right = Math.max.apply(null, nodes.map(function (n) { return n.x + n.width; })) + 24;
    var bottom = Math.max.apply(null, nodes.map(function (n) { return n.y + n.height; })) + 24;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + left + ' ' + top + ' ' + (right - left) + ' ' + (bottom - top)
      + '" role="img" aria-label="Canvas 节点与连线预览">';
    function point(node, side) {
      if (side === 'top') return [node.x + node.width / 2, node.y];
      if (side === 'bottom') return [node.x + node.width / 2, node.y + node.height];
      if (side === 'left') return [node.x, node.y + node.height / 2];
      return [node.x + node.width, node.y + node.height / 2];
    }
    var edges = data && Array.isArray(data.edges) ? data.edges.slice(0, 100) : [];
    edges.forEach(function (edge) {
      var from = nodes.find(function (node) { return node.id === String(edge.fromNode); });
      var to = nodes.find(function (node) { return node.id === String(edge.toNode); });
      if (!from || !to) return;
      var a = point(from, edge.fromSide || 'right'), b = point(to, edge.toSide || 'left');
      svg += '<line class="zq-canvas-edge" x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '"></line>';
      if (edge.toEnd !== 'none') {
        var dx = b[0] - a[0], dy = b[1] - a[1], length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        var vx = dx / length * 10, vy = dy / length * 10;
        svg += '<polyline class="zq-canvas-edge" points="' + (b[0] - vx - vy / 2) + ',' + (b[1] - vy + vx / 2) + ' '
          + b[0] + ',' + b[1] + ' ' + (b[0] - vx + vy / 2) + ',' + (b[1] - vy - vx / 2) + '"></polyline>';
      }
      if (edge.label) svg += '<text class="zq-canvas-label" x="' + ((a[0] + b[0]) / 2) + '" y="' + ((a[1] + b[1]) / 2 - 8) + '">' + esc(String(edge.label).slice(0, 60)) + '</text>';
    });
    nodes.forEach(function (node) {
      svg += '<g class="zq-canvas-node' + (node.type === 'group' ? ' zq-canvas-group' : '') + '"><rect x="' + node.x + '" y="' + node.y
        + '" width="' + node.width + '" height="' + node.height + '" rx="8"></rect><text x="' + (node.x + 12) + '" y="' + (node.y + 24) + '">';
      var characters = Math.max(6, Math.min(60, Math.floor((node.width - 24) / 8)));
      var label = node.label.replace(/\r/g, '').split('\n').join(' '), rows = Math.min(5, Math.floor((node.height - 16) / 20));
      for (var i = 0; i < rows && i * characters < label.length; i++) svg += '<tspan x="' + (node.x + 12) + '" dy="' + (i ? 20 : 0) + '">' + esc(label.slice(i * characters, (i + 1) * characters)) + '</tspan>';
      svg += '</text></g>';
    });
    return '<span class="zq-canvas-preview">' + svg + '</svg></span><span class="zq-embed-status">' + originals.length + ' 个节点 · '
      + (Array.isArray(data.edges) ? data.edges.length : 0) + ' 条连线' + (originals.length > 50 || (Array.isArray(data.edges) && data.edges.length > 100) ? ' · 预览仅显示前 50 个节点和 100 条连线' : '') + '</span>';
  }
  function attachmentPreviewHtml(meta, path) {
    var type = String(meta.previewType || 'FILE').toUpperCase();
    var title = '<span class="zq-embed-head"><span>' + esc(meta.name || '附件') + '</span><a href="' + esc(path)
      + '" data-zq-private-download="' + esc(path) + '">下载</a></span>';
    if (type === 'JSON' || type === 'TEXT' || type === 'CANVAS') {
      var canvas = '';
      var originalText = String(meta.text || '').replace(/^\uFEFF/, '');
      var text = originalText.slice(0, 65536), notice = meta.truncated || originalText.length > 65536 ? '<span class="zq-embed-status">预览已截断，下载可查看完整内容</span>' : '';
      if (type === 'JSON' || type === 'CANVAS') {
        try {
          var data = JSON.parse(originalText.slice(0, 524288));
          if (type === 'CANVAS' && data && typeof data === 'object' && !Array.isArray(data)) {
            canvas = canvasPreviewHtml(data);
            text = JSON.stringify(data, null, 2);
          } else text = JSON.stringify(data, null, 2);
        } catch (ignored) { notice += '<span class="zq-embed-status">' + (type === 'CANVAS' ? 'Canvas' : 'JSON') + ' 未通过语法校验，显示原文</span>'; }
      }
      if (text.length > 65536) {
        if (notice.indexOf('预览已截断') < 0) notice += '<span class="zq-embed-status">预览已截断，下载可查看完整内容</span>';
        text = text.slice(0, 65536);
      }
      if (meta.warning) notice += '<span class="zq-embed-status">' + esc(meta.warning) + '</span>';
      var source = '<span class="zq-embed-text"><pre><code>' + esc(text) + '</code></pre></span>';
      return title + canvas + (canvas ? '<details class="zq-canvas-source"><summary>查看 Canvas 原文</summary>' + source + '</details>' : source) + notice;
    }
    if (['IMAGE', 'PDF', 'AUDIO', 'VIDEO'].indexOf(type) >= 0) return title + '<span class="zq-embed-media"><span class="zq-embed-status">正在加载预览…</span></span>';
    return title + '<span class="zq-embed-status">此格式暂无内置预览，可下载后打开。</span>';
  }
  async function hydrateAttachment(view, context) {
    if (view.dataset.zqLoaded || view.dataset.zqLoading) return;
    var path = view.getAttribute('data-zq-attachment');
    if (!/^\/api\/knowledge\/attachments\/[1-9]\d*$/.test(path || '') || !context.auth) return;
    var serial = String(++privatePreviewSerial);
    view.dataset.zqLoading = '1'; view.dataset.zqPreviewId = serial;
    privateViews.add(view);
    try {
      context.metadata = context.metadata || Object.create(null);
      if (!context.metadata[path]) context.metadata[path] = api.get(path.slice(API.length) + '/preview');
      var meta = await context.metadata[path];
      if (!previewIsCurrent(view, context.auth, serial)) return;
      preserveEmbedViewport(view, function () { view.innerHTML = attachmentPreviewHtml(meta || {}, path); });
      view.dataset.zqLoaded = '1';
      view.dispatchEvent(new CustomEvent('zq-wiki-embed-ready', { bubbles: true }));
      var type = String(meta.previewType || 'FILE').toUpperCase();
      var mime = { IMAGE: /^(image\/(?:png|jpeg|gif|webp|bmp))$/i, PDF: /^application\/pdf$/i,
        AUDIO: /^audio\/(?:mpeg|mp4|ogg|wav|x-wav|flac|webm|3gpp)$/i,
        VIDEO: /^video\/(?:mp4|quicktime|webm|ogg|3gpp)$/i };
      if (!mime[type]) return;
      if (!mime[type].test(meta.mimeType || '')) {
        var unsupported = view.querySelector('.zq-embed-media');
        if (unsupported) unsupported.innerHTML = '<span class="zq-embed-status">此文件暂无安全内置预览，请下载后查看。</span>';
        return;
      }
      if (Number(meta.byteSize) > 32 * 1024 * 1024) {
        var large = view.querySelector('.zq-embed-media');
        if (large) large.innerHTML = '<span class="zq-embed-status">附件较大，请下载后查看完整内容。</span>';
        return;
      }
      var downloaded = await api.download(path.slice(API.length));
      if (!previewIsCurrent(view, context.auth, serial)) return;
      // The owned download response deliberately uses octet-stream. Only validated preview metadata determines the Blob's media type.
      var objectUrl = URL.createObjectURL(new Blob([downloaded.blob], { type: meta.mimeType }));
      var media = document.createElement(type === 'IMAGE' ? 'img' : type === 'PDF' ? 'iframe' : type.toLowerCase());
      var fragment = view.getAttribute('data-embed-fragment') || '';
      if (type === 'PDF') {
        var page = fragment.match(/(?:^|&)page=([1-9]\d{0,4})(?:&|$)/), height = fragment.match(/(?:^|&)height=([1-9]\d{0,3})(?:&|$)/);
        media.src = objectUrl + (page ? '#page=' + page[1] : '');
        media.title = meta.name || 'PDF 预览'; media.height = String(height ? Math.min(1200, Math.max(180, Number(height[1]))) : 480);
      } else { media.src = objectUrl; if (type === 'IMAGE') media.alt = meta.name || '图片'; else { media.controls = true; media.preload = 'metadata'; } }
      media.onload = media.onloadedmetadata = function () {
        if (previewIsCurrent(view, context.auth, serial)) view.dispatchEvent(new CustomEvent('zq-wiki-embed-ready', { bubbles: true }));
      };
      media.onerror = function () {
        if (!previewIsCurrent(view, context.auth, serial)) return;
        var errorHolder = view.querySelector('.zq-embed-media');
        if (errorHolder) errorHolder.innerHTML = '<span class="zq-embed-status">当前设备无法显示此媒体，请下载后打开。</span>';
        URL.revokeObjectURL(objectUrl); privateMedia.delete(media);
      };
      privateMedia.set(media, objectUrl);
      var holder = view.querySelector('.zq-embed-media');
      if (holder) preserveEmbedViewport(view, function () { holder.textContent = ''; holder.appendChild(media); });
      view.dispatchEvent(new CustomEvent('zq-wiki-embed-ready', { bubbles: true }));
    } catch (error) {
      if (previewIsCurrent(view, context.auth, serial)) view.innerHTML = '<span class="zq-embed-status">附件预览失败</span><a href="' + esc(path) + '" data-zq-private-download="' + esc(path) + '">下载附件</a>';
    } finally { if (view.dataset.zqPreviewId === serial) delete view.dataset.zqLoading; }
  }
  async function hydrateNote(view, context, ancestry, depth) {
    if (view.dataset.zqLoaded || view.dataset.zqLoading || !context.auth) return;
    var spec = view.getAttribute('data-zq-note-embed') || '', hash = spec.indexOf('#');
    var title = (hash < 0 ? spec : spec.slice(0, hash)).replace(/\.md$/i, '').trim();
    var anchor = hash < 0 ? '' : spec.slice(hash + 1).trim();
    var candidates = (state.wikiPages || []).filter(function (p) { return String(p.title || '') === title; });
    var page = title ? (candidates.length === 1 ? candidates[0] : null) : state.wikiCur;
    if (!page) { view.innerHTML = '<span class="zq-embed-status">知识页未找到：' + esc(title || spec) + '</span>'; return; }
    var noteKey = String(page.id) + '#' + anchor;
    if (depth >= 4 || ancestry.indexOf(noteKey) >= 0 || ++context.count > 24) {
      view.innerHTML = '<span class="zq-embed-status">嵌入已停止：循环引用或超过预览层数</span>'; return;
    }
    var serial = String(++privatePreviewSerial);
    view.dataset.zqLoading = '1'; view.dataset.zqPreviewId = serial; privateViews.add(view);
    try {
      var key = String(page.id);
      if (!context.pages[key]) context.pages[key] = api.get('/knowledge/pages/' + page.id);
      var detail = await context.pages[key];
      if (!previewIsCurrent(view, context.auth, serial)) return;
      var md = wikiEmbedSection(detail.content || '', anchor);
      if (md == null) { view.innerHTML = '<span class="zq-embed-status">知识页中的标题或段落未找到：' + esc(anchor) + '</span>'; return; }
      var room = Math.max(0, Math.min(50000, context.remaining));
      context.remaining -= Math.min(room, md.length);
      preserveEmbedViewport(view, function () { view.innerHTML = '<span class="zq-embed-head"><a data-wikilink="' + esc(spec) + '">' + esc(detail.title || page.title || '知识页')
        + '</a></span><span class="zq-embed-content">' + renderMarkdown(md.slice(0, room)) + '</span>'
        + (md.length > room ? '<span class="zq-embed-status">嵌入预览已截断，打开知识页可查看完整内容。</span>' : ''); });
      view.dataset.zqLoaded = '1';
      hydrateEmbedChildren(view, context, ancestry.concat(noteKey), depth + 1);
      renderMathIn(view, true);
      view.dispatchEvent(new CustomEvent('zq-wiki-embed-ready', { bubbles: true }));
    } catch (error) {
      if (previewIsCurrent(view, context.auth, serial)) view.innerHTML = '<span class="zq-embed-status">知识页预览加载失败，可重新打开页面重试。</span>';
    } finally { if (view.dataset.zqPreviewId === serial) delete view.dataset.zqLoading; }
  }
  async function probeAttachment(link, context) {
    if (link.dataset.zqLoaded || link.dataset.zqLoading || !context.auth) return;
    var path = link.getAttribute('data-zq-attachment-probe');
    if (!/^\/api\/knowledge\/(?:images|attachments)\/[1-9]\d*$/.test(path || '')) return;
    var previewPath = path.replace('/images/', '/attachments/');
    var serial = String(++privatePreviewSerial);
    link.dataset.zqLoading = '1'; link.dataset.zqPreviewId = serial; privateViews.add(link);
    try {
      context.metadata = context.metadata || Object.create(null);
      if (!context.metadata[previewPath]) context.metadata[previewPath] = api.get(previewPath.slice(API.length) + '/preview');
      var meta = await context.metadata[previewPath];
      if (!previewIsCurrent(link, context.auth, serial)) return;
      link.dataset.zqLoaded = '1';
      // Previous imports turned JSON embeds into ordinary links. Restore their readable preview without rewriting the user's Markdown.
      if (String(meta.previewType || '').toUpperCase() !== 'JSON'
          && !(String(meta.previewType || '').toUpperCase() === 'TEXT' && /\.json$/i.test(meta.name || ''))) return;
      var preview = document.createElement('span');
      preview.className = 'zq-embed zq-attachment-embed'; preview.setAttribute('data-zq-attachment', previewPath);
      preserveEmbedViewport(link, function () { link.appendChild(preview); }); hydrateAttachment(preview, context);
    } catch (ignored) { /* Ordinary links remain usable if preview probing fails. */ }
    finally { if (link.dataset.zqPreviewId === serial) delete link.dataset.zqLoading; }
  }
  function hydrateEmbedChildren(root, context, ancestry, depth) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-zq-attachment-probe]'), function (link) {
      context.probes = (context.probes || 0) + 1;
      if (context.probes <= 32) probeAttachment(link, context);
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-zq-attachment]'), function (view) {
      context.attachments = (context.attachments || 0) + 1;
      if (context.attachments <= 32) hydrateAttachment(view, context);
      else view.innerHTML = '<span class="zq-embed-status">附件预览数量较多，请从附件列表打开。</span>';
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-zq-note-embed]'), function (view) { hydrateNote(view, context, ancestry, depth); });
  }
  function openAttachmentPreview(id, name) {
    if (!/^[1-9]\d*$/.test(String(id || ''))) return;
    var path = '/api/knowledge/attachments/' + id;
    return openModal({
      title: name || '附件预览', width: 820,
      bodyHtml: '<span class="zq-embed zq-attachment-embed" data-zq-attachment="' + esc(path) + '" contenteditable="false"><span class="zq-embed-status">正在加载附件…</span></span>',
      onMount: function (body) { renderMathIn(body); }
    });
  }
  function hydratePrivateMedia(root, skipEmbeds) {
    if (!root || !root.querySelectorAll) return;
    privateMedia.forEach(function (url, media) {
      if (!media.isConnected) { if (media.pause) media.pause(); URL.revokeObjectURL(url); privateMedia.delete(media); }
    });
    privateViews.forEach(function (view) { if (!view.isConnected) privateViews.delete(view); });
    Array.prototype.forEach.call(root.querySelectorAll('img[data-zq-private-image]'), function (image) {
      if (image.dataset.zqLoaded || image.dataset.zqLoading) return;
      var url = image.getAttribute('data-zq-private-image');
      if (!/^\/api\/knowledge\/images\/[1-9]\d*$/.test(url || '')) return;
      var authAtStart = token(); if (!authAtStart) return;
      image.dataset.zqLoading = '1';
      loadPrivateImage(url, authAtStart).then(function (blob) {
        if (!image.isConnected || image.getAttribute('data-zq-private-image') !== url || token() !== authAtStart) return;
        var objectUrl = URL.createObjectURL(blob);
        image.onload = function () {
          if (image.isConnected && token() === authAtStart) image.dispatchEvent(new CustomEvent('zq-wiki-embed-ready', { bubbles: true }));
        };
        image.src = objectUrl; image.dataset.zqLoaded = '1'; privateMedia.set(image, objectUrl);
      }).catch(function () {
        if (image.isConnected && token() === authAtStart) image.alt = '图片加载失败：' + (image.alt || '图片');
      }).finally(function () { delete image.dataset.zqLoading; });
    });
    if (!skipEmbeds) hydrateEmbedChildren(root, { auth: token(), pages: Object.create(null), count: 0, remaining: 200000 },
      state.wikiCur ? [String(state.wikiCur.id) + '#'] : [], 0);
    if (!root.dataset || root.dataset.zqPrivateLinksWired) return;
    root.dataset.zqPrivateLinksWired = '1';
    root.addEventListener('click', function (event) {
      var link = event.target && event.target.closest ? event.target.closest('a[data-zq-private-download]') : null;
      if (!link || !root.contains(link)) return;
      event.preventDefault(); event.stopPropagation();
      var path = link.getAttribute('data-zq-private-download'), auth = token();
      if (!/^\/api\/knowledge\/(?:attachments|images)\/[1-9]\d*$/.test(path || '') || !auth) return;
      if (link.getAttribute('data-zq-private-preview') === '1') { openAttachmentPreview(path.split('/').pop(), link.textContent); return; }
      api.download(path.slice(API.length)).then(function (result) {
        if (!link.isConnected || token() !== auth) return;
        var objectUrl = URL.createObjectURL(result.blob), a = document.createElement('a');
        a.href = objectUrl; a.download = result.filename || link.textContent || '附件';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 30000);
      }).catch(function (e) { if (token() === auth) toast(e.message || '附件下载失败', 'error'); });
    });
  }
  function renderMathIn(root, skipEmbeds) {
    if (!root) return;
    hydratePrivateMedia(root, skipEmbeds);
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
    function indentBlock(text, width) {
      var pad = new Array(width + 1).join(' ');
      return text.split('\n').filter(function (l) { return l.trim() !== ''; }).map(function (l, i) { return i ? pad + l : l; }).join('\n');
    }
    function prevBlock(n) {
      var p = n.previousSibling;
      while (p && p.nodeType === 3 && !p.nodeValue.trim()) p = p.previousSibling;
      return p && p.nodeType === 1 ? p : null;
    }
    function isTaskBlock(el) { return !!el && /(^|\s)zq-task-(row|children)(\s|$)/.test(el.getAttribute('class') || ''); }
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
        if (n.getAttribute && n.getAttribute('data-embed-markdown') !== null) {
          out += n.getAttribute('data-embed-markdown');
          return;
        }
        if (n.getAttribute && n.getAttribute('data-image-markdown') !== null) {
          out += n.getAttribute('data-image-markdown');
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
          case 'H5': out += '\n##### ' + inner.trim() + '\n\n'; break;
          case 'H6': out += '\n###### ' + inner.trim() + '\n\n'; break;
          case 'STRONG': case 'B': out += '**' + inner + '**'; break;
          case 'EM': case 'I': out += '*' + inner + '*'; break;
          case 'U': out += '<u>' + inner + '</u>'; break;
          case 'PRE': { var codeTxt = (n.textContent || '').replace(/\n$/, ''); out += '\n```\n' + codeTxt + '\n```\n\n'; break; }
          case 'CODE': out += '`' + inner + '`'; break;
          case 'BLOCKQUOTE': out += '\n' + inner.trim().split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n'; break;
          case 'TABLE': {
            var md = '\n';
            var rows = Array.prototype.filter.call(n.querySelectorAll('tr'), function (tr) {
              var parent = tr.parentNode;
              while (parent && String(parent.tagName || '').toUpperCase() !== 'TABLE') parent = parent.parentNode;
              return parent === n;
            });
            rows.forEach(function (tr, ri) {
              var ownCells = Array.prototype.filter.call(tr.childNodes, function (c) { return c.nodeType === 1 && /^(TH|TD)$/.test(c.tagName.toUpperCase()); });
              var cells = ownCells.map(function (c) { return walk(c).replace(/\n+/g, ' ').trim(); });
              md += '| ' + cells.join(' | ') + ' |\n';
              if (ri === 0 && ownCells.some(function (c) { return c.tagName.toUpperCase() === 'TH'; })) md += '|' + cells.map(function () { return ' --- '; }).join('|') + '|\n';
            });
            out += md + '\n';
            break;
          }
          case 'A': {
            var wl = n.getAttribute('data-wikilink'), href = n.getAttribute('href'), auto = n.getAttribute('data-autolink-markdown');
            var autoTarget = auto && auto.charAt(0) === '<' && auto.slice(-1) === '>' ? auto.slice(1, -1) : auto;
            if (wl) out += '[[' + wl + ']]';
            else if (auto && href === autoTarget && inner === autoTarget) out += auto;
            else if (href) out += '[' + (inner || href) + '](' + href + ')';
            else out += inner;
            break;
          }
          case 'LI': {
            // 嵌套写回缩进、编号照原样（第七十一轮；原来一律「1.」、子项压成一层）：子项的每一行缩到这一项的文字下面
            var parentList = n.parentNode && String(n.parentNode.tagName || '').toUpperCase() === 'OL' ? n.parentNode : null, number = 0;
            if (parentList) {
              number = parseInt(parentList.getAttribute('start'), 10) || 1;
              for (var sib = n.previousSibling; sib; sib = sib.previousSibling) if (sib.nodeType === 1 && String(sib.tagName).toUpperCase() === 'LI') number++;
            }
            var marker = parentList ? number + '. ' : '- ';
            out += marker + indentBlock(inner.trim(), marker.length).replace(/^\s+/, '') + '\n';
            break;
          }
          // 勾选项一行一个、和普通列表项挨着也不插空行（原来每条后面都空一行，保存一次待办清单就散开）
          case 'UL': case 'OL': out += (isTaskBlock(prevBlock(n)) ? '' : '\n') + inner + '\n'; break;
          case 'P': case 'DIV': {
            if (/(^|\s)zq-task-children(\s|$)/.test(n.getAttribute('class') || '')) { out = out.replace(/\n+$/, '\n') + '  ' + indentBlock(inner.trim(), 2) + '\n'; break; }
            var taskRow = /(^|\s)zq-task-row(\s|$)/.test(n.getAttribute('class') || ''), before = prevBlock(n);
            if (taskRow && before && /^(UL|OL)$/.test(String(before.tagName).toUpperCase())) out = out.replace(/\n+$/, '\n');
            else if (out && !/\n$/.test(out)) out += '\n';   // 列表项里文字后面跟着的段落 / 勾选项另起一行
            out += inner.trim() + (taskRow ? '\n' : '\n\n'); break;
          }
          default: out += inner;
        }
      });
      return out;
    }
    return walk(root).replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // ── 几个各页共用的小件（第三十七轮从 AI 助手那一段里挪出来 —— 它们夹在那段中间，别处也用）────────────
  function pickFile(cb) {
    var input = document.createElement('input'); input.type = 'file';
    input.onchange = function () { if (input.files[0]) cb(input.files[0]); };
    input.click();
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
  /**
   * 提醒渠道的凭据字段，以及「这个渠道配齐了没有」—— 只有这一份：设置弹窗的「提醒」一栏（assets/settings.js，经 zqShared）
   * 和建任务的表单（reminderBlocker）都用它，和后端 hasRequiredChannelConfig 是同一个条件。
   * 界面本身在 settings.js 的 bindReminders（第三十轮从个人中心页挪过去）。
   */
  var REMINDER_FIELDS = {
    PUSHPLUS: [['zq-rm-pushplus', 'pushplusToken']],
    WECOM: [['zq-rm-webhook', 'webhookUrl']],
    QQ: [['zq-rm-qq-appid', 'qqAppId'], ['zq-rm-qq-secret', 'qqAppSecret'], ['zq-rm-qq-group', 'qqGroupOpenid']]
  };
  /** root：设置弹窗里那一栏（看用户正选着的渠道、正在填的字）；不给就只看服务端存着的。 */
  function currentReminderChannel(settings, root) {
    var sel = root && $('#zq-rm-channel', root);
    return (sel && sel.value) || settings.channel || 'PUSHPLUS';
  }
  /**
   * 这个渠道的凭据齐了吗。
   *
   * 已保存的值从后端回来是脱敏的（****xxxx），占位符里显示；输入框为空 = 沿用已存的值。
   * 所以「齐了」= 每个字段要么输入框有值，要么后端已经存着一个非空值。
   */
  function reminderChannelReady(settings, root) {
    var channel = currentReminderChannel(settings, root);
    return (REMINDER_FIELDS[channel] || []).every(function (pair) {
      var el = root && $('#' + pair[0], root);
      if (el && el.value.trim()) return true;
      var stored = settings[pair[1]];
      return !!(stored && String(stored).trim());
    });
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
  /**
   * 页面开着跨过业务日期的零点（第二十一轮）：看板的「今天」、例行计划的今日列表原来一直是昨天的 —— 零点过后点「完成」，
   * 列表是昨天的、打卡记到今天；番茄钟的「今日 N 个」也不归零。每分钟、切回这个标签页时看一眼业务日期，变了就重新取这一页的数据：
   * 不整页刷新（正在跑的番茄钟、打了一半的字都还在），也不重新绑事件（bootRoutines 用 addEventListener，重跑一次每个按钮点一下就提交两遍）。
   * 重新取什么由页面模块自己导出（dayReload，例行计划第三十二轮、看板第三十五轮）；原来壳里那张 DAY_RELOAD 表随着看板挪走删掉了。
   */
  var dayWatched = false;
  function watchBusinessDay(reload) {
    var day = today();
    function check() {
      var now = today();
      if (now === day) return;
      day = now;
      safe('刷新今天', reload);
    }
    setInterval(check, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  }

  // ── 设置 / 成就弹窗（第三十轮：点左下角头像弹出菜单，设置、成就是 Claude 那样的弹窗；地址 #settings/<栏>、#achievements）──
  //
  // 代码在 assets/settings.js —— 第一个从这个文件拆出去的 ES 模块，第一次打开时才 import。它用到的壳里的东西都经 zqShared 给：
  // 这就是第 4 步之后各页模块要用的那一层，模块只认它，不认壳的内部变量。
  //
  // 弹窗跟着地址走：点菜单是一次普通的 hash 跳转（往历史里加一条），所以刷新还在、后退就关。关掉弹窗时，那一条是跳转加的就后退回去
  // （不留一条「还是这一页」的历史），是直接带着 hash 打开的（刷新、外面的链接）就把 hash 抹掉。换栏只改地址、不加历史。
  var SELF_SRC = (function () { try { return (document.currentScript && document.currentScript.src) || ''; } catch (e) { return ''; } })();
  /**
   * 加载 assets/ 下的一个 ES 模块（第三十轮的设置弹窗、第三十一轮起的页面模块，方案第 4 步）。同一个只加载一次。
   * 带上和壳同一个缓存令牌（?v=）：发版换了壳，模块跟着换，浏览器的 HTTP 缓存不会拿旧模块配新壳。
   * 加载不上（断网、服务器正在重启）时说人话 —— 浏览器的原话是「Failed to fetch dynamically imported module: http://…」；
   * 失败的不缓存，下一次再试。
   */
  var loadedModules = {};
  function loadModule(rel) {
    if (!loadedModules[rel]) {
      var query = '';
      try { query = new URL(SELF_SRC).search; } catch (e) {}
      loadedModules[rel] = import(new URL('assets/' + rel + query, location.href).href)
        .catch(function (e) {
          delete loadedModules[rel];
          console.error('[zhiqu-api] 模块加载失败', rel, e);
          throw requestError('这一部分的代码没加载上（网络断了，或者服务器正在重启）。稍后刷新一下再试。', { network: true });
        });
    }
    return loadedModules[rel];
  }
  function loadSettingsModule() { return loadModule('settings.js'); }
  /**
   * 每一页的代码（方案第 4 步，第三十到三十七轮一页一页从这个文件里搬出去）：页面文件名 → assets/ 下的模块。模块导出 boots[页面文件名](zqShared)。
   * 后台页的门在 route() 里、加载模块之前 —— 普通用户直达后台页时连模块都不下载。
   */
  var PAGE_MODULES = {
    'admin.html': 'pages/admin.js', 'account-admin.html': 'pages/admin.js',
    'feedback-admin.html': 'pages/admin.js', 'shared-plan-admin.html': 'pages/admin.js',
    'routines.html': 'pages/routines.js', 'statistics.html': 'pages/statistics.js',
    'shared-plans.html': 'pages/shared-plans.js', 'tasks.html': 'pages/tasks.js', 'dashboard.html': 'pages/dashboard.js',
    'knowledge-wiki.html': 'pages/knowledge-wiki.js', 'ai-assistant.html': 'pages/ai-assistant.js', 'mini.html': 'pages/mini.js'
  };
  function isDialogHash(h) { return /^#(?:settings(?:[/?]|$)|achievements$)/.test(h || ''); }
  var dialog = null;            // 开着的那个：{ kind, handle }
  var dialogPushed = false;     // 这条 hash 是不是从「没有弹窗」跳过来、往历史里加的那一条
  var dialogHashBefore = false;
  function leaveDialogHash() {
    if (!isDialogHash(location.hash)) return;
    if (dialogPushed) { dialogPushed = false; history.back(); }
    else history.replaceState(history.state, '', location.pathname + location.search);
  }
  function syncDialog() {
    if (!isDialogHash(location.hash)) {
      if (dialog) { var gone = dialog; dialog = null; gone.handle.close(); }
      return;
    }
    safe('打开设置', async function () {
      var mod = await loadSettingsModule();
      var want = mod.parseZqHash(location.hash);   // 加载的这一会儿地址可能又变了：按现在的
      if (!want) return;
      if (dialog && dialog.kind === want.kind) {
        if (want.kind === 'settings') dialog.handle.show(want.tab, want.params);
        return;
      }
      if (dialog) { var old = dialog; dialog = null; old.handle.close(); }
      var entry = { kind: want.kind, handle: null };
      var onClose = function () { if (dialog === entry) { dialog = null; leaveDialogHash(); } };
      dialog = entry;
      entry.handle = want.kind === 'settings'
        ? mod.openSettings(zqShared, { tab: want.tab, params: want.params, onClose: onClose,
            onTab: function (tab) { history.replaceState(history.state, '', '#settings/' + tab); } })
        : mod.openAchievements(zqShared, { onClose: onClose });
    });
  }
  var dialogWatched = false;
  function watchDialogs() {
    if (dialogWatched) return;
    dialogWatched = true;
    dialogHashBefore = isDialogHash(location.hash);
    window.addEventListener('hashchange', function () {
      var now = isDialogHash(location.hash);
      if (!now) dialogPushed = false;
      else if (!dialogHashBefore) dialogPushed = true;
      dialogHashBefore = now;
      syncDialog();
    });
    syncDialog();
  }
  /** 退出登录（头像菜单、设置里的「退出」）。原来只在个人中心页顶上有。番茄钟和草稿一样删掉（任务名不留在公用电脑上；第四十九轮）。 */
  function logout() {
    return safe('退出', async function () { var had = token(); await api.post('/auth/logout', {}); drafts.clearUser(); writePomo(null); clearAuth(); announceLogout(had); location.href = 'index.html'; });
  }
  /**
   * 改完密码，之前签发的令牌（别的设备上的、被偷走的）全部作废 —— 包括这一页手里那张；服务器给这个会话回一张新的。
   * 存上它（「记住我」照旧），不然改完密码下一个请求就被踢回登录页。
   */
  function adoptNewToken(fresh) {
    var before = token();
    if (!fresh) return;
    setAuth({ token: fresh, role: role() || 'USER' }, Boolean(localStorage.getItem('token')));
    announceNewToken(before, fresh);   // 同一个浏览器里别的标签页手里是旧令牌，已经作废了
  }
  /** 给页面模块的共用层（第 4 步）：模块只用这里面的东西。往里加之前想一想 —— 加进来的每一样，模块都可能依赖它。 */
  var zqShared = {
    api: api, state: state, esc: esc, toast: toast, notice: notice, askConfirm: askConfirm, askText: askText, showInfo: showInfo, safe: safe, openModal: openModal,
    $: $, $all: $all, pickFile: pickFile, empty: empty, fmtDate: fmtDate, hm: hm, d10: d10, updateSidebarUser: updateSidebarUser, normalizeModelList: normalizeModelList,
    planCategory: planCategory, planCategoryOptions: planCategoryOptions, freqLabel: freqLabel,
    today: today, latestOnly: latestOnly, keepDraft: keepDraft, writeKey: writeKey, qKey: qKey, pLabel: pLabel, openTaskForm: openTaskForm,
    weekRange: weekRange, zoneNote: zoneNote, updatePomoCount: updatePomoCount, pomo: pomo, miniBridge: miniBridge,
    API: API, token: token, popMenu: popMenu, drafts: drafts, renderMarkdown: renderMarkdown, renderMathIn: renderMathIn,
    REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS, role: role, requestError: requestError, redirectToLogin: redirectToLogin, nowMs: nowMs,
    serverTime: serverTime, highlightCode: highlightCode, codeTokens: codeTokens,
    mathBlockHtml: mathBlockHtml, htmlToMarkdown: htmlToMarkdown, openAttachmentPreview: openAttachmentPreview, normalizeTask: normalizeTask, qLabel: qLabel, sLabel: sLabel,
    REMINDER_FIELDS: REMINDER_FIELDS, currentReminderChannel: currentReminderChannel, reminderChannelReady: reminderChannelReady,
    logout: logout, adoptNewToken: adoptNewToken, icon: icon,
    loadModule: loadModule   // 第七十轮：Wiki 的编辑内核验证版按需加载 assets/wiki-cm.js（带同一个缓存令牌）
  };

  var pomoWatched = false;
  function route() {
    maintainShellCache();
    flushDeniedNotice();
    safe('初始化', async function () {
      // 跳转已经发起时不要揭示内容：location.replace 不中断 JS，下面的 finally 照样会跑，
      // 摘掉 zq-booting 会让后台骨架淡入 180ms（zhiqu-ui.css:616 的过渡）才被导航打断。
      var leaving = false;
      try {
        if (page === 'index.html' || $('#form-login')) {
          // 别的标签页已经登录了：落地页直接进看板（或 next 指的那一页），不再让人登第二遍
          if (!token() && await borrowToken()) { location.href = safeNext(new URLSearchParams(location.search).get('next')); return; }
          revealContent(); return bootIndex();
        }
        // 个人中心、成就第三十轮改成了弹窗：旧地址（书签、历史记录、命令行打印过的 profile.html#harness=…）换到首页的弹窗。
        // 在登录检查之前跳：没登录的话首页会带着弹窗的地址去登录页，登录完回来照样打开
        if (page === 'profile.html' || page === 'achievement.html') {
          leaving = true;
          var legacy = await loadSettingsModule();
          location.replace(HOME_PAGE + legacy.legacyHash(page, location.hash));
          return;
        }
        if (!token()) await borrowToken();
        // 当前普通页的代码与登录校验并行下载；业务启动仍等校验成功。
        // 后台页保持先确认管理员再加载，失败的预载也立即接住，稍后由初始化统一报告。
        var pageCode = PAGE_MODULES[page] && window.ZQUI && window.ZQUI.isAdminPage && !window.ZQUI.isAdminPage(page)
          ? loadModule(PAGE_MODULES[page]) : null;
        if (pageCode) pageCode.catch(function () {});
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
          location.replace(HOME_PAGE);
          return;
        }

        watchReminders();
        watchPomo();
        watchDialogs();
        // 番茄钟的待补记不能挂在页面启动之后：启动失败（网断着打开的、被限流）时正是有待补记的时候，挂在后面的话这一页就不补了。
        // 当场那一趟放在启动之后（成不成都跑）：补上了要刷新的看板数字，得等看板自己先起来
        var watchPomodoros = !pomoWatched;
        if (watchPomodoros) {
          pomoWatched = true;
          window.addEventListener('online', catchUpPomodoros);
          setInterval(catchUpPomodoros, 60000);
        }
        try {
          // 每一页都是 assets/pages/ 下的一个模块（方案第 4 步，第三十一到三十七轮一页一页搬完；原来这里还有一张壳里的 boots 表）
          if (PAGE_MODULES[page]) {
            var pageModule = await (pageCode || loadModule(PAGE_MODULES[page]));
            // 页面开着跨过业务日期的零点要重新取什么：页面模块自己说（看板、例行计划的「今天」），见 watchBusinessDay
            if (!dayWatched && pageModule.dayReload && pageModule.dayReload[page]) { dayWatched = true; watchBusinessDay(pageModule.dayReload[page]); }
            await pageModule.boots[page](zqShared);
          }
        } finally {
          if (watchPomodoros) catchUpPomodoros();
        }
      } finally {
        // 卡死不了：zhiqu-ui.js:31 那个 2.5s 无条件兜底仍会摘遮罩，
        // 所以万一导航没成行，页面也不会永远停在空白。
        if (!leaving) revealContent();
        // 这一页的数据都画好了的时刻（相对导航开始）：量页面切换要多久时读它（第三十九轮）
        try { performance.mark('zq-boot-done'); } catch (e) {}
      }
    }, { renderError: true });
  }

  // localDate 一并暴露：页面内联脚本要算「今天」时用同一份定义，而不是各写一个 toISOString
  // （原来用它的是看板番茄钟那段内联脚本；第四十九轮番茄钟挪进了壳，现在没有内联脚本在用）
  window.zqApi = { api: api, reload: route, today: today, localDate: localDate, now: nowMs, serverTime: serverTime, businessDate: businessDate, toast: toast, recordPomodoro: recordPomodoro,
    notify: pageNotify, askNotifyPermission: askNotifyPermission, logout: logout };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', route); else route();
})();
