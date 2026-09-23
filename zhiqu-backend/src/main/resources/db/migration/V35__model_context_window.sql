-- 模型的上下文窗口（token）。可空：不填时一切按原来的保守上限走，旧行不受影响。
--
-- 由来（2026-09-24）：用户问能不能把上下文拓展到 1M。各处上限原本都写死
-- （对话历史 20 条、代码 12000 字、Wiki 20000 字、coding agent 看不到历史），与模型能吃多少无关。
-- 窗口是<b>模型自己的</b>能力，只能由配置它的人填；填了之后各处上限按比例放大（ContextBudget）。
--
-- 与 V34 退掉的 daily_quota 相反：那一列能写进来却没有任何代码读。这一列必须有读者 ——
-- ModelContextWindowTest 钉着「填了窗口，发给模型的历史真的变长」。
ALTER TABLE ai_model_config
    ADD COLUMN context_window_tokens INT NULL COMMENT '上下文窗口（token），空 = 按保守默认上限';
