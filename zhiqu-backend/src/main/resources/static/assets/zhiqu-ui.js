/* ════════════════════════════════════════════════════════════
   知趣 · 新前端  zhiqu-ui.js
   - 主题（5 风格 × 浅/深）应用 + 切换弹层（记忆到 localStorage）
   - 渲染统一侧边导航到 <nav id="zq-side">，按当前文件名高亮
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
      ['dashboard.html','看板','▦'], ['ai-assistant.html','AI 助手','✦'], ['tasks.html','任务','☰'],
      ['routines.html','例行计划','↻'], ['shared-plans.html','参考计划','❏'], ['knowledge-wiki.html','知识 Wiki','≣'], ['profile.html','个人中心','◉']
    ],
    data: [ ['statistics.html','学习统计','∿'], ['achievement.html','成就系统','✪'] ],
    admin: [ ['admin.html','监管后台','◈'], ['account-admin.html','账号管理','⌘'], ['feedback-admin.html','反馈管理','✉'], ['shared-plan-admin.html','共享计划审核','✓'] ]
  };
  function curFile(){ var p=location.pathname.split('/').pop(); return p || 'dashboard.html'; }
  // mark：给该组每个元素打一个属性，供 setAdminNav 事后精确摘除/补回。
  // 不用「按位置切片」是因为分组数量将来会变，位置法会在加组那天静默错位。
  function navGroup(title, items, mark){
    var cur = curFile();
    var attr = mark ? ' ' + mark : '';
    var h = title ? '<div class="zq-nav-group"'+attr+'>'+title+'</div>' : '';
    items.forEach(function(it){
      var active = it[0]===cur ? ' active' : '';
      h += '<a class="'+active.trim()+'"'+attr+' href="'+it[0]+'"><span class="zq-ic">'+it[2]+'</span><span>'+it[1]+'</span></a>';
    });
    return h;
  }
  var ADMIN_MARK = 'data-zq-nav-admin';
  function buildSidebar(){
    var host = document.getElementById('zq-side');
    if (!host) return;
    host.className = 'zq-side';
    host.innerHTML =
      '<div class="zq-brand"><div class="zq-brand-badge">知</div><div class="zq-brand-name">知趣<span> · 象限学习</span></div></div>'
      + '<div class="zq-nav">' + navGroup('', NAV.main) + navGroup('数据', NAV.data)
      + (isAdminRole(storedRole()) ? navGroup('管理', NAV.admin, ADMIN_MARK) : '') + '</div>'
      + '<div class="zq-switch" style="padding:12px 4px 2px;border-top:1px solid var(--zq-sb-border);margin-top:10px;">'
      +   '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 4px 7px;">'
      +     '<span style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--zq-text3);">界面风格</span>'
      +     '<button type="button" class="zq-mode-btn" style="height:24px;padding:0 9px;border:1px solid var(--zq-sb-border);border-radius:var(--zq-rs);background:transparent;color:var(--zq-sb-text);font-size:11px;font-weight:600;cursor:pointer;"></button>'
      +   '</div>'
      +   '<button type="button" class="zq-trigger" style="display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;height:30px;padding:0 10px;border:1px solid var(--zq-sb-border);border-radius:var(--zq-rs);background:var(--zq-input-bg);color:var(--zq-text);font-size:12.5px;font-weight:600;cursor:pointer;"><span class="zq-cur">'+verName(readVer())+'</span><span style="opacity:.6;">▧</span></button>'
      + '</div>'
      + '<div class="zq-user"><div class="zq-avatar">远</div><div style="min-width:0;"><div style="font-size:12.5px;font-weight:600;color:var(--zq-sb-active-text);">王明远</div><div style="font-size:11px;color:var(--zq-text3);">管理员</div></div></div>';
    wireSwitch(host);
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
  var pop=null;
  function closePop(){ if(pop){ pop.remove(); pop=null; document.removeEventListener('mousedown',onDown,true);} }
  function onDown(e){ if(pop && !pop.contains(e.target) && !e.target.closest('.zq-trigger')) closePop(); }
  function place(tr){ if(!pop) return; var r=tr.getBoundingClientRect(),pw=238,ph=pop.offsetHeight||340; var l=r.right+8; if(l+pw>innerWidth-8) l=r.left-pw-8; if(l<8)l=8; var t=r.top; if(t+ph>innerHeight-8)t=innerHeight-ph-8; if(t<8)t=8; pop.style.left=l+'px'; pop.style.top=t+'px'; }
  function openPop(tr){
    closePop(); var ver=readVer(),mode=readMode();
    pop=document.createElement('div'); pop.className='zq-pop';
    var h='<div class="zq-pop-t">界面风格</div>';
    VERSIONS.forEach(function(v){ h+='<button type="button" class="zq-opt'+(v.id===ver?' on':'')+'" data-ver="'+v.id+'"><span class="zq-dot"></span><span>'+v.name+'</span></button>'; });
    h+='<div class="zq-sep"></div><div class="zq-modes"><button type="button" class="zq-m'+(mode==='light'?' on':'')+'" data-mode="light">☀ 浅色</button><button type="button" class="zq-m'+(mode==='dark'?' on':'')+'" data-mode="dark">☾ 深色</button></div>';
    pop.innerHTML=h; document.body.appendChild(pop);
    pop.addEventListener('click',function(e){
      var vb=e.target.closest('[data-ver]'), mb=e.target.closest('[data-mode]');
      if(vb){ lss(K_VER,vb.getAttribute('data-ver')); apply(readVer(),readMode()); pop.querySelectorAll('.zq-opt').forEach(function(o){o.classList.toggle('on',o===vb);}); syncTrig(); }
      else if(mb){ lss(K_MODE,mb.getAttribute('data-mode')); apply(readVer(),readMode()); pop.querySelectorAll('.zq-m').forEach(function(o){o.classList.toggle('on',o===mb);}); syncMode(); }
    });
    place(tr); setTimeout(function(){ document.addEventListener('mousedown',onDown,true); },0);
  }
  function syncTrig(){ document.querySelectorAll('.zq-trigger .zq-cur').forEach(function(el){ el.textContent=verName(readVer()); }); }
  function syncMode(){ document.querySelectorAll('.zq-mode-btn').forEach(function(b){ b.textContent = readMode()==='dark'?'☾ 深色':'☀ 浅色'; }); }
  function wireSwitch(scope){
    var tr=scope.querySelector('.zq-trigger'), mb=scope.querySelector('.zq-mode-btn');
    if(mb){ mb.textContent=readMode()==='dark'?'☾ 深色':'☀ 浅色'; mb.addEventListener('click',function(e){ e.stopPropagation(); lss(K_MODE, readMode()==='dark'?'light':'dark'); apply(readVer(),readMode()); syncMode(); }); }
    if(tr){ tr.addEventListener('click',function(e){ e.stopPropagation(); if(pop) closePop(); else openPop(tr); }); }
  }
  addEventListener('resize',function(){ if(pop){ var t=document.querySelector('.zq-trigger'); if(t) place(t); } });
  addEventListener('scroll',function(){ closePop(); },true);

  // ── 折叠助手 ──
  function makeCollapsible(panel, opts){
    if(!panel || panel.dataset.zqC) return; panel.dataset.zqC='1';
    var cbtn=document.createElement('button'); cbtn.type='button'; cbtn.className='zq-cbtn'; cbtn.textContent=opts.dir==='right'?'›':'‹'; panel.appendChild(cbtn);
    var rail=document.createElement('div'); rail.className='zq-rail';
    rail.innerHTML='<button type="button" class="zq-xbtn">'+(opts.dir==='right'?'‹':'›')+'</button><div class="zq-rlabel">'+opts.label+'</div>';
    panel.insertBefore(rail, panel.firstChild);
    function set(c){ panel.classList.toggle('zq-collapsed',c); if(opts.onToggle) opts.onToggle(c); lss(opts.key, c?'1':'0'); }
    cbtn.addEventListener('click',function(e){e.stopPropagation();set(true);});
    rail.querySelector('.zq-xbtn').addEventListener('click',function(e){e.stopPropagation();set(false);});
    rail.querySelector('.zq-rlabel').addEventListener('click',function(e){e.stopPropagation();set(false);});
    var st=ls(opts.key); set(st===null?(opts.defaultCollapsed!==false):(st==='1'));
  }
  function setupPanels(){
    document.querySelectorAll('[data-zq-collapse]').forEach(function(el){
      var dir=el.getAttribute('data-zq-collapse'); // left | right
      makeCollapsible(el,{ key:'zq.c.'+(el.id||el.getAttribute('data-zq-label')||dir), label:el.getAttribute('data-zq-label')||'面板', dir:dir, defaultCollapsed: el.getAttribute('data-zq-open')!=='1' });
    });
  }

  /**
   * 用**服务端**角色校正「管理」组 —— zhiqu-api.js 拿到 /auth/info 后调一次。
   *
   * 为什么不能只靠 buildSidebar 里的 storedRole()：那个值来自 localStorage/sessionStorage，
   * 客户端可改，也可能是上一个账号留下的陈旧值（同一浏览器换人登录）。
   * 服务端角色是唯一权威，这里做最终裁决——两个方向都要走：
   *   存储说不是、服务端说是 → 补回来（否则管理员少了入口）；
   *   存储说是、服务端说不是 → 摘掉（否则就是这次要修的那个 bug 换了个入口重现）。
   */
  function setAdminNav(isAdmin){
    var nav = document.querySelector('#zq-side .zq-nav');
    if (!nav) return;
    var want = isAdminRole(isAdmin === true ? 'ADMIN' : isAdmin);
    var existing = nav.querySelectorAll('[' + ADMIN_MARK + ']');
    if (want === (existing.length > 0)) return;
    if (want) nav.insertAdjacentHTML('beforeend', navGroup('管理', NAV.admin, ADMIN_MARK));
    else Array.prototype.forEach.call(existing, function (el) { el.remove(); });
  }
  window.ZQUI = window.ZQUI || {};
  window.ZQUI.setAdminNav = setAdminNav;

  function boot(){ buildSidebar(); setupPanels(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
