-- 第二十七轮：AI 助手读不读得到用户的任务（用户 2026-10-04 定的：让它读，给一个开关）。
-- 可空：空 = 开（用户选的是「让它读」），0 = 关，1 = 开。已有的行不用回填，照旧是空、即开。
ALTER TABLE sys_user ADD COLUMN ai_read_tasks TINYINT NULL;
