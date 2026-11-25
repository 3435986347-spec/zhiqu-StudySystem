# 第一百八十二轮（2026-11-26）：改了测试文件就由 harness 跑那一条

`docs/harness-next-plan.md` 第 4 步。模型说验证过了，隐藏测试仍挂。提示句已经量过，不改变通过率。

## 计划

这一轮改过的 `*.test.js` 最多 3 个时，收尾前由 harness 跑 `node --test` 这几个文件，把退出码和输出尾部写进上下文，模型接着看。超过 3 个、或是 `npm test` / `mvn test`，不猜。验收标准里单独写了一行 `node --test 某.test.js` 也认。没有系统沙箱就不跑。只跑一次。

## 结果

`test/evidence.test.js` 钉着认哪些、不认哪些。
