// 本地工具：读过才能改、只读一部分不许整份重写、替换要唯一、确认期间被改过不写、新建目录说清楚、截断要说出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { LocalTools } from '../src/tools/local.js';
import { resolveOnPath } from '../src/tools/exec.js';
import { tmpdir, write } from './helpers.js';

function tools() {
  const root = tmpdir();
  return { root, t: new LocalTools({ root }) };
}

test('没读过不许改已存在的文件；新建不用先读，并报出要新建的目录', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'old\n');
  assert.match(t.prepareWrite({ path: 'a.js', content: 'new\n' }).error, /必须先 read_file/);
  const prep = t.prepareWrite({ path: 'game/assets/x.js', content: 'hi\n' });
  assert.equal(prep.kind, 'create');
  assert.deepEqual(prep.newDirectories, ['game', 'game/assets']);
  assert.match(t.commitWrite(prep).content, /已新建 game\/assets\/x\.js，连同新建目录 game、game\/assets/);
  assert.equal(fs.readFileSync(path.join(root, 'game/assets/x.js'), 'utf8'), 'hi\n');
});

test('读过之后被别人改了：拒绝，要求重读', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'v1\n');
  t.readFile({ path: 'a.js' });
  write(root, 'a.js', 'v2（用户在编辑器里改的）\n');
  assert.match(t.prepareWrite({ path: 'a.js', content: 'v3\n' }).error, /读过之后被改过了/);
});

test('只读了一部分：不许整份重写（会冲掉没读到的部分），替换用法可以', () => {
  const { root, t } = tools();
  write(root, 'long.js', Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const r = t.readFile({ path: 'long.js' });
  assert.match(r.content, /没读完，用 offset=2001 接着读/);
  assert.match(t.prepareWrite({ path: 'long.js', content: 'x' }).error, /只读了一部分/);
  const rep = t.prepareWrite({ path: 'long.js', old_string: 'line 42\n', new_string: 'LINE 42\n' });
  assert.equal(rep.kind, 'replace');
  t.commitWrite(rep);
  assert.match(fs.readFileSync(path.join(root, 'long.js'), 'utf8'), /\nLINE 42\nline 43\n/);
});

test('替换：没找到、出现不止一次都拒；追加接在末尾', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'x = 1\nx = 1\ny = 2\n');
  t.readFile({ path: 'a.js' });
  assert.match(t.prepareWrite({ path: 'a.js', old_string: 'z', new_string: 'q' }).error, /没找到/);
  assert.match(t.prepareWrite({ path: 'a.js', old_string: 'x = 1', new_string: 'x = 3' }).error, /出现了 2 处（第 1、2 行）/);
  const ap = t.prepareWrite({ path: 'a.js', content: 'z = 3\n', append: true });
  assert.equal(ap.kind, 'append');
  t.commitWrite(ap);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'x = 1\nx = 1\ny = 2\nz = 3\n');
  // 自己刚写过的文件，接着追加不用再读
  const again = t.prepareWrite({ path: 'a.js', content: 'w = 4\n', append: true });
  assert.ok(!again.error, again.error);
});

test('替换：只给 old_string、没给 new_string —— 拒绝，文件一个字不动；新旧一样也拒；明写 new_string 为空才是删（第八十六轮：pytest-5840 原来被一声不响删了 32 行）', () => {
  const { root, t } = tools();
  const src = 'def a():\n    return 1\n\ndef b():\n    return 2\n';
  write(root, 'm.py', src);
  t.readFile({ path: 'm.py' });
  // 照评测记录里模型发的样子：替换后的文字放进了 content，没有 new_string
  const r = t.prepareWrite({ path: 'm.py', old_string: 'def a():\n    return 1\n', content: 'def a():\n    return 10\n' });
  assert.ok(r.error, `应当拒绝，却准备写成：${JSON.stringify(r.newText)}`);
  assert.match(r.error, /old_string 和 content 不能一起给/);
  assert.match(r.error, /content 只用于整份写入/);
  // 三项全给（new_string 也合法）：分不清要整份写还是替换 —— 只有「不能一起给」这道关拦得住（缺 new_string 那道管不到）
  const all = t.prepareWrite({ path: 'm.py', old_string: 'return 1', new_string: 'return 10', content: 'def a():\n    return 10\n' });
  assert.ok(all.error, `三项全给应当拒绝，却准备写成：${JSON.stringify(all.newText)}`);
  assert.match(all.error, /不能一起给/);
  const only = t.prepareWrite({ path: 'm.py', old_string: 'def a():\n    return 1\n' });
  assert.ok(only.error, `只给 old_string 应当拒绝，却准备写成：${JSON.stringify(only.newText)}`);
  assert.match(only.error, /new_string: ""/);
  const same = t.prepareWrite({ path: 'm.py', old_string: 'return 1', new_string: 'return 1' });
  assert.ok(same.error, '新旧一样应当拒绝（原来回「已修改 +0 -0」，模型以为改上了）');
  assert.match(same.error, /什么都没改/);
  assert.equal(fs.readFileSync(path.join(root, 'm.py'), 'utf8'), src);
  const del = t.prepareWrite({ path: 'm.py', old_string: '\ndef b():\n    return 2\n', new_string: '' });
  assert.equal(del.kind, 'replace');
  t.commitWrite(del);
  assert.equal(fs.readFileSync(path.join(root, 'm.py'), 'utf8'), 'def a():\n    return 1\n');
});

test('Python 项目常见的 .rst / .pyi / MANIFEST.in 能读能写；列目录时读不了的不再一律说「可能含密钥」、拒绝时说清去哪加（第八十六轮：pytest-10356 在 .rst 上白花约 10 轮）', () => {
  const { root, t } = tools();
  write(root, 'changelog/10150.bugfix.rst', 'Fixed.\n');
  write(root, 'pkg/__init__.pyi', 'x: int\n');
  write(root, 'MANIFEST.in', 'include README.rst\n');
  write(root, 'cert.pem', 'x');
  for (const f of ['changelog/10150.bugfix.rst', 'pkg/__init__.pyi', 'MANIFEST.in']) assert.ok(!t.readFile({ path: f }).error, f);
  assert.equal(t.prepareWrite({ path: 'changelog/10356.bugfix.rst', content: 'Fix MRO.\n' }).kind, 'create');
  const list = t.listFiles({ depth: 2 }).content;
  assert.ok(!list.includes('可能含密钥'), list);
  assert.match(list, /cert\.pem {2}（这类文件读不了：不在能读的清单里）/);
  assert.match(t.readFile({ path: 'cert.pem' }).error, /\.zhiqu\/settings\.json 的 extensions/);
});

test('确认期间文件被改过：commit 不写（用户在编辑器里的改动不能被旧草稿覆盖）', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'v1\n');
  t.readFile({ path: 'a.js' });
  const prep = t.prepareWrite({ path: 'a.js', content: 'mine\n' });
  write(root, 'a.js', 'theirs\n');
  assert.match(t.commitWrite(prep).error, /确认期间被改过了/);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'theirs\n');
});

test('新建的文件在确认期间被别人先建了：同样不写（新建和覆盖是两件事）', () => {
  const { root, t } = tools();
  const prep = t.prepareWrite({ path: 'n.js', content: 'mine\n' });
  write(root, 'n.js', 'theirs\n');
  assert.ok(t.commitWrite(prep).error);
  assert.equal(fs.readFileSync(path.join(root, 'n.js'), 'utf8'), 'theirs\n');
});

test('列目录：略过 node_modules / .git / .zhiqu，密钥类文件标成读不了，软链不跟随，超过 500 条要说出来', () => {
  const { root, t } = tools();
  write(root, 'node_modules/x/index.js', '');
  write(root, '.env', 'SECRET=1');
  write(root, 'src/a.js', '1');
  fs.symlinkSync('/etc', path.join(root, 'etc-link'));
  const r = t.listFiles({});
  assert.match(r.content, /node_modules\/ （略过）/);
  assert.match(r.content, /\.env {2}（这类文件读不了/);
  assert.match(r.content, /etc-link → （软链，不跟随）/);
  assert.ok(!r.content.includes('index.js'));
  for (let i = 0; i < 520; i++) write(root, `many/f${i}.txt`, '');
  assert.match(t.listFiles({ path: 'many', depth: 1 }).content, /只列出了前 500 个 —— 这不是全部/);
});

test('搜索：字面量（不是正则）、跳过读不了的文件、命中太多要说出来', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'const re = /(a+)+b/;\n');
  write(root, '.env', 'TOKEN=(a+)+b');
  const r = t.search({ query: '(a+)+b' });
  assert.match(r.content, /a\.js:1:/);
  assert.ok(!r.content.includes('.env'), '密钥文件不该被搜进来');
  write(root, 'many.txt', 'hit\n'.repeat(200));
  assert.match(t.search({ query: 'hit' }).content, /只列出了前 80 条 —— 这不是全部/);
});

test('运行：规则在起进程之前判（不在清单里、参数不是数组、工作目录跳出去）', () => {
  const { t } = tools();
  assert.match(t.prepareRun({ command: 'bash', args: ['x.sh'] }).error, /不在允许清单里/);
  assert.match(t.prepareRun({ command: 'node', args: 'a.js b.js' }).error, /必须是数组/);
  assert.match(t.prepareRun({ command: 'node', args: ['a.js'], cwd: '../' }).error, /工作目录不可用/);
});

test('删除：没看过的不许删；看过的删掉是挪进 .zhiqu/trash/，内容原样、能恢复', () => {
  const { root, t } = tools();
  write(root, 'check.js', 'console.log(1)\n');
  assert.match(t.prepareDelete({ path: 'check.js' }).error, /必须先 read_file 看过/);
  t.readFile({ path: 'check.js' });
  const prep = t.prepareDelete({ path: 'check.js' });
  assert.equal(prep.rel, 'check.js');
  assert.equal(prep.lines, 1);
  const r = t.commitDelete(prep);
  assert.ok(!fs.existsSync(path.join(root, 'check.js')), '原处还在');
  assert.match(r.trashed, /^\.zhiqu\/trash\/[^/]+\/check\.js$/);
  assert.equal(fs.readFileSync(path.join(root, r.trashed), 'utf8'), 'console.log(1)\n', '挪进回收站的内容要原样');
  assert.match(r.content, /已删除 check\.js（挪进了 \.zhiqu\/trash\/.*要恢复/);
  assert.match(t.prepareDelete({ path: 'check.js' }).error, /不存在/);
});

test('删除：自己这段会话写的文件可以删；读过之后被改了、确认期间被改了都不删', () => {
  const { root, t } = tools();
  const w = t.prepareWrite({ path: 'tmp/probe.js', content: 'x\n' });
  t.commitWrite(w);
  assert.ok(!t.prepareDelete({ path: 'tmp/probe.js' }).error, '自己写的不用再读一遍');

  write(root, 'a.js', 'v1\n');
  t.readFile({ path: 'a.js' });
  write(root, 'a.js', 'v2 用户在编辑器里改的\n');
  assert.match(t.prepareDelete({ path: 'a.js' }).error, /读过之后被改过/);

  t.readFile({ path: 'a.js' });
  const prep = t.prepareDelete({ path: 'a.js' });
  write(root, 'a.js', 'v3 确认期间又改了\n');
  assert.match(t.commitDelete(prep).error, /确认期间被改过了，没有删除/);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'v3 确认期间又改了\n');
});

test('删除：目录、工作区外、软链、.git / .zhiqu 里的、密钥类文件，一律不删', () => {
  const { root, t } = tools();
  fs.mkdirSync(path.join(root, 'src'));
  write(root, '.git/config.json', '{}');
  write(root, '.zhiqu/settings.json', '{}');
  write(root, '.env', 'KEY=1');
  const outside = tmpdir();
  write(outside, 'x.js', 'x');
  fs.symlinkSync(path.join(outside, 'x.js'), path.join(root, 'link.js'));
  for (const p of ['src', '../x.js', path.join(outside, 'x.js'), 'link.js', '.git/config.json', '.zhiqu/settings.json', '.env']) {
    const r = t.prepareDelete({ path: p });
    assert.ok(r.error, `${p} 不该能删`);
  }
  assert.ok(fs.existsSync(path.join(root, 'src')) && fs.existsSync(path.join(root, '.zhiqu/settings.json')));
  // .git / .zhiqu 那一道要单独见红：先读过，「没看过不许删」就替它挡不住了
  for (const p of ['.git/config.json', '.zhiqu/settings.json']) {
    assert.ok(!t.readFile({ path: p }).error, `${p} 应当读得到（这条判据要的是「读过也不许删」）`);
    assert.match(t.prepareDelete({ path: p }).error, /不能由你来删/, p);
  }
});

test('run_command 跑 rm：照样拒绝，并指到 delete_file', () => {
  const { t } = tools();
  assert.match(t.prepareRun({ command: 'rm', args: ['check.js'] }).error, /delete_file/);
  assert.ok(!/delete_file/.test(t.prepareRun({ command: 'curl', args: ['x'] }).error || ''), '别的命令不该提删除');
});

test('.zhiqu（命令行自己的配置）与 .git：模型写不了 —— 不然它能给自己加命令、挂 MCP 服务器、改自己的系统内容', () => {
  const { root, t } = tools();
  write(root, '.zhiqu/settings.json', '{}');
  for (const p of ['.zhiqu/settings.json', '.zhiqu/mcp.json', '.zhiqu/system.md', '.zhiqu/skills/x/SKILL.md',
    './.zhiqu/settings.json', 'src/../.zhiqu/mcp.json', '.ZHIQU/settings.json', '.git/hooks/pre-push.js']) {
    const r = t.prepareWrite({ path: p, content: '{"allowedCommands":["bash"]}' });
    assert.match(r.error || '', /不能由你来改/, `${p} 居然能写`);
  }
  assert.match(t.prepareWrite({ path: '.zhiqu/settings.json', content: 'x' }).error, /告诉用户，让用户自己改/);
  assert.ok(!t.prepareWrite({ path: 'src/zhiqu-notes.md', content: 'x' }).error, '普通文件照样能写');

  // .zhiqu 还不存在时：macOS 的文件系统不分大小写，建出来的 .ZHIQU/mcp.json 之后就是命令行读的 .zhiqu/mcp.json
  const fresh = tools();
  assert.match(fresh.t.prepareWrite({ path: '.ZHIQU/mcp.json', content: '{}' }).error || '', /不能由你来改/);
});

test('.zhiqu 的保护绕不过：目录软链（cfg -> .zhiqu）也拦住', () => {
  const { root, t } = tools();
  write(root, '.zhiqu/settings.json', '{}');
  fs.symlinkSync(path.join(root, '.zhiqu'), path.join(root, 'cfg'));
  assert.match(t.prepareWrite({ path: 'cfg/settings.json', content: '{}' }).error || '', /不能由你来改/);
  t.readFile({ path: 'cfg/settings.json' });
  assert.match(t.prepareDelete({ path: 'cfg/settings.json' }).error || '', /不能由你来删/);
});

// 第六十九轮：开头 / 结尾的空行在 read_file 的输出里看不出来（第一行空着和标题下面那一行一个样）——
// HumanEval 8 题失败里 6 题是整份重写时「开头的空行没了」。标题里要说出来，不然模型没法照原样保留
test('read_file：开头 / 结尾有空行时标题里说出来（不然看不出来，整份重写就丢了）', () => {
  const { root, t } = tools();
  write(root, 'solution.py', '\ndef unique(l):\n    """doc"""\n');
  const r = t.readFile({ path: 'solution.py' });
  assert.match(r.content, /^【solution\.py，共 3 行；开头第 1 行是空行】\n\ndef unique/, r.content);
  write(root, 'two.py', '\n\nx = 1\n');
  assert.match(t.readFile({ path: 'two.py' }).content, /^【two\.py，共 3 行；开头 2 行是空行】/);
  write(root, 'tail.md', '# t\n\n\n');
  assert.match(t.readFile({ path: 'tail.md' }).content, /^【tail\.md，共 3 行；最后 2 行是空行】/);
  write(root, 'plain.js', 'a\nb\n');
  assert.match(t.readFile({ path: 'plain.js' }).content, /^【plain\.js，共 2 行】\n/, '没有空行就不说');
  write(root, 'mid.js', 'a\n\nb\n');
  assert.match(t.readFile({ path: 'mid.js' }).content, /^【mid\.js，共 3 行】\n/, '中间的空行看得见，不说');
});

test('read_file：只读中间一段时，开头那条不说（第 1 行不在这段里）；读到结尾时照样说结尾的空行', () => {
  const { root, t } = tools();
  write(root, 'big.txt', '\n' + Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n\n');
  const mid = t.readFile({ path: 'big.txt', offset: 5, limit: 3 }).content;
  assert.match(mid, /^【big\.txt 第 5–7 行（共 32 行）；没读完，用 offset=8 接着读】/, mid);
  const end = t.readFile({ path: 'big.txt', offset: 30 }).content;
  assert.match(end, /^【big\.txt 第 30–32 行（共 32 行）；最后一行是空行】/, end);
});

// 第八十七轮（用户 2026-10-31：「还有第二、第三点也都能用」）：命令行放开行内代码和 git 的只读子命令
test('运行：行内代码放开（python3 -c、node -e —— 整条命令照样摆在终端里），git 只认 status / diff / log', () => {
  const { t } = tools();
  for (const [command, args] of [['node', ['-e', 'console.log(1)']], ['python3', ['-c', 'print(1)']], ['node', ['-pe', '1+1']], ['python3', ['-Bc', 'print(1)']]]) {
    const prep = t.prepareRun({ command, args });
    if (prep.error && /找不到命令/.test(prep.error)) continue;   // 这台机器上没装的跳过（规则在找命令之前判）
    assert.equal(prep.error, undefined, `${command} ${args.join(' ')}：${prep.error}`);
  }
  assert.ok(t.commands.includes('git'), '默认清单里没有 git');
  for (const sub of ['status', 'diff', 'log']) assert.equal(t.prepareRun({ command: 'git', args: [sub] }).error, undefined, 'git ' + sub);
  const refused = [
    [['push'], /只能跑 git 的 status \/ diff \/ log/], [['stash'], /只能跑/], [['checkout', '.'], /只能跑/], [[], /只能跑/],
    [['-c', 'core.pager=x', 'log'], /只能跑/], [['-C', 'sub', 'status'], /只能跑/], [['--git-dir=x', 'status'], /只能跑/],
    [['diff', '--output=patch.txt'], /--output/], [['diff', '--output', 'patch.txt'], /--output/], [['log', '--ext-diff'], /--ext-diff/],
    [['diff', '--textconv'], /--textconv/], [['log', '--show-signature'], /--show-signature/],
    [['diff', '/etc/passwd'], /绝对路径/], [['log', '../x'], /跳出工作区/],
  ];
  for (const [args, re] of refused) assert.match(t.prepareRun({ command: 'git', args }).error || '（没拒）', re, 'git ' + args.join(' '));
  assert.equal(t.prepareRun({ command: 'git', args: ['diff', '--output-indicator-new=+'] }).error, undefined, '--output-indicator-new 是正经参数');
  assert.match(t.prepareRun({ command: 'npm', args: ['exec', 'x'] }).error, /下载并运行别人的包/, 'npm exec 照旧拒');
});

test('git 真的跑：工作区里带的 .gitconfig、.gitattributes 叫不起别的程序（fsmonitor / clean 过滤器 / 外部 diff）；status / diff / log 照常出结果', async (ctx) => {
  if (!resolveOnPath('git')) return ctx.skip('这台机器上没有 git');
  const { root, t } = tools();
  const git = (...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', '-c', 'core.fsmonitor=false', ...a], { cwd: root, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } });
  git('init', '-q', '.');
  write(root, 'f.txt', 'a\n');
  write(root, 'g.txt', 'same\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  // 子进程的 HOME 是工作区：克隆下来的仓库里放一个 .gitconfig，git 就当成全局配置读（第八十七轮在这台机器上试出来的：status 叫起 fsmonitor，diff 叫起 clean 过滤器和外部 diff）
  const evil = path.join(root, 'evil.sh');
  fs.writeFileSync(evil, '#!/bin/sh\necho x >> "$(dirname "$0")/MARK-$1"\n[ "$1" = clean ] && cat\nexit 0\n', { mode: 0o755 });
  write(root, '.gitconfig', `[core]\n\tfsmonitor = ${evil} fsmon\n\tpager = ${evil} pager\n[diff]\n\texternal = ${evil} extdiff\n[filter "x"]\n\tclean = ${evil} clean\n\tsmudge = cat\n`);
  write(root, '.gitattributes', '*.txt filter=x diff=t\n');
  // 仓库自己的 .git/config 里的 fsmonitor、外部 diff、textconv：靠真正跑时加的参数关掉（环境隔离管不到这一份）
  git('config', 'core.fsmonitor', `${evil} lfsmon`);
  git('config', 'diff.external', `${evil} lextdiff`);
  git('config', 'diff.t.textconv', `${evil} ltextconv`);
  // 带签名的提交 + log.showSignature：git log 会叫 gpg.program 去验（签名是假的，叫起来就算）
  const tree = git('rev-parse', 'HEAD^{tree}').toString().trim(), parent = git('rev-parse', 'HEAD').toString().trim();
  const signed = `tree ${tree}\nparent ${parent}\nauthor t <a@b> 1700000000 +0000\ncommitter t <a@b> 1700000000 +0000\n`
    + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----\n\nsigned\n';
  const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: root, input: signed }).toString().trim();
  git('update-ref', 'HEAD', sha);
  git('config', 'log.showSignature', 'true');
  git('config', 'gpg.program', `${evil}`);
  write(root, 'f.txt', 'a\nb\n');
  fs.utimesSync(path.join(root, 'g.txt'), new Date(2030, 0, 1), new Date(2030, 0, 1));   // 内容没变、时间变了：status 想顺手把新时间写回 .git/index
  const index = fs.readFileSync(path.join(root, '.git', 'index'));
  const outputs = {};
  for (const args of [['status'], ['diff'], ['log', '-p', '-1']]) {
    const prep = t.prepareRun({ command: 'git', args });
    assert.equal(prep.error, undefined);
    const r = await t.commitRun(prep);
    outputs[args[0]] = r;
    assert.equal(r.exitCode, 0, `git ${args.join(' ')}：${r.output}`);
    // status 不顺手重写 .git/index（GIT_OPTIONAL_LOCKS）；git diff 自己会刷新 index 里的时间戳（内容不动，git 的老规矩，管不到）
    if (args[0] === 'status') assert.ok(fs.readFileSync(path.join(root, '.git', 'index')).equals(index), 'git status 重写了 .git/index（不是只读）');
  }
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('MARK-')), [], '工作区里的配置叫起了别的程序');
  assert.match(outputs.status.output, /f\.txt/);
  assert.match(outputs.diff.output, /\+b/);
  assert.match(outputs.log.output, /signed/);
  assert.match(outputs.status.content, /^\$ git status\n/, '终端里摆出来的是模型给的那条命令');
});

// 第八十八轮：评测里模型三次把工作区根（/work/base_repo）当 cwd 传进来，被当成「超出工作区」拒掉
test('工作区里面的绝对路径照收（文件、目录、cwd、工作区根本身）；外面的、软链跳出去的照旧拒', () => {
  const { root, t } = tools();
  write(root, 'src/a.js', 'x\n');
  const abs = (rel) => path.join(root, rel);
  assert.match(t.readFile({ path: abs('src/a.js') }).content, /x/);
  assert.equal(t.prepareWrite({ path: abs('src/a.js'), old_string: 'x', new_string: 'y' }).rel, 'src/a.js');
  assert.match(t.listFiles({ path: abs('src') }).content, /a\.js/);
  assert.match(t.search({ query: 'x', path: abs('src') }).content, /a\.js:1/);
  assert.equal(t.prepareRun({ command: 'node', args: ['-e', '1'], cwd: root }).cwdRel, '.');
  assert.equal(t.prepareRun({ command: 'node', args: ['-e', '1'], cwd: abs('src') }).cwdRel, 'src');
  assert.equal(t.prepareDelete({ path: abs('src/a.js') }).rel, 'src/a.js');
  // 外面
  assert.match(t.readFile({ path: '/etc/hosts' }).error, /超出了工作区范围/);
  assert.match(t.prepareRun({ command: 'node', args: ['-e', '1'], cwd: path.dirname(root) }).error, /工作目录不可用/);
  const sibling = root + '-sibling/x.js';
  assert.ok(t.readFile({ path: sibling }).error.includes(sibling), '前缀相同的兄弟目录不算在里面：照旧拒，报错里是模型给的那条原路径');
  // 根是经过软链给的（macOS 上 /tmp 就是 /private/tmp）：按给的写法传绝对路径也认
  const viaLink = path.join(tmpdir(), 'ws-link');
  fs.symlinkSync(root, viaLink);
  const linked = new LocalTools({ root: viaLink });
  assert.match(linked.readFile({ path: path.join(viaLink, 'src/a.js') }).content, /x/);
  // 软链跳出去：换成相对路径以后照样由原来的检查拦
  const outside = tmpdir();
  write(outside, 'secret.js', 's\n');
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.ok(t.readFile({ path: abs('link/secret.js') }).error, '工作区里的软链指到外面：照旧拒');
});
