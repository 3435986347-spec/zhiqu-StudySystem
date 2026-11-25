# 第一百七十八轮（2026-11-26）：直连也把思考档位发出去

`docs/harness-next-plan.md` 第 1 步。用户同日定了后面几步的取舍（花钱跑思考对照、shell 改动计入第 3 回根因、本会话的本机端口可以预览、没有可观测标准不能判达成、第 8 和第 9 步也可以花钱，模型用 deepseek-flash）。密钥不进仓库。这一轮只做第 1 步。

## 计划

直连的 `openaiBody` 只送 model、messages、tools、max_tokens。用户选了 `--effort`，请求里的 `reasoning` 被丢掉；这一轮的思考也不挂回 `done` 的 message，下一轮没有 `reasoning_content`。DeepSeek 开着思考、带工具时缺了这个字段会 400。

按网关同一张表发（`ReasoningEffort` / `applyOpenAiReasoningOptions` / `applyAnthropicThinking`），不另写一套词：

- 没选档位：什么都不加。直连没有服务端默认可听。
- `instant`：DeepSeek（名字里没有 reasoner）发 `thinking: { type: disabled }`，不回传思考原文。
- 开着：DeepSeek 发 `thinking: enabled` 加 `reasoning_effort`（medium → low，high 和 extra → high，max → max），每条助手消息都带 `reasoning_content`，不是这个模型想的给空串。
- OpenAI 的 o1/o3/o4 和 gpt-5 起，以及走 OpenAI 兼容的 Claude：只发 `reasoning_effort`（extra → xhigh；这些模型的 max → xhigh，其余 max → max）。
- Anthropic 协议：claude-2 / claude-3 用 `thinking.budget_tokens`，其余 `thinking: adaptive` 加 `output_config.effort`。思考块只回给想出它的那个模型。
- 供应商用 400/422 拒绝思考参数：去掉再试一次，并记住，下次不再先撞。

## 怎么验

`zhiqu-cli/test/direct.test.js` 加四条：档位对照、没选不加、Anthropic 两代和换模型不回放、done 回环加上拒绝后记住。先写判据再改实现，四条都是断言失败。实现之后把 `type: 'enabled'` 改成 `on`，那条对照再红，然后改回。

## 结果

- 扰动 1 处见红（`enabled` → `on`），已改回。
- CLI 全量 782 项：759 过 / 23 跳。整包里「被中断：退出码 130」一次是 null（800ms 后发 SIGINT，进程还没起来），单独再跑过。和直连无关。
- 没调付费模型。默认档位仍关。第 2 步的对照还没跑。
