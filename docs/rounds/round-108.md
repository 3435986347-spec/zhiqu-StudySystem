# 第一百零八轮（2026-11-07）：Codex 同级第 1 步 —— 思考档位

## 由来
用户 2026-11-07：「把这个agent优化到市面上的codex相同级别的」。方案在 [`docs/codex-parity-plan.md`](../codex-parity-plan.md)。做到一半用户又说：「同时把深度思考的按钮换成思考档位切换（instant-medium-high-extra-max）同样还是点击之后上方拉出页面点击切换」。

读代码时发现：命令行所有请求写死 `thinking: disabled`（第十二轮用户说 v4-pro「一直在思考循环」关的，之后没量过）；DeepSeek 官方给 Codex 的配置是 `model_reasoning_effort = "high"`。第九十八轮的失败多数是「修法判断不对」。同一个模型，两边跑的不是一回事。

## 计划
1. 档位用用户定的名字 instant / medium / high / extra / max：`--effort`、`/effort`、`settings.effort`；不给就用服务端默认（`app.ai.harness-reasoning`，**默认还是关，量过再改**）。网页的「深度思考」按钮换成同样五档，点了向上拉起面板，和工作区档位一个样子。
2. 网关照档位发：DeepSeek `thinking: enabled` + `reasoning_effort`；OpenAI 系 `reasoning_effort`；Anthropic `output_config.effort` + `thinking: adaptive`。
3. 回传：DeepSeek 带工具时之前每一轮的 `reasoning_content` 都要传回，缺了 400；关着档位时生成的旧消息补空串。Claude 的思考块（带签名）原样回放（原来是丢的）。换了模型不回放。别的供应商不见这些字段。
4. 不收就降：参数被拒就关掉重试并记住这个模型；回放被拒（历史被改过、签名失效）就去掉回放重试。思考占输出上限：开着时上限翻倍（窗口允许的话）。
5. 终端显示「思考中」，不把思考打出来。网页代码模式听网页选的档位。
6. 判据先红；假模型真 HTTP。评测工具能开思考跑，等用户点头跑真模型对比。

## 结果
**做完了什么**
- 五档一个出处：`ReasoningEffort`（各家的词都在这）。DeepSeek 只有 low / high / max 三个词，所以 medium → low、high 和 extra → high、max → max；Claude 用 `output_config.effort`，老模型用 `budget_tokens`。
- 命令行：`--effort`、`/effort`（选了立刻生效、记进用户设置，坏值不改）；没选就不说，听服务端。思考不打进终端，只显示「思考中 N」。
- 网关：`ReasoningHistory` 管回传和那三个只有网关认识的字段；思考算进窗口估算；不收就降、记住。
- 网页：按钮换成五档面板（面板只写名字，说明在悬停提示）；老的「深度思考开着」接着算 high；代码模式听网页选的档位（`CodeWorkspaceAgent` → `JsCodeAgent` → 宿主）。

**做的时候查出来的错**
- 原来判断「模型支不支持深度思考」比错了对象（拿 provider 对象比字符串），`deepseek-v4-pro` 被当成不支持，选了就整个请求报错。逻辑挪进 `ReasoningEffort.supported`；模型不能思考时当 instant 发，不再报错。
- 命令行的上下文估算没算思考内容（说是和服务端同一个算法，服务端算了）：开着思考时压缩来得太晚，最后由服务端按轮丢。`compact.js` 补上。
- 评测代理：网关开思考会把输出上限翻倍，代理看到 `start` 的上限比请求的大，当成违规**停掉整场**；一次超过 16384 的回答也会停。加 `outputReservationTokens`（只有 16384 / 32768 两个值，说了才进账本的 init，老账本照样对得上）。如果直接开跑，第一个请求就白花了。
- `Rig` 那几条判据 mock 的是不带档位的重载，改了调用之后就红了：改成带档位的，并加一条档位传到循环。
- 真浏览器 375 宽：思考档位写着名字比原来的图标宽，模型名被挤到只剩一个字，发送键还压着它；面板也有出屏幕的可能。手机上换两行、面板向左展开。
- 我自己的判据：`effort.test.js` 第一版「思考不打进终端」断言了一个永远是空的数组，看了什么都绿。扰动发现后改成看真实输出、再加一条正向断言。
- 扰动 79 处：第一批 54 处红 53，绿的那处（发给 Anthropic 的内部字段）是 `AnthropicFormat` 按字段挑、替它挡了，补了一条只有它能照出来的样本。第二批 21 处、估算 2 处、手机样式 2 处全红。

**真跑过的**（假模型按 DeepSeek 文档的规矩回：开思考带工具缺 `reasoning_content` 就 400）
| 入口 | 档位 | 模型收到 |
|---|---|---|
| 命令行，经真网关 | instant / 不选 | `disabled`，无 effort，16384 |
| | medium | `enabled`，`low`，32000 |
| | high / extra | `enabled`，`high`，32000 |
| | max | `enabled`，`max`，32000 |
| 网页代码模式 | high | `enabled`，`high`，32000；上一轮是关着档位生成的，补了空串，没有 400 |
| 网页代码模式 | instant | `disabled`，16384 |

两轮都带工具，第二轮收到了第一轮想的原文；`reasoning_model` / `reasoning_blocks` 没有发给供应商。网页里用真鼠标点过：面板在按钮正上方、当前档标出来、选了收起、和工作区档位互相关掉、Esc 收起、刷新后还在。

判据：后端全量 1327（1 跳过写明原因）、命令行 306/306、评测工具 102 过 1 跳。

**还没做的**
- **没有用真模型跑过。** 上面都是假模型。默认值还是关：第十二、五十四轮关思考的理由（慢、空转）是真的，要量（第九十八轮的四题三遍当基线，5/12）。要用户点头花钱；开的办法写在 `docs/notes/cli.md`。
- 改了 AI 助手的输入框，首页轮播的截图要重出（要开窗口，先问用户）。
