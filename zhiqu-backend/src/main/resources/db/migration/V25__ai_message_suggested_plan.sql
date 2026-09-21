-- 保存 AI 生成的学习计划草稿（tasks/routines）。
-- 用于「切走页面后端继续跑、切回来恢复右侧任务确认面板」：草稿在用户确认前不入任务表，
-- 过去只随 SSE done 事件推送，连接断开即丢失；持久化后可在加载/轮询历史时恢复。
ALTER TABLE ai_message
  ADD COLUMN suggested_plan_json MEDIUMTEXT NULL AFTER usage_json;
