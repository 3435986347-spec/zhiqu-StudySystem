/* ════════════════════════════════════════════════════════════
   知趣 · 成熟稳重主题包  zhiqu-theme.js
   - 首帧前读取 localStorage 设置 <html data-zq-ver / data-zq-mode>，避免闪白
   - DOMContentLoaded 后在导航栏注入「界面风格」下拉 + 深/浅色按钮
   - 纯原生 JS，无依赖；不改动后端与既有逻辑
   引入方式：在每个页面 </body> 之前加
     <script src="/js/zhiqu-theme.js"></script>
   （无需放在 common.js 之前；本脚本会在首次执行时立即应用属性）
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSIONS = [
    { id: 'v0', name: '暖纸墨青' },
    { id: 'v1', name: '石墨蓝' },
    { id: 'v2', name: '纸墨松绿' },
    { id: 'v3', name: '黛紫·静雅' },
    { id: 'v4', name: '玄墨鎏金' }
  ];
  var DEFAULT_VER = 'v1';
  var DEFAULT_MODE = 'light';
  var KEY_VER = 'zq.ver';
  var KEY_MODE = 'zq.mode';

  function readVer() {
    var v = null;
    try { v = localStorage.getItem(KEY_VER); } catch (e) {}
    for (var i = 0; i < VERSIONS.length; i++) { if (VERSIONS[i].id === v) return v; }
    return DEFAULT_VER;
  }
  function readMode() {
    var m = null;
    try { m = localStorage.getItem(KEY_MODE); } catch (e) {}
    return (m === 'dark' || m === 'light') ? m : DEFAULT_MODE;
  }

  // ── 1) 立即应用（首帧前，防闪白） ──
  function apply(ver, mode) {
    var h = document.documentElement;
    h.setAttribute('data-zq-ver', ver);
    h.setAttribute('data-zq-mode', mode);
  }
  apply(readVer(), readMode());

  // ── 2) 导航栏注入切换控件 ──
  function buildSwitch() {
    var nav = document.querySelector('.navbar');
    if (!nav || nav.querySelector('.zq-switch')) return;

    var ver = readVer(), mode = readMode();

    var wrap = document.createElement('div');
    wrap.className = 'zq-switch';

    var sel = document.createElement('select');
    sel.setAttribute('aria-label', '界面风格');
    VERSIONS.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.id; o.textContent = v.name;
      if (v.id === ver) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      try { localStorage.setItem(KEY_VER, sel.value); } catch (e) {}
      apply(sel.value, readMode());
    });

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zq-mode-btn';
    function label() { return readMode() === 'dark' ? '☾ 深色' : '☀ 浅色'; }
    btn.textContent = label();
    btn.addEventListener('click', function () {
      var next = readMode() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY_MODE, next); } catch (e) {}
      apply(readVer(), next);
      btn.textContent = label();
    });

    wrap.appendChild(sel);
    wrap.appendChild(btn);
    nav.appendChild(wrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildSwitch);
  } else {
    buildSwitch();
  }

  // 导航栏可能由 renderNavbar() 异步注入，兜底重试几次
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    buildSwitch();
    if (document.querySelector('.zq-switch') || tries > 20) clearInterval(timer);
  }, 200);
})();
