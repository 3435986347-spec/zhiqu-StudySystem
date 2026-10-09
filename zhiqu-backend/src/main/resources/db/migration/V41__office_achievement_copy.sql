-- 第二十六轮：定位改成 AI 办公助手（用户 2026-10-04 定的），成就从导航收起、数据不删。页面直接打地址照样能进，
-- 所以名字和说明里的「学习任务」「累计学习」「连续学习」改成「任务」「专注」。只改文字：code、条件、点数一个不动，
-- 已解锁的照旧算数（StudyCountingIntegrationTest 用的是条件，不看名字）。
UPDATE achievement_def SET description = '首次完成一个任务' WHERE code = 'FIRST_TASK_DONE';
UPDATE achievement_def SET name = '连续专注7天', description = '连续专注达到7天' WHERE code = 'STREAK_7';
UPDATE achievement_def SET name = '累计专注100小时', description = '累计专注达到100小时' WHERE code = 'STUDY_100H';
UPDATE achievement_def SET description = '创建至少 3 个任务，开始把想法落到清单里。' WHERE code = 'TASK_PLANNER_3';
UPDATE achievement_def SET description = '创建至少 10 个任务，能把事情拆成可执行的动作。' WHERE code = 'TASK_PLANNER_10';
UPDATE achievement_def SET description = '累计完成 5 个任务，开始形成闭环。' WHERE code = 'TASK_DONE_5';
UPDATE achievement_def SET description = '累计完成 20 个任务，执行力正在稳定成型。' WHERE code = 'TASK_DONE_20';
UPDATE achievement_def SET description = '累计完成 30 次专注记录，工作节奏已经有航线。' WHERE code = 'FOCUS_30';
UPDATE achievement_def SET description = '累计专注达到 10 小时，基础工程正式开工。' WHERE code = 'STUDY_10H';
UPDATE achievement_def SET description = '累计专注达到 30 小时，进入稳定推进状态。' WHERE code = 'STUDY_30H';
UPDATE achievement_def SET description = '连续专注 3 天，先把链条接起来。' WHERE code = 'STREAK_3';
UPDATE achievement_def SET description = '连续专注 14 天，习惯已经开始站稳。' WHERE code = 'STREAK_14';
UPDATE achievement_def SET description = '在 7 个不同日期留下专注记录。' WHERE code = 'STUDY_DAYS_7';
