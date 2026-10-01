-- 幂等键的结果落库（第二十二轮）。
--
-- 由来：结果原来只存在 Redis 里；没有 Redis 时（桌面应用就没有）退回进程内。进程一重启就全忘了 ——
-- 回应丢在路上、页面说「不确定有没有保存上 —— 再点一次不会重复保存」，学生等服务起来再点，拿的是同一个键，
-- 新进程却不认得它，又建了一份（kill -9 重启实测：同一个键 1 条 → 2 条）。
-- key_hash 是「用户 + 接口 + 地址 + 键」的 SHA-256：原文可能很长（地址、查询串），唯一索引放不下。
CREATE TABLE IF NOT EXISTS idempotency_record (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    key_hash CHAR(64) NOT NULL COMMENT '用户 + 接口 + 地址 + 幂等键 的 SHA-256',
    user_id BIGINT NOT NULL,
    result_json MEDIUMTEXT NOT NULL COMMENT '第一次执行成功时的回包',
    expires_at DATETIME NOT NULL COMMENT '过了这个时刻就不再认（和 Redis 里的一样，10 分钟）',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_idempotency_key_hash (key_hash),
    KEY idx_idempotency_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='幂等键的结果：重启之后同一个键再来也只做一次';
