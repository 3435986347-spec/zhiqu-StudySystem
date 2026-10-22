-- 第六十四轮：Wiki 附件独立于解析来源；正文一样使用现有主密钥加密，绝不放到公开 /uploads。
CREATE TABLE IF NOT EXISTS knowledge_attachment (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    name VARCHAR(180) NOT NULL,
    kind VARCHAR(10) NOT NULL,
    original_path VARCHAR(1024) NULL,
    mime_type VARCHAR(40) NOT NULL,
    byte_size BIGINT NOT NULL,
    width INT NULL,
    height INT NULL,
    encrypted_data LONGTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted TINYINT NOT NULL DEFAULT 0,
    INDEX idx_knowledge_attachment_owner (user_id, deleted, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
