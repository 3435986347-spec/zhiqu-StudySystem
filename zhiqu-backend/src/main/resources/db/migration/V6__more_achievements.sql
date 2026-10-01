INSERT INTO achievement_def (code, name, description, icon, points, condition_type, condition_value)
VALUES
('TASK_PLANNER_3', '三件事上轨', '创建至少 3 个学习任务，开始把想法落到清单里。', '🧭', 15, 'TASK_CREATED_COUNT', 3),
('TASK_PLANNER_10', '任务编排师', '创建至少 10 个学习任务，能把学习拆成可执行动作。', '📐', 25, 'TASK_CREATED_COUNT', 10),
('TASK_DONE_5', '小有章法', '累计完成 5 个学习任务，开始形成闭环。', '✅', 30, 'TASK_DONE_COUNT', 5),
('TASK_DONE_20', '清单终结者', '累计完成 20 个学习任务，执行力正在稳定成型。', '🏁', 60, 'TASK_DONE_COUNT', 20),
('FOCUS_FIRST', '第一颗番茄', '完成 1 次专注记录，真正坐下来开始。', '🍅', 15, 'STUDY_RECORD_COUNT', 1),
('FOCUS_10', '十次专注', '累计完成 10 次专注记录，把启动变成习惯。', '⏱️', 30, 'STUDY_RECORD_COUNT', 10),
('FOCUS_30', '专注航线', '累计完成 30 次专注记录，学习节奏已经有航线。', '🛰️', 60, 'STUDY_RECORD_COUNT', 30),
('STUDY_10H', '十小时地基', '累计学习达到 10 小时，基础工程正式开工。', '⛏️', 25, 'TOTAL_STUDY_MINUTES', 600),
('STUDY_30H', '三十小时推进', '累计学习达到 30 小时，进入稳定推进状态。', '📚', 40, 'TOTAL_STUDY_MINUTES', 1800),
('STREAK_3', '三日不断线', '连续学习 3 天，先把链条接起来。', '🔗', 20, 'CONSECUTIVE_DAYS', 3),
('STREAK_14', '十四日成势', '连续学习 14 天，习惯已经开始站稳。', '🌿', 60, 'CONSECUTIVE_DAYS', 14),
('STUDY_DAYS_7', '七日足迹', '在 7 个不同日期留下学习记录。', '👣', 30, 'STUDY_DAY_COUNT', 7),
('ROUTINE_FIRST', '例行启动', '创建至少 1 个例行计划，把日常事项从任务堆里解放出来。', '🔁', 20, 'ROUTINE_COUNT', 1),
('ROUTINE_CHECKIN_7', '七次打卡', '累计完成 7 次例行计划打卡。', '📌', 35, 'ROUTINE_CHECKIN_COUNT', 7),
('ROUTINE_CHECKIN_30', '三十次打卡', '累计完成 30 次例行计划打卡，日常节奏已经很稳。', '🏷️', 70, 'ROUTINE_CHECKIN_COUNT', 30)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  icon = VALUES(icon),
  points = VALUES(points),
  condition_type = VALUES(condition_type),
  condition_value = VALUES(condition_value);
