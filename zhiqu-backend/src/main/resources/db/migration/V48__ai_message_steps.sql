-- 回答里按顺序列出的每一步（第一百二十七轮，用户要的「像 codex 那样」）：思考、检索、联网、读任务、
-- 代码模式里的列目录 / 读 / 搜 / 运行 / 新建 / 修改 …，连同结果（命令输出的头尾、diff 的分块）。
-- 原来代码模式的逐步叙述只在流里发、不存，刷新就没了。只做加法：老消息这一列是 NULL，照样合法。
ALTER TABLE ai_message
  ADD COLUMN steps_json MEDIUMTEXT NULL AFTER suggested_plan_json;
