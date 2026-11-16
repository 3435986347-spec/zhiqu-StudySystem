-- 用户的长期记忆逐条存（第一百四十三轮，docs/memory-plan.md 第 7 步）。只做加法：
-- 原来的 user_ai_memory（一块文本）不动，继续存一份「拼回来的全文」—— 连同一个库的旧后端照样读得到、写得进；
-- 新后端每次读的时候比一下，旧后端改过那块文本就按行对回这张表。旧数据不在这里搬（密文要用主密钥解，SQL 里解不了），
-- 第一次读到这个用户时由程序按行拆进来。
CREATE TABLE IF NOT EXISTS user_ai_memory_item (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  category VARCHAR(20) NULL,
  encrypted_text MEDIUMTEXT NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  pinned TINYINT NOT NULL DEFAULT 0,
  superseded_by BIGINT NULL,
  invalidated_at DATETIME NULL,
  last_used_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_ai_memory_item_user (user_id, invalidated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 命令行开工时带不带上长期记忆（用户 2026-11-15 定的「自动带上」，给一个开关，和 ai_read_tasks 并排）。空 = 开。
ALTER TABLE sys_user ADD COLUMN ai_cli_memory TINYINT NULL;
