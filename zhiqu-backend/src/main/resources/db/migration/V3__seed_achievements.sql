INSERT INTO achievement_def (code, name, description, icon, points, condition_type, condition_value)
VALUES
('FIRST_LOGIN', '初次登录', '首次登录系统', 'icon-login', 10, 'LOGIN_COUNT', 1),
('FIRST_TASK_DONE', '完成第一个任务', '首次完成学习任务', 'icon-task', 20, 'TASK_DONE_COUNT', 1),
('STREAK_7', '连续学习7天', '连续学习达到7天', 'icon-streak', 30, 'CONSECUTIVE_DAYS', 7),
('STUDY_100H', '累计学习100小时', '累计学习达到100小时', 'icon-study', 50, 'TOTAL_STUDY_MINUTES', 6000)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  icon = VALUES(icon),
  points = VALUES(points),
  condition_type = VALUES(condition_type),
  condition_value = VALUES(condition_value);
