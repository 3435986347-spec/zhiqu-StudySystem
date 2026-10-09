// 参考计划页的行为判据（第五十七轮，界面打磨第 8 步）—— 直接 import 发布的 assets/pages/shared-plans.js，壳的东西用替身。
//
//   用法：node src/test/resources/js/shared-plans-check.js <zhiqu-api.js 的路径>
//   退出码 0 = 全绿；非 0 = 有判据红了，逐条打印在上面。由 SharedPlansLookTest 调用。
//
// 钉的是：
//   1 卡片：分类是小圆点 + 名字、点赞是图标（原来是字符）、键盘能打开、没有内联样式
//   2 详情：分类写名字（原来写代码「GENERAL」）、点赞按下 aria-pressed、套用的日期框默认今天并先聚焦（原来先聚焦「点赞」，一按回车就赞上）
//   3 我的投稿：状态、驳回原因（管理员写的解释唯一的出口）
//   4 排序下拉一个值说清两件事；点赞之后照着现在选的分类和排序重新取（原来整页重跑启动，列表回到默认）；点赞连点只发一次
//   5 套用：键在打开时生成、带上日期；连点只发一次；没选日期不发；换个日期是另一次
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const shellPath = path.resolve(process.argv[2]);
const src = fs.readFileSync(shellPath, 'utf8');

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}
// 壳里那份分类表（后台也用）
const ca = src.indexOf('  var PLAN_CATEGORIES = [');
const cb = src.indexOf('  function mathBlockHtml(', ca);
if (ca < 0 || cb < 0) throw new Error('抠不到 PLAN_CATEGORIES / planCategory');
const cats = new Function(src.slice(ca, cb) + '\nreturn { planCategory, planCategoryOptions };')();

const DAY = '2026-10-10';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function el(props) {
  return Object.assign({ value: '', disabled: false, hidden: false, textContent: '', innerHTML: '', dataset: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } }, props || {});
}
function harness(opts) {
  opts = opts || {};
  const h = { gets: [], posts: [], toasts: [], errors: [], modals: [], closed: 0, keys: 0 };
  h.dom = { '#zq-plan-cat': el({ value: 'GENERAL' }), '#zq-plan-sort': el({ value: 'likeCount:desc' }), '#zq-plans': el(), '#zq-plan-count': el(), '#zq-plan-submit': el() };
  h.sh = {
    api: {
      get: async (u) => { h.gets.push(u); if (u.startsWith('/shared-plans/') ) return opts.detail; if (u.startsWith('/shared-plans')) return opts.list || []; return []; },
      post: async (u, body, headers) => {
        h.posts.push({ u, body, headers });
        await new Promise((r) => setTimeout(r, 5));
        if (opts.failPost) throw new Error('服务器说不行');
        return u.endsWith('/like') ? { liked: true, likeCount: 8 } : {};
      }
    },
    esc, $: (sel) => h.dom[sel] || null, $all: () => [], empty: (s) => '<p class="zq-empty">' + s + '</p>', fmtDate: (d) => String(d || '').replace('T', ' ').slice(0, 16),
    safe: async (name, fn) => { try { return await fn(); } catch (e) { h.errors.push(name + '：' + e.message); } },
    toast: (m, kind) => h.toasts.push((kind || '') + m),
    openModal: (o) => { const handle = { close() { h.closed++; } }; h.modals.push(o); o.onMount({}, handle); return handle; },
    today: () => DAY, latestOnly: () => () => true, normalizeTask: (t) => t, writeKey: () => 'k' + (++h.keys),
    planCategory: cats.planCategory, planCategoryOptions: cats.planCategoryOptions,
    icon: (n) => '<svg data-icon="' + n + '"></svg>'
  };
  return h;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));

(async () => {
  const mod = await import(pathToFileURL(path.join(path.dirname(shellPath), 'pages', 'shared-plans.js')).href);
  for (const fn of ['planCardsHtml', 'planDetailHtml', 'submissionsHtml', 'sortParams', 'openPlan', 'bind']) {
    if (typeof mod[fn] !== 'function') throw new Error('pages/shared-plans.js 没有导出 ' + fn);
  }

  console.log('── 1 卡片 ──');
  let h = harness(); mod.bind(h.sh);
  const cards = mod.planCardsHtml([
    { id: 3, title: '新项目 <启动>', category: 'PROJECT', likeCount: 5, description: '两周', targetAudience: '新人', applyCount: 2 },
    { id: 4, title: '没写分类的', likeCount: 0 }
  ]);
  judge('分类：小圆点 + 名字，点的颜色按分类表（项目推进 = q1）', cards.includes('<span class="zq-plan-cat" data-q="q1"><i></i>项目推进</span>'), cards);
  judge('没写分类的按「通用规划」', cards.includes('data-q="q4"><i></i>通用规划</span>'), cards);
  judge('点赞是图标 + 数，不是字符', cards.includes('<svg data-icon="heart"></svg>5') && !/[♡♥]/.test(cards), cards);
  judge('键盘能打开：role=button、tabindex、带名字的 aria-label', cards.includes('role="button" tabindex="0" aria-label="打开「新项目 &lt;启动&gt;」"'), cards);
  judge('适用 / 套用过几次写在底下；两样都没有就不画底栏', cards.includes('适用：新人') && cards.includes('套用过 2 次') && (cards.match(/zq-plan-foot/g) || []).length === 1, cards);
  judge('没有内联样式', !/style=/.test(cards), cards.match(/style="[^"]*"/));
  judge('一个都没有：说出来', mod.planCardsHtml([]).includes('还没有参考计划'));

  console.log('── 2 详情 ──');
  const detail = { id: 3, title: 'X', category: 'GENERAL', liked: true, likeCount: 7, creator: { nickname: '小王' }, tasks: [{ title: '写 <b>' }], routines: [], description: '说明' };
  const d = mod.planDetailHtml(detail, DAY);
  judge('分类写名字（原来写代码「GENERAL」）', d.includes('>通用规划</span>') && !d.includes('GENERAL'), d);
  judge('谁分享的', d.includes('来自 小王'), d);
  judge('点赞是图标按钮、按下 aria-pressed、读得出数', d.includes('id="zq-plan-like" aria-pressed="true"') && d.includes('aria-label="点赞，现在 7 个赞"') && d.includes('<svg data-icon="heart"></svg>'), d);
  judge('任务一条一行、转义；例行计划没有就说「没有」', d.includes('<li>写 &lt;b&gt;</li>') && d.includes('例行计划 · 0</h4><p class="zq-plan-none">没有</p>'), d);
  judge('套用：日期框默认今天、先聚焦它（不是「点赞」）', d.includes('id="zq-plan-start" type="date" class="zq-input" value="' + DAY + '" autofocus'), d);
  judge('没有内联样式', !/style=/.test(d), d.match(/style="[^"]*"/));

  console.log('── 3 我的投稿 ──');
  const subs = mod.submissionsHtml([
    { title: '被驳回的', status: 'rejected', rejectionReason: '含 <手机号>', createdAt: '2026-10-01T09:00' },
    { title: '没写原因的', status: 'REJECTED' },
    { title: '等着的', status: 'PENDING' }
  ]);
  judge('驳回原因写出来（转义）', subs.includes('<b>驳回原因：</b>含 &lt;手机号&gt;'), subs);
  judge('驳回了没写原因：说「管理员未填写驳回原因」', subs.includes('管理员未填写驳回原因。'), subs);
  judge('状态写中文、颜色交给样式表（data-status）', subs.includes('data-status="REJECTED">已驳回') && subs.includes('data-status="PENDING">待审核'), subs);
  judge('没有内联样式', !/style=/.test(subs), subs.match(/style="[^"]*"/));

  console.log('── 4 排序、点赞后重新取 ──');
  judge('「赞最多」→ likeCount / desc', JSON.stringify(mod.sortParams('likeCount:desc')) === '{"sort":"likeCount","order":"desc"}');
  judge('「最早发布」→ time / asc', JSON.stringify(mod.sortParams('time:asc')) === '{"sort":"time","order":"asc"}');
  judge('认不出的 → 最新发布', JSON.stringify(mod.sortParams('drop table')) === '{"sort":"time","order":"desc"}' && JSON.stringify(mod.sortParams('')) === '{"sort":"time","order":"desc"}');
  h = harness({ detail }); mod.bind(h.sh);
  h.dom['#zq-plan-like'] = el({ attrs: { 'aria-pressed': 'false' } });
  h.dom['.zq-num'] = el();
  h.dom['#zq-plan-apply'] = el();
  h.dom['#zq-plan-start'] = el({ value: DAY });
  await mod.openPlan(3);
  judge('详情用 openModal 打开（原来是 HTML 里另写的一套）', h.modals.length === 1 && h.modals[0].title === 'X');
  const like = h.dom['#zq-plan-like'];
  like.onclick(); like.onclick();
  await tick();
  judge('点赞连点只发一次', h.posts.filter((p) => p.u.endsWith('/like')).length === 1, JSON.stringify(h.posts));
  judge('点完：按下、数换成服务端回的', like.getAttribute('aria-pressed') === 'true' && h.dom['.zq-num'].textContent === 8);
  judge('点完重新取列表，照着现在选的分类和排序（原来回到默认）', h.gets.includes('/shared-plans?category=GENERAL&sort=likeCount&order=desc'), JSON.stringify(h.gets));

  console.log('── 5 套用 ──');
  const apply = h.dom['#zq-plan-apply'];
  h.dom['#zq-plan-start'].value = '';
  await apply.onclick();
  judge('没选日期：说出来、不发', h.toasts.includes('error先选从哪天开始') && !h.posts.some((p) => p.u.endsWith('/apply')), JSON.stringify(h.toasts));
  h.dom['#zq-plan-start'].value = '2026-10-12';
  apply.onclick(); apply.onclick(); apply.onclick();
  await tick();
  const applies = h.posts.filter((p) => p.u.endsWith('/apply'));
  judge('连点三下只发一次', applies.length === 1, applies.length + ' 次');
  judge('带着打开时生成的键 + 日期', applies[0] && applies[0].headers && applies[0].headers['Idempotency-Key'] === 'k1:2026-10-12' && applies[0].body.startDate === '2026-10-12', JSON.stringify(applies[0]));
  judge('套用上了：关弹窗、说一声', h.closed === 1 && h.toasts.includes('已套用到你的日历'));
  h.dom['#zq-plan-start'].value = '2026-11-01';
  await apply.onclick();
  const again = h.posts.filter((p) => p.u.endsWith('/apply'));
  judge('换个日期是另一次（键跟着变）', again.length === 2 && again[1].headers['Idempotency-Key'] === 'k1:2026-11-01', JSON.stringify(again.map((p) => p.headers)));
  await mod.openPlan(3);
  h.dom['#zq-plan-start'].value = '2026-10-12';
  await h.dom['#zq-plan-apply'].onclick();
  const third = h.posts.filter((p) => p.u.endsWith('/apply'));
  judge('再打开一次是新的一次（新的键）', third[2] && third[2].headers['Idempotency-Key'] === 'k2:2026-10-12', JSON.stringify(third.map((p) => p.headers)));

  h = harness({ detail, failPost: true }); mod.bind(h.sh);
  h.dom['#zq-plan-like'] = el(); h.dom['.zq-num'] = el(); h.dom['#zq-plan-apply'] = el(); h.dom['#zq-plan-start'] = el({ value: DAY });
  await mod.openPlan(3);
  await h.dom['#zq-plan-apply'].onclick();
  judge('套用失败：说出来、弹窗不关、按钮能再点', h.errors.length === 1 && h.closed === 0 && h.dom['#zq-plan-apply'].disabled === false, JSON.stringify(h.errors));

  if (fail) { console.log('\nRED: ' + fail + ' 条'); process.exit(1); }
  console.log('\nALL-GREEN');
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
