# 第一百八十五轮（2026-11-26）：网页宿主没传思考档位不再改成 instant

`docs/harness-next-plan.md` 第 7 步。

## 计划

页面提交代码模式时已经带 `effort`（`ai-assistant.js`）。宿主在没收到这个字段时，原来一律写成 `instant`。这一轮改成：传来的档位照用；认不出的值不改写成 `instant`；服务器上的宿主不读这台机器的配置；桌面本机没传时读用户配置里的档位。

skills 只在桌面本机、而且选了项目目录时加载（项目、用户、内置，和命令行同一份）。产物空间和服务器宿主保持空，不从别的目录找。子 agent 不接。

## 结果

`effort.test.js` 里「没传是 instant」先改成断言，把实现改回 instant 时断言失败（Failures，不是 Errors）；`hostSkills` 固定返回空数组时，「项目 skill」那条也失败。改回之后这条和 `code-host.test.js` 里不依赖 git 的用例通过。`/review` 那几条在沙箱里 `git init` 写不了 hooks，和这一轮无关。
