-- 退掉 ai_agent_run 上两列「建了但从来没有人读、也守不住任何东西」的控制列。
--
-- 与 V32 同一个物种：列在、机制没写，而读代码的人会从列名推断系统在做某件事。
-- 区别是 V32 那两列曾有设计意图（Phase 2 cutover、摘要栅栏），这两列连意图都撑不住：
--
-- 1. max_steps（默认 20）
--    本意是「一轮最多几个步骤」。而一轮的步骤数由图决定，图由意图判定决定 ——
--    实测最多 10 个 startAgentStep 落点，且多数带条件。20 这个上界结构上永远够不到。
--    它守的不是一个会发生的风险，接不接都一样；留着只会让人以为存在步骤数限制。
--
-- 2. max_tokens
--    setMaxTokens 全仓库零调用 —— 这一列恒为 NULL，从建表起就没写过值。
--    真正发给模型的 max_tokens 此前在九处各写死 4096，与本列毫无关系；
--    那九处已收成 AiServiceImpl.MODEL_MAX_TOKENS 一个常量。
--    若将来要让它可配，应当是「配置项为准、常量退位」，而不是把这一列复活成第二个真相。
--
-- 保留的三列都已接线：
--   execution_mode     建图之后由 markExecutionMode 按真实形态订正
--   max_parallel_tasks AgentStageExecutor 的线程池上限
--   timeout_seconds    与 SSE emitter 同源（AiWorkspaceService.STREAM_TIMEOUT_MS）

ALTER TABLE ai_agent_run DROP COLUMN max_steps;
ALTER TABLE ai_agent_run DROP COLUMN max_tokens;
