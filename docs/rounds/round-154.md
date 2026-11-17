# 第一百五十四轮（2026-11-17）：干活中途补充第 5 步 —— 普通聊天

## 由来

[`docs/steer-plan.md`](../steer-plan.md) 第 5 步。普通聊天（不是代码模式）生成中补的话，只在最终回答动笔之前并一次（第一百三十三轮）。
「帮我改 Wiki」那一段是一个最多 4 轮的工具循环（`WikiToolAgent`，OpenAI / Anthropic 各一份），途中说「标题别动」要等它整个跑完 —— 草稿已经按原来的意思生成了。

## 要做的

- **`WikiToolAgent`**：带一个 `Steer`（`take()` 取走待补的话）的新重载。两个循环每次调模型之前取一次，有就追加一条标明「中途补充」的 user 消息（OpenAI：整批 tool 结果之后；Anthropic：并进最后那条 user 消息，作为文本块）。
  模型这次没调工具、要收尾时有补充 → 不收尾，带上接着调一次（还在 4 轮之内）。
- **`StreamState`**：`takeForTools()` —— 最终回答没动笔、代码 agent 没开口子时取走 `injected`，记进「已读到」。
- **`WikiToolAgentRunner`**：取到的发 `message.steer.delivered`、记一步「你补充」（和代码模式同一种显示）。
- **最终回答**：已读到的照样给模型看（它要按补充来写），但只发一次 `delivered`、同一句不在消息里出现两次。

## 判据

- `WikiToolAgentSteerTest`（OpenAI / Anthropic 各一遍，假模型）：第 1 轮之后补 → 第 2 轮请求里有、在 tool 结果之后；Anthropic 不出现连着两条 user；要收尾时有补充 → 多调一次；没有补充时请求和原来一样。
- `AiServiceImpl` 这一段（`StreamState` 是私有类）：源码判据 + 真跑一遍的那条看情况。扰动各一。

## 结果

普通聊天里「帮我改 / 查 Wiki」那一段途中补的话，下一次调模型就看得到（OpenAI 排在整批工具结果后面；Anthropic 并进 tool_result 那条 user 消息）；模型要收尾时正好补了，就带上补充再调一次。读到的发一次送达、回答里记一步「你补充」；最终回答也按它写，但同一句只出现一次、不再发第二次送达。

## 怎么验

- **`WikiToolAgentSteerTest`** 6 条（OpenAI / Anthropic × 轮与轮之间、要收尾时、没有补充）。
  - 写的时候撞到两处空转：第一版样本句「搜一下」不是 Wiki 工具请求，「没有补充」那条一次模型调用都没有、比的是两份空的也绿了 —— 加了「两次调用」的下限；重新装假模型时 `when(...)` 自己调了一次旧答复，多记一条空请求。
- **`WikiToolAgentRunnerSteerTest`** 2 条（真跑 `WikiToolAgentRunner` + `FinalWriterRunner`，`StreamState` 用反射造，照 `WikiWriterStateTest`）。
- 扰动 10 处见红：OpenAI / Anthropic 轮间不取、要收尾时不看（两份）、Anthropic 另起一条 user、`takeForTools` 不取、最终回答不带已读到的、不发送达、不记步骤、取了不清（最终回答里出现两次）。
- **全量**：后端 1550 条，只差 `ClaudeMdTest` 的登记行（这一行）。命令行和评测工具这一轮没改，用的是第一百五十三轮的结果。

## 部署

- 桌面应用 **1.5.5**（第一百五十三、一百五十四轮的外壳 + 宿主）：`bash deploy/desktop/package-macos-native.sh 1.5.5`，签名校验过，包里的宿主和仓库里的源码逐个文件一样，新外壳的提示文字在二进制里。
  sha256 `e97ed5c2eb14b64ea0486fb857d57b89c99d031c966cd296934dd4656e430185`。
- 服务器、下载目录：见下面「部署结果」。
