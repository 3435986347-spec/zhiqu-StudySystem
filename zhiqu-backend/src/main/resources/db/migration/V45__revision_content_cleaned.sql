-- 第七十四轮第六遍 review：Wiki 草稿入库前洗过（WikiDrafts）就标 1，合入时不再洗第二遍；
-- 这一轮之前存的草稿是 NULL —— 其中两条路径从没洗过，合入时补洗一遍。只做加法。
ALTER TABLE user_knowledge_revision ADD COLUMN content_cleaned TINYINT NULL;
