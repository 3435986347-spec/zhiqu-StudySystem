-- 退掉四列「建了、有的还能从接口写进来，但没有任何代码读」的列。
--
-- 与 V32 / V33 同一物种，但 daily_quota 这一列更糟一点：它<不只是>没接线，
-- 而是<可以被写入>的。PUT /api/ai/models 接受请求体里的 dailyQuota 并落库，
-- 调用方有充分理由相信自己给这个模型设了每日上限 —— 而系统从不检查它。
--
-- 1. ai_model_config.daily_quota / used_today / quota_date
--    本意是模型的每日调用配额。实际状态（全仓库不区分大小写穷举过）：
--      getDailyQuota()  零调用
--      getUsedToday()   零调用
--      used_today       只在三处新建模型时被置 0，<从不自增>
--      quota_date       一次都没有被碰过，恒为 NULL
--    也就是说：计数器不走、日期不翻、上限不查。三列合起来是一套完整的假象。
--    前端既不发也不显示它，所以这个假象目前只对直接调 API 的人可见。
--
--    要真做配额，缺的是：在模型调用处按 (model, 日期) 自增并比对上限、
--    跨天翻转、以及超限时的用户可见反馈。那是一个功能，不是接一根线，
--    而且要先想清楚「超限之后这轮对话怎么收口」—— 与 timeout_seconds 同一类问题。
--
-- 2. ai_agent_step.input_summary
--    同表的 output_summary 由 completeStep 正常写入；input_summary 只有建表语句
--    和实体字段两处出现，没有任何写入方，也没有任何读取方。
--
-- 这些列都没有数据可丢：used_today 恒为 0，其余三列恒为 NULL 或仅由 API 写入过
-- 一个从未生效的数字。

ALTER TABLE ai_model_config DROP COLUMN daily_quota;
ALTER TABLE ai_model_config DROP COLUMN used_today;
ALTER TABLE ai_model_config DROP COLUMN quota_date;
ALTER TABLE ai_agent_step DROP COLUMN input_summary;
