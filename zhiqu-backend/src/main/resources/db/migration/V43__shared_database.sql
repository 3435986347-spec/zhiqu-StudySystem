-- 第二十八轮：好几个后端连同一个库（用户 2026-10-04：桌面应用和网页端都连服务器上的同一个 MySQL）。

-- 1) 主密钥哨兵：用主密钥加密的一句固定的话。启动时解不开就不启动 —— 主密钥不一致的实例写进来的密文，别的实例都解不开。
--    只有一行（id = 1）。轮换主密钥时它和别的密文一起换（CryptoKeyRotation.TABLES）。
CREATE TABLE IF NOT EXISTS crypto_canary (
  id TINYINT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2) 心跳：进行中的回答和执行记录每 30 秒用数据库的钟碰一下。收拾「上一个进程没做完的」看心跳停了多久，
--    不再看「是不是这个进程启动之前建的」—— 那样会掐掉别的进程正在做的。可空：旧行没有心跳，按建立时间算。
ALTER TABLE ai_message ADD COLUMN heartbeat_at DATETIME NULL;
ALTER TABLE ai_agent_run ADD COLUMN heartbeat_at DATETIME NULL;
-- 收拾每 2 分钟一趟，按状态找进行中的那几行：不加索引就是每 2 分钟整表扫一遍
CREATE INDEX idx_ai_message_status ON ai_message (status);
CREATE INDEX idx_ai_agent_run_status ON ai_agent_run (status);

-- 3) 一天一次的定时任务按天认领：插进去的那个实例做，别的跳过（不依赖 Redis —— 没有共享 Redis 时锁只在本进程有效）。
CREATE TABLE IF NOT EXISTS scheduled_job_claim (
  job VARCHAR(60) NOT NULL,
  slot VARCHAR(40) NOT NULL,
  claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job, slot)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
