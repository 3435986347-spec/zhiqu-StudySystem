# 第九十三轮（2026-11-02）：按缓存命中价记账 —— 网关把缓存命中数传出来，命令行、用量记录、评测账本都认它

## 由来
用户 2026-10-31 定的顺序里的第三件：「按缓存命中价记账」。第八十九轮锐评第 4 节：每一轮重发整段对话，供应商的前缀缓存其实命中了大半，
但网关不传缓存命中数，评测代理的账本全按未命中价算 —— 保守口径比真实账单高几倍，预算上限按它卡，十题一次就「花掉」¥30。

## 摸底（DeepSeek 文档，2026-11-02 查的）
- 价格（api-docs.deepseek.com「模型 & 价格」，元 / 百万 token）：deepseek-v4-pro 高峰时段 输入缓存命中 0.30、未命中 9.0、输出 27.0；空闲时段减半。
  评测账本用的 9 / 27 就是高峰时段的未命中价和输出价。
- 用量字段（「对话补全」接口）：`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`（两者之和 = `prompt_tokens`），`prompt_tokens_details.cached_tokens` 和命中数相同；
  流式时最后一块带整个请求的 usage。
- Anthropic 的 `input_tokens` 不含缓存读写，命中数在 `cache_read_input_tokens`、写缓存在 `cache_creation_input_tokens`（现在的累加器只认 `input_tokens`，有缓存时把输入算少了）。

## 计划
1. 累加器（`ToolStreamAccumulator`）认缓存命中数：OpenAI 兼容认 `prompt_cache_hit_tokens`，没有就认 `prompt_tokens_details.cached_tokens`；Anthropic 认 `cache_read_input_tokens`，
   并且输入总数 = `input_tokens` + 缓存读 + 缓存写（和 OpenAI 兼容那边「prompt_tokens 是全部输入」同一个口径）。
2. 网关：`done` 的 usage 多一个 `cachedTokens`（供应商不报就不给）；`harness_usage` 多一列可空的 `cached_tokens`（V46，只做加法）；`/api/harness/usage` 的今天合计带上它。
3. 命令行：会话用量记命中数，`/usage` 说「输入 X（缓存命中 Y，Z%）」。
4. 评测代理（`repository-broker.mjs`）：预留照旧按未命中价（还不知道会不会命中，保守）；结算按命中价 —— 命中的部分每 10 个 token 3 微元（¥0.30 / 百万），向上取整，
   新账本的 init 里记下这个价；老账本（没有这个价）回放照旧、出现命中数就拒。花费汇总分开写「按命中价」和「全按未命中价」两个数。
5. 判据先红；用用户的 key 跑一段真请求，看网关报出来的命中数和 DeepSeek 后台的账对不对得上（能看到的话）。

## 结果
- **网关**：`ToolStreamAccumulator` 认缓存命中数（DeepSeek 的 `prompt_cache_hit_tokens`，没有就认 `prompt_tokens_details.cached_tokens`；Anthropic 的 `cache_read_input_tokens`）。
  Anthropic 的输入总数原来只认 `input_tokens`，有缓存时算少了 —— 现在加上缓存读写。`HarnessModelGateway` 的 `done` 里 usage 多一个 `cachedTokens`（供应商报了、不是估算才给），
  记进 `harness_usage.cached_tokens`（V46，可空：没报是 NULL 不是 0）；`/api/harness/usage` 的今天 / 近 30 天合计带上它。
- **命令行**：会话用量记命中数，`/usage` 说「输入 X（缓存命中 Y，Z%）」，今天的合计同样。
- **评测代理**（`repository-broker.mjs`）：预留照旧全按未命中价；结算按命中价（每 10 个命中 token 3 微元 = ¥0.30 / 百万，每次请求向上取整），新账本的 init 记下这个价。
  老账本（第九十三轮之前开的，没有命中价）回放照旧、之后的结算也照旧全按未命中价，回放时出现命中数就拒；报上来的命中数比输入还大算坏用量、停账。
  报告多两个数：`miss_price_micro_cny`（老口径）、`cached_input_tokens`。真网关接上代理时试出来一处：整本的合计原来是「命中 token 加总以后取整一次」，比各次结算之和少（7721 对 7722）——
  账本要保守，改成记各次结算里命中那部分的钱之和，合计 = 各次结算之和 + 还没结的预留。
- 判据：累加器 1 条（三家各自的字段，DeepSeek 的样本只带它自己的字段 —— 两个都带时删掉认 DeepSeek 的那个分支会被另一个分支挡住）、网关 1 条 + 原来那条加「没报就不给」、
  真库上的用量合计 1 条（新的 `HarnessUsageIntegrationTest`，迁移真跑过）、命令行 1 条、代理 4 条（按命中价结算并能重放、老账本、命中数大于输入、合计是各次之和）。
  扰动：网关 6 处、命令行 2 处、代理 7 处，全红。
- **真模型**（第九十一轮的模型 ID 23；V46 迁移在验证库上跑过）：尺子四题各一遍全过，**输入里 88.2% 命中缓存**（每题 86–90%）；四题按命中价 ¥0.25，全按未命中价 ¥1.03（4.2 倍）。
  用量表 27 行和尺子报的一致（输入 102,011、命中 89,984、没有 NULL）；`/api/harness/usage` 带出了命中数。真网关前面挂评测代理、同一段请求发两遍：9,211 个输入命中 9,088，
  每次 3,861 微元（全按未命中价 82,926），合计 7,722 = 两次之和。
- **影响**：第八十七、八十八轮的评测账本按老口径是 ¥33.13、¥30.44；照这次量到的命中率，按命中价大约是它们的四分之一。老账本里没有命中数，没法补算，只能估。
- 三组判据：后端全量 1334（0 失败、0 跳过）、命令行 271/271、评测工具 99 过 1 跳。
