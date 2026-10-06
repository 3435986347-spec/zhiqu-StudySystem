/* ════════════════════════════════════════════════════════════
   知趣 · 新前端  zhiqu-ui.js
   - 外观（跟随系统 / 浅色 / 深色）与强调色（金 / 黑白）的应用 + 切换弹层（记忆到 localStorage）
   - 渲染统一侧边导航到 <nav id="zq-side">，按当前文件名高亮；底部头像点开向上弹的菜单
   - 面板折叠助手（[data-zq-collapse]）：AI 两侧 / Wiki 目录
   仅负责界面显示；业务数据/接口后续接入。
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  // 外观与强调色（第四十轮，用户 2026-10-06 定的「中性风」「白天白色，晚上黑色」）：
  // 外观默认跟着系统走（macOS 设成「自动」时日落之后系统自己切深色），也可以固定成浅色 / 深色；强调色黑白（默认，第四十一轮用户定的「主题就黑白的吧」）或金色。
  // 用新的键 zq.theme / zq.accent：原来的 zq.mode / zq.ver（五套配色 × 明暗）不再读 —— 手动选过浅色的人也回到「跟随系统」，那正是用户要的。
  // 每页头上那行内联脚本用同一个规则先定好明暗（免得先闪一下另一种颜色），这里接着管切换和「系统外观变了」。
  var THEMES = [ { id: 'auto', name: '跟随系统' }, { id: 'light', name: '浅色' }, { id: 'dark', name: '深色' } ];
  var ACCENTS = [ { id: 'mono', name: '黑白' }, { id: 'gold', name: '金色' } ];
  var K_THEME = 'zq.theme', K_ACCENT = 'zq.accent';
  function ls(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  // 登录时存下的角色。侧栏在 zhiqu-api.js 之前同步渲染，/auth/info 还没回来，
  // 只能先用它决定要不要画「管理」组，避免非管理员先看到再被摘掉的闪烁。
  // **这是显示判断，不是权限判断**：存储是客户端可改的，改了也只是多显示几个入口，
  // 真正的拦截在后端 AdminGuard（每个 /api/admin/** 都回库查 sys_user.role）。
  // 服务端角色到手后由 zhiqu-api.js 调 setAdminNav() 校正，那一次才是权威的。
  function storedRole(){ try { return sessionStorage.getItem('role') || localStorage.getItem('role') || ''; } catch(e){ return ''; } }
  function isAdminRole(r){ return String(r || '').toUpperCase() === 'ADMIN'; }
  function lss(k,v){ try { localStorage.setItem(k,v); } catch(e){} }
  function readTheme(){ var t=ls(K_THEME); return (t==='light'||t==='dark')?t:'auto'; }
  function readAccent(){ return ls(K_ACCENT)==='gold'?'gold':'mono'; }
  function nameOf(list,id){ for(var i=0;i<list.length;i++) if(list[i].id===id) return list[i].name; return id; }
  var darkQuery = null;
  try { darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null; } catch(e){}
  function systemDark(){ return !!(darkQuery && darkQuery.matches); }
  function resolvedMode(){ var t=readTheme(); return t==='auto' ? (systemDark()?'dark':'light') : t; }
  function apply(){ var h=document.documentElement; h.setAttribute('data-zq-mode',resolvedMode()); h.setAttribute('data-zq-accent',readAccent()); }
  apply();
  // 跟随系统时，系统外观一变（日落、日出、手动切）页面当场跟着变；固定了浅 / 深色的不受影响（apply 读的是存下的选择）
  if (darkQuery) {
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', apply);
    else if (darkQuery.addListener) darkQuery.addListener(apply);
  }

  // 首屏遮罩只留给「可能马上要被送走」的页面：后台页（普通用户会被劝返，见 zhiqu-api.js 的 route）和两个旧地址的跳转页。
  // 别的页面一打开就露出自己的骨架（标题、按钮、表头），数据回来再填进去 —— 原来每一页都先把主内容区藏起来、
  // 等接口全回来再淡入，每切一次页面都是「空白 → 淡入」（第三十九轮，用户说「页面切换非常不流畅」）。
  // 页面里不再有示例数据（第二十四轮），露出骨架不会先闪一下假内容。2.5s 安全兜底照旧。
  function holdsUntilBoot(file){ var f=String(file||'').toLowerCase(); return f==='profile.html' || f==='achievement.html' || isAdminPage(f); }

  // ── 图标（第四十二轮，docs/ui-plan.md 第 2 步）────────────────────────────────────
  // 原来导航、菜单、按钮里是 Unicode 符号（✦ ▦ ☰ ↻ ❏ ≣ ◈ ⌘ ✉ ∿ « » ‹ › ⚙ ◐ ⏻ ✪ ＋ ×），每个来自不同字体、粗细基线都不一样 —— 「玩具感」最直接的来源。
  // 现在是一套线性图标：24 格、1.75 线宽、圆头圆角。图形照 Lucide 画（https://lucide.dev，ISC 许可：
  //   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
  //   All other copyright (c) for Lucide are held by Lucide Contributors 2022.
  //   Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted,
  //   provided that the above copyright notice and this permission notice appear in all copies.）
  // 不从外网取：这里只放用到的几十个，随页面一起发。静态 HTML 写 <span data-zq-icon="名字"></span>，启动时由 paintIcons 填上；
  // 脚本里拼的用 ZQUI.icon(名字)（页面模块经 zqShared.icon）。认不出的名字给空串 —— 用到的名字都画得出来由判据（IconSetTest）管。
  var ICONS = {
    'sparkles': '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    'list-checks': '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    'repeat': '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'book-open': '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    'chart-column': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    'shield': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    'users': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    'clipboard-check': '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
    'settings': '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    'award': '<path d="m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"/><circle cx="12" cy="8" r="6"/>',
    'contrast': '<circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    'panel-left-close': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
    'panel-left-open': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
    'panel-right-close': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>',
    'panel-right-open': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m10 15-3-3 3-3"/>',
    'paperclip': '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    'globe': '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    'lightbulb': '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    'code': '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'check': '<path d="M20 6 9 17l-5-5"/>',
    'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'
  };
  function icon(name){
    var body = ICONS[name];
    return body ? '<svg class="zq-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>' : '';
  }
  /** 静态 HTML 里的 <span data-zq-icon="名字"></span>：填上图形（只填一次） */
  function paintIcons(root){
    var nodes = (root || document).querySelectorAll('[data-zq-icon]');
    Array.prototype.forEach.call(nodes, function (el) {
      if (el.getAttribute('data-zq-icon-done') === '1') return;
      el.innerHTML = icon(el.getAttribute('data-zq-icon'));
      el.setAttribute('data-zq-icon-done', '1');
    });
  }

  // ── 侧边导航数据 ──
  var NAV = {
    main: [
      ['ai-assistant.html','AI 助手','sparkles'], ['dashboard.html','看板','layout-dashboard'], ['tasks.html','任务','list-checks'],
      ['routines.html','例行计划','repeat'], ['shared-plans.html','参考计划','copy'], ['knowledge-wiki.html','知识 Wiki','book-open']
    ],
    // 侧栏只放干活的地方（第三十轮，用户定的）；设置、成就、专注统计、界面风格、后台、退出都在底部头像的菜单里（openUserMenu）。
    // 成就第二十六轮从导航收起（偏游戏化、偏学生），第三十轮成了菜单里的弹窗
    data: [ ['statistics.html','专注统计','chart-column'] ],
    admin: [ ['admin.html','监管后台','shield'], ['account-admin.html','账号管理','users'], ['feedback-admin.html','反馈管理','message-square'], ['shared-plan-admin.html','共享计划审核','clipboard-check'] ]
  };
  function curFile(){ var p=location.pathname.split('/').pop(); return p || 'dashboard.html'; }
  // 放在 NAV 之后：isAdminPage 读的是 NAV.admin（放在前面时 NAV 还是 undefined，抛了被 try 吞掉，后台页就不遮了）
  try { if (holdsUntilBoot(curFile())) { document.documentElement.classList.add('zq-booting'); setTimeout(function(){ document.documentElement.classList.remove('zq-booting'); }, 2500); } } catch(e){}
  function navGroup(title, items){
    var cur = curFile();
    var h = title ? '<div class="zq-nav-group">'+title+'</div>' : '';
    items.forEach(function(it){
      var active = it[0]===cur ? ' active' : '';
      // title 是折叠态的名称来源 —— 不自己造 tooltip：原生的在触屏与边界情况上都对
      h += '<a class="'+active.trim()+'" href="'+it[0]+'" title="'+it[1]+'"><span class="zq-ic">'+icon(it[2])+'</span><span>'+it[1]+'</span></a>';
    });
    return h;
  }
  var SIDE_COLLAPSED_KEY = 'zq-side-collapsed';

  // 折叠是一个偏好，不是一次性动作：14 个页面是各自独立的文档（MPA），
  // 不存的话每次跳页都弹回展开态。localStorage 读写包 try —— 隐私模式下会抛。
  function sideCollapsed(){
    try { return localStorage.getItem(SIDE_COLLAPSED_KEY) === '1'; } catch (e) { return false; }
  }
  function storeSideCollapsed(on){
    try { localStorage.setItem(SIDE_COLLAPSED_KEY, on ? '1' : '0'); } catch (e) {}
  }
  // 手机宽度（与 zhiqu-ui.css 里的 @media 同一个断点）：侧栏默认收起、展开是临时的 —— 不改桌面上存的偏好
  var MOBILE_QUERY = '(max-width: 760px)';
  function isMobile(){
    try { return !!(window.matchMedia && window.matchMedia(MOBILE_QUERY).matches); } catch (e) { return false; }
  }
  function applySideCollapsed(on){
    var host = document.getElementById('zq-side');
    if (host) host.classList.toggle('is-collapsed', on);
    // 正文区跟着让位；用类而不是直接写 style，折叠宽度只在 CSS 里定义一处
    document.querySelectorAll('.zq-main').forEach(function (main) {
      main.classList.toggle('is-side-collapsed', on);
    });
    var btn = host && host.querySelector('.zq-side-toggle');
    if (btn) {
      btn.title = on ? '展开导航栏' : '收起导航栏';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-expanded', on ? 'false' : 'true');
      var ic = btn.querySelector('.zq-ic');
      if (ic) ic.innerHTML = icon(on ? 'panel-left-open' : 'panel-left-close');
    }
  }
  function buildSidebar(){
    var host = document.getElementById('zq-side');
    if (!host) return;
    host.className = 'zq-side';
    host.innerHTML =
      // 收起按钮是品牌那一行右边的一个小图标（第四十三轮；原来是导航最上面一整条带字的按钮，比导航项还显眼），收起后在品牌标志下面
      '<div class="zq-brand"><div class="zq-brand-badge">知</div><div class="zq-brand-name">知趣<span> · 象限</span></div>'
      +   '<button type="button" class="zq-side-toggle" aria-expanded="true" aria-label="收起导航栏" title="收起导航栏">'
      +   '<span class="zq-ic">'+icon('panel-left-close')+'</span></button></div>'
      + '<div class="zq-nav">' + navGroup('', NAV.main) + '</div>'
      // 名字、身份由 zhiqu-api.js 的 updateSidebarUser 拿到 /auth/info 之后填（原来这里写着设计稿的「王明远 · 管理员」，先闪一下才被换掉）。
      // 上一页画过的先画上（按令牌认，换了账号不认），不然每切一次页面左下角都先空一下再冒出来
      + '<button type="button" class="zq-user'+(inMenu(curFile())?' active':'')+'" aria-haspopup="menu" aria-expanded="false" title="设置、成就、统计、退出"></button>';
    var userBtn = host.querySelector('.zq-user');
    paintUser(userBtn, cachedUser());
    userBtn.addEventListener('click', function (e) { e.stopPropagation(); if (menu) closeMenu(); else openUserMenu(userBtn); });
    var toggle = host.querySelector('.zq-side-toggle');
    if (toggle) {
      toggle.onclick = function () {
        var next = !host.classList.contains('is-collapsed');
        if (!isMobile()) storeSideCollapsed(next);
        applySideCollapsed(next);
      };
    }
    applySideCollapsed(isMobile() || sideCollapsed());
    // 手机上展开的侧栏浮在正文上面：点正文就收起（不然只能再找到那个小按钮）
    document.addEventListener('mousedown', function (e) {
      if (isMobile() && !host.classList.contains('is-collapsed') && !host.contains(e.target)) applySideCollapsed(true);
    });
    // 转屏 / 拖窗口跨过断点：回到那个宽度该有的样子
    try {
      var mq = window.matchMedia(MOBILE_QUERY);
      var onChange = function () { applySideCollapsed(isMobile() || sideCollapsed()); };
      if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    } catch (e) {}
    // 跨页面保留导航滚动位置：MPA 每次跳转都重建侧栏，不记忆的话 scrollTop 会归零
    var nav = host.querySelector('.zq-nav');
    if (nav) {
      try { nav.scrollTop = Number(sessionStorage.getItem('zq.navScroll') || 0); } catch (e) {}
      nav.addEventListener('scroll', function () {
        try { sessionStorage.setItem('zq.navScroll', String(nav.scrollTop)); } catch (e) {}
      });
    }
  }

  // ── 主题切换弹层 ──
  var pop=null, popAnchor=null;
  function closePop(){ if(pop){ pop.remove(); pop=null; document.removeEventListener('mousedown',onDown,true);} }
  function onDown(e){ if(pop && !pop.contains(e.target) && !(popAnchor && popAnchor.contains(e.target))) closePop(); }
  function place(tr){ if(!pop) return; var r=tr.getBoundingClientRect(),pw=238,ph=pop.offsetHeight||340; var l=r.right+8; if(l+pw>innerWidth-8) l=r.left-pw-8; if(l<8)l=8; var t=r.top; if(t+ph>innerHeight-8)t=innerHeight-ph-8; if(t<8)t=8; pop.style.left=l+'px'; pop.style.top=t+'px'; }
  function openPop(tr){
    closePop(); popAnchor=tr; var theme=readTheme(),accent=readAccent();
    pop=document.createElement('div'); pop.className='zq-pop';
    var h='<div class="zq-pop-t">外观</div><div class="zq-modes">';
    THEMES.forEach(function(t){ h+='<button type="button" class="zq-m'+(t.id===theme?' on':'')+'" data-theme="'+t.id+'">'+t.name+'</button>'; });
    h+='</div><div class="zq-pop-t" style="padding-top:12px;">强调色</div><div class="zq-modes">';
    ACCENTS.forEach(function(a){ h+='<button type="button" class="zq-m'+(a.id===accent?' on':'')+'" data-accent="'+a.id+'">'+a.name+'</button>'; });
    h+='</div>';
    pop.innerHTML=h; document.body.appendChild(pop);
    pop.addEventListener('click',function(e){
      var tb=e.target.closest('[data-theme]'), ab=e.target.closest('[data-accent]');
      if(tb){ lss(K_THEME,tb.getAttribute('data-theme')); apply(); pop.querySelectorAll('[data-theme]').forEach(function(o){o.classList.toggle('on',o===tb);}); }
      else if(ab){ lss(K_ACCENT,ab.getAttribute('data-accent')); apply(); pop.querySelectorAll('[data-accent]').forEach(function(o){o.classList.toggle('on',o===ab);}); }
    });
    place(tr); setTimeout(function(){ document.addEventListener('mousedown',onDown,true); },0);
  }
  addEventListener('resize',function(){ if(pop && popAnchor && popAnchor.isConnected) place(popAnchor); closeMenu(); });
  addEventListener('scroll',function(e){ closePop(); if(menu && !menu.contains(e.target)) closeMenu(); },true);

  // ── 头像菜单（第三十轮，用户定的：点左下角头像向上弹出，Claude 那样）──
  // 设置、成就是地址里的弹窗（#settings/…、#achievements），由 zhiqu-api.js 按地址打开 —— 这里只放链接，所以刷新、后退都对。
  // 后台那一组只是显示（真正的拦截在后端 AdminGuard）：首屏按本地存的角色，/auth/info 回来后由 setAdminNav 校正。
  var menu=null;
  var adminView=isAdminRole(storedRole());
  /** 这一页属于菜单里的哪一项（专注统计、后台页）：侧栏里没有它的高亮，就让头像按钮亮着 —— 不然用户看不出自己在哪。 */
  function inMenu(file){ if(file===NAV.data[0][0]) return true; return isAdminPage(file); }
  // 左下角的名字、身份、头像：只有这一处画（zhiqu-api.js 的 updateSidebarUser 拿到 /auth/info 之后也调它）。
  // u 为空时画两行空白占位，高度不变
  var USER_CACHE = 'zq.sideUser';
  function currentToken(){ try { return sessionStorage.getItem('token') || localStorage.getItem('token') || ''; } catch(e){ return ''; } }
  function paintUser(box, u){
    if (!box) return;
    if (!u) { box.innerHTML = '<div class="zq-avatar"></div><div style="min-width:0;"><div style="font-size:12.5px;font-weight:var(--zq-fw-medium);color:var(--zq-sb-active-text);">&nbsp;</div><div style="font-size:11px;color:var(--zq-text3);">&nbsp;</div></div>'; return; }
    var name = u.name || '知趣用户';
    var avatar = u.avatar ? '<img src="' + escHtml(u.avatar) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">' : escHtml(name.slice(0, 1));
    // 头像菜单的顶上一行（openUserMenu）从这里读
    box.dataset.name = name;
    box.dataset.account = u.account || '';
    box.innerHTML = '<div class="zq-avatar">' + avatar + '</div><div style="min-width:0;"><div style="font-size:12.5px;font-weight:var(--zq-fw-medium);color:var(--zq-sb-active-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(name) + '</div><div style="font-size:11px;color:var(--zq-text3);">' + escHtml(u.admin ? '管理员' : '普通用户') + '</div></div>';
  }
  function rememberUser(u){
    var t = currentToken();
    try { if (u && t) sessionStorage.setItem(USER_CACHE, JSON.stringify({ owner: t.slice(-24), name: u.name, account: u.account, avatar: u.avatar, admin: !!u.admin })); } catch(e){}
  }
  function cachedUser(){
    try { var c = JSON.parse(sessionStorage.getItem(USER_CACHE) || 'null'), t = currentToken(); return c && t && c.owner === t.slice(-24) ? c : null; } catch(e){ return null; }
  }
  function escHtml(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function closeMenu(){
    if(!menu) return;
    menu.remove(); menu=null;
    document.removeEventListener('mousedown',onMenuDown,true);
    document.removeEventListener('keydown',onMenuKey,true);
    var b=document.querySelector('#zq-side .zq-user'); if(b) b.setAttribute('aria-expanded','false');
  }
  function onMenuDown(e){ if(menu && !menu.contains(e.target) && !e.target.closest('#zq-side .zq-user')) closeMenu(); }
  function onMenuKey(e){
    if(!menu) return;
    if(e.key==='Escape'){ e.stopPropagation(); var b=document.querySelector('#zq-side .zq-user'); closeMenu(); if(b) b.focus(); return; }
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();
      var items=Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
      var i=items.indexOf(document.activeElement);
      i = e.key==='ArrowDown' ? (i+1)%items.length : (i<=0?items.length-1:i-1);
      items[i].focus();
    }
  }
  function menuLink(href, ic, label, cur){ return '<a role="menuitem" href="'+href+'"'+(cur?' aria-current="page"':'')+'><span class="zq-ic">'+icon(ic)+'</span><span>'+label+'</span></a>'; }
  function openUserMenu(btn){
    closeMenu(); closePop();
    var cur=curFile();
    menu=document.createElement('div'); menu.className='zq-user-menu'; menu.setAttribute('role','menu'); menu.setAttribute('aria-label','账号菜单');
    var h='<div class="zq-user-menu-head"><strong>'+escHtml(btn.dataset.name||'')+'</strong><span>'+escHtml(btn.dataset.account||'')+'</span></div>'
      + menuLink('#settings/profile','settings','设置') + menuLink('#achievements','award','成就')
      + menuLink(NAV.data[0][0], NAV.data[0][2], NAV.data[0][1], cur===NAV.data[0][0])
      + '<button type="button" role="menuitem" data-zq-theme><span class="zq-ic">'+icon('contrast')+'</span><span>界面风格</span><span class="zq-user-menu-note">'+nameOf(THEMES,readTheme())+' · '+nameOf(ACCENTS,readAccent())+'</span></button>';
    if(adminView){
      h += '<div class="zq-user-menu-sep"></div><div class="zq-user-menu-group">管理</div>'
        + NAV.admin.map(function(it){ return menuLink(it[0], it[2], it[1], cur===it[0]); }).join('');
    }
    h += '<div class="zq-user-menu-sep"></div><button type="button" role="menuitem" data-zq-logout><span class="zq-ic">'+icon('log-out')+'</span><span>退出登录</span></button>';
    menu.innerHTML=h;
    document.body.appendChild(menu);
    // 向上弹：底边贴着头像按钮的上沿；收起的窄侧栏里从按钮右边出来
    var r=btn.getBoundingClientRect(), side=document.getElementById('zq-side');
    var narrow = side && side.classList.contains('is-collapsed');
    var w=Math.max(220, narrow ? 0 : r.width);
    var left = narrow ? r.right+8 : r.left;
    if(left+w>innerWidth-8) left=Math.max(8, innerWidth-w-8);
    menu.style.width=w+'px'; menu.style.left=left+'px';
    menu.style.bottom = (narrow ? Math.max(8, innerHeight-r.bottom) : innerHeight-r.top+6)+'px';
    btn.setAttribute('aria-expanded','true');
    menu.addEventListener('click',function(e){
      if(e.target.closest('a')){ closeMenu(); return; }   // 链接照常走（hash 的由 zhiqu-api.js 打开弹窗）
      if(e.target.closest('[data-zq-theme]')){ closeMenu(); openPop(btn); return; }
      if(e.target.closest('[data-zq-logout]')){
        closeMenu();
        if(window.zqApi && window.zqApi.logout) window.zqApi.logout(); else location.href='index.html';
      }
    });
    setTimeout(function(){ document.addEventListener('mousedown',onMenuDown,true); document.addEventListener('keydown',onMenuKey,true); },0);
    var first=menu.querySelector('[role="menuitem"]'); if(first) try{ first.focus({preventScroll:true}); }catch(err){}
  }

  // ── 折叠助手 ──
  function makeCollapsible(panel, opts){
    if(!panel || panel.dataset.zqC) return; panel.dataset.zqC='1';
    // 开关只是面板图标（第四十四轮；原来收起后的竖条上是竖排的字），名字在提示和 aria-label 里。手机上收起的面板是正文上方的页签，字由样式表露出来
    var right=opts.dir==='right';
    var cbtn=document.createElement('button'); cbtn.type='button'; cbtn.className='zq-cbtn'; cbtn.innerHTML=icon(right?'panel-right-close':'panel-left-close');
    cbtn.title='收起「'+opts.label+'」'; cbtn.setAttribute('aria-label',cbtn.title); panel.appendChild(cbtn);
    var rail=document.createElement('div'); rail.className='zq-rail';
    rail.innerHTML='<button type="button" class="zq-xbtn" title="展开「'+opts.label+'」" aria-label="展开「'+opts.label+'」">'+icon(right?'panel-right-open':'panel-left-open')+'</button><div class="zq-rlabel">'+opts.label+'</div>';
    panel.insertBefore(rail, panel.firstChild);
    // 手机上展开是临时的（浮在正文上面，见 zhiqu-ui.css 的 .zq-panel-host）：不写进桌面上记住的偏好
    function set(c){ panel.classList.toggle('zq-collapsed',c); if(opts.onToggle) opts.onToggle(c); if(!isMobile()) lss(opts.key, c?'1':'0'); }
    cbtn.addEventListener('click',function(e){e.stopPropagation();set(true);});
    rail.querySelector('.zq-xbtn').addEventListener('click',function(e){e.stopPropagation();set(false);});
    rail.querySelector('.zq-rlabel').addEventListener('click',function(e){e.stopPropagation();set(false);});
    function remembered(){ var st=ls(opts.key); return st===null?(opts.defaultCollapsed!==false):(st==='1'); }
    set(isMobile() || remembered());
    // 手机上点面板外面就收起（它盖着正文，不收起就只能去找那个小按钮）
    document.addEventListener('mousedown',function(e){
      if(isMobile() && !panel.classList.contains('zq-collapsed') && !panel.contains(e.target)) set(true);
    });
    try {
      var mq=window.matchMedia(MOBILE_QUERY);
      var onChange=function(){ set(isMobile() || remembered()); };
      if(mq.addEventListener) mq.addEventListener('change',onChange); else if(mq.addListener) mq.addListener(onChange);
    } catch(e) {}
  }
  function setupPanels(){
    document.querySelectorAll('[data-zq-collapse]').forEach(function(el){
      if(el.parentElement) el.parentElement.classList.add('zq-panel-host');
      var dir=el.getAttribute('data-zq-collapse'); // left | right
      makeCollapsible(el,{ key:'zq.c.'+(el.id||el.getAttribute('data-zq-label')||dir), label:el.getAttribute('data-zq-label')||'面板', dir:dir, defaultCollapsed: el.getAttribute('data-zq-open')!=='1' });
    });
  }

  /**
   * 用**服务端**角色校正头像菜单里的「管理」组 —— zhiqu-api.js 拿到 /auth/info 后调一次。
   *
   * 为什么不能只靠 storedRole()：那个值来自 localStorage/sessionStorage，
   * 客户端可改，也可能是上一个账号留下的陈旧值（同一浏览器换人登录）。
   * 服务端角色是唯一权威，这里做最终裁决——两个方向都要走：
   *   存储说不是、服务端说是 → 补回来（否则管理员少了入口）；
   *   存储说是、服务端说不是 → 摘掉（否则就是这次要修的那个 bug 换了个入口重现）。
   * 菜单每次打开都按 adminView 现画（第三十轮起这一组不在侧栏里了），所以这里记下结论就够。
   */
  function setAdminNav(isAdmin){
    adminView = isAdminRole(isAdmin === true ? 'ADMIN' : isAdmin);
    if (menu) closeMenu();
  }
  /**
   * 这个文件名是不是后台页 —— <b>集合从 NAV.admin 派生，不在别处再抄一份</b>。
   *
   * <p>route() 里硬写一个四元数组是最省事的写法，也正是本仓库记过的那类漂移：
   * 将来加第五个后台页，NAV.admin 加了、门里忘了，它就又静默可直达，
   * 而没有任何东西会红（与「按位置切片」会在加分组那天静默错位同一族）。
   * 派生之后两者不可能分家：进不了侧栏的页进不了门，反之亦然。
   */
  function isAdminPage(file){
    // 折大小写收在函数**里面**，不指望调用方先折：zhiqu-api.js 传进来的 page 已经小写过
    // （zhiqu-api.js:9），而无参形态走 curFile() 拿的是原样文件名 —— 同一个函数两种行为，
    // 且门的正确性挂在「下一个人记得传那个已小写的值」上。
    // 提供了默认参数，就等于邀请他不传。与集合从 NAV.admin 派生同一个动机：
    // 别让机制的正确性挂在下一个人的记性上。
    var f = String(file || curFile()).toLowerCase();
    for (var i = 0; i < NAV.admin.length; i++) if (NAV.admin[i][0] === f) return true;
    return false;
  }
  window.ZQUI = window.ZQUI || {};
  window.ZQUI.setAdminNav = setAdminNav;
  window.ZQUI.isAdminPage = isAdminPage;
  window.ZQUI.paintUser = function (box, u) { paintUser(box, u); rememberUser(u); };
  window.ZQUI.icon = icon;
  window.ZQUI.paintIcons = paintIcons;

  function boot(){ buildSidebar(); setupPanels(); paintIcons(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
