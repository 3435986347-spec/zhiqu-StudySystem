-- 退掉 V27 里两列「看上去在保护、实际什么都没做」的东西。
--
-- V27 建了四列竞态栅栏，注释写得像已经生效（"最终事务比对本列，不匹配则整体丢弃"），
-- 但四列在 Java 侧全是零引用 —— 列在，机制没写。同期还有三条名字带 MemoryEpoch 的绿测试，
-- 测的只是 schema 形状（列存在、NOT NULL、默认值），行为侧一个断言都没有。
-- 于是读者拿到两个独立的正向信号，而实际保护为零。这正是本仓库反复在杀的物种，
-- 只不过这次它藏在迁移注释和测试名里，而不是判据里。
--
-- 两列删，两列接（接的部分见 V27 保留下来的 memory_epoch）：
--
-- 1. sys_user.memory_state（LEGACY/MIGRATING/FACTS）
--    它服务的是「记忆从 blob 迁到离散 facts」那套 Phase 2 cutover。该计划已放弃。
--    留着就是承诺一个不存在的 cutover：下一个人会去找 MIGRATING 态的迁移任务，找不到。
--
-- 2. ai_conversation.revision（写侧递增的会话修订号）
--    它要防的是「摘要读了旧消息 → 用户删掉其中一条 → 摘要写入已作废内容」。
--    这件事 V31 已经解决了，用的是读侧指纹（summary_live_count），
--    而且恰恰不是写侧递增 —— 理由写在 V31 表头：写侧的正确性分散在调用点，
--    取决于将来每条新增删除路径都记得递增，并且没法扰动自证。
--    本列就是那条理由的实证：它今天是死的，死因正是没人去写那些递增点。
--    同一张表上留两套同职责机制、其中一套是死的，是纯粹的误导面。

ALTER TABLE sys_user DROP COLUMN memory_state;
ALTER TABLE ai_conversation DROP COLUMN revision;
