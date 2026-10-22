-- 第二十六轮：参考计划的分类改成办公方向（用户 2026-10-04 定的：产品定位从「学生学习系统」改成「AI 办公助手」）。
-- key 不变 —— 已有模板的 category 存的是 key，改名之后照样对得上；只改显示名、说明和自动归类用的关键词，再加三个办公分类。
-- 同一份清单还写在 SharedPlanServiceImpl.CATEGORY_NAMES 和 zhiqu-api.js 的 PLAN_CATEGORIES 里，
-- PlanCategoryListTest 核对三处一致（只改一处的话，页面上的筛选、自动归类建出来的分类、库里的名字会是三种叫法）。
INSERT INTO shared_plan_category(category_key, name, description, keywords, template_count, last_used_at)
VALUES
('PROJECT', '项目推进', '项目排期、里程碑、上线和交付', '项目,里程碑,上线,交付,需求,迭代,排期,发布,验收,立项', 0, NOW()),
('MEETING', '会议与汇报', '周报、月报、述职、复盘会和演示的准备', '会议,汇报,周报,月报,述职,复盘,总结,演示,ppt,例会', 0, NOW()),
('ROUTINE', '日常事务', '邮件、报销、整理归档这类日常事务的节奏', '邮件,报销,归档,整理,日常,收件箱,对账,行政', 0, NOW()),
('COMPUTER', '技能提升', '编程、数据分析、办公软件、写作等技能的练习', '编程,算法,数据分析,excel,python,sql,写作,技能,工具', 0, NOW()),
('LANGUAGE', '外语', '英语、日语等外语的听说读写练习', '英语,日语,外语,单词,口语,听力,阅读,雅思,托福', 0, NOW()),
('EXAM', '考证与培训', '职业资格、证书、内部考核和培训的备考', '考试,认证,证书,资格,培训,考核,备考,考研', 0, NOW()),
('GENERAL', '通用规划', '通用的工作和生活计划', '计划,复盘,习惯,任务,目标', 0, NOW())
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  keywords = VALUES(keywords);
