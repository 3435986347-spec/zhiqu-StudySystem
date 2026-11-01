-- 第九十三轮：命令行网关每次调用记下供应商报的缓存命中输入 token 数（DeepSeek prompt_cache_hit_tokens、
-- OpenAI prompt_tokens_details.cached_tokens、Anthropic cache_read_input_tokens），按命中价算钱要用它。
-- 可空：老记录和不报的供应商都是 NULL，不是 0 —— 「没报」和「没命中」是两回事。只做加法。
ALTER TABLE harness_usage ADD COLUMN cached_tokens INT NULL;
