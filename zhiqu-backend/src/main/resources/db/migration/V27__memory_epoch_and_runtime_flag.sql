-- 三类竞态栅栏的基础列，以及 cutover 需要的运行时开关表。
--
-- 为什么需要 epoch：记忆抽取与摘要压缩都改成异步 worker 之后，出现了「用户清空 →
-- 在途模型调用稍后返回 → worker 写入 → 已删数据复活」的窗口。仅靠「写入前检查一下」
-- 挡不住（检查与写入之间仍有间隙），必须让 worker 在同一个事务里、锁着行去比对纪元。
--
-- memory_state 的默认值这里是 LEGACY 而不是 FACTS：本迁移到 Phase 2 上线之间注册的
-- 新用户，其记忆仍写入 user_ai_memory blob。若此刻就默认 FACTS，Phase 2 的迁移任务
-- 会漏掉他们、blob 静默丢失。默认值改为 FACTS 的动作留到 Phase 2 的迁移里做。
-- 另注：ADD COLUMN 带 DEFAULT 会自动回填存量行，因此不需要额外的 UPDATE 语句。

ALTER TABLE sys_user
  ADD COLUMN memory_epoch BIGINT NOT NULL DEFAULT 0 COMMENT '记忆纪元，清空记忆时递增，隔离在途异步任务' AFTER achievement_points,
  ADD COLUMN memory_state VARCHAR(20) NOT NULL DEFAULT 'LEGACY' COMMENT 'LEGACY=只读旧 blob, MIGRATING=迁移中, FACTS=只读 facts' AFTER memory_epoch;

-- 会话修订号：删消息 / 清空记忆 / 删除 Notebook 时递增。
-- 摘要 worker 读取消息时快照它，落库前比对活值，避免「读了旧消息 → 用户删掉其中一条
-- → worker 用已作废的内容写入摘要」——那会让已删除的正文经由摘要重新暴露。
ALTER TABLE ai_conversation
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 0 COMMENT '会话修订号，删消息/清空/删Notebook时递增，用于摘要栅栏' AFTER title;

-- run 开始时的记忆纪元快照。清空记忆时，仍在跑的流式聊天会走「重建消息对」分支把
-- 内容写回来（AiServiceImpl 的迟到回答重建路径），仅靠 fact 侧的栅栏拦不住它。
-- 最终事务比对本列，不匹配则整体丢弃，落实「清空必须获胜」。
ALTER TABLE ai_agent_run
  ADD COLUMN memory_epoch BIGINT NOT NULL DEFAULT 0 COMMENT 'run 开始时的记忆纪元快照，最终事务校验' AFTER agent_mode;

-- 运行时可变开关。存在的唯一理由是 Spring Boot 不热读 application.yml，而 cutover
-- 需要在不重启的前提下先冻结生产者、等队列排空，再停机换版本。
-- yaml 只提供种子默认值；本表有行时以本表为准。
-- 注意：本方案假定单实例部署，此表不是为多实例准备的。
CREATE TABLE IF NOT EXISTS app_runtime_flag (
  flag_key VARCHAR(60) PRIMARY KEY,
  flag_value VARCHAR(60) NOT NULL,
  updated_by VARCHAR(120) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
