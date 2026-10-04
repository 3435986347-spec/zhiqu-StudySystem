/* ════════════════════════════════════════════════════════════
   知趣 · 新前端  zhiqu-ui.js
   - 主题（5 风格 × 浅/深）应用 + 切换弹层（记忆到 localStorage）
   - 渲染统一侧边导航到 <nav id="zq-side">，按当前文件名高亮；底部头像点开向上弹的菜单
   - 面板折叠助手（[data-zq-collapse]）：AI 两侧 / Wiki 目录
   仅负责界面显示；业务数据/接口后续接入。
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var VERSIONS = [
    { id: 'v0', name: '暖纸墨青' }, { id: 'v1', name: '石墨蓝' }, { id: 'v2', name: '纸墨松绿' },
    { id: 'v3', name: '黛紫·静雅' }, { id: 'v4', name: '玄墨鎏金' }
  ];
  var DEF_VER = 'v1', DEF_MODE = 'light', K_VER = 'zq.ver', K_MODE = 'zq.mode';
  function ls(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  // 登录时存下的角色。侧栏在 zhiqu-api.js 之前同步渲染，/auth/info 还没回来，
  // 只能先用它决定要不要画「管理」组，避免非管理员先看到再被摘掉的闪烁。
  // **这是显示判断，不是权限判断**：存储是客户端可改的，改了也只是多显示几个入口，
  // 真正的拦截在后端 AdminGuard（每个 /api/admin/** 都回库查 sys_user.role）。
  // 服务端角色到手后由 zhiqu-api.js 调 setAdminNav() 校正，那一次才是权威的。
  function storedRole(){ try { return sessionStorage.getItem('role') || localStorage.getItem('role') || ''; } catch(e){ return ''; } }
  function isAdminRole(r){ return String(r || '').toUpperCase() === 'ADMIN'; }
  function lss(k,v){ try { localStorage.setItem(k,v); } catch(e){} }
  function readVer(){ var v=ls(K_VER); for(var i=0;i<VERSIONS.length;i++) if(VERSIONS[i].id===v) return v; return DEF_VER; }
  function readMode(){ var m=ls(K_MODE); return (m==='dark'||m==='light')?m:DEF_MODE; }
  function verName(id){ for(var i=0;i<VERSIONS.length;i++) if(VERSIONS[i].id===id) return VERSIONS[i].name; return id; }
  function apply(ver,mode){ var h=document.documentElement; h.setAttribute('data-zq-ver',ver); h.setAttribute('data-zq-mode',mode); }
  apply(readVer(), readMode());

  // 首屏防闪：隐藏主内容区，等 zhiqu-api.js 渲染真实数据后揭示（2.5s 安全兜底）
  try { document.documentElement.classList.add('zq-booting'); setTimeout(function(){ document.documentElement.classList.remove('zq-booting'); }, 2500); } catch(e){}

  // ── 侧边导航数据 ──
  var NAV = {
    main: [
      ['ai-assistant.html','AI 助手','✦'], ['dashboard.html','看板','▦'], ['tasks.html','任务','☰'],
      ['routines.html','例行计划','↻'], ['shared-plans.html','参考计划','❏'], ['knowledge-wiki.html','知识 Wiki','≣']
    ],
    // 侧栏只放干活的地方（第三十轮，用户定的）；设置、成就、专注统计、界面风格、后台、退出都在底部头像的菜单里（openUserMenu）。
    // 成就第二十六轮从导航收起（偏游戏化、偏学生），第三十轮成了菜单里的弹窗
    data: [ ['statistics.html','专注统计','∿'] ],
    admin: [ ['admin.html','监管后台','◈'], ['account-admin.html','账号管理','⌘'], ['feedback-admin.html','反馈管理','✉'], ['shared-plan-admin.html','共享计划审核','✓'] ]
  };
  function curFile(){ var p=location.pathname.split('/').pop(); return p || 'dashboard.html'; }
  function navGroup(title, items){
    var cur = curFile();
    var h = title ? '<div class="zq-nav-group">'+title+'</div>' : '';
    items.forEach(function(it){
      var active = it[0]===cur ? ' active' : '';
      // title 是折叠态的名称来源 —— 不自己造 tooltip：原生的在触屏与边界情况上都对
      h += '<a class="'+active.trim()+'" href="'+it[0]+'" title="'+it[1]+'"><span class="zq-ic">'+it[2]+'</span><span>'+it[1]+'</span></a>';
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
      btn.setAttribute('aria-expanded', on ? 'false' : 'true');
      var icon = btn.querySelector('.zq-ic');
      if (icon) icon.textContent = on ? '»' : '«';
    }
  }
  function buildSidebar(){
    var host = document.getElementById('zq-side');
    if (!host) return;
    host.className = 'zq-side';
    host.innerHTML =
      '<div class="zq-brand"><div class="zq-brand-badge">知</div><div class="zq-brand-name">知趣<span> · 象限</span></div></div>'
      + '<button type="button" class="zq-side-toggle" aria-expanded="true" title="收起导航栏">'
      +   '<span class="zq-ic">«</span><span>收起</span></button>'
      + '<div class="zq-nav">' + navGroup('', NAV.main) + '</div>'
      // 名字、身份由 zhiqu-api.js 的 updateSidebarUser 拿到 /auth/info 之后填（原来这里写着设计稿的「王明远 · 管理员」，先闪一下才被换掉）
      + '<button type="button" class="zq-user'+(inMenu(curFile())?' active':'')+'" aria-haspopup="menu" aria-expanded="false" title="设置、成就、统计、退出">'
      +   '<div class="zq-avatar"></div><div style="min-width:0;"><div style="font-size:12.5px;font-weight:600;color:var(--zq-sb-active-text);">&nbsp;</div><div style="font-size:11px;color:var(--zq-text3);">&nbsp;</div></div></button>';
    var userBtn = host.querySelector('.zq-user');
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
    closePop(); popAnchor=tr; var ver=readVer(),mode=readMode();
    pop=document.createElement('div'); pop.className='zq-pop';
    var h='<div class="zq-pop-t">界面风格</div>';
    VERSIONS.forEach(function(v){ h+='<button type="button" class="zq-opt'+(v.id===ver?' on':'')+'" data-ver="'+v.id+'"><span class="zq-dot"></span><span>'+v.name+'</span></button>'; });
    h+='<div class="zq-sep"></div><div class="zq-modes"><button type="button" class="zq-m'+(mode==='light'?' on':'')+'" data-mode="light">☀ 浅色</button><button type="button" class="zq-m'+(mode==='dark'?' on':'')+'" data-mode="dark">☾ 深色</button></div>';
    pop.innerHTML=h; document.body.appendChild(pop);
    pop.addEventListener('click',function(e){
      var vb=e.target.closest('[data-ver]'), mb=e.target.closest('[data-mode]');
      if(vb){ lss(K_VER,vb.getAttribute('data-ver')); apply(readVer(),readMode()); pop.querySelectorAll('.zq-opt').forEach(function(o){o.classList.toggle('on',o===vb);}); }
      else if(mb){ lss(K_MODE,mb.getAttribute('data-mode')); apply(readVer(),readMode()); pop.querySelectorAll('.zq-m').forEach(function(o){o.classList.toggle('on',o===mb);}); }
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
  function menuLink(href, ic, label, cur){ return '<a role="menuitem" href="'+href+'"'+(cur?' aria-current="page"':'')+'><span class="zq-ic">'+ic+'</span><span>'+label+'</span></a>'; }
  function openUserMenu(btn){
    closeMenu(); closePop();
    var cur=curFile();
    menu=document.createElement('div'); menu.className='zq-user-menu'; menu.setAttribute('role','menu'); menu.setAttribute('aria-label','账号菜单');
    var h='<div class="zq-user-menu-head"><strong>'+escHtml(btn.dataset.name||'')+'</strong><span>'+escHtml(btn.dataset.account||'')+'</span></div>'
      + menuLink('#settings/profile','⚙','设置') + menuLink('#achievements','✪','成就')
      + menuLink(NAV.data[0][0], NAV.data[0][2], NAV.data[0][1], cur===NAV.data[0][0])
      + '<button type="button" role="menuitem" data-zq-theme><span class="zq-ic">◐</span><span>界面风格</span><span class="zq-user-menu-note">'+verName(readVer())+' · '+(readMode()==='dark'?'深色':'浅色')+'</span></button>';
    if(adminView){
      h += '<div class="zq-user-menu-sep"></div><div class="zq-user-menu-group">管理</div>'
        + NAV.admin.map(function(it){ return menuLink(it[0], it[2], it[1], cur===it[0]); }).join('');
    }
    h += '<div class="zq-user-menu-sep"></div><button type="button" role="menuitem" data-zq-logout><span class="zq-ic">⏻</span><span>退出登录</span></button>';
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
    var cbtn=document.createElement('button'); cbtn.type='button'; cbtn.className='zq-cbtn'; cbtn.textContent=opts.dir==='right'?'›':'‹'; panel.appendChild(cbtn);
    var rail=document.createElement('div'); rail.className='zq-rail';
    rail.innerHTML='<button type="button" class="zq-xbtn">'+(opts.dir==='right'?'‹':'›')+'</button><div class="zq-rlabel">'+opts.label+'</div>';
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

  function boot(){ buildSidebar(); setupPanels(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
