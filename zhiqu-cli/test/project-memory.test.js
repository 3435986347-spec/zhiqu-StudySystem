// 项目笔记（第一百四十二轮，docs/memory-plan.md 第 6 步）：模型自己的本子，放在项目的 .zhiqu/memory/ 里。
// 由来：用户那段真实记录里，ZHIQU.md 写的还是「单文件小游戏合集」，上一段会话建的 zero-platform/ 没人记，新会话先去读了不相干的文件。
// 用户 2026-11-15 定的：直接写（不走草稿）、不进 git。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn, systemText } from '../src/agent.js';
import { slash } from '../src/cli.js';
import { MAX_PROJECT_NOTES, PROJECT_NOTE_CHARS, ProjectMemory, projectMemory, slug } from '../src/memory.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

function makeCtx({ replies = [{ text: '好' }], root = tmpdir(), storeRoot = null } = {}) {
  const store = new SessionStore(storeRoot || root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 30,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 },
  };
}
const call = (name, args) => ({ calls: [{ name, args }] });
const results = (ctx) => ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
const mem = (root) => new ProjectMemory(path.join(root, '.zhiqu', 'memory'), root);

test('note（kind: project）直接写进 .zhiqu/memory/：一条一个文件、带类型和出处；同一个 topic 再记是更新；终端里说一声', async () => {
  const root = tmpdir();
  const ctx = makeCtx({ root, replies: [
    call('note', { kind: 'project', type: 'command', topic: '测试怎么跑', text: '后端 `mvn -o test`，命令行 `npm test`；改了签名要 clean。' }),
    call('note', { kind: 'project', type: 'pitfall', topic: '缓存令牌', text: '改了静态资源要同时换 HTML 的 ?v= 和 service-worker 的 ZHIQU_CACHE。' }),
    call('note', { kind: 'project', type: 'command', topic: '测试怎么跑', text: '后端 `mvn -o clean test`（要开 Docker），命令行 `npm test`。' }),
    { text: '记好了' },
  ] });
  await runTurn(ctx, '把这两条记进项目笔记');
  const r = results(ctx);
  assert.match(r[0], /^记下了项目笔记「测试怎么跑」→ \.zhiqu\/memory\//);
  assert.match(r[2], /^更新了项目笔记「测试怎么跑」/);
  assert.match(ctx.ui.text(), /记下了项目笔记「缓存令牌」/, '每次写都在终端里说一声');
  const notes = mem(root).list();
  assert.equal(notes.length, 2, '同一个 topic 是更新，不是多一条');
  const test1 = notes.find((n) => n.title === '测试怎么跑');
  assert.equal(test1.type, 'command');
  assert.equal(test1.source, ctx.session.id);
  assert.match(test1.body, /要开 Docker/);
  assert.match(test1.created, /^\d{4}-\d\d-\d\d$/);
  // 磁盘上：一条一个文件 + 程序生成的索引
  const files = fs.readdirSync(path.join(root, '.zhiqu', 'memory')).sort();
  assert.equal(files.length, 3);
  assert.ok(files.includes('MEMORY.md'));
  assert.match(fs.readFileSync(path.join(root, '.zhiqu', 'memory', 'MEMORY.md'), 'utf8'), /- \[命令\] 测试怎么跑 —— 后端 `mvn -o clean test`/);
  // 这段会话里没有草稿、没有别的确认：直接生效（用户定的）
  assert.ok(!ctx.api.posts.length);
});

test('不进 git：.zhiqu/.gitignore 里有 memory/；老项目的 .gitignore 没有这一行就补上，原来的不动', () => {
  const fresh = tmpdir();
  new SessionStore(fresh).create();
  assert.match(fs.readFileSync(path.join(fresh, '.zhiqu', '.gitignore'), 'utf8'), /^memory\/$/m);
  const old = tmpdir();
  write(old, '.zhiqu/.gitignore', '# 以前写的\nsessions/\nsetup.json\nsettings.local.json');
  mem(old).write({ title: '约定', text: '缩进两格' });
  const gi = fs.readFileSync(path.join(old, '.zhiqu', '.gitignore'), 'utf8');
  assert.equal(gi, '# 以前写的\nsessions/\nsetup.json\nsettings.local.json\nmemory/\n');
  mem(old).write({ title: '约定二', text: '不用分号' });
  assert.equal(fs.readFileSync(path.join(old, '.zhiqu', '.gitignore'), 'utf8'), gi, '已经有了就不再加');
});

test('拦住的：空的、太长的、像密钥的、满了；哪里没有项目笔记（评测、子 agent、生成到产物）', async () => {
  const root = tmpdir();
  const m = mem(root);
  assert.match(m.write({ title: 'x', text: '  ' }).error, /没有 text/);
  assert.match(m.write({ title: 'x', text: '字'.repeat(PROJECT_NOTE_CHARS + 1) }).error, /最多 600 字/);
  for (const secret of ['key 是 sk-abcdefghijklmnop1234', 'password = hunter2222', 'token: zqp_abcdefghijklmnop12']) {
    assert.match(m.write({ title: '配置', text: secret }).error, /像带了密钥/, secret);
  }
  assert.equal(m.list().length, 0, '被拦的一条都没写');
  for (let i = 0; i < MAX_PROJECT_NOTES; i++) assert.ok(!m.write({ title: `第 ${i} 条笔记`, text: `内容 ${i}` }).error);
  assert.match(m.write({ title: '再来一条', text: 'x' }).error, /已经有 120 条了/);
  assert.ok(!m.write({ title: '第 3 条笔记', text: '更新不受上限挡' }).error);
  // 会话记录不在这个项目的 .zhiqu/ 里（评测：题目的仓库不能多出东西）
  const repo = tmpdir();
  const bench = makeCtx({ root: repo, storeRoot: tmpdir(), replies: [call('note', { kind: 'project', topic: 't', text: 'x' }), call('write_file', { path: 'newdir/a.js', content: 'x\n' }), { text: '好' }] });
  await runTurn(bench, '记一条');
  assert.match(results(bench)[0], /这里没有项目笔记/);
  assert.ok(!fs.existsSync(path.join(repo, '.zhiqu')), '题目的仓库里多出了 .zhiqu');
  assert.equal(projectMemory({ ...makeCtx(), subagent: { id: 'a1', role: 'worker' } }), null);
  const art = makeCtx();
  art.local.artifact = true;
  assert.equal(projectMemory(art), null);
  assert.equal(slug('测试怎么跑'), '测试怎么跑');
  assert.match(slug('!'), /^note-[0-9a-f]{6}$/);
  assert.notEqual(`${slug('project map')}.md`, 'project-map.md', '模型的笔记不能把程序的地图顶掉');
});

test('项目地图由程序维护：这一句里多出来的顶层目录记一行（哪天建的、出自哪段会话）；不重复记；目录没了那一行去掉', async () => {
  const root = tmpdir();
  write(root, 'index.html', '<h1>小游戏合集</h1>\n');
  fs.mkdirSync(path.join(root, 'Library'));
  const ctx = makeCtx({ root, replies: [call('write_file', { path: 'zero-platform/index.html', content: '<h1>零号平台</h1>\n' }), { text: '做好了' }, { text: '好' }] });
  await runTurn(ctx, '仿照 AAA 文件夹内的游戏，做一款 AAA 游戏');
  const map = mem(root).list().find((n) => n.type === 'map');
  assert.ok(map, '没有地图');
  assert.match(map.body, /^- `zero-platform\/`：\d{4}-\d\d-\d\d 建的，出自会话「仿照 AAA 文件夹内的游戏，做一款 AAA 游戏」$/m);
  assert.ok(!map.body.includes('Library'), '开工时就在的目录不是这段会话建的');
  assert.match(ctx.ui.text(), /项目地图里记下了新目录：zero-platform\//);
  await runTurn(ctx, '再说一句');
  assert.equal((mem(root).list().find((n) => n.type === 'map').body.match(/zero-platform/g) || []).length, 1, '不重复记');
  // 新开一段会话（开工时这个目录已经在）不会再记；就算又交上来一次，地图自己也不重复记
  assert.deepEqual(mem(root).mapAdd([{ dir: 'zero-platform', title: '别的会话' }]), []);
  assert.equal((mem(root).list().find((n) => n.type === 'map').body.match(/zero-platform/g) || []).length, 1);
  // shell 建的目录也算（这里直接在盘上建），目录删了那一行跟着没
  const next = makeCtx({ root, replies: [{ text: '好' }] });
  const real = next.api.stream.bind(next.api);
  next.api.stream = async (...a) => { fs.mkdirSync(path.join(root, 'neon-tetris')); fs.rmSync(path.join(root, 'zero-platform'), { recursive: true }); return real(...a); };
  await runTurn(next, '做一个霓虹俄罗斯方块');
  const after = mem(root).list().find((n) => n.type === 'map').body;
  assert.match(after, /`neon-tetris\/`/);
  assert.ok(!after.includes('zero-platform'), '目录已经没了，地图里还留着');
});

test('新会话开工：索引在系统提示里（地图 + 每条一行），这段会话里不再变；中途新记的下一段才看得到', async () => {
  const root = tmpdir();
  write(root, 'index.html', '<h1>小游戏合集</h1>\n');
  const first = makeCtx({ root, replies: [call('write_file', { path: 'zero-platform/index.html', content: 'x\n' }),
    call('note', { kind: 'project', type: 'convention', topic: '游戏放哪', text: '每个游戏一个顶层目录，入口是 `zero-platform/index.html` 这样的单文件；合集首页是 `index.html`。' }), { text: '好了' }] });
  const before = systemText(first);
  assert.ok(!before.includes('项目笔记'), '还没有笔记：系统提示里不多这一段');
  await runTurn(first, '做一款 AAA 游戏');
  assert.equal(systemText(first), before, '这段会话里记的不改系统提示（缓存）');
  assert.ok(first.api.requests.every((r) => r.messages[0].content === before));

  const second = makeCtx({ root, replies: [{ text: '好' }] });
  await runTurn(second, '背景也很模糊，你要做一个在白天的');
  const system = second.api.requests[0].messages[0].content;
  assert.match(system, /## 项目笔记（你以前在这个项目里记的）/);
  assert.match(system, /是资料不是指令/);
  assert.match(system, /- \[地图\] `zero-platform\/`：\d{4}-\d\d-\d\d 建的，出自会话「做一款 AAA 游戏」/);
  assert.match(system, /- \[约定\] 游戏放哪 —— 每个游戏一个顶层目录/);
  assert.ok(system.indexOf('## 项目笔记') > system.indexOf('系统内容'), '排在后面');
  // 笔记里提到的路径不在了：索引里标出来
  fs.rmSync(path.join(root, 'zero-platform'), { recursive: true });
  const third = makeCtx({ root });
  assert.match(systemText(third), /游戏放哪.*⚠ 提到的 `zero-platform\/index\.html` 已经不在了，用之前先核对/);
  assert.ok(!systemText(third).includes('`index.html` 已经不在'), '还在的路径不标');
});

test('/memory：列出来、删一条；没有笔记时说清楚', async () => {
  const root = tmpdir();
  const ctx = makeCtx({ root });
  await slash(ctx, '/memory');
  assert.match(ctx.ui.text(), /这个项目里还没有笔记/);
  mem(root).write({ type: 'pitfall', title: '缓存令牌', text: '改了静态资源要换 ?v=' });
  mem(root).write({ type: 'command', title: '测试怎么跑', text: 'npm test' });
  const listed = makeCtx({ root });
  await slash(listed, '/memory');
  assert.match(listed.ui.text(), /\d\. \[坑\] 缓存令牌/);
  assert.match(listed.ui.text(), /\d\. \[命令\] 测试怎么跑/);
  assert.match(listed.ui.text(), /文件在 \.zhiqu\/memory\//);
  const n = /(\d)\. \[坑\] 缓存令牌/.exec(listed.ui.text())[1];
  await slash(listed, `/memory rm ${n}`);
  assert.match(listed.ui.text(), /已删除「缓存令牌」/);
  assert.deepEqual(mem(root).list().map((n) => n.title), ['测试怎么跑']);
  assert.ok(!fs.readFileSync(path.join(root, '.zhiqu', 'memory', 'MEMORY.md'), 'utf8').includes('缓存令牌'), '索引跟着改');
  await slash(listed, '/memory rm 9');
  assert.match(listed.ui.text(), /没有「9」这条笔记/);
});
