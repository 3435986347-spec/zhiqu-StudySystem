ALTER TABLE shared_plan_template
  ADD COLUMN like_count INT NOT NULL DEFAULT 0 AFTER apply_count;

CREATE TABLE IF NOT EXISTS shared_plan_like (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_shared_plan_like_template FOREIGN KEY (template_id) REFERENCES shared_plan_template(id),
  CONSTRAINT fk_shared_plan_like_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  UNIQUE KEY uk_shared_plan_like_user_template (template_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shared_plan_category (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  category_key VARCHAR(60) NOT NULL,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(300) DEFAULT NULL,
  keywords VARCHAR(500) DEFAULT NULL,
  template_count INT NOT NULL DEFAULT 0,
  last_used_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  UNIQUE KEY uk_shared_plan_category_key (category_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO shared_plan_category(category_key, name, description, keywords, template_count, last_used_at)
VALUES
('EXAM', '考试备考', '面向考研、期末、证书考试等长期备考计划', '考研,期末,考试,备考,数学,英语,政治,408', 0, NOW()),
('COMPUTER', '计算机学习', '面向编程、算法、计算机基础和项目学习', '计算机,编程,算法,408,数据结构,操作系统,计网,计组', 0, NOW()),
('LANGUAGE', '语言学习', '面向英语、日语等语言输入输出训练', '英语,单词,阅读,听力,作文,语言', 0, NOW()),
('GENERAL', '通用规划', '通用学习、工作和生活计划模板', '计划,复盘,习惯,任务,学习', 0, NOW());

CREATE INDEX idx_shared_plan_status_category_like_created
  ON shared_plan_template(status, category, like_count, created_at, deleted);

CREATE INDEX idx_shared_plan_user_title_status
  ON shared_plan_template(user_id, title, status, deleted);

CREATE INDEX idx_shared_plan_like_user
  ON shared_plan_like(user_id, deleted, created_at);

CREATE INDEX idx_shared_plan_category_name
  ON shared_plan_category(name, deleted, last_used_at);
