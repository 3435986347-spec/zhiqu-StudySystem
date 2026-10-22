// 这几份判据模拟的是真终端（xterm 一类，test/vt.js 逐字节回放）：TERM 不能跟着跑测试的那个 shell 走。
// TERM=dumb 时 Node 的 readline 换成一个简易编辑器 —— 不重画输入行、不认方向键 —— 测的就不是用户的终端了。
// 第六十九轮：公司电脑的 shell 是 TERM=dumb，interrupt / live-input / narrow-terminal / slash-menu 这 15 条从第五十九轮起一直红。
// 命令行在 TERM=dumb 下怎么说，见 dumb-terminal.test.js。
process.env.TERM = 'xterm-256color';
