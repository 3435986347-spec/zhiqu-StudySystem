package com.zhiqu.rag;

import java.util.List;

/**
 * 回读一个可索引单元的结果。
 *
 * <p><b>三种结局必须在类型上就分开，不能都用「返回空串」表达。</b>「页面被删了」与
 * 「页面还在但这次读不出来」是两件后果相反的事：
 * <ul>
 *   <li>{@link Outcome#GONE} → 单元转 {@code RETIRED} 并删除向量。当成 SKIPPED 处理的话，
 *       软删页的向量<b>永远不会被清理</b>，用户以为删掉的内容还能被检索到，
 *       而 {@code status} 列上看不出任何异常。</li>
 *   <li>{@link Outcome#UNUSABLE} → 单元转 {@code SKIPPED}，等下次 reconcile 重试。当成 GONE
 *       处理的话，一次临时的解密失败会把好数据的向量删干净。</li>
 * </ul>
 * 用同一个「空」值表示两者，就是把这个选择推给每一个调用点各自去猜。
 */
public record UnitContent(Outcome outcome, String title, String canonicalText,
                          List<RagUnitChunker.Chunk> presetChunks, String reason) {

    public enum Outcome {
        /** 读到了内容。 */
        OK,
        /**
         * 单元的原始行已不存在、已软删、或<b>不属于该用户</b> —— 应当退役并删向量。
         *
         * <p><b>最后那一条是一处已知的合并，暂未拆开。</b>「行没了」与「行还在但归属对不上」
         * 是两件事：前者退役是对的，后者是注册侧写错了 user_id 的信号，
         * 而实体本身完好 —— 退役它等于拿删除去响应一个注册缺陷，
         * 一份健康数据就此销毁（切分边界删除 → DELETE_UNIT → 向量清理），
         * 且每一步单看都是正确行为。
         *
         * <p>两个 provider 的 reason 字符串自己承认了这次合并：
         * {@code PAGE_NOT_FOUND_OR_NOT_OWNED} / {@code SOURCE_NOT_FOUND_OR_NOT_OWNED}。
         *
         * <h4>为什么<b>今天不拆</b> —— 记的是压制关系，不是一条 TODO</h4>
         *
         * <p>这处合并要造成破坏，需要「一个非空但<b>写错</b>的 userId 到达注册」。
         * 而 {@code RagUnitRegistry.ensureRow} 对外<b>只留两个收实体的重载</b>，
         * 收游离 {@code userId} 的那个七参版本是 {@code private} —— 归属只能取自实体行，
         * 于是那个因在类外<b>不可构造</b>。因被压制，果就不必防。
         *
         * <p><b>压制一旦被放宽，这条立刻变紧急</b>：新增任何一个收游离 {@code userId} 的
         * 注册入口，破坏路径就重新可达 —— 那时的后果不是漏索引，是
         * <b>把一份健康数据销毁掉</b>（切分边界删除 → DELETE_UNIT → 向量清理），
         * 而每一步单看都是正确行为。
         *
         * <p>拆法（真要拆时）：归属不匹配单独成第四种结局，既不退役也不跳过，
         * 直接抛让作业转 DEAD 并告警。{@code RagUnitRegistry.refresh} 里那个 switch
         * <b>已经是表达式</b>，加常量时编译器会把所有落点指出来。
         */
        GONE,
        /** 原始行还在，但这次拿不到可索引的正文（解密失败、无父块、正文为空）—— 应当跳过并保留。 */
        UNUSABLE
    }

    public static UnitContent ok(String title, String canonicalText) {
        return new UnitContent(Outcome.OK, title, canonicalText, null, null);
    }

    /**
     * 带预设切分边界的成功结果 —— Notebook 资料专用。
     *
     * <p>它必须复用 {@code ai_source_chunk} 的既有父块边界，而不是重新分块：重切会让每份
     * 存量资料的 content_hash 全部变化，触发一次没人要求的全量重建，
     * 「1B-1 是纯重构、Notebook 行为不变」当场破功。
     */
    public static UnitContent ok(String title, String canonicalText, List<RagUnitChunker.Chunk> presetChunks) {
        return new UnitContent(Outcome.OK, title, canonicalText, presetChunks, null);
    }

    public static UnitContent gone(String reason) {
        return new UnitContent(Outcome.GONE, null, null, null, reason);
    }

    public static UnitContent unusable(String reason) {
        return new UnitContent(Outcome.UNUSABLE, null, null, null, reason);
    }
}
