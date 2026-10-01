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
    // 带上原来那一页：登录之后回到这里（第十五轮：原来一律回看板，在哪一页、打了什么都没了 —— 打的字由草稿接住，见 drafts）
    if (page !== 'index.html') { redirecting = true; location.replace('index.html?login=1&next=' + encodeURIComponent(page + location.search)); }
  }
  /**
   * 登录之后去哪：只认本站的「xxx.html」加查询串 —— 不是本站的（//别处、https:、javascript:、../）一律回看板，
   * 否则 index.html?login=1&next=https://钓鱼站 就是一个开放跳转。
   */
  function safeNext(raw) {
    var next = String(raw || '');
    if (/^[a-z0-9_-]+\.html(\?[^#\s\\]*)?$/i.test(next) && !/^index\.html/i.test(next) && next.indexOf('//') < 0) return next;
    return 'dashboard.html';
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
      var uploaded = requestWithRetry(path, options, method, upload, false);
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

  function toast(msg, kind, ms) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;right:22px;top:22px;z-index:99999;max-width:360px;padding:10px 14px;border:1px solid var(--zq-border);border-radius:var(--zq-rs);background:var(--zq-card);box-shadow:var(--zq-sh2);color:' + (kind === 'error' ? 'var(--zq-bad)' : 'var(--zq-text)') + ';font-size:13px;font-weight:600;';
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
        location.href = safeNext(new URLSearchParams(location.search).get('next'));
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
    if (token()) { location.href = safeNext(new URLSearchParams(location.search).get('next')); return; }
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
    // 日期和星期都用服务端那一行的：原来是浏览器的日期拼服务端的星期（UTC+14 时「2026-09-29 · 周一」）
    if (headerDate) headerDate.textContent = (todayRow ? todayRow.date + ' · ' + todayRow.weekday : today()) + zoneNote();
    renderWeek(data.days || []);
    renderToday(todayRow ? todayRow.items || [] : [], todayRow ? todayRow.date : null);
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
      var tasks = ((await api.get('/task/page?status=0&limit=50')).items || []).map(normalizeTask);
      // 看板会被重新取（换周、记完一个番茄钟、跨过零点）：番茄钟正在跑时选好的任务不能被换回「不指定」
      var keep = sel.value;
      sel.innerHTML = '<option value="">（不指定任务）</option>' + tasks.map(function (t) {
        return '<option value="' + t.id + '">' + esc(t.title) + '</option>';
      }).join('');
      if (keep && tasks.some(function (t) { return String(t.id) === keep; })) sel.value = keep;
    } catch (e) { /* 忽略：下拉保持默认项 */ }
  }
  async function updatePomoCount() {
    var host = $('#zq-pomo-count'); if (!host) return;
    var waiting = pendingPomodoros().length;
    var tail = waiting ? ' ｜ 另有 ' + waiting + ' 个还没传上去（连上网自动补记）' : '';
    try {
      var t = today();
      var recs = await api.get('/record/list?from=' + t + '&to=' + t);
      var todays = (recs || []).filter(function (rec) { return d10(rec.studyDate) === t; });
      var mins = todays.reduce(function (a, rec) { return a + (rec.durationMinutes || 0); }, 0);
      host.textContent = '今日：' + todays.length + ' 个 ｜ ' + mins + ' 分钟' + tail;
      // 原来是设计稿写死的「第 3 轮 · 专注阶段」，新账号一个没做也是第 3 轮（2026-10-01 排查参考计划假数字时一起查出）
      var round = $('#zq-pomo-round');
      if (round) round.textContent = '今天第 ' + (todays.length + 1) + ' 轮';
    } catch (e) {
      if (tail) host.textContent = tail.slice(3);
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
  /** 专注完了：先落在这台设备上，再发。说清楚是记上了、先存着、还是真的没记上。 */
  async function recordPomodoro(rec) {
    var item = { key: writeKey(), user: pomoOwner(), day: today(), taskId: rec.taskId == null ? null : rec.taskId, durationMinutes: rec.durationMinutes, note: rec.note || '' };
    var list = readPomoOutbox();
    list.push(item);
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
    var r = await flushPomodoros();
    if (r.sent) {
      toast('补记了 ' + r.sent + ' 个番茄钟（专注完的时候网断了）');
      if (window.zqApi && window.zqApi.afterRecord) window.zqApi.afterRecord();
    }
    if (r.failed.length) toast('有 ' + r.failed.length + ' 个番茄钟补记不上：' + r.failed[0], 'error', 6000);
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
  function renderToday(items, date) {
    var host = $('#zq-today');
    if (!host) return;
    host.innerHTML = items.length ? items.map(function (x) {
      var routine = x.kind === 'ROUTINE';
      var q = routine ? 'routine' : qKey(x.quadrant);
      var color = routine ? 'var(--zq-primary)' : 'var(--zq-' + q + ')';
      return '<div style="display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:12px;align-items:center;padding:8px 12px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:' + (routine ? 'var(--zq-tint)' : 'var(--zq-card)') + ';opacity:' + (x.status === 2 || x.completed ? .58 : 1) + ';"><span class="zq-mono" style="color:var(--zq-primary);font-size:12.5px;font-weight:600;">' + esc(x.time || hm(x.deadline) || '') + '</span><div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(x.title) + '</div><div style="display:flex;gap:6px;margin-top:4px;align-items:center;min-width:0;"><span class="zq-badge" style="background:var(--zq-tint);color:' + color + ';">' + esc(routine ? '例行' : qLabel(x.quadrant)) + '</span><span style="flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--zq-text2);font-size:11.5px;">' + esc(x.description || fmtDate(x.deadline)) + '</span></div></div><button class="zq-btn-ghost" data-task-done="' + esc(x.id || '') + '" data-kind="' + esc(x.kind || '') + '" data-date="' + esc(date || '') + '" style="height:28px;padding:0 11px;font-size:12px;">' + (x.status === 2 || x.completed ? '已完成' : '完成') + '</button></div>';
    }).join('') : empty('今天暂时没有安排');
    $all('[data-task-done]', host).forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute('data-task-done');
        if (!id) return;
        safe('完成', async function () {
          // 打卡记到这一行所在的那天（服务端给的日期），不是按下去这一刻浏览器算的「今天」：页面开着跨过零点、还没刷新时，
          // 用户看着的是昨天的列表，点的就是昨天那一条
          if (btn.getAttribute('data-kind') === 'ROUTINE') await api.post('/routine/' + id + '/checkin', { checkDate: btn.getAttribute('data-date') || today(), status: 'DONE' });
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
      var items = (row.items || []).map(function (x) { return '<div style="padding:7px 9px;border-radius:var(--zq-rs);background:var(--zq-' + q + '-bg);font-size:12px;font-weight:500;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(x.title) + '</div>'; }).join('') || '<div style="font-size:12px;color:var(--zq-text3);">暂无关键任务</div>';
      return '<div style="min-height:150px;padding:13px;border:1px solid var(--zq-' + q + '-border);border-radius:var(--zq-rs);background:var(--zq-card);border-top:3px solid var(--zq-' + q + ');"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;"><span style="font-size:12px;font-weight:700;color:var(--zq-' + q + ');white-space:nowrap;">' + qLabel(row.quadrant) + '</span><span class="zq-mono" style="font-size:12px;font-weight:600;color:var(--zq-text3);">' + (row.total || 0) + ' 项</span></div><div style="display:flex;flex-direction:column;gap:7px;">' + items + '</div></div>';
    }).join('');
  }
  function renderDeadlines(list) {
    var host = $('#zq-ddl'); if (!host) return;
    host.innerHTML = list.length ? list.map(function (d) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--zq-border-soft);"><div style="min-width:0;"><strong style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px;line-height:1.35;font-weight:600;">' + esc(d.title) + '</strong><span style="display:block;margin-top:3px;color:var(--zq-text2);font-size:11.5px;">' + esc(fmtDate(d.deadline)) + '</span></div><span class="zq-badge zq-mono" style="flex:none;background:var(--zq-card-soft);color:var(--zq-text2);">DDL</span></div>';
    }).join('') : empty('暂无临近 DDL');
  }

  async function bootTasks() {
    var selects = $all('.zq-card .zq-select');
    var queryBtn = $all('.zq-card .zq-btn')[0], newBtn = $all('.zq-card .zq-btn')[1];
    if (queryBtn) queryBtn.onclick = loadTasks;
    if (newBtn) newBtn.onclick = function () { openTaskForm(null); };
    await loadTasks();
    async function loadTasks() {
      var params = new URLSearchParams();
      var q = selects[0] ? selects[0].selectedIndex : 0, s = selects[1] ? selects[1].selectedIndex : 0, p = selects[2] ? selects[2].selectedIndex : 0;
      if (q) params.set('quadrant', q);
      if (s) params.set('status', s - 1);
      if (p) params.set('priority', p - 1);
      params.set('sortBy', selects[3] && selects[3].selectedIndex === 1 ? 'deadline' : selects[3] && selects[3].selectedIndex === 2 ? 'priority' : 'updatedAt');
      params.set('sortOrder', selects[4] && selects[4].selectedIndex === 1 ? 'asc' : 'desc');
      var current = latestOnly('tasks');
      var page = await api.get('/task/page?' + params.toString() + '&offset=0&limit=' + TASK_PAGE_SIZE);
      if (!current()) return;
      state.taskQuery = params.toString();
      state.tasks = (page.items || []).map(normalizeTask);
      state.taskTotal = Number(page.total || 0);
      renderTaskRows(state.tasks);
    }
  }
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

  /**
   * 任务页一次取一页（第十七轮）。用了两年的账号有几千条任务：原来一次全取回来（1.6MB）、画出四万多个节点，
   * 页面要卡好几秒。现在先给 100 条，「加载更多」再取下一页；页脚写的是真的总数。
   */
  var TASK_PAGE_SIZE = 100;
  async function loadMoreTasks() {
    var query = state.taskQuery;
    var page = await api.get('/task/page?' + query + '&offset=' + state.tasks.length + '&limit=' + TASK_PAGE_SIZE);
    // 这期间换了筛选条件（loadTasks 重新来过）：这一页是旧条件下的，不能接到新列表后面
    if (query !== state.taskQuery) return;
    state.tasks = state.tasks.concat((page.items || []).map(normalizeTask));
    state.taskTotal = Number(page.total || 0);
    renderTaskRows(state.tasks);
  }
  function renderTaskRows(list) {
    var host = $('#zq-rows'); if (!host) return;
    host.innerHTML = list.length ? list.map(function (t) {
      var q = qKey(t.quadrant);
      return '<div style="display:grid;grid-template-columns:minmax(200px,2.2fr) 104px 64px 78px 118px 118px 108px;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--zq-border-soft);opacity:' + (t.status === 2 ? .55 : 1) + ';"><div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.title) + '</div><div style="font-size:11.5px;color:var(--zq-text3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.description || '—') + '</div></div><span><span class="zq-badge" style="background:var(--zq-' + q + '-bg);color:var(--zq-' + q + ');">' + qLabel(t.quadrant) + '</span></span><span style="font-size:12.5px;font-weight:600;">' + pLabel(t.priority) + '</span><span><button data-cycle-task="' + t.id + '" style="display:inline-flex;align-items:center;height:22px;padding:0 9px;border:1px solid var(--zq-border);border-radius:999px;background:var(--zq-card-soft);color:var(--zq-text2);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">' + sLabel(t.status) + '</button></span><span class="zq-mono" style="font-size:12px;color:var(--zq-text2);">' + esc(fmtDate(t.deadline)) + '</span><span class="zq-mono" style="font-size:12px;color:var(--zq-text2);">' + esc(fmtDate(t.reminderTime)) + '</span><span style="display:flex;justify-content:flex-end;gap:6px;"><button class="zq-btn-ghost" data-edit-task="' + t.id + '" style="height:26px;padding:0 10px;font-size:12px;">编辑</button><button class="zq-btn-ghost" data-del-task="' + t.id + '" style="height:26px;padding:0 10px;font-size:12px;">删除</button></span></div>';
    }).join('') : empty('暂无任务');
    var total = Math.max(state.taskTotal || 0, list.length);
    if (total > list.length) {
      host.insertAdjacentHTML('beforeend', '<div style="padding:12px 16px;text-align:center;"><button class="zq-btn-ghost" data-more-tasks style="height:30px;">加载更多（还有 ' + (total - list.length) + ' 条）</button></div>');
      var more = $('[data-more-tasks]', host);
      if (more) more.onclick = function () { more.disabled = true; safe('加载任务', loadMoreTasks); };
    }
    var foot = $('.zq-table > div:last-child span');
    if (foot) foot.textContent = '共 ' + total + ' 条' + (total > list.length ? '（显示了 ' + list.length + ' 条）' : '');
    $all('[data-cycle-task]', host).forEach(function (b) { b.onclick = function () { cycleTask(Number(b.dataset.cycleTask)); }; });
    $all('[data-del-task]', host).forEach(function (b) { b.onclick = function () { deleteTask(Number(b.dataset.delTask)); }; });
    $all('[data-edit-task]', host).forEach(function (b) { b.onclick = function () { safe('打开任务', function () { return openTaskForm(Number(b.dataset.editTask)); }); }; });
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
      + '<p style="margin:-4px 0 13px;font-size:12px;color:var(--zq-text3);line-height:1.6;">「提醒时间」到点提醒一次；「截止前提醒」在截止前那几天的早上 8 点提醒（默认按任务难度提前几天，0 是截止当天）。都发到个人中心里设置的提醒渠道。</p>'
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
  async function openTaskForm(id) {
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
          // 幂等键交给 request()：原来这里每次点击生成一个新键 —— 回应丢了、学生照着「网络连接失败」再点一次，拿的是新键，
          // 服务器当成新的一次，建出两份（第二十二轮实测）。request() 在「不确定有没有保存上」之后，内容一样的下一次沿用同一个键。
          ok.disabled = true;
          safe(before ? '保存任务' : '创建任务', async function () {
            var res = await api[plan.method](plan.url, plan.body);
            keep.forEach(function (k) { k.clear(); });
            h.close();
            toast(before ? '任务已保存' : (res && res.created ? '已创建 ' + res.created + ' 条（每周一条）' : '任务已创建'));
            await bootTasks();
          }).finally(function () { ok.disabled = false; });
        };
      }
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
    // 开始日期默认今天、结束日期空着（服务器按开始日期 +29 天）。原来 HTML 里写死 2026-07-06 → 2026-08-30，
    // 是设计稿上的日期：过了那天照默认值建出来的就是一个已经结束的计划（第十四轮真浏览器里看到的）
    var newSection = $all('section').find(function (s) { return /新建例行计划/.test(s.textContent); });
    var startInput = newSection && $('input[type="date"]', newSection);
    if (startInput && !startInput.value) startInput.value = today();
    // 标题、说明打了一半刷新也还在（第十五轮）；建好之后清空（见 createRoutineFromForm）
    if (newSection && !state.routineDrafts) {
      state.routineDrafts = [keepDraft($('input[placeholder*="英语单词"]', newSection), 'routine.new.title'),
        keepDraft($('textarea', newSection), 'routine.new.desc')];
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
    var params = statusIdx === 1 ? '&status=0' : statusIdx === 2 ? '&status=1' : '';
    var current = latestOnly('routine-sources');
    var tasks = ((await api.get('/task/page?limit=20' + params)).items || []).map(normalizeTask);
    if (!current()) return;
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
      // 生成完把勾去掉：勾还在的话，回来之后再点一下就把同一批任务又生成一遍（同「新建例行计划」清空表单）
      checked.forEach(function (c) { c.checked = false; });
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
  // 例行计划今天是什么状态：没开始 / 进行中 / 已结束（日期都是 YYYY-MM-DD，按字符串比就是按日期比）。
  // 原来一律当「进行中」、都给「标记完成」—— 已经结束的点了只会报「该日期不在例行计划范围内」（第十四轮连点暴力测试撞见的）
  function routinePhase(r, day) {
    if (r.startDate && String(r.startDate).slice(0, 10) > day) return 'upcoming';
    if (r.endDate && String(r.endDate).slice(0, 10) < day) return 'ended';
    return 'active';
  }
  async function loadRoutines() {
    var host = $('#zq-rt'); if (!host) return;
    var list = await api.get('/routine/list');
    var day = today();
    var active = list.filter(function (r) { return routinePhase(r, day) === 'active'; }).length;
    // 标题旁那句「N 个进行中」原来是设计稿写死的「5 个进行中」，从来不变
    var countEl = host.closest('section') && $all('span', host.closest('section')).find(function (x) { return /个进行中/.test(x.textContent); });
    if (countEl) countEl.textContent = active + ' 个进行中';
    host.innerHTML = list.length ? list.map(function (r) {
      var phase = routinePhase(r, day);
      var when = phase === 'upcoming' ? ' · ' + String(r.startDate).slice(5, 10).replace('-', '/') + ' 开始'
        : phase === 'ended' ? ' · 已结束（' + String(r.endDate).slice(5, 10).replace('-', '/') + '）' : '';
      var check = phase === 'active' ? '<button data-check-routine="' + r.id + '" class="zq-btn-ghost" style="height:28px;padding:0 11px;font-size:12px;">标记完成</button>' : '';
      return '<div style="display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card);"><div class="zq-mono" style="flex:none;min-width:46px;height:32px;padding:0 8px;border-radius:var(--zq-rs);background:var(--zq-tint);color:var(--zq-primary);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;">' + esc((r.preferredTime || '08:00').slice(0, 5)) + '</div><div style="flex:1;min-width:0;"><div style="font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(r.title) + '</div><div style="font-size:11.5px;color:var(--zq-text2);margin-top:3px;">' + esc(freqLabel(r.frequency, r.daysOfWeek) + ' · ' + (r.durationMinutes || 0) + ' 分钟' + when) + '</div></div>' + check + '<button data-del-routine="' + r.id + '" class="zq-btn-ghost" style="height:28px;padding:0 11px;font-size:12px;">删除</button></div>';
    }).join('') : empty('暂无例行计划');
    $all('[data-check-routine]', host).forEach(function (b) { b.onclick = async function () { await api.post('/routine/' + b.dataset.checkRoutine + '/checkin', { status: 'DONE' }); await loadRoutines(); }; });
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
      // 建好就清空标题和说明：这是页面上常驻的表单，不像弹窗那样一建就关。不清的话，
      // 回来之后多点的那一下（第十四轮真浏览器：双击后又补了一下）会拿同一个标题再建一个
      $('input[placeholder*="英语单词"]', section).value = '';
      $('textarea', section).value = '';
      (state.routineDrafts || []).forEach(function (d) { d.clear(); });
      toast('例行计划已创建'); await loadRoutines();
    });
  }

  async function bootStatistics() {
    var stat = await api.get('/record/statistics');
    var nums = $all('.zq-stat-num');
    if (nums[0]) nums[0].textContent = stat.consecutiveDays || 0;
    if (nums[1]) nums[1].textContent = stat.totalMinutes || stat.totalStudyMinutes || 0;
    // 接口给的是 completedTaskCount / totalTaskCount —— 原来读 completedTasks / totalTasks，这两格永远是 0（第十七轮看到的）
    if (nums[2]) nums[2].textContent = stat.completedTaskCount || 0;
    if (nums[3]) nums[3].textContent = stat.totalTaskCount || 0;
    window.setTab = function (k) { highlightStatTab(k); paintTrend(k); };
    await paintTrend('day');
    highlightStatTab('day');
    renderQuadrantDonut(stat.quadrantDistribution || {});
  }
  function highlightStatTab(k) {
    $all('#zq-tabs button').forEach(function (b) {
      var on = b.dataset.k === k;
      b.style.background = on ? 'var(--zq-primary)' : 'var(--zq-card)';
      b.style.color = on ? 'var(--zq-on-primary)' : 'var(--zq-text2)';
    });
  }
  /** 四象限的分布：/record/statistics 已经按象限数好了（一条 GROUP BY）。原来另外取回全部任务在页面里再数一遍（第十七轮：三千条任务就是 1.6MB） */
  function renderQuadrantDonut(distribution) {
    var donut = $('#zq-donut'); if (!donut) return;
    var counts = [1, 2, 3, 4].map(function (q) { return Number((distribution || {})[q] || 0); });
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
    var current = latestOnly('trend');
    var list = await api.get('/record/trend?type=' + encodeURIComponent(type));
    if (!current()) return;
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

  /**
   * 命令行登录（设备码）与个人访问令牌。
   *
   * 允许之前先把「哪台设备、从哪个地址、什么时候」摆出来 —— 设备码登录的已知风险是别人发起、骗你点允许，
   * 让人看出「这不是我的机器」是唯一的防线。令牌在列表里只显示末 4 位，撤销立即生效。
   * 终端里打印的链接是 profile.html#harness=XXXX-XXXX：带着它打开时直接填好码并查看。
   */
  function wireCliLogin() {
    var host = $('#zq-cli-login');
    if (!host) return;
    var input = $('#zq-cli-code'), device = $('#zq-cli-device'), list = $('#zq-cli-tokens');
    async function paintTokens() {
      var rows = await safe('命令行令牌', function () { return api.get('/access-tokens'); });
      rows = Array.isArray(rows) ? rows : [];
      list.innerHTML = rows.length
        ? rows.map(function (t) {
            return '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px;'
              + ' padding:6px 8px; border:1px solid var(--zq-border-soft); border-radius:var(--zq-rs);">'
              + '<div style="min-width:0;"><div style="font-weight:600;">' + esc(t.name) + ' <span class="zq-mono" style="color:var(--zq-text3); font-weight:400;">' + esc(t.hint) + '</span></div>'
              + '<div style="color:var(--zq-text3); font-size:11px;">' + (t.lastUsedAt ? '最近使用 ' + esc(String(t.lastUsedAt).replace('T', ' ').slice(0, 16)) : '还没用过')
              + '</div></div><button class="zq-btn-ghost" data-revoke="' + esc(t.id) + '" style="height:24px; padding:0 10px; font-size:11.5px;">撤销</button></div>';
          }).join('')
        : '<div style="font-size:11.5px; color:var(--zq-text3);">还没有命令行登录过。</div>';
      $all('[data-revoke]', list).forEach(function (b) {
        b.onclick = function () {
          safe('撤销令牌', async function () {
            await api.del('/access-tokens/' + encodeURIComponent(b.dataset.revoke));
            toast('已撤销，那台机器上的命令行需要重新登录');
            await paintTokens();
          });
        };
      });
    }
    async function check() {
      var code = (input.value || '').trim();
      if (!code) { device.innerHTML = ''; return; }
      var info = await safe('查看设备码', function () { return api.get('/access-tokens/device/' + encodeURIComponent(code)); });
      if (!info) { device.innerHTML = ''; return; }
      device.innerHTML = '<div style="padding:10px 12px; border:1px solid var(--zq-border-soft); border-radius:var(--zq-rs); background:var(--zq-card-soft); font-size:12px; line-height:1.6;">'
        + '<div><strong>' + esc(info.clientName || '命令行') + '</strong> 请求登录你的账号</div>'
        + '<div style="color:var(--zq-text3);">来自 ' + esc(info.clientIp || '未知地址') + ' · ' + esc(String(info.createdAt || '').replace('T', ' ').slice(0, 16)) + ' · 设备码 ' + esc(info.userCode) + '</div>'
        + '<div style="color:var(--zq-text2); margin-top:4px;">只在这是你自己刚刚在终端里发起的时候才允许。</div>'
        + '<div style="display:flex; gap:8px; margin-top:8px;"><button class="zq-btn" id="zq-cli-approve" style="height:28px; padding:0 14px; font-size:12px;">允许</button>'
        + '<button class="zq-btn-ghost" id="zq-cli-deny" style="height:28px; padding:0 12px; font-size:12px;">拒绝</button></div></div>';
      $('#zq-cli-approve').onclick = function () {
        safe('允许命令行登录', async function () {
          await api.post('/access-tokens/device/' + encodeURIComponent(info.userCode) + '/approve', {});
          device.innerHTML = '<div style="font-size:12px; color:var(--zq-q2);">已允许。回到终端，命令行会自动完成登录。</div>';
          input.value = '';
          // 令牌在命令行来取（轮询）的那一刻才签出，时间点不固定 —— 刷几次，直到列表里多出一张
          var before = list.querySelectorAll('[data-revoke]').length, tries = 0;
          (function again() {
            setTimeout(async function () {
              await paintTokens();
              if (list.querySelectorAll('[data-revoke]').length <= before && ++tries < 10) again();
            }, 3000);
          })();
        });
      };
      $('#zq-cli-deny').onclick = function () {
        safe('拒绝命令行登录', async function () {
          await api.post('/access-tokens/device/' + encodeURIComponent(info.userCode) + '/deny', {});
          device.innerHTML = '<div style="font-size:12px; color:var(--zq-text3);">已拒绝。</div>';
          input.value = '';
        });
      };
    }
    $('#zq-cli-check').onclick = check;
    input.onkeydown = function (e) { if (e.key === 'Enter') check(); };
    var m = /[#&]harness=([A-Za-z0-9-]{8,9})/.exec(location.hash || '');
    if (m) {
      input.value = m[1].toUpperCase();
      check();
      if (host.scrollIntoView) host.scrollIntoView({ block: 'center' });
    }
    paintTokens();
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
    wireCliLogin();
    // 早八提醒 ↔ /reminder/settings（开关 + 渠道凭据）
    var morning = $('#zq-morning');
    if (morning) {
      var settings = await safe('提醒设置', function () { return api.get('/reminder/settings'); });
      settings = settings || {};
      setMorningToggle(morning, settings.enabled);
      wireReminderChannel(settings, morning);
      morning.onclick = function () {
        var next = morning.dataset.on !== '1';
        // 开启之前先确认渠道真的配得起来：后端 isEnabled 要求对应凭据非空，
        // 否则每天早八都会把提醒标成 FAILED，而用户只看到开关是绿的。
        if (next && !reminderChannelReady(settings)) {
          toast('请先填写并保存推送渠道的凭据，否则提醒发不出去', 'error');
          return;
        }
        safe('保存提醒', async function () {
          await api.put('/reminder/settings', { channel: currentReminderChannel(settings), enabled: next });
          settings.enabled = next;
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
    if (logout) logout.onclick = function (e) { e.preventDefault(); safe('退出', async function () { await api.post('/auth/logout', {}); drafts.clearUser(); clearAuth(); location.href = 'index.html'; }); };
    var pw = $all('section').find(function (s) { return /修改密码/.test(s.textContent); });
    if (pw) {
      var pis = $all('input', pw), b = $('.zq-btn', pw);
      if (b) b.onclick = function () {
        if (pis[1].value !== pis[2].value) return toast('两次新密码不一致', 'error');
        safe('修改密码', async function () {
          // 改完密码，之前签发的令牌（别的设备上的、被偷走的）全部作废；这个会话拿新令牌接着用，「记住我」照旧
          var fresh = await api.put('/user/password', { oldPassword: pis[0].value, newPassword: pis[1].value });
          if (fresh && fresh.token) setAuth({ token: fresh.token, role: role() || 'USER' }, Boolean(localStorage.getItem('token')));
          toast('密码已更新，其他设备上的登录已失效');
          pis.forEach(function (i) { i.value = ''; });
        });
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
      // 桌面应用要先判：它内嵌的是系统 WebView，UA 和 Safari 长得一模一样，
      // 先走下面的浏览器分支就会把「从应用登录」显示成「Safari · macOS」。
      // 标记由原生外壳用 applicationNameForUserAgent 追加（ZhiquShell.swift）。
      if (/ZhiquDesktop/.test(ua)) return '桌面应用' + (os ? ' · ' + os : '');
      // zhiqu 命令行（ZhiquCli.userAgent）：UA 里没有任何浏览器标记，不认的话落到「浏览器」
      if (/ZhiquCLI\//.test(ua)) return '命令行' + (os ? ' · ' + os : '');
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
    return { section: section, display: ins[0], modelName: ins[1], apiUrl: ins[2], apiKey: ins[3], provider: $('select', section),
      contextWindow: $('#zq-model-context') };
  }
  function clearModelForm(els) {
    els = els || modelFormEls(); if (!els) return;
    ['display', 'modelName', 'apiUrl', 'apiKey', 'contextWindow'].forEach(function (k) { if (els[k]) els[k].value = ''; });
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
      // 总是带上这个键：空串 = 清掉（回到保守默认）。后端只在请求体里有这个键时才改它
      if (els.contextWindow) body.contextWindowTokens = els.contextWindow.value.trim();
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
    if (els.contextWindow) els.contextWindow.value = m.contextWindowTokens || '';
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
    if (refreshBtn) refreshBtn.onclick = function () { doLoad(); loadMySubmissions(); };
    selects.forEach(function (s) { s.onchange = doLoad; });
    await loadPlans('', 'time', 'desc');
    await loadMySubmissions();
  }

  var SUBMISSION_STATUS = {
    PENDING:  { label: '待审核', tone: 'var(--zq-text2)' },
    APPROVED: { label: '已发布', tone: 'var(--zq-q2)' },
    REJECTED: { label: '已驳回', tone: 'var(--zq-q1)' },
    OFFLINE:  { label: '已下架', tone: 'var(--zq-text3)' }
  };
  /**
   * 我的投稿，含驳回理由。
   *
   * 后台驳回弹窗的文案是「驳回原因（可选，将展示给提交者）」，而在此之前系统里
   * 没有任何地方展示它：公开列表只返回 APPROVED，带审核意见的 reviews 只在
   * adminDetail 里。管理员以为自己写的解释会送达，实际写完就再无出口。
   * 这一块是那句承诺的落地处。
   */
  async function loadMySubmissions() {
    var section = $('#zq-my-submissions'), host = $('#zq-my-sub-list');
    if (!section || !host) return;
    var mine;
    try {
      mine = await api.get('/shared-plans/mine');
    } catch (e) {
      section.hidden = true;   // 拉不到就整块不显示，不在公开列表下面留一条错误
      return;
    }
    mine = mine || [];
    if (!mine.length) { section.hidden = true; return; }
    section.hidden = false;
    host.innerHTML = mine.map(function (p) {
      var st = SUBMISSION_STATUS[String(p.status || '').toUpperCase()]
        || { label: p.status || '未知', tone: 'var(--zq-text3)' };
      var reason = p.rejectionReason
        ? '<div style="margin-top:8px;padding:9px 11px;border-radius:var(--zq-rs);background:var(--zq-q1-bg);'
          + 'color:var(--zq-q1);font-size:12.5px;line-height:1.55;"><b>驳回原因：</b>' + esc(p.rejectionReason) + '</div>'
        : (String(p.status || '').toUpperCase() === 'REJECTED'
            ? '<div style="margin-top:8px;font-size:12px;color:var(--zq-text3);">管理员未填写驳回原因。</div>'
            : '');
      return '<article style="padding:13px 15px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rm);'
        + 'background:var(--zq-card);"><div style="display:flex;align-items:center;gap:10px;">'
        + '<span style="font-size:14px;font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;'
        + 'white-space:nowrap;">' + esc(p.title || '未命名计划') + '</span>'
        + '<span class="zq-badge" style="color:' + st.tone + ';">' + esc(st.label) + '</span></div>'
        + '<div style="margin-top:4px;font-size:11.5px;color:var(--zq-text3);">'
        + esc(fmtDate(p.createdAt) || '') + (p.reviewedAt ? ' · 审核于 ' + esc(fmtDate(p.reviewedAt)) : '')
        + '</div>' + reason + '</article>';
    }).join('');
  }
  async function loadPlans(category, sort, order) {
    var host = $('#zq-plans'); if (!host) return;
    var qs = [];
    if (category) qs.push('category=' + category);
    if (sort) qs.push('sort=' + sort);
    if (order) qs.push('order=' + order);
    var current = latestOnly('shared-plans');
    var plans = await api.get('/shared-plans' + (qs.length ? '?' + qs.join('&') : '')) || [];
    if (!current()) return;
    // 原来这里是设计稿写死的「已审核模板 · 4 个」，从来不变（2026-10-01 用户报）。接口不分页，列表有几个就是几个
    var count = $('#zq-plan-count');
    if (count) count.textContent = (category ? (CAT_LABEL[category] || '已审核模板') : '已审核模板') + ' · ' + plans.length + ' 个';
    host.innerHTML = plans.map(function (p) {
      var cat = (p.category || 'GENERAL').toUpperCase();
      var k = CAT_KEY[cat] || 'q4';
      return '<article data-plan="' + p.id + '" style="padding:16px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rm);background:var(--zq-card);box-shadow:var(--zq-sh1);cursor:pointer;"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;"><span class="zq-badge" style="background:var(--zq-' + k + '-bg);color:var(--zq-' + k + ');font-weight:700;">' + esc(CAT_LABEL[cat] || '通用规划') + '</span><span class="zq-mono" style="font-size:12px;color:var(--zq-text3);">♡ ' + esc(p.likeCount || 0) + '</span></div><h3 style="margin:0 0 6px;font-size:15.5px;font-weight:700;">' + esc(p.title || p.name) + '</h3><p style="margin:0 0 10px;font-size:12.5px;color:var(--zq-text2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(p.description || '') + '</p><div style="display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--zq-text3);border-top:1px solid var(--zq-border-soft);padding-top:9px;"><span>' + esc(p.targetAudience || p.audience || '通用') + '</span><span>' + esc(p.creatorNickname || (p.creator && (p.creator.nickname || p.creator.username)) || '') + '</span></div></article>';
    }).join('') || empty('暂无参考计划');
    $all('[data-plan]', host).forEach(function (b) { b.onclick = function () { openPlan(Number(b.dataset.plan)); }; });
  }
  function submitPlanTemplate() {
    safe('加载我的任务', async function () {
      var tasks = (((await api.get('/task/page?limit=30')) || {}).items || []).map(normalizeTask);
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
      // 这一次打开这个计划就是「一次套用」：键在这里生成，连点、等得不耐烦又点一次，带的都是同一个键 ——
      // 服务器只执行一次（原来连点两下就建两整份任务）。换个开始日期是另一次，所以键里带上日期。
      var applyKey = writeKey();
      if (applyBtn) applyBtn.onclick = async function () {
        if (applyBtn.disabled) return;
        var startDate = await askText({ title: '套用参考计划', label: '开始日期', value: today(), hint: '格式 YYYY-MM-DD，计划内任务将从该日期起排入你的日历。', okText: '套用' });
        if (!startDate || !startDate.trim()) return;
        applyBtn.disabled = true;
        try {
          await api.post('/shared-plans/' + id + '/apply', { startDate: startDate.trim() }, { 'Idempotency-Key': applyKey + ':' + startDate.trim() });
          toast('已套用到你的日历');
          modal.style.display = 'none';
        } finally {
          applyBtn.disabled = false;
        }
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
        return itemRow(r, freqLabel(r.frequency, r.daysOfWeek) + (r.preferredTime ? ' · ' + r.preferredTime : '') + (r.durationMinutes ? ' · ' + r.durationMinutes + '分钟' : '') + ' · 第' + (r.relativeStartDay == null ? 0 : r.relativeStartDay) + '~' + (r.relativeEndDay == null ? '—' : r.relativeEndDay) + '天');
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
    wireWikiTabShortcuts();
    paintWikiTree();
    // 先尝试恢复上次的标签页；恢复不出来（第一次来、或那些页都删了）才退回默认第一页。
    if (loadWikiTabs()) {
      var restored = wikiPageById(activeWikiTab() && activeWikiTab().id);
      if (restored) { paintWikiDoc(restored, { history: true }); return; }
      state.wikiTabs = []; state.wikiTabIdx = -1;
    }
    if (state.wikiCur) paintWikiDoc(state.wikiCur);
    else paintWikiTabs();
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
      // ⌘/Ctrl+点击开新标签，和浏览器里点链接同一个手势
      a.onclick = function (e) { var p = pageOf(); if (p) paintWikiDoc(p, { newTab: e.metaKey || e.ctrlKey }); };
      a.onauxclick = function (e) {
        if (e.button !== 1) return;   // 中键
        e.preventDefault();
        var p = pageOf(); if (p) paintWikiDoc(p, { newTab: true });
      };
      a.oncontextmenu = function (e) {
        e.preventDefault();
        var p = pageOf(); if (!p) return;
        var items = [
          { label: '打开', onClick: function () { paintWikiDoc(p); } },
          { label: '在新标签页打开', onClick: function () { paintWikiDoc(p, { newTab: true }); } }
        ];
        if (!isSystemWikiPage(p)) items.push({ label: '删除该页', danger: true, onClick: function () { deleteWikiPage(p); } });
        popMenu(e.clientX, e.clientY, items);
      };
    });
  }
  /**
   * 打开一个知识页。
   *
   * opts:
   *   newTab  —— 在新标签页打开（⌘/Ctrl+点击、中键、右键菜单）
   *   history —— 这次跳转来自前进/返回按钮，不要再往历史栈里压
   *
   * 不带 opts 就是「在当前标签里跳过去」，当前页进 back 栈 —— 浏览器的行为。
   */
  async function paintWikiDoc(p, opts) {
    opts = opts || {};
    // 正在编辑时点了目录里的别的页：原来改的字直接被新页面冲掉，一声不吭。先存成草稿，回到这一页时能恢复
    if (state.wikiDirty) saveWikiDraftNow();
    state.wikiDirty = false;
    removeWikiDraftBar();
    trackWikiNavigation(p, opts);
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
    paintWikiTabs();
    offerWikiDraft(p);
  }

  // ── 知识 Wiki 没保存的改动（第十五轮） ─────────────────────────────────
  //
  // 编辑时打的字存成草稿（drafts，键 wiki.<页 id>，带着开始改时的版本号 base）：刷新、关页、登录过期、点了别的页都还在，
  // 回到这一页时顶上一条「恢复 / 丢弃」。恢复后保存用的是 base —— 这一页之后被别人改过的话，乐观锁会挡住，
  // 不会拿一份旧草稿盖掉新内容；挡住时草稿还在、字还在编辑框里。
  function wikiDraftKey(p) { return 'wiki.' + p.id; }
  function currentWikiMarkdown() {
    var doc = $('#zq-doc');
    if (!doc || doc.dataset.editing !== '1') return null;
    return doc.dataset.source === '1' ? ($('#zq-src-ta') ? $('#zq-src-ta').value : '') : htmlToMarkdown(doc);
  }
  function saveWikiDraftNow() {
    if (state.wikiDraftTimer) { clearTimeout(state.wikiDraftTimer); state.wikiDraftTimer = null; }
    var p = state.wikiCur, md = currentWikiMarkdown();
    if (!p || p.id == null || md == null) return;
    drafts.save(wikiDraftKey(p), md, { base: p._draftBase != null ? p._draftBase : p.version, title: p.title });
  }
  function wireWikiDrafts(doc) {
    if (!doc || doc.dataset.draftWired) return;
    doc.dataset.draftWired = '1';
    // 源码模式的 textarea 在 doc 里面，它的 input 事件也冒泡到这里
    doc.addEventListener('input', function () {
      if (doc.dataset.editing !== '1') return;
      state.wikiDirty = true;
      if (state.wikiDraftTimer) clearTimeout(state.wikiDraftTimer);
      state.wikiDraftTimer = setTimeout(saveWikiDraftNow, 800);
    });
    window.addEventListener('pagehide', function () { if (state.wikiDirty) saveWikiDraftNow(); });
    // 编辑了还没保存就要走：草稿先存下，浏览器再问一句
    window.addEventListener('beforeunload', function (e) {
      if (!state.wikiDirty) return;
      saveWikiDraftNow();
      e.preventDefault();
      e.returnValue = '';
    });
  }
  function removeWikiDraftBar() { var b = document.getElementById('zq-wiki-draft'); if (b) b.remove(); }
  function offerWikiDraft(p) {
    removeWikiDraftBar();
    var doc = $('#zq-doc');
    if (!doc || !p || p.id == null) return;
    var d = drafts.load(wikiDraftKey(p));
    if (!d || d.text === (p.content || '')) return;
    var bar = document.createElement('div');
    bar.id = 'zq-wiki-draft';
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin:0 0 12px;padding:9px 12px;border:1px solid var(--zq-tint-strong);border-radius:var(--zq-rs);background:var(--zq-tint);font-size:12.5px;color:var(--zq-text);';
    var when = new Date(d.at);
    var moved = d.base != null && p.version != null && Number(d.base) !== Number(p.version);
    bar.innerHTML = '<span style="flex:1;">这一页有没保存的修改（' + esc((when.getMonth() + 1) + '/' + when.getDate() + ' ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0'))
      + '）' + (moved ? '。之后这一页被改过，恢复后保存时会先问你' : '') + '</span>'
      + '<button class="zq-btn" data-draft="restore" style="height:28px;">恢复</button><button class="zq-btn-ghost" data-draft="drop" style="height:28px;">丢弃</button>';
    doc.parentNode.insertBefore(bar, doc);
    $('[data-draft="restore"]', bar).onclick = function () {
      removeWikiDraftBar();
      enterWikiEdit();
      if (doc.dataset.source !== '1') toggleWikiSource();
      var ta = $('#zq-src-ta'); if (ta) ta.value = d.text;
      p._draftBase = d.base != null ? d.base : p.version;
      state.wikiDirty = true;
    };
    $('[data-draft="drop"]', bar).onclick = function () { drafts.clear(wikiDraftKey(p)); removeWikiDraftBar(); };
  }
  // ── 知识 Wiki 的标签页 ────────────────────────────────────────────────
  //
  // 三件事凑在一起：标签栏、每个标签自己的前进/返回、刷新后还在。
  // 形状故意只存 id 不存整页对象：页面内容会被编辑，存快照会让标签显示旧标题。

  var WIKI_TABS_KEY = 'zq.wiki.tabs';

  function activeWikiTab() {
    return state.wikiTabs[state.wikiTabIdx] || null;
  }

  function newWikiTab(id, title) {
    return { id: id == null ? null : String(id), title: title || '新标签页', back: [], fwd: [] };
  }

  /** 把这次跳转记进标签与历史。paintWikiDoc 的第一件事。 */
  function trackWikiNavigation(p, opts) {
    var id = p && p.id != null ? String(p.id) : null;
    if (opts.newTab || !state.wikiTabs.length) {
      state.wikiTabs.push(newWikiTab(id, p && p.title));
      state.wikiTabIdx = state.wikiTabs.length - 1;
      saveWikiTabs();
      return;
    }
    var tab = activeWikiTab();
    if (!tab) {
      state.wikiTabs.push(newWikiTab(id, p && p.title));
      state.wikiTabIdx = state.wikiTabs.length - 1;
      saveWikiTabs();
      return;
    }
    // 两个条件各挡一件事，而承重的是后一个：
    //   !opts.history —— 调用方明说「这不是跳转」（前进/返回、切标签、保存后重绘）
    //   tab.id !== id —— 同一页再打开一次不算跳转
    // 扰动实测：去掉 history:true 那些地方历史栈纹丝不动，因为 id 相等这一条已经拦住了。
    // 所以 history 参数是把意图写明白，真正防止「返回按钮原地打转」的是 id 比较。
    if (!opts.history && tab.id && tab.id !== id) {
      tab.back.push(tab.id);
      // 走过新路就没有「前进」可言了 —— 和浏览器一致。
      tab.fwd = [];
      // 历史不必无限长；50 步远超实际需要，但比「无上限」安全。
      if (tab.back.length > 50) tab.back.shift();
    }
    tab.id = id;
    tab.title = (p && p.title) || tab.title;
    saveWikiTabs();
  }

  function wikiPageById(id) {
    if (id == null) return null;
    return (state.wikiPages || []).find(function (x) { return String(x.id) === String(id); }) || null;
  }

  /** 前进 / 返回。方向：-1 返回，+1 前进。 */
  function wikiHistoryGo(direction) {
    var tab = activeWikiTab();
    if (!tab) return;
    var from = direction < 0 ? tab.back : tab.fwd;
    var to = direction < 0 ? tab.fwd : tab.back;
    if (!from.length) return;
    var targetId = from.pop();
    var target = wikiPageById(targetId);
    if (!target) {
      // 那一页被删了。丢掉这一步继续往回找，而不是卡住 ——
      // 「点了没反应」比「跳过一步」更让人以为按钮坏了。
      saveWikiTabs();
      return wikiHistoryGo(direction);
    }
    if (tab.id) to.push(tab.id);
    tab.id = targetId;
    saveWikiTabs();
    paintWikiDoc(target, { history: true });
  }

  function closeWikiTab(index) {
    if (index < 0 || index >= state.wikiTabs.length) return;
    state.wikiTabs.splice(index, 1);
    if (!state.wikiTabs.length) {
      state.wikiTabIdx = -1;
      state.wikiCur = null;
      saveWikiTabs();
      var doc = $('#zq-doc'), title = $('#zq-doc-title');
      if (doc) doc.innerHTML = empty('没有打开的页面 · 从左侧目录选一页，或点 + 新建标签');
      if (title) title.textContent = '';
      paintWikiTabs();
      paintWikiTree();
      return;
    }
    // 关掉的是当前标签或它左边的标签时，索引要跟着往左收 —— 否则会指到别人身上。
    if (state.wikiTabIdx >= state.wikiTabs.length) state.wikiTabIdx = state.wikiTabs.length - 1;
    else if (index < state.wikiTabIdx) state.wikiTabIdx -= 1;
    saveWikiTabs();
    var next = wikiPageById(activeWikiTab().id);
    if (next) paintWikiDoc(next, { history: true });
    else { paintWikiTabs(); paintWikiTree(); }
  }

  function activateWikiTab(index) {
    if (index === state.wikiTabIdx || index < 0 || index >= state.wikiTabs.length) return;
    state.wikiTabIdx = index;
    saveWikiTabs();
    var target = wikiPageById(state.wikiTabs[index].id);
    // history:true —— 切换标签不是一次「跳转」，不该进任何一个标签的历史栈。
    if (target) paintWikiDoc(target, { history: true });
    else { paintWikiTabs(); paintWikiTree(); }
  }

  function paintWikiTabs() {
    var bar = $('#zq-wiki-tabs');
    if (!bar) return;
    var tabs = state.wikiTabs || [];
    bar.innerHTML = tabs.map(function (t, i) {
      var on = i === state.wikiTabIdx;
      return '<div data-wiki-tab="' + i + '" title="' + esc(t.title || '') + '" style="' +
        'display:flex;align-items:center;gap:6px;max-width:190px;padding:7px 8px 7px 12px;cursor:pointer;' +
        'border-right:1px solid var(--zq-border-soft);font-size:12.5px;white-space:nowrap;' +
        'background:' + (on ? 'var(--zq-card)' : 'transparent') + ';' +
        'color:' + (on ? 'var(--zq-text)' : 'var(--zq-text2)') + ';' +
        'font-weight:' + (on ? 600 : 500) + ';' +
        'box-shadow:' + (on ? 'inset 0 2px 0 var(--zq-primary)' : 'none') + ';">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;">' + esc(t.title || '新标签页') + '</span>' +
        '<span data-wiki-tab-close="' + i + '" title="关闭" style="flex:0 0 auto;width:16px;height:16px;' +
        'display:flex;align-items:center;justify-content:center;border-radius:4px;' +
        'color:var(--zq-text3);font-size:13px;line-height:1;">×</span></div>';
    }).join('') +
      '<div data-wiki-tab-new="1" title="新标签页" style="display:flex;align-items:center;justify-content:center;' +
      'width:30px;flex:0 0 auto;cursor:pointer;color:var(--zq-text3);font-size:15px;">+</div>';

    $all('[data-wiki-tab]', bar).forEach(function (el) {
      el.onclick = function (e) {
        if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-wiki-tab-close')) return;
        activateWikiTab(Number(el.dataset.wikiTab));
      };
      // 中键关闭 —— 浏览器标签页的通用手势
      el.onauxclick = function (e) {
        if (e.button !== 1) return;
        e.preventDefault();
        closeWikiTab(Number(el.dataset.wikiTab));
      };
    });
    $all('[data-wiki-tab-close]', bar).forEach(function (el) {
      el.onclick = function (e) { e.stopPropagation(); closeWikiTab(Number(el.dataset.wikiTabClose)); };
    });
    var plus = $('[data-wiki-tab-new]', bar);
    if (plus) plus.onclick = openWikiQuickSwitch;

    var back = $('#zq-wiki-back'), fwd = $('#zq-wiki-fwd'), tab = activeWikiTab();
    // 没有历史时置灰而不是隐藏：按钮位置固定，标题才不会左右跳。
    if (back) { back.disabled = !(tab && tab.back.length); back.style.opacity = back.disabled ? '.35' : '1'; }
    if (fwd) { fwd.disabled = !(tab && tab.fwd.length); fwd.style.opacity = fwd.disabled ? '.35' : '1'; }
  }

  /** + 按钮：列出所有页面让用户挑一个，选中后在新标签打开。 */
  function openWikiQuickSwitch() {
    var pages = state.wikiPages || [];
    var h = openModal({
      title: '在新标签页打开',
      width: 460,
      bodyHtml: '<input id="zq-qs-input" class="zq-input" placeholder="输入标题筛选…" style="width:100%;margin-bottom:10px;">' +
        '<div id="zq-qs-list" style="max-height:52vh;overflow:auto;display:flex;flex-direction:column;gap:2px;"></div>',
      onMount: function (body) {
        var input = $('#zq-qs-input', body), list = $('#zq-qs-list', body);
        function paint() {
          var q = (input.value || '').trim().toLowerCase();
          var hit = pages.filter(function (p) { return !q || (p.title || '').toLowerCase().indexOf(q) >= 0; });
          list.innerHTML = hit.map(function (p) {
            return '<a data-qs="' + p.id + '" style="display:block;padding:8px 10px;border-radius:var(--zq-rs);' +
              'cursor:pointer;font-size:13px;color:var(--zq-text2);">' + esc(p.title) + '</a>';
          }).join('') || empty('没有匹配的页面');
          $all('[data-qs]', list).forEach(function (a) {
            a.onclick = function () {
              var target = wikiPageById(a.dataset.qs);
              if (target) { h.close(); paintWikiDoc(target, { newTab: true }); }
            };
          });
        }
        input.oninput = paint;
        paint();
        input.focus();
      }
    });
  }

  /**
   * 标签页存进 localStorage，刷新后还在。
   *
   * 两处防御：写失败要吞掉（隐私模式下 localStorage 会抛），读回来的东西要当成
   * 不可信数据校验 —— 它可能是上一个版本写的，形状对不上就整份丢掉，而不是让
   * 后面每一次 tab.back.push 都炸。
   */
  function saveWikiTabs() {
    try {
      localStorage.setItem(WIKI_TABS_KEY, JSON.stringify({ tabs: state.wikiTabs, idx: state.wikiTabIdx }));
    } catch (e) { /* 存不下就算了，标签页只是便利 */ }
  }

  function loadWikiTabs() {
    var raw = null;
    try { raw = localStorage.getItem(WIKI_TABS_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return false;
    var tabs = [];
    data.tabs.forEach(function (t) {
      if (!t || typeof t !== 'object') return;
      // 页可能已经被删掉了 —— 那条标签不该复活
      if (t.id != null && !wikiPageById(t.id)) return;
      tabs.push({
        id: t.id == null ? null : String(t.id),
        title: typeof t.title === 'string' ? t.title : '新标签页',
        back: Array.isArray(t.back) ? t.back.filter(function (x) { return wikiPageById(x); }).map(String) : [],
        fwd: Array.isArray(t.fwd) ? t.fwd.filter(function (x) { return wikiPageById(x); }).map(String) : []
      });
    });
    if (!tabs.length) return false;
    state.wikiTabs = tabs;
    state.wikiTabIdx = Number.isInteger(data.idx) && data.idx >= 0 && data.idx < tabs.length ? data.idx : 0;
    return true;
  }

  function wireWikiTabShortcuts() {
    if (wireWikiTabShortcuts._done) return;
    wireWikiTabShortcuts._done = true;
    var back = $('#zq-wiki-back'), fwd = $('#zq-wiki-fwd');
    if (back) back.onclick = function () { wikiHistoryGo(-1); };
    if (fwd) fwd.onclick = function () { wikiHistoryGo(1); };
    document.addEventListener('keydown', function (e) {
      if (!$('#zq-wiki-tabs')) return;
      var doc = $('#zq-doc');
      // 编辑正文时 ⌘[ 是缩进之类的编辑操作，不抢
      if (doc && doc.dataset.editing === '1') return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === '[') { e.preventDefault(); wikiHistoryGo(-1); }
      else if (e.key === ']') { e.preventDefault(); wikiHistoryGo(1); }
      else if (e.key === 'w' && state.wikiTabs.length) { e.preventDefault(); closeWikiTab(state.wikiTabIdx); }
    });
  }

  function wireWikiLinks(doc) {
    $all('[data-wikilink]', doc).forEach(function (a) {
      a.onclick = function (e) {
        if (doc.dataset.editing === '1') return;
        e.preventDefault();
        e.stopPropagation(); // 阻止冒泡到正文容器，否则跳转后的目标页会立刻进入编辑态
        var t = a.getAttribute('data-wikilink');
        var target = (state.wikiPages || []).find(function (x) { return (x.title || '') === t; });
        if (target) paintWikiDoc(target, { newTab: e.metaKey || e.ctrlKey }); else toast('页面不存在：' + t, 'error');
      };
      a.onauxclick = function (e) {
        if (e.button !== 1 || doc.dataset.editing === '1') return;
        e.preventDefault(); e.stopPropagation();
        var t = a.getAttribute('data-wikilink');
        var target = (state.wikiPages || []).find(function (x) { return (x.title || '') === t; });
        if (target) paintWikiDoc(target, { newTab: true });
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
          // 改名走的是整页保存，要带着正文 —— 目录树不给正文（只给摘要），正文还没取回来（刚打开、或者取失败了）
          // 就先取一遍。不取的话后端会拒（「内容不能为空」），用户看到的是改名莫名失败。
          if (!p._full) {
            var detail = await api.get('/knowledge/pages/' + p.id);
            p.content = detail.content; p.version = detail.version; p._full = true;
          }
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
    wireWikiDrafts(doc);
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
      doc.innerHTML = '<textarea id="zq-src-ta" style="width:100%;min-height:360px;border:1px solid var(--zq-border);border-radius:var(--zq-rs);padding:12px;font-size:13px;line-height:1.7;font-family:var(--zq-fontM);background:var(--zq-input-bg);color:var(--zq-text);resize:vertical;box-sizing:border-box;"></textarea>';
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
    // history:true —— 取消编辑是重绘当前页，不是一次跳转，不该压进返回栈
    $('#zq-wiki-cancel').onclick = function () {
      // 取消 = 明确不要这些改动：草稿一起删，不再提示恢复
      var cur = state.wikiCur;
      state.wikiDirty = false;
      if (cur) { drafts.clear(wikiDraftKey(cur)); cur._draftBase = null; }
      paintWikiDoc(state.wikiCur, { history: true });
    };
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
  async function saveWikiEdit() {
    var doc = $('#zq-doc'), p = state.wikiCur; if (!doc || !p) return;
    var md = doc.dataset.source === '1' ? ($('#zq-src-ta') ? $('#zq-src-ta').value : '') : htmlToMarkdown(doc);
    // 恢复的是一份旧版本上改的草稿，而这一页之后被改过：直接按旧版本存会被乐观锁挡住，而且每次都挡 —— 刷新重试也一样，
    // 草稿永远存不进去（第十五轮真浏览器里走出来的死胡同）。所以先明说，用户点了「替换」才按现在的版本存。
    if (p._draftBase != null && p.version != null && Number(p._draftBase) !== Number(p.version)) {
      var replace = await askConfirm({
        title: '这一页在你离开之后被改过',
        message: '编辑框里是你当时没保存的那一版。直接保存会用它替换现在的内容 —— 别处后来加的会没了。\n\n想先对照的话点「取消」，在另一个标签页打开这一页看看现在是什么样。',
        okText: '用我的这一版替换',
        danger: true
      });
      if (!replace) return;
      p._draftBase = p.version;
    }
    safe('保存知识页', async function () {
      var baseVersion = p._draftBase != null ? p._draftBase : p.version;
      var updated = await api.put('/knowledge/pages/' + p.id, { title: p.title, content: md, pageType: p.pageType, parentId: p.parentId, sortOrder: p.sortOrder, pinned: p.pinned, version: baseVersion });
      // 存上了才删草稿；被乐观锁挡住时走不到这里，草稿和编辑框里的字都还在
      drafts.clear(wikiDraftKey(p));
      p._draftBase = null;
      state.wikiDirty = false;
      p.content = updated && updated.content != null ? updated.content : md;
      if (updated && updated.version != null) p.version = updated.version;
      if (updated && updated.updatedAt) p.updatedAt = updated.updatedAt;
      // history:true —— 保存后重绘的还是这一页，压进返回栈会让「返回」原地打转
      paintWikiDoc(p, { history: true });
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
        + '<div class="zq-field"><label class="zq-label" for="zq-imp-file">选择文件</label><input id="zq-imp-file" type="file" class="zq-input" style="height:auto;padding:7px 12px;" accept=".pdf,.xlsx,.xls,.txt,.md,.csv,.json,.xml,.png,.jpg,.jpeg,.webp"></div>'
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
        // 粘贴的一大段原文：弹窗被遮罩点掉、刷新、登录过期都还在（第十五轮）；导入成功才删
        var contentDraft = keepDraft($('#zq-imp-content', b), 'wiki.import.content');
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
                var saved = await api.upload('/knowledge/sources/upload', file, title ? { title: title } : {});
                n.update('来源解析完成' + truncatedNote(saved), { done: true });
              } catch (e) { n.update('解析失败：' + (e.message || '未知错误'), { error: true }); throw e; }
            });
            return;
          }
          var content = $('#zq-imp-content', b).value;
          var type = $('#zq-imp-type', b).value;
          if (!title) return toast('请填写来源标题', 'error');
          safe('导入来源', async function () {
            var saved = await api.post('/knowledge/sources', { title: title, content: content, sourceType: type });
            contentDraft.clear();
            h.close(); toast('来源已导入' + truncatedNote(saved));
          });
        };
      }
    });
  }
  /** 来源原文超过上限时后端只存前面一段，并在回包里说 {kept, total} —— 这里把它说给用户，不让截断悄悄发生 */
  function truncatedNote(saved) {
    var t = saved && saved.truncated;
    return t ? '（原文 ' + t.total + ' 字，只保存了前 ' + t.kept + ' 字）' : '';
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
    var html = '', inUl = false, inOl = false, inCode = false, inMath = false, codeBuf = [], codeLang = '', mathBuf = [], quoteBuf = [], tableBuf = [];
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
          html += '<pre style="margin:12px 0;padding:12px 14px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);overflow-x:auto;"><code class="zq-mono" style="font-size:12.5px;line-height:1.65;white-space:pre;">' + highlightCode(codeBuf.join('\n'), codeLang) + '</code></pre>';
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
    if (inCode) { html += '<pre style="margin:12px 0;padding:12px 14px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);overflow-x:auto;"><code class="zq-mono" style="font-size:12.5px;line-height:1.65;white-space:pre;">' + highlightCode(codeBuf.join('\n'), codeLang) + '</code></pre>'; }
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
    var codeRemembered = false;
    try { codeRemembered = localStorage.getItem('zq.codeMode') === '1'; } catch (e) { /* 隐私模式 */ }
    setAiToggleState('code', codeRemembered);
    var webBtn = $('#zq-web'), thinkBtn = $('#zq-think'), sendBtn = $('#zq-send'), draft = $('#zq-draft');
    var codeBtn = $('#zq-code');
    if (codeBtn) codeBtn.onclick = function () { aiToggle('code'); };
    if (webBtn) webBtn.onclick = function () { aiToggle('web'); };
    if (thinkBtn) thinkBtn.onclick = function () { aiToggle('think'); };
    if (sendBtn) sendBtn.onclick = sendAiMessage;
    if (draft) {
      state.chatDraft = keepDraft(draft, chatDraftKey, growDraft);
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
    // 工作区与 notebook / 模型并行拉：它是独立的一块，不该让首屏多等一轮
    await Promise.all([loadAiNotebooks(), loadAiModelSelect(), loadWorkspace()]);
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

  var AI_TOGGLE_IDS = { web: 'zq-web', think: 'zq-think', code: 'zq-code' };
  function setAiToggleState(kind, on) {
    var button = document.getElementById(AI_TOGGLE_IDS[kind]);
    if (!button) return;
    button.dataset.on = on ? '1' : '0';
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.style.border = '1px solid ' + (on ? 'var(--zq-tint-strong)' : 'var(--zq-border)');
    button.style.background = on ? 'var(--zq-tint)' : 'var(--zq-card)';
    button.style.color = on ? 'var(--zq-primary)' : 'var(--zq-text2)';
    button.style.fontWeight = '600';
  }

  function aiToggle(k) {
    var button = document.getElementById(AI_TOGGLE_IDS[k]);
    if (!button) return;
    setAiToggleState(k, button.dataset.on !== '1');
    // 「代码」开关要记住：进了写代码的状态，一般会连着说好几轮，每次都重按是折磨。
    // 联网 / 深度思考不记 —— 它们按轮计费或变慢，默认关着更稳妥。
    if (k === 'code') {
      try { localStorage.setItem('zq.codeMode', button.dataset.on === '1' ? '1' : '0'); } catch (e) { /* 隐私模式 */ }
    }
  }
  /** 「代码」开关此刻是否生效：按钮可见（工作区生效）且按下。隐藏时即使按下过也不算。 */
  function codeModeOn() {
    var b = $('#zq-code');
    return !!(b && !b.hidden && b.dataset.on === '1');
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

    // 直接在输入框里粘贴图片 / 文件（⌘V）。走拖拽同一条上传路径，
    // 所以上传完同样会出现在左侧资料区、并自动挂到下一条消息上。
    //
    // 只在剪贴板里真的有文件时才拦截：粘贴纯文本必须照常插进输入框，
    // 一律拦掉的话用户连复制一段话进来都做不到。
    var draftInput = $('#zq-draft');
    if (draftInput) {
      draftInput.addEventListener('paste', function (event) {
        var items = (event.clipboardData && event.clipboardData.items) || [];
        var files = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === 'file') {
            var file = items[i].getAsFile();
            if (file) files.push(file);
          }
        }
        if (!files.length) return;   // 纯文本粘贴：不拦
        event.preventDefault();
        uploadAiFiles(files, true);
      });
    }
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
    var readyCount = 0, archiveCount = 0, errorCount = 0, imageCount = 0, firstError = '';
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
          // 图片是 UPLOADED（只存原件、不做文本解析），但它照样要能挂到消息上 ——
          // 后端会把它作为视觉内容块直接交给模型。只认 READY 的话，拖进来的图片
          // 永远到不了模型面前，而界面只显示「0 份可用于问答」，看起来像没用。
          if (attachToNextMessage && notebookId === state.notebookId
              && String(source.sourceType || '').toUpperCase() === 'IMAGE') {
            addPendingSource(source);
            imageCount++;
          }
        } else {
          errorCount++;
          // 失败要说出原因。只报「1 份失败」的话，图片原件没保存下来这种事
          // 看起来跟「文件格式不对」一模一样，用户没法判断该重试还是该换文件。
          if (!firstError && source && source.parseError) firstError = String(source.parseError);
        }
      } catch (error) {
        errorCount++;
        if (!firstError && error && error.message) firstError = String(error.message);
      }
    }
    if (notebookId === state.notebookId) {
      await loadAiNotebooks();
    }
    var summary = readyCount + ' 份可用于问答';
    if (imageCount) summary += '，' + imageCount + ' 张图片已附到下一条消息';
    if (archiveCount - imageCount > 0) summary += '，' + (archiveCount - imageCount) + ' 份仅存档';
    if (errorCount) summary += '，' + errorCount + ' 份失败';
    setAiDropState(summary, errorCount && !readyCount ? 'error' : 'done');
    toast('上传完成：' + summary + (firstError ? '（' + firstError + '）' : ''),
      errorCount && !(readyCount || imageCount) ? 'error' : undefined);
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
      return '<div style="display:flex;gap:9px;padding:5px 0;"><div style="display:flex;flex-direction:column;align-items:center;flex:none;width:10px;"><span style="width:8px;height:8px;border-radius:50%;background:' + color + ';margin-top:4px;"></span>' + (last ? '' : '<span style="flex:1;width:1px;background:var(--zq-border-soft);margin-top:2px;"></span>') + '</div><div style="min-width:0;padding-bottom:6px;"><div style="font-size:11.5px;font-weight:600;line-height:1.45;">' + esc(stepName) + '</div><div class="zq-mono" style="font-size:10px;color:' + color + ';margin-top:1px;">' + esc(metaLine) + '</div>' + (s.notes || []).map(stepNoteHtml).join('') + '</div></div>';
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
      MEMORY_DRAFT: '记忆草稿',
      CODE_DRAFT: '代码改动草稿',
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
    if (item.frequency) bits.push(freqLabel(item.frequency, item.daysOfWeek));
    if (item.preferredTime) bits.push(item.preferredTime);
    if (item.durationMinutes) bits.push(item.durationMinutes + ' 分钟');
    if (item.startDate) bits.push(item.startDate + (item.endDate ? ' → ' + item.endDate : ''));
    return bits.join(' · ');
  }


  // 记忆草稿：AI 从对话里挑出的长期事实，逐条勾选，确认后才并进长期记忆。
  // 和计划草稿同一条纪律——不确认不落库；记忆更需要它，因为它会进后续每一轮的系统提示词。
  var shownMemoryModals = Object.create(null);

  function isMemoryDraft(artifact) {
    var status = String(artifact.status || '').toUpperCase();
    return String(artifact.artifactType || '').toUpperCase() === 'MEMORY_DRAFT'
      && (status === 'DRAFT' || status === 'PENDING');
  }

  function memoryDraftItems(artifact) {
    var content = artifactContent(artifact);
    var items = Array.isArray(content.items) ? content.items : [];
    return items.map(function (item) {
      return typeof item === 'string' ? { text: item } : Object.assign({}, item);
    }).filter(function (item) { return String(item.text || '').trim(); });
  }

  function openMemoryConfirmModal(artifact) {
    var items = memoryDraftItems(artifact);
    if (!items.length) return null;
    shownMemoryModals[artifact.id] = true;
    var picked = items.map(function () { return true; });
    var handle = openModal({ title: 'AI 想记住这些', width: 520, bodyHtml: '<div class="zq-plan-confirm"></div>' });
    var root = handle.body.querySelector('.zq-plan-confirm');

    function paint() {
      var html = '<p class="zq-plan-hint">以下内容会长期影响 AI 对你的了解，'
        + '<strong>确认后才会写入长期记忆</strong>。</p><div class="zq-plan-group">';
      items.forEach(function (item, i) {
        html += '<label class="zq-plan-row">'
          + '<input type="checkbox" data-pick="' + i + '"' + (picked[i] ? ' checked' : '') + '>'
          + '<div class="zq-plan-row-body"><div class="zq-plan-name">' + esc(String(item.text)) + '</div></div>'
          + '</label>';
      });
      html += '</div><div class="zq-plan-actions">'
        + '<button class="zq-btn" data-mem="ignore">忽略</button>'
        + '<button class="zq-btn zq-btn-primary" data-mem="ok">确认写入</button></div>';
      root.innerHTML = html;
      $all('[data-pick]', root).forEach(function (box) {
        box.onchange = function () { picked[Number(box.dataset.pick)] = box.checked; };
      });
      $('[data-mem="ignore"]', root).onclick = function () {
        safe('忽略记忆草稿', async function () {
          await api.post('/ai/artifacts/' + artifact.id + '/discard', {});
          handle.close(); toast('已忽略'); await renderAgentPanels();
        });
      };
      $('[data-mem="ok"]', root).onclick = function () {
        var chosen = items.filter(function (_, i) { return picked[i]; });
        if (!chosen.length) { toast('请至少勾选一条，或点「忽略」'); return; }
        safe('确认记忆', async function () {
          await api.post('/ai/artifacts/' + artifact.id + '/confirm', { items: chosen });
          handle.close(); toast('已写入长期记忆'); await renderAgentPanels();
        });
      };
    }
    paint();
    return handle;
  }

// ── 代码草稿：AI 改代码的产物，确认之前磁盘一个字节都没动 ─────────────────
  //
  // 与计划 / 记忆草稿同一条纪律，但确认的后果更重：写的是用户自己电脑上的源码。
  // 所以弹窗展示的是 **diff**，不是整份新内容 —— 用户要能一眼看出改了哪几行。
  var shownCodeModals = Object.create(null);

  function isCodeDraft(artifact) {
    var status = String(artifact.status || '').toUpperCase();
    return String(artifact.artifactType || '').toUpperCase() === 'CODE_DRAFT'
      && (status === 'DRAFT' || status === 'PENDING');
  }

  function codeDraftFiles(artifact) {
    var content = artifactContent(artifact);
    var files = Array.isArray(content.files) ? content.files : [];
    return files.filter(function (f) { return f && f.path; }).map(function (f) {
      return { path: String(f.path), content: String(f.content == null ? '' : f.content),
               baseline: f.baseline, creating: !!f.creating,
               newDirectories: Array.isArray(f.newDirectories) ? f.newDirectories.map(String) : [] };
    });
  }

  /**
   * 逐行 diff（最长公共子序列）。
   *
   * <p>行数乘积超过 LCS_BUDGET 就不算了 —— O(n·m) 的表在大文件上会把浏览器卡死，
   * 而「卡死」比「没有 diff」糟糕得多。这时退回整份替换视图，并明说退回了。
   */
  var LCS_BUDGET = 2000 * 2000;

  function diffLines(oldText, newText) {
    var a = String(oldText == null ? '' : oldText).split('\n');
    var b = String(newText == null ? '' : newText).split('\n');
    if (a.length * b.length > LCS_BUDGET) return null;
    var m = a.length, n = b.length;
    var table = [];
    for (var i = 0; i <= m; i++) table.push(new Int32Array(n + 1));
    for (var i2 = m - 1; i2 >= 0; i2--) {
      for (var j2 = n - 1; j2 >= 0; j2--) {
        table[i2][j2] = a[i2] === b[j2] ? table[i2 + 1][j2 + 1] + 1
          : Math.max(table[i2 + 1][j2], table[i2][j2 + 1]);
      }
    }
    var out = [], i3 = 0, j3 = 0;
    while (i3 < m && j3 < n) {
      if (a[i3] === b[j3]) { out.push([' ', a[i3]]); i3++; j3++; }
      else if (table[i3 + 1][j3] >= table[i3][j3 + 1]) { out.push(['-', a[i3]]); i3++; }
      else { out.push(['+', b[j3]]); j3++; }
    }
    while (i3 < m) { out.push(['-', a[i3++]]); }
    while (j3 < n) { out.push(['+', b[j3++]]); }
    return out;
  }

  /** 只显示改动附近的行，中间大段未改动的折起来 —— 否则一个长文件里几行改动根本找不到。 */
  function diffHtml(rows) {
    if (!rows) {
      return '<div style="padding:8px;font-size:11.5px;color:var(--zq-text3);">'
        + '文件太大，没有逐行比对（那会把浏览器卡住）。请确认后自行用 git 查看改动。</div>';
    }
    var CONTEXT = 3;
    var keep = rows.map(function () { return false; });
    rows.forEach(function (r, i) {
      if (r[0] === ' ') return;
      for (var k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) keep[k] = true;
    });
    var html = '', skipped = 0;
    var color = { '+': 'var(--zq-q2)', '-': 'var(--zq-bad)', ' ': 'var(--zq-text3)' };
    var bg = { '+': 'color-mix(in srgb, var(--zq-q2) 12%, transparent)',
               '-': 'color-mix(in srgb, var(--zq-bad) 12%, transparent)', ' ': 'transparent' };
    rows.forEach(function (r, i) {
      if (!keep[i]) { skipped++; return; }
      if (skipped) {
        html += '<div style="padding:2px 8px;font-size:10.5px;color:var(--zq-text3);">⋯ 省略 '
          + skipped + ' 行未改动 ⋯</div>';
        skipped = 0;
      }
      html += '<div style="display:flex;background:' + bg[r[0]] + ';">'
        + '<span style="flex:none;width:16px;text-align:center;color:' + color[r[0]] + ';">' + r[0] + '</span>'
        + '<span style="flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;color:'
        + (r[0] === ' ' ? 'var(--zq-text2)' : color[r[0]]) + ';">' + esc(r[1]) + '</span></div>';
    });
    if (skipped) {
      html += '<div style="padding:2px 8px;font-size:10.5px;color:var(--zq-text3);">⋯ 省略 '
        + skipped + ' 行未改动 ⋯</div>';
    }
    return '<div class="zq-mono" style="font-size:11.5px;line-height:1.55;max-height:46vh;overflow:auto;'
      + 'border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);background:var(--zq-card-soft);">'
      + (html || '<div style="padding:8px;color:var(--zq-text3);">没有差异</div>') + '</div>';
  }

  function openCodeConfirmModal(artifact) {
    var files = codeDraftFiles(artifact);
    if (!files.length) return null;
    shownCodeModals[artifact.id] = true;
    var picked = files.map(function () { return true; });
    var handle = openModal({ title: 'AI 想改这些文件', width: 760, bodyHtml: '<div class="zq-plan-confirm"></div>' });
    var root = handle.body.querySelector('.zq-plan-confirm');
    root.innerHTML = '<p class="zq-plan-hint">正在读取文件当前内容…</p>';

    // 先把每个文件<b>现在</b>的内容取回来再比 —— diff 要比的是「磁盘上现在是什么」，
    // 不是模型当时读到的那份。中间用户可能已经自己改过了，那种情况确认时会被基线挡住，
    // 但在弹窗里就该让他看见。
    Promise.all(files.map(function (f) {
      if (f.creating) return Promise.resolve('');
      return api.get('/workspace/file?path=' + encodeURIComponent(f.path))
        .then(function (r) { return r && r.content != null ? r.content : ''; })
        .catch(function () { return null; });   // 读不到就标出来，而不是当成空文件
    })).then(function (currents) {
      function paint() {
        var html = '<p class="zq-plan-hint">这些改动<strong>还没有写进磁盘</strong>。'
          + '看过 diff、点「确认写入」之后才会落盘。</p>';
        files.forEach(function (f, i) {
          var current = currents[i];
          var unreadable = current === null;
          html += '<div class="zq-plan-group" style="margin-bottom:10px;">'
            + '<label class="zq-plan-row" style="align-items:center;">'
            + '<input type="checkbox" data-pick="' + i + '"' + (picked[i] ? ' checked' : '') + '>'
            + '<div class="zq-plan-row-body"><div class="zq-plan-name zq-mono">' + esc(f.path)
            + (f.creating ? '<span style="margin-left:6px;font-size:10.5px;color:var(--zq-q2);">新建</span>' : '')
            + (f.newDirectories.length ? '<span style="margin-left:6px;font-size:10.5px;color:var(--zq-q2);">连同新建目录 '
                + esc(f.newDirectories.join('、')) + '</span>' : '')
            + (unreadable ? '<span style="margin-left:6px;font-size:10.5px;color:var(--zq-bad);">读不到当前内容</span>' : '')
            + '</div></div></label>'
            + (unreadable ? '' : diffHtml(diffLines(current, f.content)))
            + '</div>';
        });
        html += '<div class="zq-plan-actions">'
          + '<button class="zq-btn" data-code="ignore">忽略</button>'
          + '<button class="zq-btn zq-btn-primary" data-code="ok">确认写入</button></div>';
        root.innerHTML = html;
        $all('[data-pick]', root).forEach(function (box) {
          box.onchange = function () { picked[Number(box.dataset.pick)] = box.checked; };
        });
        $('[data-code="ignore"]', root).onclick = function () {
          safe('忽略代码草稿', async function () {
            await api.post('/ai/artifacts/' + artifact.id + '/discard', {});
            handle.close(); toast('已忽略'); await renderAgentPanels();
          });
        };
        $('[data-code="ok"]', root).onclick = function () {
          var chosen = files.filter(function (_, i) { return picked[i]; }).map(function (f) { return { path: f.path }; });
          if (!chosen.length) { toast('请至少勾选一个文件，或点「忽略」'); return; }
          safe('写入代码改动', async function () {
            await api.post('/ai/artifacts/' + artifact.id + '/confirm', { files: chosen });
            handle.close(); toast('已写入 ' + chosen.length + ' 个文件'); await renderAgentPanels();
          });
        };
      }
      paint();
    });
    return handle;
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
      var draft = ['PLAN_DRAFT', 'TASK_DRAFT', 'ROUTINE_DRAFT', 'WIKI_DRAFT', 'NOTE_DRAFT', 'MEMORY_DRAFT'].indexOf(type) >= 0
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
            + ((isPlanDraft(artifact) || isMemoryDraft(artifact) || isCodeDraft(artifact))
              ? '<button data-art-view="' + artifact.id + '">查看并确认</button>'
              : '<button data-art-ok="' + artifact.id + '">确认</button>')
            + '<button data-art-no="' + artifact.id + '" class="zq-btn-ghost">忽略</button></div>' : '')
        + '</article>';
    }).join('') : empty('暂无产物');
    $all('[data-art-view]', host).forEach(function (b) {
      b.onclick = function () {
        var target = grouped.filter(function (a) { return String(a.id) === String(b.dataset.artView); })[0];
        if (target) {
          if (isCodeDraft(target)) openCodeConfirmModal(target);
          else if (isMemoryDraft(target)) openMemoryConfirmModal(target);
          else openPlanConfirmModal(target);
        }
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
    var freshMemory = groupArtifacts(artifacts).filter(function (a) {
      return isMemoryDraft(a) && !shownMemoryModals[a.id];
    })[0];
    if (freshMemory) openMemoryConfirmModal(freshMemory);
    var freshCode = groupArtifacts(artifacts).filter(function (a) {
      return isCodeDraft(a) && !shownCodeModals[a.id];
    })[0];
    if (freshCode) openCodeConfirmModal(freshCode);
  }
  var CHAT_PAGE_SIZE = 50;
  async function loadAiMessages() {
    // 聊天记录按 notebook 隔离:后端会话 key = notebook-{id},切换 notebook 时重新拉取
    var nbId = state.notebookId;
    var list = await api.get('/ai/messages?limit=' + CHAT_PAGE_SIZE + (nbId ? '&notebookId=' + nbId : ''));
    if (nbId !== state.notebookId) return; // 响应期间已切换 notebook,防止慢响应覆盖新窗口
    state.messages = list || [];
    // 拿满一页 = 可能还有更早的。这是个上界判断，不是精确值：
    // 正好整页而其实没有更早的时候，用户点一次会拿到空列表，按钮随即消失。
    // 换成精确值要么多查一次、要么改响应形状（现在是裸数组，前端其它地方都按数组读）。
    state.chatHasMore = state.messages.length >= CHAT_PAGE_SIZE;
    var sync = $('#zq-sync-count'); if (sync) sync.textContent = '已同步 ' + state.messages.length + ' 条历史消息';
    renderAiMessages();
    watchStreamingMessages();
  }

  /**
   * 刷新之后接住「还在生成」的那条消息。
   *
   * 后端在流开始时就建好了 assistant 消息行（status=STREAMING），并在生成过程中
   * 阶段性把已生成的正文写进 content（见 AiMessageMapper.flushStreamingContent）。
   * 所以刷新后能看到已经生成的部分 —— 但这一页没有 SSE 连接了，剩下的部分不会自己出现。
   * 这里补一个轻量轮询，直到它进入终态。
   *
   * 三个边界：
   * - 本标签页正在发送时不轮询（SSE 在跑，轮询只会和它抢着改同一批消息）。
   * - 切换了 notebook 就停：那是另一个会话，拉回来的消息会覆盖当前窗口。
   * - 有上限。后端进程若在生成中途被杀，这条消息会永远停在 STREAMING，
   *   没有上限的话这个页面会一直轮询到关闭为止。上限取 5 分钟，与 SSE 的
   *   STREAM_TIMEOUT_MS 一致 —— 超过它，那条流无论如何都已经不在了。
   */
  var STREAM_POLL_INTERVAL_MS = 2000;
  var STREAM_POLL_MAX_ATTEMPTS = 150;   // 150 × 2s = 5min，与后端 STREAM_TIMEOUT_MS 对齐
  function stopStreamWatch() {
    if (state.streamPollTimer) { clearTimeout(state.streamPollTimer); state.streamPollTimer = null; }
  }
  function watchStreamingMessages(attempt) {
    stopStreamWatch();
    if (state.aiSending) return;   // 本页正在流，SSE 会负责更新
    var pending = (state.messages || []).some(function (m) {
      return String(m.status || '').toUpperCase() === 'STREAMING';
    });
    if (!pending) return;
    var tries = attempt || 0;
    if (tries >= STREAM_POLL_MAX_ATTEMPTS) return;
    var watchedNb = state.notebookId;
    state.streamPollTimer = setTimeout(function () {
      state.streamPollTimer = null;
      if (state.aiSending || watchedNb !== state.notebookId) return;
      var nbId = state.notebookId;
      api.get('/ai/messages?limit=50' + (nbId ? '&notebookId=' + nbId : ''))
        .then(function (list) {
          if (watchedNb !== state.notebookId || state.aiSending) return;
          state.messages = list || [];
          renderAiMessages({ keepScroll: !state.chatFollow });
          watchStreamingMessages(tries + 1);
        })
        .catch(function () { watchStreamingMessages(tries + 1); });
    }, STREAM_POLL_INTERVAL_MS);
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
  /**
   * 距底多少像素以内算「还在底部」。
   *
   * 取 48 而不是 0：行高 1.65 的正文一行约 22px，留两行的余量 ——
   * 用户手指刚离开、或浏览器因图片/公式渲染微调了一下高度，都不该被判成「他翻上去了」。
   */
  var CHAT_BOTTOM_SLACK_PX = 48;
  function chatAtBottom(host) {
    return host.scrollHeight - host.scrollTop - host.clientHeight <= CHAT_BOTTOM_SLACK_PX;
  }
  /**
   * 聊天区的滚动策略。
   *
   * 此前是无条件 `host.scrollTop = host.scrollHeight` —— 流式期间每个 token 都重渲染一次，
   * 于是用户只要想往上翻看前面说了什么，就会被立刻拽回底部，一个字也读不完。
   *
   * 现在：用户在底部才跟随；他一旦往上翻，就停在原地，并冒出一个「↓ 新内容」按钮，
   * 点它（或自己滑回底部）恢复跟随。发送新消息时无条件回到底部 —— 那是他自己的动作。
   */
  function applyChatScroll(host, prevScroll, keepScroll) {
    if (keepScroll || !state.chatFollow) {
      host.scrollTop = prevScroll;
    } else {
      host.scrollTop = host.scrollHeight;
    }
    var jump = $('#zq-chat-jump');
    if (jump) jump.hidden = state.chatFollow;
  }
  /**
   * 绑滚动监听与「↓ 新内容」按钮。
   *
   * 两者各有各的 guard，而不是共用一个：按钮在首次渲染时万一还不在 DOM 里，
   * 共用 guard 会让它<b>永远</b>绑不上 —— 监听已经标记成「绑过了」，后面再也不进来。
   * 这类「一个 guard 罩住两件事」的写法，失效的那件事不会有任何迹象。
   */
  function bindChatScroll(host) {
    if (host.dataset.zqScrollBound !== '1') {
      host.dataset.zqScrollBound = '1';
      host.addEventListener('scroll', function () {
        var atBottom = chatAtBottom(host);
        if (atBottom === state.chatFollow) return;
        state.chatFollow = atBottom;
        var jump = $('#zq-chat-jump');
        if (jump) jump.hidden = atBottom;
      }, { passive: true });
    }
    var jump = $('#zq-chat-jump');
    if (jump && jump.dataset.zqBound !== '1') {
      jump.dataset.zqBound = '1';
      jump.onclick = function () {
        state.chatFollow = true;
        host.scrollTop = host.scrollHeight;
        jump.hidden = true;
      };
    }
  }
  /**
   * 一条消息的气泡内容（思考摘要 + 正文）。
   *
   * <p>抽出来是为了让<b>全量渲染</b>与<b>流式增量补丁</b>共用同一份生成逻辑 ——
   * 两处各写一份的话，Markdown / 数学公式 / 「仍在生成」尾巴的处理迟早会分叉，
   * 而分叉只在流式时可见，最难被发现。
   */
  function messageBodyHtml(m, i) {
    var me = m.role === 'user';
    var reasoningMode = String(m.reasoningMode || 'OFF').toUpperCase();
    var reasoningText = m.reasoningSummary || m.reasoning || '';
    var reasonKey = String(m._clientKey || m.id || m.requestId || ('assistant-' + i));
    var reason = (!me && reasoningMode !== 'OFF' && reasoningText)
      ? '<details class="zq-ai-reasoning" data-reason-key="' + esc(reasonKey) + '"' + (state.reasoningExpanded[reasonKey] ? ' open' : '') + '><summary>思考摘要</summary><span>' + esc(reasoningText) + '</span></details>'
      : '';
    // 流式中的内容换行完好且可能只收到半截,跳过压平回填,防止启发式误触
    var body = m.content ? renderMarkdown((me || m.status === 'STREAMING') ? m.content : reflowFlatMarkdown(m.content)) : (m.status === 'STREAMING' ? '<span style="color:var(--zq-text3);" data-wait-since="' + waitSince(m) + '">' + waitText(waitSince(m)) + '</span>' : '');
    // 刷新之后那条消息会带着「已经生成的一半」回来（后端阶段性落库）。
    // 光有半截正文看不出它是写完了还是还在写 —— 补一个尾巴说清楚，
    // 否则用户会以为回答就到这里为止。
    if (!me && m.content && String(m.status || '').toUpperCase() === 'STREAMING') {
      body += '<div style="margin-top:6px;font-size:11.5px;color:var(--zq-text3);">仍在生成…</div>';
    }
    // 失败了要说出来，哪怕已经出来了半截（原来有半截正文就把错误原因丢掉，看着像是模型说完了）；
    // 能用但不完整（输出上限、内容审核、太长）也说。两句都存在库里，刷新之后还在。
    if (!me && m.errorMessage) {
      body += '<div data-msg-error style="margin-top:8px;font-size:12px;color:var(--zq-bad);">⚠ ' + esc(m.errorMessage) + '</div>';
    }
    if (!me && m.notice) {
      body += '<div data-msg-notice style="margin-top:8px;font-size:12px;color:var(--zq-warn);">' + esc(m.notice) + '</div>';
    }
    return reason + body;
  }

  /**
   * 还没收到第一个字时，说出已经等了多久（第十九轮）。模型卡住时服务器要 60 秒才放弃（回答之前的检索、代码循环更久），
   * 而网页没有「停止」：原来这段时间里只有一行一动不动的「正在生成…」，看不出是在想还是已经死了。
   */
  function waitSince(m) {
    if (m._startedAt) return m._startedAt;
    // createdAt 是业务时区的钟面、不带时区：按业务时区换成时刻，和按服务器的钟的「此刻」比（第二十一轮：原来 Date.parse 按浏览器时区，
    // 比东八区快的浏览器一刷新就是「已等 21600 秒」、慢的永远从 0 数起）
    var t = m.createdAt ? serverTime(m.createdAt) : NaN;
    return isFinite(t) && t <= nowMs() ? t : nowMs();
  }
  function waitText(since) {
    var s = Math.floor((nowMs() - since) / 1000);
    if (s < 5) return '正在生成…';
    if (s < 30) return '正在生成…（已等 ' + s + ' 秒）';
    return '还在等模型开始回答（已等 ' + s + ' 秒）';
  }
  setInterval(function () {
    var nodes = document.querySelectorAll('[data-wait-since]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = waitText(Number(nodes[i].getAttribute('data-wait-since')));
  }, 1000);

  /**
   * 流式增量：只改正在生成的那一条，不重建整个聊天区。
   *
   * <h2>为什么值得单独走一条路</h2>
   *
   * <p>此前每收到一个 token 都跑一次完整的 renderAiMessages：重建全部消息的 innerHTML、
   * 重新绑定每条消息的右键菜单、并对<b>整个聊天区</b>重跑一次数学公式渲染。
   * 代价随对话长度增长 —— 聊得越久，每个 token 越贵，而一轮有几千个 token。
   *
   * <p>返回 false 表示 DOM 不是预期的形状（比如这条消息还没被渲染出来），
   * 调用方退回全量渲染。不假装成功，也不静默什么都不做。
   */
  function patchStreamingMessage(index) {
    var host = $('#zq-chat'); if (!host) return false;
    var node = host.querySelector('[data-msg-body="' + index + '"]');
    var m = state.messages[index];
    if (!node || !m) return false;
    var prevScroll = host.scrollTop;
    node.innerHTML = messageBodyHtml(m, index);
    renderMathIn(node);
    applyChatScroll(host, prevScroll, false);
    return true;
  }
  /**
   * 往更早翻一页。
   *
   * <h2>预挂载前必须记住高度</h2>
   *
   * <p>在列表<b>前面</b>插内容会把已有内容整体往下推，浏览器保持 scrollTop 不变，
   * 于是用户正在读的那一段瞬间跑到屏幕下方 —— 视觉上就是「一点加载就跳走了」。
   * 所以要在渲染前记下 scrollHeight，渲染后把 scrollTop 加上高度差，
   * 让用户眼前的那一行留在原处。
   *
   * <p>这也是为什么这里不能复用 renderAiMessages 的滚动策略：那套策略管的是
   * 「新内容加在末尾」，而这里是加在开头，两者要做的补偿方向相反。
   */
  async function loadOlderMessages() {
    if (state.chatLoadingMore || !state.chatHasMore || !state.messages.length) return;
    var host = $('#zq-chat'); if (!host) return;
    var oldest = null;
    for (var i = 0; i < state.messages.length; i++) {
      if (state.messages[i].id != null) { oldest = state.messages[i].id; break; }
    }
    if (oldest == null) return;   // 全是本地临时消息，没有可用游标

    state.chatLoadingMore = true;
    renderAiMessages({ keepScroll: true });
    var nbId = state.notebookId;
    try {
      var older = await api.get('/ai/messages?limit=' + CHAT_PAGE_SIZE
        + (nbId ? '&notebookId=' + nbId : '') + '&before=' + oldest);
      if (nbId !== state.notebookId) return;   // 期间切了 notebook，这页属于别的会话
      older = older || [];
      if (!older.length) {
        state.chatHasMore = false;
        return;
      }
      // 锚点取当前第一条消息的气泡，记它在视口里的位置。
      // 不用 scrollHeight 之差：那一页若正好把「加载更早」按钮用没了（older 不满一页），
      // 按钮那约 34px 会算进差值里，视口就会跳一下。锚元素与按钮在不在无关。
      var anchor = host.querySelector('[data-msg-body="0"]');
      var topBefore = anchor ? anchor.getBoundingClientRect().top : null;

      state.messages = older.concat(state.messages);
      state.chatHasMore = older.length >= CHAT_PAGE_SIZE;
      state.chatLoadingMore = false;   // 先落定，让下面这次渲染就是最终形态
      renderAiMessages({ keepScroll: true });

      // 原来的第 0 条现在排在 older.length 位；把视口挪回去，让它看起来没动过
      var moved = host.querySelector('[data-msg-body="' + older.length + '"]');
      if (moved && topBefore != null) {
        host.scrollTop += moved.getBoundingClientRect().top - topBefore;
      }
    } finally {
      // 只有上面提前 return 的两条分支还没落定
      if (state.chatLoadingMore) {
        state.chatLoadingMore = false;
        if (nbId === state.notebookId) renderAiMessages({ keepScroll: true });
      }
    }
  }

  function renderAiMessages(opts) {
    var host = $('#zq-chat'); if (!host) return;
    bindChatScroll(host);
    var keepScroll = opts && opts.keepScroll, prevScroll = host.scrollTop;
    $all('details[data-reason-key]', host).forEach(function (details) {
      state.reasoningExpanded[details.dataset.reasonKey] = details.open;
    });
    var moreRow = state.chatHasMore
      ? '<div style="display:flex;justify-content:center;padding:2px 0 6px;">'
        + '<button type="button" data-load-older="1"' + (state.chatLoadingMore ? ' disabled' : '')
        + ' style="height:26px;padding:0 12px;border:1px solid var(--zq-border);border-radius:999px;'
        + 'background:var(--zq-card-soft);color:var(--zq-text2);font-size:11.5px;cursor:pointer;">'
        + (state.chatLoadingMore ? '加载中…' : '↑ 加载更早的消息') + '</button></div>'
      : '';
    host.innerHTML = moreRow + state.messages.map(function (m, i) {
      var me = m.role === 'user';
      var name = me ? '我' : 'AI';
      var body = messageBodyHtml(m, i);
      return '<div data-msg-idx="' + i + '" style="display:flex;gap:10px;flex-direction:' + (me ? 'row-reverse' : 'row') + ';"><div style="width:30px;height:30px;flex:none;border-radius:50%;background:' + (me ? 'var(--zq-card-soft)' : 'var(--zq-primary)') + ';color:' + (me ? 'var(--zq-text2)' : 'var(--zq-on-primary)') + ';display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">' + name + '</div><div data-msg-body="' + i + '" class="zq-msg-body" style="max-width:72%;padding:8px 12px;border-radius:var(--zq-rm);background:' + (me ? 'var(--zq-tint)' : 'var(--zq-card)') + ';border:1px solid ' + (me ? 'var(--zq-tint-strong)' : 'var(--zq-border-soft)') + ';font-size:13.5px;line-height:1.65;">' + body + '</div></div>';
    }).join('');
    var olderButton = host.querySelector('[data-load-older]');
    if (olderButton) olderButton.onclick = function () { loadOlderMessages(); };
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
    // 删除消息等场景保持原滚动位置;其余按「用户是否在底部」决定跟不跟随
    applyChatScroll(host, prevScroll, keepScroll);
  }
  /**
   * 记住当前 notebook，让刷新之后还落在同一个会话上。
   *
   * 聊天记录是按 notebook 隔离的（后端会话 key = notebook-{id}）。刷新后 state.notebookId
   * 是 null，于是 loadAiNotebooks 永远选 notebooks[0] —— 你在第三个 notebook 里聊了半天，
   * 刷新一下看到的是第一个的记录。内容没丢，只是你被换到了别的房间，看上去和丢了一样。
   *
   * localStorage 在隐私窗口/禁用站点数据时会抛，所以读写都兜住；读不到就回落到原来的行为。
   */
  var NOTEBOOK_KEY = 'zq-ai-notebook';
  function rememberNotebook(id) {
    try {
      if (id == null) localStorage.removeItem(NOTEBOOK_KEY);
      else localStorage.setItem(NOTEBOOK_KEY, String(id));
    } catch (e) {}
  }
  function recallNotebook() {
    try {
      var raw = localStorage.getItem(NOTEBOOK_KEY);
      return raw ? Number(raw) : null;
    } catch (e) { return null; }
  }
  async function loadAiNotebooks() {
    var list = await api.get('/ai/notebooks');
    state.notebooks = list || [];
    if (!state.notebooks.length) {
      state.notebookId = null;
      rememberNotebook(null);
      clearPendingSources();
      renderNotebooks();
      await loadAiSources();
      renderSteps([]);
      renderArtifacts([]);
      return;
    }
    // 本次会话内已有选择就用它；刚刷新时（还没有选择）用上次记住的那个。
    // 记住的那个可能已被删除，所以仍要过「还在不在」这一关，最后才回落到第一个。
    if (state.notebookId == null) state.notebookId = recallNotebook();
    var selectedStillExists = state.notebooks.some(function (item) { return Number(item.id) === Number(state.notebookId); });
    if (!selectedStillExists) state.notebookId = state.notebooks[0].id;
    rememberNotebook(state.notebookId);
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
    label.title = current ? (current.title || '未命名') : '';   // 名字长时标题栏只显示开头，悬停看全名
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
    if (state.chatDraft && state.chatDraft.key() !== chatDraftKey()) state.chatDraft.reload();
    var host = $('#zq-notebooks'); if (!host) return;
    renderCurrentNotebookLabel();
    host.innerHTML = (state.notebooks || []).map(function (nb) {
      var active = nb.id === state.notebookId;
      return '<div data-notebook="' + nb.id + '" style="padding:9px 11px;border:1px solid ' + (active ? 'var(--zq-tint-strong)' : 'var(--zq-border-soft)') + ';border-radius:var(--zq-rs);background:' + (active ? 'var(--zq-tint)' : 'var(--zq-card)') + ';cursor:pointer;"><div data-nb-name="' + nb.id + '" title="' + esc(nb.title || 'Notebook') + (active ? ' · 点击重命名' : '') + '" style="font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(nb.title || 'Notebook') + '</div><div style="font-size:11px;color:var(--zq-text3);margin-top:2px;">' + esc(nb.sourceCount != null ? nb.sourceCount + ' 份资料' : '资料工作区') + '</div></div>';
    }).join('') || '<div class="zq-ai-empty-notebook"><strong>暂无 Notebook</strong><span>普通聊天仍可使用；上传资料前请先新建。</span></div>';
    $all('[data-notebook]', host).forEach(function (d) {
      var id = Number(d.dataset.notebook);
      var nb = (state.notebooks || []).find(function (x) { return x.id === id; });
      d.onclick = function (e) {
        // 已选中的 notebook 再点名字 → 改名；否则点击切换
        if (id === state.notebookId && e.target.closest('[data-nb-name]')) { renameNotebook(nb); return; }
        state.notebookId = id;
        rememberNotebook(id);   // 这条切换路径不经过 loadAiNotebooks，要自己记
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
  function srcStatusLabel(s, sourceType) {
    // 图片不做文本解析，UPLOADED 就是它的正常终态 —— 而它是作为视觉内容交给模型的，
    // 写「仅存档，暂未进入问答」会让人以为图片没用、模型看不到。
    if (String(sourceType || '').toUpperCase() === 'IMAGE') {
      var st = String(s || '').toUpperCase();
      if (st === 'UPLOADED') return '图片，勾选后随消息交给模型';
      if (st === 'ERROR') return '图片不可用';
    }
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
      var statusText = srcStatusLabel(status, s.sourceType) + (status === 'ERROR' && s.parseError ? '：' + s.parseError : '')
        + (indexText ? ' · ' + indexText : '');
      return '<div class="zq-src-tile" data-source="' + s.id + '" data-source-title="' + esc(title) + '" data-source-url="' + esc(s.url || '') + '" style="--srcc:' + info[1] + ';" title="' + esc(statusText) + '">'
        + '<span class="zq-src-type">' + esc(info[0]) + '</span>'
        + '<span class="zq-src-dl">↓</span>'
        + '<div class="zq-src-glass">'
        + '<div class="zq-src-title">' + esc(title) + '</div>'
        + '<div class="zq-src-meta"><span style="width:6px;height:6px;border-radius:50%;flex:none;background:' + (status === 'READY' ? 'var(--zq-ok)' : status === 'ERROR' ? 'var(--zq-bad)' : 'var(--zq-text3)') + ';"></span><span>' + esc(srcStatusLabel(status, s.sourceType)) + '</span></div>'
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
  /**
   * 一个 SSE 帧 → { event, data }。纯注释的帧（服务器心跳 `:ping`，见 SseHeartbeats）返回 null —— 它不是事件，
   * 不许被当成一个空的 message 交给处理函数。
   * SSE 规范：多条 data: 行以 \n 连接还原；只剥一个可选前导空格，不 trim（防止破坏换行 / 空白）。
   */
  function parseSseFrame(frame) {
    var event = null, dataLines = [];
    frame.split(/\r\n|\n|\r/).forEach(function (l) {
      if (l.indexOf('event:') === 0) event = l.slice(6).trim();
      else if (l.indexOf('data:') === 0) dataLines.push(l.slice(5).replace(/^ /, ''));
    });
    if (event == null && !dataLines.length) return null;
    var dataStr = dataLines.join('\n');
    var data = {};
    if (dataStr) { try { data = JSON.parse(dataStr); } catch (e) { data = { text: dataStr }; } }
    return { event: event || 'message', data: data };
  }
  /**
   * 读一块，但最多等 ms 毫秒。服务器每 15 秒发一次心跳，所以 75 秒一个字节都没有，就是连接悄悄死了 ——
   * 原来这里会永远等下去，界面停在「发送中」，下面那套「断线后从库里接回」根本没有机会启动。
   */
  var STREAM_IDLE_MS = 75000;
  function readWithIdleTimeout(reader, ms) {
    var timer;
    return Promise.race([
      reader.read(),
      new Promise(function (_, reject) {
        timer = setTimeout(function () {
          reject(requestError('连接 ' + Math.round(ms / 1000) + ' 秒没有任何数据', { idle: true }));
        }, ms);
      })
    ]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }
  async function streamAiChat(body, handlers) {
    var headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    // 响应头 30 秒不到也算连不上（服务器挂住时 fetch 会一直等）
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var headTimer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
    var res;
    try {
      res = await fetch(API + '/ai/chat/stream', { method: 'POST', credentials: 'same-origin', headers: headers, body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
    } catch (e) {
      // 一个字节都没回来就连不上。原来原样抛出浏览器的「Failed to fetch」，页面上就是这句英文（第二十二轮断网实测）。
      // 等满 30 秒没有回应不算「没发出去」：连接是通的、请求多半已经到了，只是服务器卡着 —— 它可能正在存这句、正在回答
      var headTimedOut = !!(ctrl && ctrl.signal.aborted);
      throw requestError(headTimedOut ? '服务器 ' + Math.round(REQUEST_TIMEOUT_MS / 1000) + ' 秒没有回应' : '网络连接失败',
        { network: true, beforeResponse: !headTimedOut, timedOut: headTimedOut });
    } finally {
      if (headTimer) clearTimeout(headTimer);
    }
    if (res.status === 401 || res.status === 403) { redirectToLogin(); throw new Error('未登录或无权限'); }
    if (!res.ok || !res.body) throw new Error(res.status === 429 ? '请求过于频繁，请稍后再试' : '流式连接失败(' + res.status + ')');
    var reader = res.body.getReader(), decoder = new TextDecoder('utf-8'), buf = '';
    // 业务终止事件(done/error)送达后,个别容器/代理收尾时不发终止 chunk,读取器会报 network error;
    // 此时流在语义上已完整,按正常结束处理,不让收尾噪声打断发送方后续流程
    var terminalSeen = false;
    while (true) {
      var chunk;
      try {
        chunk = await readWithIdleTimeout(reader, STREAM_IDLE_MS);
      } catch (e) {
        if (e && e.idle) { try { reader.cancel(); } catch (x) { /* 已经断了 */ } }
        if (terminalSeen) break;
        if (e && !e.userFacing) throw requestError('连接断了', { network: true });   // 浏览器的原话是「network error」
        throw e;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      // SSE 帧边界:规范允许 LF/CRLF/CR 三种行尾,空行即帧结束
      var m;
      while ((m = /\r\n\r\n|\n\n|\r\r/.exec(buf))) {
        var frame = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
        var parsed = parseSseFrame(frame);
        if (!parsed) continue;
        handlers(parsed.event, parsed.data);
        if (parsed.event === 'done' || parsed.event === 'error') terminalSeen = true;
      }
    }
  }
  function upsertAgentStep(raw, done) {
    var step = raw.step || raw;
    var id = step.id || step.stepId || step.title || (state.agentSteps.length + 1);
    var existing = state.agentSteps.find(function (s) { return s._id === id; });
    // 流式事件带的是 publicSummary / agentType，不是 title —— 原来只取 title，
    // 于是实时显示的轨迹是「步骤 1、步骤 2」，要等刷新重载才有名字。
    if (existing) {
      existing.status = done ? 'DONE' : (step.status || existing.status);
      if (step.title) existing.title = step.title;
      if (step.publicSummary) existing.publicSummary = step.publicSummary;
    } else {
      state.agentSteps.push({ _id: id, title: step.title || step.name || step.stepType || ('步骤 ' + (state.agentSteps.length + 1)),
        publicSummary: step.publicSummary || '', agentType: step.agentType || '',
        status: done ? 'DONE' : (step.status || 'RUNNING'), notes: [] });
    }
    renderSteps(state.agentSteps);
  }
  /**
   * coding agent 的逐步叙述（agent.step.note）：读了哪个文件、跑了什么命令、输出是什么。
   * 挂在对应步骤下面。命令行 zhiqu 读的是同一份事件 —— 两边说同样的话。
   * 每步最多留 NOTE_CAP 条：一个 10 轮的循环可能有几十次调用，全留会把轨迹栏撑爆。
   */
  var NOTE_CAP = 40;
  function addAgentStepNote(data) {
    if (!data || !data.message) return;
    var step = state.agentSteps.find(function (s) { return s._id === data.stepId; });
    if (!step) return;
    step.notes = step.notes || [];
    step.notes.push({ phase: data.phase || '', message: String(data.message) });
    if (step.notes.length > NOTE_CAP) step.notes.splice(0, step.notes.length - NOTE_CAP);
    renderSteps(state.agentSteps);
  }
  /** 一条叙述的 HTML。命令输出可能含任意字符（包括 HTML），一律 esc —— 它来自用户机器上跑出来的东西。 */
  function stepNoteHtml(n) {
    if (n.phase === 'result') {
      var lines = n.message.split('\n');
      var shown = lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n…' : '');
      return '<pre class="zq-mono" style="margin:2px 0 3px 12px;padding:4px 6px;font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-all;background:var(--zq-card-soft);border-radius:4px;color:var(--zq-text2);">' + esc(shown) + '</pre>';
    }
    return '<div class="zq-mono" style="font-size:10.5px;color:' + (n.phase === 'error' ? 'var(--zq-bad)' : n.phase === 'budget' ? 'var(--zq-warn)' : 'var(--zq-text2)')
      + ';margin-top:2px;word-break:break-all;">⎿ ' + esc(n.message) + '</div>';
  }
  /** 单行时的高度，与同排按钮对齐；也是清空后要回到的高度。 */
  var DRAFT_BASE_HEIGHT = 32;
  /**
   * 输入框自适应高度。先置 auto 再读 scrollHeight —— 不置的话 scrollHeight 会被
   * 当前高度撑住，内容变少时收不回去。
   */
  /** 聊天框的草稿按 Notebook 分开存。 */
  function chatDraftKey() { return 'chat.' + (state.notebookId || 'none'); }
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
    // 草稿等服务器确认收到了这条消息（任一事件带 userMessageId）才删；没收到就把字放回输入框（第十五轮）。
    // 原来一按发送就清空：没配模型、被限流、一刷新，这句话就没了。
    if (state.chatDraft) state.chatDraft.flush();
    var draftKeyAtSend = state.chatDraft ? state.chatDraft.key() : null;
    var stored = false;
    var gotEvent = false;
    inp.value = '';
    inp.style.height = DRAFT_BASE_HEIGHT + 'px'; // 收回单行，否则清空后仍撑着上一条的高度
    state.aiSending = true;
    stopStreamWatch();   // SSE 接管，轮询再跑就会和它抢着改同一批消息
    var sendButton = $('#zq-send');
    if (sendButton) { sendButton.disabled = true; sendButton.textContent = '生成中'; }
    var reasoningMode = ($('#zq-think') && $('#zq-think').dataset.on === '1') ? 'DEEP' : 'OFF';
    // READY（有分块，走检索）和 IMAGE（无分块，走视觉内容块）都要发给后端。
    // 只发 READY 的话图片就被挡在这一层，后端永远收不到它。
    var selectedSourceIds = state.pendingSources
      .filter(function (source) {
        var st = String(source.status || '').toUpperCase();
        return st === 'READY' || String(source.sourceType || '').toUpperCase() === 'IMAGE';
      })
      .map(function (source) { return Number(source.id); });
    var clientKey = 'stream-' + Date.now();
    var assistant = {
      role: 'assistant',
      content: '',
      reasoningSummary: '',
      reasoningMode: reasoningMode,
      status: 'STREAMING',
      _clientKey: clientKey,
      _startedAt: nowMs()
    };
    state.messages.push({ role: 'user', content: txt, _clientKey: clientKey + '-user' }, assistant);
    // 用户刚按下发送，这是他自己的动作：无条件回到底部，之后再由他的滚动决定跟不跟随
    state.chatFollow = true;
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
        selectedSourceIds: selectedSourceIds,
        codeMode: codeModeOn()
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
    // 传输层断开（与 SSE 的 error 事件不同：那是流正常结束）。断了之后要去把
    // 后端已经落库的部分接回来，见下面的 finally。
    var disconnected = false;
    // 一个字都没收到就连不上（断着网点了发送）：多半根本没发出去
    var notSent = false;
    try {
      await safe('AI 发送', async function () {
      try {
        await streamAiChat(body, function (event, data) {
          gotEvent = true;
          if (!stored && data && data.userMessageId) {
            stored = true;
            if (draftKeyAtSend) drafts.clearIf(draftKeyAtSend, txt);
          }
          if (event === 'message.delta') {
            assistant.content += (data.text || data.delta || data.content || '');
            // 只改这一条气泡。退回全量渲染的两种情形：节点还没渲染出来（第一个增量），
            // 或 DOM 不是预期形状。不假装成功，也不静默什么都不做。
            if (sameNb() && !patchStreamingMessage(state.messages.indexOf(assistant))) renderAiMessages();
          }
          else if (event === 'reasoning.delta' && reasoningMode !== 'OFF') {
            assistant.reasoningSummary += (data.text || data.delta || '');
            if (sameNb()) renderAiMessages();
          }
          else if (event === 'agent.step.start') { if (sameNb()) upsertAgentStep(data, false); }
          else if (event === 'agent.step.done') { if (sameNb()) upsertAgentStep(data, true); }
          else if (event === 'agent.step.note') { if (sameNb()) addAgentStepNote(data); }
          // 消息太长被截了中间（后端 UserMessageFit）：说给用户，而且多停一会儿 —— 这句话要读完
          else if (event === 'message.notice') { toast((data && data.message) || '这条消息被截短了', data && data.level === 'error' ? 'error' : 'warn', 9000); }
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
              if (data && data.notice) assistant.notice = data.notice;
              assistant.status = '';
              completed = true;
              if (sameNb()) renderAiMessages();
            }
          }
          else if (event === 'error') {
            failed = true;
            assistant.status = '';
            // 已经收到的半截留着，原因另起一行说（原来有半截就不说原因 —— 看着像是模型说完了）
            assistant.errorMessage = (data && data.message) || '未知错误';
            if (sameNb()) renderAiMessages();
          }
        });
      } catch (e) {
        if (!gotEvent && e && e.beforeResponse) {
          // 断着网点了发送：原来这里也当成「流到一半断了」—— 气泡里写「（连接中断，正在尝试接回…）」，可根本没有什么可接的，
          // 而且一直挂在那（第二十二轮断网实测）。本地先摆上的这两条撤掉，字放回输入框（finally），照实说没发出去。
          // 万一其实发到了（回应丢在路上）：网回来之后拉一次消息，那两条会从服务器那边回来
          notSent = true;
          var at = state.messages.indexOf(assistant);
          if (at > 0 && state.messages[at - 1]._clientKey === clientKey + '-user') state.messages.splice(at - 1, 2);
          renderAiMessages();
          throw requestError(e.message + '，这句没发出去 —— 字放回输入框了，连上网再发', { network: true });
        }
        // 连接断了，但后端多半还在生成 —— 而正文已经在阶段性落库（flushStreamingContent）。
        // 所以这里不再是死路。真正的重新拉取放在 finally 里：那时 state.aiSending 才置回
        // false，watchStreamingMessages 才会真的开始轮询（它见 aiSending 为真就直接返回）。
        // 在这里拉的话，轮询会被自己的「本页正在流」判断挡掉，接回悄悄失效。
        disconnected = true;
        assistant.status = '';
        if (!assistant.content) assistant.content = '（连接中断，正在尝试接回…）';
        renderAiMessages();
        if (!gotEvent && e && e.timedOut) {
          // 服务器等满 30 秒都没回应：这句可能已经存上了、正在回答。不说「没发出去」（那会诱导再发一遍、问两次），
          // 等一下从服务器拉一次（finally 里的 whenOnline）：存上了就接着显示，没存上那两条会自己消失
          throw requestError(e.message + '，不确定这句发出去没有 —— 稍后会从服务器拉一次，先别重发', { network: true });
        }
        throw e && e.network ? requestError('连接断了，网回来之后会把回答接上', { network: true }) : e;
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
      // 服务器没收到这句（没配模型、限流、根本没连上）：字放回输入框，草稿里也还在 —— 改一改就能再发。
      // 收到了（事件带过 userMessageId）的不放回：那会诱导再发一遍、存两条
      if (!stored && (failed || !gotEvent) && sameNb() && inp && !inp.value.trim()) {
        inp.value = txt;
        growDraft();
      }
      // 断线接回：此刻 aiSending 已经是 false，loadAiMessages 末尾的 watchStreamingMessages
      // 才会真的开始轮询，把后端继续生成的部分续上。不用用户手动刷新。
      // 网还断着的话这一下拉不到 —— 原来就停在这了；现在等网回来再拉（whenOnline）
      if (disconnected || notSent) whenOnline(function () { return sameNb() && !state.aiSending ? loadAiMessages() : null; });
    }
  }
  /**
   * 网回来之后做一次 fn（返回 promise）：现在就试；失败了等 online 事件或 3 秒再试，最多试 40 次（约两分钟）。
   * 「网还断着」浏览器不一定知道（Wi-Fi 连着、外面不通），所以不只等 online 事件。
   */
  function whenOnline(fn) {
    var tries = 0;
    function attempt() {
      tries++;
      Promise.resolve().then(fn).catch(function () {
        if (tries >= 40) return;
        var fired = false;
        var go = function () { if (fired) return; fired = true; window.removeEventListener('online', go); clearTimeout(timer); attempt(); };
        var timer = setTimeout(go, 3000);
        window.addEventListener('online', go);
      });
    }
    attempt();
  }


  /**
   * 提醒渠道的配置界面。
   *
   * <p>此前这一整块只存在于 js/profile.js —— 而那个文件<b>零页面加载</b>（见 CLAUDE.md），
   * 于是用户没有任何途径填凭据：开关只发 {channel:'PUSHPLUS', enabled:true}，
   * 而后端的 hasRequiredChannelConfig 要求 pushplusToken 非空，早八时每条提醒都被标成
   * FAILED（理由「提醒渠道未启用或未配置」）。用户看到的是绿色的开关和一行写死的
   * 「渠道：PushPlus · 已绑定」，然后什么都收不到。
   */
  var REMINDER_FIELDS = {
    PUSHPLUS: [['zq-rm-pushplus', 'pushplusToken']],
    WECOM: [['zq-rm-webhook', 'webhookUrl']],
    QQ: [['zq-rm-qq-appid', 'qqAppId'], ['zq-rm-qq-secret', 'qqAppSecret'], ['zq-rm-qq-group', 'qqGroupOpenid']]
  };
  function currentReminderChannel(settings) {
    var sel = $('#zq-rm-channel');
    return (sel && sel.value) || settings.channel || 'PUSHPLUS';
  }
  /**
   * 这个渠道的凭据齐了吗。
   *
   * 已保存的值从后端回来是脱敏的（****xxxx），占位符里显示；输入框为空 = 沿用已存的值。
   * 所以「齐了」= 每个字段要么输入框有值，要么后端已经存着一个非空值。
   */
  function reminderChannelReady(settings) {
    var channel = currentReminderChannel(settings);
    return (REMINDER_FIELDS[channel] || []).every(function (pair) {
      var el = $('#' + pair[0]);
      if (el && el.value.trim()) return true;
      var stored = settings[pair[1]];
      return !!(stored && String(stored).trim());
    });
  }
  function paintReminderChannel(settings) {
    var channel = currentReminderChannel(settings);
    // 用 style.display 而不是 hidden 属性：这些 div 带着内联样式，
    // 而内联 display 的优先级高于 [hidden] 的 UA 规则 —— 设 hidden 不会让它们消失
    $all('[data-rm-group]').forEach(function (group) {
      group.style.display = group.dataset.rmGroup === channel ? 'flex' : 'none';
    });
    Object.keys(REMINDER_FIELDS).forEach(function (key) {
      REMINDER_FIELDS[key].forEach(function (pair) {
        var el = $('#' + pair[0]);
        if (!el) return;
        var stored = settings[pair[1]];
        // 脱敏值只作为占位提示，绝不填进 value —— 填进去用户一保存就会把掩码当成新凭据提交
        el.placeholder = stored && String(stored).trim()
          ? '已保存（' + stored + '），留空则不修改'
          : el.dataset.rmPlaceholder || el.placeholder;
      });
    });
    var status = $('#zq-rm-status');
    if (status) {
      status.textContent = reminderChannelReady(settings) ? '凭据已配置' : '尚未配置凭据，提醒发不出去';
      status.style.color = reminderChannelReady(settings) ? 'var(--zq-q2)' : 'var(--zq-q1)';
    }
  }
  function wireReminderChannel(settings, morning) {
    var sel = $('#zq-rm-channel');
    if (!sel) return;   // 这一块只在个人中心页存在
    // 记下原始占位符，后面要在「已保存」与「未保存」之间切换
    Object.keys(REMINDER_FIELDS).forEach(function (key) {
      REMINDER_FIELDS[key].forEach(function (pair) {
        var el = $('#' + pair[0]);
        if (el) el.dataset.rmPlaceholder = el.placeholder;
      });
    });
    sel.value = settings.channel || 'PUSHPLUS';
    paintReminderChannel(settings);
    sel.onchange = function () { paintReminderChannel(settings); };

    var save = $('#zq-rm-save');
    if (save) save.onclick = function () {
      var channel = currentReminderChannel(settings);
      var body = { channel: channel, enabled: !!settings.enabled };
      var filled = false;
      (REMINDER_FIELDS[channel] || []).forEach(function (pair) {
        var el = $('#' + pair[0]);
        if (el && el.value.trim()) { body[pair[1]] = el.value.trim(); filled = true; }
      });
      if (!filled && !reminderChannelReady(settings)) { toast('请先填写凭据', 'error'); return; }
      safe('保存推送渠道', async function () {
        await api.put('/reminder/settings', body);
        var fresh = await api.get('/reminder/settings');
        Object.keys(fresh || {}).forEach(function (k) { settings[k] = fresh[k]; });
        (REMINDER_FIELDS[channel] || []).forEach(function (pair) {
          var el = $('#' + pair[0]); if (el) el.value = '';
        });
        paintReminderChannel(settings);
        if (morning) setMorningToggle(morning, settings.enabled);
        toast('推送渠道已保存');
      });
    };

    var test = $('#zq-rm-test');
    if (test) test.onclick = function () {
      safe('发送测试', async function () {
        await api.post('/reminder/test', {});
        toast('测试消息已发出，去对应渠道确认');
      });
    };
  }


  // ───────────────────────── 代码工作区（只读） ─────────────────────────
  /**
   * 工作区面板。
   *
   * <p>整块默认不显示。三种情况都不显示，而且<b>只有第三种要说话</b>：
   * 非管理员（接口 403）、压根没配（正常状态，不该打扰用户）、
   * 配了但前置没满足（必须说清是哪一条 —— 否则用户以为功能坏了）。
   */
  var wsState = { path: '', enabled: false };

  // ── 工作区设置：像 Cursor 那样选工作文件夹 + 切档位 ─────────────────────
  //
  // 三条前提（回环 / 目录存在 / 管理员）由后端裁决，前端不复述判断 —— 只把后端返回的
  // effectiveMode / reason / loopback 如实显示。切换按钮在非回环上也点得动，但后端会拒，
  // 并把原因显示出来，而不是前端偷偷禁用（那样用户不知道为什么不行）。

  function openWorkspaceSettings(settings) {
    var modes = (settings && settings.modes) || ['OFF', 'READ', 'WRITE', 'EXEC'];
    var chosen = (settings && settings.selectedMode) || 'OFF';
    var chosenRoot = (settings && settings.selectedRoot) || '';
    var loopback = !(settings && settings.loopback === false);

    var desc = {
      OFF: '关闭。AI 助手看不到任何本机文件。',
      READ: '只读：AI 能读工作文件夹里的文件，一个字节都不改。',
      WRITE: '读 + 写：能改文件，但每次改动都要你在草稿里确认后才落盘。',
      EXEC: '读 + 写 + 运行：能改、还能跑白名单命令（python3 / node / java…）。仅本机自用。'
    };

    var h = openModal({
      title: '工作区设置',
      width: 520,
      bodyHtml:
        (loopback ? '' :
          '<div style="margin-bottom:12px;padding:9px 11px;border-radius:var(--zq-rs);background:var(--zq-tint);' +
          'font-size:12px;color:var(--zq-text2);line-height:1.6;">当前不是本机回环地址（多半是服务器 / 网页版）。' +
          '出于安全，工作区只能在<b>本机桌面应用</b>里开启，这里改了也不会生效。</div>') +
        '<div style="font-size:12px;font-weight:700;margin-bottom:6px;">工作文件夹</div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;">' +
          '<input id="zq-wss-root" class="zq-input" readonly placeholder="（未选择）" style="flex:1;height:32px;font-size:12px;" />' +
          '<button id="zq-wss-browse" class="zq-btn-ghost" style="height:32px;font-size:12px;white-space:nowrap;">浏览…</button>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--zq-text3);margin-bottom:16px;">AI 只能读/改/运行这一个文件夹里的东西，范围越小越安全。</div>' +
        '<div style="font-size:12px;font-weight:700;margin-bottom:6px;">访问档位</div>' +
        '<div id="zq-wss-modes" style="display:flex;gap:6px;margin-bottom:8px;">' +
          modes.map(function (m) {
            return '<button type="button" data-mode="' + m + '" class="zq-btn-ghost" style="flex:1;height:32px;font-size:12px;">' +
              (WS_MODE_LABEL[m] || m) + '</button>';
          }).join('') +
        '</div>' +
        '<div id="zq-wss-desc" style="font-size:11.5px;color:var(--zq-text2);line-height:1.6;min-height:34px;"></div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
          '<button id="zq-wss-cancel" class="zq-btn-ghost" style="height:34px;font-size:12.5px;">取消</button>' +
          '<button id="zq-wss-save" class="zq-btn" style="height:34px;font-size:12.5px;">保存并生效</button>' +
        '</div>',
      onMount: function (body) {
        var rootInput = $('#zq-wss-root', body);
        rootInput.value = chosenRoot;
        var descEl = $('#zq-wss-desc', body);

        function paintModes() {
          $all('[data-mode]', body).forEach(function (btn) {
            var on = btn.getAttribute('data-mode') === chosen;
            btn.style.background = on ? 'var(--zq-primary)' : '';
            btn.style.color = on ? 'var(--zq-on-primary)' : '';
            btn.style.borderColor = on ? 'var(--zq-primary)' : '';
          });
          descEl.textContent = desc[chosen] || '';
        }
        $all('[data-mode]', body).forEach(function (btn) {
          btn.onclick = function () { chosen = btn.getAttribute('data-mode'); paintModes(); };
        });
        paintModes();

        $('#zq-wss-browse', body).onclick = function () {
          openWorkspaceFolderPicker(chosenRoot, function (picked) {
            chosenRoot = picked;
            rootInput.value = picked;
          });
        };
        $('#zq-wss-cancel', body).onclick = function () { h.close(); };
        $('#zq-wss-save', body).onclick = function () {
          if (chosen !== 'OFF' && !chosenRoot) {
            toast('先选一个工作文件夹', 'error');
            return;
          }
          safe('保存工作区设置', async function () {
            await api.put('/workspace/settings', { mode: chosen, root: chosenRoot });
            h.close();
            await loadWorkspace();
            toast('工作区设置已保存');
          });
        };
      }
    });
  }

  // 文件夹选择器：走后端 /workspace/browse 一层层点进去。onPick(绝对路径) 选定当前文件夹。
  function openWorkspaceFolderPicker(startPath, onPick) {
    var cur = { path: startPath || '', parent: null };
    var h = openModal({
      title: '选择工作文件夹',
      width: 480,
      bodyHtml:
        '<div id="zq-fp-cur" class="zq-mono" style="font-size:11.5px;color:var(--zq-text2);word-break:break-all;margin-bottom:8px;">读取中…</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:8px;">' +
          '<button id="zq-fp-up" class="zq-btn-ghost" style="height:28px;font-size:12px;">↑ 上一层</button>' +
          '<button id="zq-fp-pick" class="zq-btn" style="height:28px;font-size:12px;margin-left:auto;">选定当前文件夹</button>' +
        '</div>' +
        '<div id="zq-fp-list" style="max-height:46vh;overflow:auto;display:flex;flex-direction:column;gap:1px;border:1px solid var(--zq-border-soft);border-radius:var(--zq-rs);padding:6px;"></div>',
      onMount: function (body) {
        async function go(path) {
          var res;
          try {
            res = await api.get('/workspace/browse' + (path ? '?path=' + encodeURIComponent(path) : ''));
          } catch (e) { toast('读不了这个目录', 'error'); return; }
          cur.path = res.path; cur.parent = res.parent;
          $('#zq-fp-cur', body).textContent = res.path;
          $('#zq-fp-up', body).disabled = !res.parent;
          $('#zq-fp-up', body).style.opacity = res.parent ? '1' : '.4';
          var list = $('#zq-fp-list', body);
          var dirs = res.dirs || [];
          list.innerHTML = dirs.length ? '' : '<div style="padding:10px;font-size:12px;color:var(--zq-text3);">（没有子文件夹）</div>';
          dirs.forEach(function (d) {
            var a = document.createElement('a');
            a.style.cssText = 'display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:var(--zq-rs);cursor:pointer;font-size:12.5px;color:var(--zq-text2);';
            a.innerHTML = '<span>📁</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(d.name) + '</span>';
            a.onmouseenter = function () { a.style.background = 'var(--zq-card-soft)'; };
            a.onmouseleave = function () { a.style.background = ''; };
            a.onclick = function () { go(d.path); };
            list.appendChild(a);
          });
          if (res.truncated) {
            var more = document.createElement('div');
            more.style.cssText = 'padding:8px 9px;font-size:11px;color:var(--zq-text3);';
            more.textContent = '子文件夹太多，只显示了前 500 个';
            list.appendChild(more);
          }
        }
        $('#zq-fp-up', body).onclick = function () { if (cur.parent) go(cur.parent); };
        $('#zq-fp-pick', body).onclick = function () {
          if (!cur.path) return;
          onPick(cur.path);
          h.close();
        };
        go(cur.path);
      }
    });
  }

  var WS_MODE_LABEL = { OFF: '未启用', READ: '只读', WRITE: '读+写', EXEC: '读+写+运行' };

  async function loadWorkspace() {
    var section = $('#zq-ws');
    if (!section) return;            // 只有 AI 助手页有这一块
    var status;
    try {
      // /settings 是管理员限定的：拿得到 = 是管理员，这一块就该显示（哪怕当前 OFF，
      // 也要给出齿轮让他去开）。拿不到（403）= 非管理员，静默不显示。
      status = await api.get('/workspace/settings');
    } catch (e) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    var gear = $('#zq-ws-settings');
    if (gear) gear.onclick = function () { openWorkspaceSettings(status); };

    wsState.enabled = !!(status && status.enabled);
    // 「代码」按钮只在工作区真的生效时出现。没生效时按了也没用 —— 后端会因为工作区不可读
    // 而不造 CODE_AGENT 节点，按钮却亮着，那是在骗人。
    var codeToggle = $('#zq-code');
    if (codeToggle) codeToggle.hidden = !wsState.enabled;
    if (!wsState.enabled) {
      // 没开：显示原因（配了没生效）或一句「点⚙开启」，并把文件树/搜索收起来
      $('#zq-ws-sub').textContent = '未启用';
      $('#zq-ws-path').textContent = (status && status.reason)
        ? status.reason : '点右上角 ⚙ 选择工作文件夹并开启';
      $('#zq-ws-tree').innerHTML = '';
      $('#zq-ws-up').hidden = true;
      var sr0 = $('#zq-ws-search-row'); if (sr0) sr0.hidden = true;
      return;
    }
    $('#zq-ws-sub').textContent = WS_MODE_LABEL[status.effectiveMode] || status.effectiveMode;
    wsState.root = status.root || '';
    $('#zq-ws-up').onclick = function () {
      var at = wsState.path.lastIndexOf('/');
      paintWorkspace(at > 0 ? wsState.path.slice(0, at) : '');
    };
    var searchRow = $('#zq-ws-search-row');
    if (searchRow) { searchRow.hidden = false; }
    var q = $('#zq-ws-q');
    if (q) {
      q.onkeydown = function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        var text = q.value.trim();
        // 空关键词不发请求：后端会拒，但那是一次没必要的往返和一条没必要的报错
        if (!text) { paintWorkspace(wsState.path); return; }
        searchWorkspace(text);
      };
    }
    var back = $('#zq-ws-back');
    if (back) {
      back.onclick = function () { if (q) { q.value = ''; } paintWorkspace(wsState.path); };
    }
    await paintWorkspace('');
  }

  /**
   * 工作区路径那一行：明确画成<b>文件夹</b>。
   *
   * <p>原来只印一行 {@code /Users/.../test}，没有图标、结尾没有斜杠，下面紧跟「这个目录是空的」——
   * 用户看成了「工作区是一个具体的文件」。现在：📁 + 文件夹名 + 「/」，完整路径放在第二行、字小一号。
   */
  function paintWorkspacePath() {
    var el = $('#zq-ws-path'); if (!el) return;
    // 两种分隔符都认：Windows 上根目录是 C:\code\test，只按「/」切会把整条路径当成文件夹名。
    var root = String(wsState.root || '').replace(/[\\/]+$/, '');
    var sep = root.indexOf('\\') >= 0 && root.indexOf('/') < 0 ? '\\' : '/';
    var rootName = root ? root.slice(Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\')) + 1) : '工作区';
    var shown = rootName + '/' + (wsState.path ? wsState.path.replace(/\/+$/, '') + '/' : '');
    el.innerHTML = '<div style="display:flex;align-items:center;gap:5px;color:var(--zq-text2);font-size:12px;font-weight:600;">'
      + '<span style="flex:none;">📁</span><span style="min-width:0;word-break:break-all;">' + esc(shown) + '</span></div>'
      + (root ? '<div style="margin-top:2px;font-size:10.5px;color:var(--zq-text3);word-break:break-all;" title="工作文件夹的完整路径">'
        + esc(root + sep + (wsState.path ? wsState.path.split('/').join(sep) + sep : '')) + '</div>' : '');
  }

  async function paintWorkspace(path) {
    var tree = $('#zq-ws-tree'); if (!tree) return;
    var entries, listTruncated = false;
    try {
      // 响应是 {truncated, entries}：条目太多时后端只给前 N 条，而「N 条」和「至少 N 条」
      // 是两回事 —— 不显示的话用户会以为这个目录就这么大。
      var res = await api.get('/workspace/files' + (path ? '?path=' + encodeURIComponent(path) : ''));
      entries = (res && res.entries) || [];
      listTruncated = !!(res && res.truncated);
    } catch (e) {
      tree.innerHTML = '<div style="font-size:11.5px;color:var(--zq-bad);">' + esc(e.message || '读取失败') + '</div>';
      return;
    }
    wsState.path = path || '';
    paintWorkspacePath();
    $('#zq-ws-up').hidden = !wsState.path;
    var backBtn = $('#zq-ws-back');
    if (backBtn) { backBtn.hidden = true; }
    tree.innerHTML = (entries || []).map(function (e) {
      var name = e.path.indexOf('/') >= 0 ? e.path.slice(e.path.lastIndexOf('/') + 1) : e.path;
      // 不可读的文件也列出来但置灰 —— 让用户知道它在那儿、而且知道系统刻意没读它，
      // 比干脆不显示诚实
      var dim = !e.directory && !e.readable;
      return '<button type="button" data-ws-entry="' + esc(e.path) + '" data-ws-dir="' + (e.directory ? '1' : '0')
        + '" data-ws-readable="' + (e.readable ? '1' : '0')
        + '" style="display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border:none;border-radius:var(--zq-rs);'
        + 'background:transparent;color:' + (dim ? 'var(--zq-text3)' : 'var(--zq-text2)') + ';font-size:11.5px;'
        + 'text-align:left;cursor:' + (dim ? 'not-allowed' : 'pointer') + ';">'
        + '<span style="flex:none;">' + (e.directory ? '📁' : '📄') + '</span>'
        + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(name) + '</span>'
        + (dim ? '<span style="flex:none;font-size:10px;">不可读</span>' : '')
        + '</button>';
    }).join('') || '<div style="font-size:11.5px;color:var(--zq-text3);padding:4px 6px;">这个文件夹还是空的'
      + (wsState.path ? '' : ' —— 按下输入框旁的「代码」，让 AI 在这里新建文件') + '</div>';
    if (listTruncated) {
      tree.innerHTML += '<div style="font-size:10.5px;color:var(--zq-warn);padding:6px;">'
        + '条目过多，只列出了前 ' + (entries || []).length + ' 条 —— 这不是全部</div>';
    }

    $all('[data-ws-entry]', tree).forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.wsDir === '1') { paintWorkspace(b.dataset.wsEntry); return; }
        if (b.dataset.wsReadable !== '1') { toast('这个文件不在允许读取的清单里', 'error'); return; }
        openWorkspaceFile(b.dataset.wsEntry);
      };
    });
  }

  /**
   * 工作区搜索。结果复用文件树那块区域 —— 侧栏窄，再开一块只会两边都挤。
   *
   * <p>截断状态<b>必须显示出来</b>：用户看到 80 条会以为一共 80 条，
   * 而「至少 80 条，没找完」是完全不同的结论。后端已经把 truncated 传上来了，
   * 传上来却不显示，等于没传。
   */
  function searchWorkspace(query) {
    var tree = $('#zq-ws-tree'); if (!tree) return;
    tree.innerHTML = '<div style="font-size:11.5px;color:var(--zq-text3);padding:4px 6px;">搜索中…</div>';
    var back = $('#zq-ws-back');
    if (back) { back.hidden = false; }
    $('#zq-ws-up').hidden = true;
    $('#zq-ws-path').textContent = '搜索「' + query + '」'
      + (wsState.path ? ' · 范围 ' + wsState.path : '');

    safe('搜索工作区', async function () {
      var res = await api.get('/workspace/search?query=' + encodeURIComponent(query)
        + (wsState.path ? '&path=' + encodeURIComponent(wsState.path) : ''));
      var hits = (res && res.hits) || [];
      if (!hits.length) {
        tree.innerHTML = '<div style="font-size:11.5px;color:var(--zq-text3);padding:4px 6px;">'
          + '没找到。扫了 ' + ((res && res.filesScanned) || 0) + ' 个文件。</div>';
        return;
      }
      tree.innerHTML = hits.map(function (h) {
        return '<button type="button" data-ws-hit="' + esc(h.path) + '"'
          + ' style="display:block;width:100%;padding:5px 6px;border:none;border-radius:var(--zq-rs);'
          + 'background:transparent;text-align:left;cursor:pointer;">'
          + '<span class="zq-mono" style="display:block;font-size:10.5px;color:var(--zq-text3);'
          + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
          + esc(h.path) + ':' + esc(String(h.line)) + '</span>'
          + '<span class="zq-mono" style="display:block;font-size:11px;color:var(--zq-text2);'
          + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(h.text) + '</span>'
          + '</button>';
      }).join('')
        + '<div style="font-size:10.5px;color:' + (res.truncated ? 'var(--zq-warn)' : 'var(--zq-text3)')
        + ';padding:6px;">'
        + (res.truncated
          ? '还有更多 —— 只显示了前 ' + hits.length + ' 条，换个更具体的关键词'
          : '共 ' + hits.length + ' 条，扫了 ' + (res.filesScanned || 0) + ' 个文件')
        + '</div>';

      $all('[data-ws-hit]', tree).forEach(function (b) {
        b.onclick = function () { openWorkspaceFile(b.dataset.wsHit); };
      });
    });
  }

  /** 从文件名取语言标记，喂给着色器。取不到就不着色，不瞎猜。 */
  function langOfPath(path) {
    var at = String(path || '').lastIndexOf('.');
    return at < 0 ? '' : path.slice(at + 1).toLowerCase();
  }

  function openWorkspaceFile(path) {
    safe('读取文件', async function () {
      var file = await api.get('/workspace/file?path=' + encodeURIComponent(path));
      openModal({
        title: path,
        width: 860,
        bodyHtml: '<pre style="margin:0;max-height:62vh;overflow:auto;padding:12px 14px;border:1px solid var(--zq-border-soft);'
          + 'border-radius:var(--zq-rs);background:var(--zq-card-soft);"><code class="zq-mono" style="font-size:12.5px;'
          + 'line-height:1.6;white-space:pre;">' + highlightCode(file.content || '', langOfPath(path)) + '</code></pre>'
      });
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
   */
  var DAY_RELOAD = { 'dashboard.html': function () { return bootDashboard(); }, 'routines.html': function () { return loadRoutines(); } };
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

  var pomoWatched = false;
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

        // 页面开着跨过业务日期的零点：只重新取数据（看板、例行计划的「今天」），见 watchBusinessDay
        if (!dayWatched && DAY_RELOAD[page]) { dayWatched = true; watchBusinessDay(DAY_RELOAD[page]); }
        var boots = { 'dashboard.html': bootDashboard, 'tasks.html': bootTasks, 'routines.html': bootRoutines, 'statistics.html': bootStatistics, 'achievement.html': bootAchievement, 'profile.html': bootProfile, 'admin.html': bootAdmin, 'feedback-admin.html': bootFeedbackAdmin, 'account-admin.html': bootAccountAdmin, 'shared-plans.html': bootSharedPlans, 'shared-plan-admin.html': bootSharedPlanAdmin, 'knowledge-wiki.html': bootKnowledge, 'ai-assistant.html': bootAiAssistant };
        // 番茄钟的待补记不能挂在页面启动之后：启动失败（网断着打开的、被限流）时正是有待补记的时候，挂在后面的话这一页就不补了。
        // 当场那一趟放在启动之后（成不成都跑）：补上了要刷新的看板数字，得等看板自己先起来
        var watchPomodoros = !pomoWatched;
        if (watchPomodoros) {
          pomoWatched = true;
          window.addEventListener('online', catchUpPomodoros);
          setInterval(catchUpPomodoros, 60000);
        }
        try {
          if (boots[page]) await boots[page]();
        } finally {
          if (watchPomodoros) catchUpPomodoros();
        }
      } finally {
        // 卡死不了：zhiqu-ui.js:31 那个 2.5s 无条件兜底仍会摘遮罩，
        // 所以万一导航没成行，页面也不会永远停在空白。
        if (!leaving) revealContent();
      }
    }, { renderError: true });
  }

  // localDate 一并暴露：页面内联脚本（如 dashboard 的番茄钟）也要算「今天」，
  // 让它们用同一份定义，而不是各写一个 toISOString
  window.zqApi = { api: api, reload: route, today: today, localDate: localDate, now: nowMs, serverTime: serverTime, businessDate: businessDate, toast: toast, recordPomodoro: recordPomodoro };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', route); else route();
})();
