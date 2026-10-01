-- 回答「照样能用、但不完整」时给用户的那句话：被单次输出上限截断、后面被内容审核拦下、太长只存了前一段。
--
-- 由来（2026-09-28，第十九轮）：这几种情况原来一个字都不说 —— 回答停在半句话，刷新之后也看不出是模型说完了还是被截了。
-- 不复用 error_message：那一列是「这一轮失败了」（status = ERROR），这里的回答是成功的（status = DONE）。
ALTER TABLE ai_message
    ADD COLUMN notice VARCHAR(500) NULL COMMENT '回答不完整的原因（输出上限 / 内容审核 / 太长）；完整的回答为空' AFTER error_message;
