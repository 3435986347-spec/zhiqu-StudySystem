// 真浏览器里量「手机上 / 放大后能不能用」（第二十轮）。MobileLayoutTest 钉的是修法的结构，这里量的是结果。
//
//   TOKEN=<用户令牌> [ADMIN_TOKEN=<管理员令牌>] [BASE=http://127.0.0.1:18080] \
//     NODE_PATH="$(npm root -g)" node tools/layout-check/check.js
//
// 需要 playwright（npm i -g playwright && npx playwright install chromium）。先用 seed.js 给账号塞极端内容再量才有意义 ——
// 空账号什么都撑不破（第二十轮就是这样：空账号全绿，塞了内容之后看板 21007px 高）。
// 每页每个尺寸量四样：
//   FAIL 整页被撑宽（最外层出现横向滚动），并点名是哪个元素撑的（自己会横向滚动的框里的不算）
//   FAIL 被 overflow:hidden 的框切掉一截的文字 / 按钮 / 输入框（省略号、限行是故意的，不算）
//   WARN 一块文字被压成细柱或整段摊开（高于 WARN_TALL 像素）
//   FAIL 弹框不在视口里、关闭按钮够不着、里面有东西伸出去
// 另外量 AI 对话区、Wiki 正文区还剩多高（定高页面在矮视口里会被压没）。有 FAIL 时退出码 1。
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:18080';
const TOKEN = process.env.TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const LS = JSON.parse(process.env.LS || '{}');
const WARN_TALL = Number(process.env.WARN_TALL || 600);
const SIZES = (process.env.SIZES || '375x740,320x640,683x384').split(',').map((s) => s.split('x').map(Number));
const USER_PAGES = ['dashboard', 'tasks', 'routines', 'shared-plans', 'knowledge-wiki', 'ai-assistant', 'statistics', 'achievement', 'profile'];
const ADMIN_PAGES = ['admin', 'account-admin', 'feedback-admin', 'shared-plan-admin'];
const DIALOGS = [
  ['tasks', 'button:has-text("新建任务")'], ['tasks', '[data-edit-task]'],
  ['knowledge-wiki', 'button:has-text("新建知识页")'], ['knowledge-wiki', 'button:has-text("导入来源")'],
  ['knowledge-wiki', 'button:has-text("健康检查")'], ['knowledge-wiki', 'button:has-text("图谱")'],
  ['knowledge-wiki', 'button:has-text("待合入变更")'], ['shared-plans', 'button:has-text("提交")'],
];
if (!TOKEN) { console.error('要 TOKEN=<用户令牌>（POST /api/auth/login 的 data.token）'); process.exit(2); }

// 在页面里跑：整页溢出、被切掉的、太高的
function inspect(warnTall) {
  const W = document.documentElement.clientWidth;
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { s += `#${e.id}`; parts.unshift(s); break; }
      if (e.classList.length) s += `.${[...e.classList].slice(0, 2).join('.')}`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const nearestX = (el) => {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (/(auto|scroll)/.test(s.overflowX)) return { a, kind: 'scroll' };
      if (/(hidden|clip)/.test(s.overflowX)) return { a, kind: 'clip' };
    }
    return { a: null, kind: null };
  };
  const skip = (el) => el.closest('[aria-hidden="true"], svg, .katex-mathml');
  const over = document.documentElement.scrollWidth - W;
  const overHits = [], clipHits = [], tall = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || skip(el)) continue;
    const rc = el.getBoundingClientRect();
    if (rc.width < 2 || rc.height < 2) continue;
    const { a, kind } = nearestX(el);
    // 整页被撑宽：右边超出视口、又没有被某个框收住
    if (cs.position !== 'fixed' && rc.right > W + 1 && (!a || a.getBoundingClientRect().right > W + 1)) {
      const par = el.parentElement.getBoundingClientRect();
      if (!(el.parentElement !== document.body && par.right > W + 1)) overHits.push(`${Math.round(rc.right)}px ${path(el)}`);
    }
    // 被切掉一截
    if (kind === 'clip' && cs.textOverflow !== 'ellipsis' && getComputedStyle(el.parentElement).textOverflow !== 'ellipsis'
        && !(cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) {
      const ar = a.getBoundingClientRect();
      const cut = Math.max(rc.right - ar.right, ar.left - rc.left);
      const interactive = /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName);
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (cut > 2 && (interactive || hasText)) {
        let inner = false;
        for (let q = el.parentElement; q && q !== a; q = q.parentElement) if (seen.has(q)) { inner = true; break; }
        seen.add(el);
        if (!inner) clipHits.push(`-${Math.round(cut)}px ${el.tagName} ${path(el)} 「${(el.innerText || el.placeholder || '').trim().slice(0, 24)}」`);
      }
    }
    // 太高的一块字（自己会纵向滚动的框里的不算）
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (own.length >= 20 && rc.height >= warnTall && el.closest('.zq-main')) {
      let scroller = false;
      for (let q = el; q && q !== document.body; q = q.parentElement) {
        const s = getComputedStyle(q);
        if (/(auto|scroll)/.test(s.overflowY) && q.scrollHeight > q.clientHeight + 2) { scroller = true; break; }
      }
      if (!scroller) tall.push(`${Math.round(rc.height)}px × ${Math.round(rc.width)}px ${own.length} 字 ${path(el)}`);
    }
  }
  const h = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) : null; };
  return { over, overHits: overHits.slice(0, 6), clipHits: clipHits.slice(0, 8), tall: tall.slice(0, 4),
    pageH: document.documentElement.scrollHeight, chat: h('#zq-chat'), doc: h('#zq-doc') };
}

function inspectDialog() {
  const m = document.querySelector('.zq-modal');
  if (!m) return null;
  const W = innerWidth, H = innerHeight, mr = m.getBoundingClientRect();
  const close = m.querySelector('.zq-modal-close').getBoundingClientRect();
  const out = [];
  for (const el of m.querySelectorAll('*')) {
    const rc = el.getBoundingClientRect();
    if (rc.width < 2 || getComputedStyle(el).display === 'none' || getComputedStyle(el).textOverflow === 'ellipsis') continue;
    let scroll = false;
    for (let a = el.parentElement; a && a !== m; a = a.parentElement) if (/(auto|scroll)/.test(getComputedStyle(a).overflowX)) { scroll = true; break; }
    if (!scroll && (rc.right > mr.right + 1 || rc.left < mr.left - 1) && el.parentElement.getBoundingClientRect().right <= mr.right + 1) {
      out.push(`${el.tagName} +${Math.round(rc.right - mr.right)}px`);
    }
  }
  return { title: m.querySelector('.zq-modal-title').textContent.slice(0, 20),
    inView: mr.left >= 0 && mr.right <= W && mr.top >= 0 && mr.bottom <= H, closeOk: close.right <= W && close.top >= 0, out };
}

(async () => {
  const browser = await chromium.launch();
  let fails = 0, warns = 0;
  const say = (level, msg) => { if (level === 'FAIL') fails++; if (level === 'WARN') warns++; console.log(`${level}\t${msg}`); };
  for (const [w, h] of SIZES) {
    for (const [pages, tk, role] of [[USER_PAGES, TOKEN, 'USER'], [ADMIN_TOKEN ? ADMIN_PAGES : [], ADMIN_TOKEN, 'ADMIN']]) {
      if (!pages.length) continue;
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript(([t, r, ls]) => {
        for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
        localStorage.setItem('token', t); localStorage.setItem('role', r);
      }, [tk, role, LS]);
      for (const p of pages) {
        const page = await ctx.newPage();
        await page.goto(`${BASE}/${p}.html`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(600);
        const r = await page.evaluate(inspect, WARN_TALL);
        const tag = `${w}x${h} ${p}`;
        if (r.over > 0 || r.overHits.length) say('FAIL', `${tag} 整页宽出 ${r.over}px\n\t  ${r.overHits.join('\n\t  ')}`);
        if (r.clipHits.length) say('FAIL', `${tag} 被切掉：\n\t  ${r.clipHits.join('\n\t  ')}`);
        if (r.tall.length) say('WARN', `${tag} 太高的一块字（页面 ${r.pageH}px）：\n\t  ${r.tall.join('\n\t  ')}`);
        if (r.chat != null && r.chat < 150) say('WARN', `${tag} AI 对话区只剩 ${r.chat}px`);
        if (r.doc != null && r.doc < 150) say('WARN', `${tag} Wiki 正文区只剩 ${r.doc}px`);
        if (!r.over && !r.overHits.length && !r.clipHits.length) console.log(`ok\t${tag}\t页面 ${r.pageH}px${r.chat != null ? ` · 对话区 ${r.chat}px` : ''}${r.doc != null ? ` · 正文区 ${r.doc}px` : ''}`);
        await page.close();
      }
      if (role === 'USER' && w <= 375) {
        for (const [p, sel] of DIALOGS) {
          const page = await ctx.newPage();
          await page.goto(`${BASE}/${p}.html`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(500);
          const btn = page.locator(sel).first();
          if (!(await btn.count())) { await page.close(); continue; }
          try { await btn.click({ timeout: 3000 }); } catch (e) { say('FAIL', `${w}x${h} ${p} ${sel} 点不到`); await page.close(); continue; }
          await page.waitForTimeout(600);
          const d = await page.evaluate(inspectDialog);
          if (d && (!d.inView || !d.closeOk || d.out.length)) say('FAIL', `${w}x${h} ${p} 弹框「${d.title}」 inView=${d.inView} 关闭=${d.closeOk} ${d.out.join(' ')}`);
          await page.close();
        }
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`\n${fails} FAIL · ${warns} WARN`);
  process.exit(fails ? 1 : 0);
})();
