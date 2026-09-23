package com.zhiqu.service.ai;

/**
 * 一次对话里各处能给模型塞多少内容 —— 由模型的上下文窗口决定。
 *
 * <p>由来（2026-09-24）：用户问上下文能不能拓展到 1M。各处上限原本写死在各自的类里
 * （对话历史 20 条、工作区代码 12000 字、Wiki 20000 字），和模型能吃多少无关：
 * 1M 窗口的模型只用了几万字，小窗口的本地模型又可能被撑爆。
 *
 * <h2>两条规矩</h2>
 * <ul>
 *   <li><b>没填窗口就一个字都不变</b>：{@link #DEFAULT} 正是原来那组常量。已有的对话行为不受影响。</li>
 *   <li>填了窗口 W（token）就<b>按每一次模型调用</b>分配：最终回答里历史约 35%、工作区代码与 Wiki 各约 15%；
 *       coding agent 那一次调用里历史约 35%。按 1 字 ≈ 1 token 保守估计（中文大致如此，代码更省）。
 *       剩下的留给系统提示词、检索资料和输出。</li>
 * </ul>
 *
 * <p>窗口是上限，不是目标：每一轮真正发出去的是「实际存在的内容」和这些上限中小的那个。
 * 但窗口越大，长对话里每一轮越贵、越慢 —— 这是配置的人要知道的，界面上写明了。
 */
public record ContextBudget(int historyMessages, int historyChars, int codeContextChars,
                            int codeHistoryChars, int wikiContextChars) {

    public static final int MIN_WINDOW = 8_000;
    public static final int MAX_WINDOW = 1_000_000;

    /** 没填窗口时：原来写死的那一组，逐项不变。 */
    public static final ContextBudget DEFAULT = new ContextBudget(20, Integer.MAX_VALUE, 12_000, 24_000, 20_000);

    public static ContextBudget forWindow(Integer windowTokens) {
        if (windowTokens == null) {
            return DEFAULT;
        }
        int w = Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, windowTokens));
        return new ContextBudget(
                clamp(w / 2_500, 6, 400),          // 条数只是粗筛，真正的闸门是下面的字数
                (int) (w * 0.35),
                (int) (w * 0.15),
                (int) (w * 0.35),
                (int) (w * 0.15));
    }

    /** 保存时的校验：空（用默认）或 [MIN_WINDOW, MAX_WINDOW]。 */
    public static Integer validate(Integer windowTokens) {
        if (windowTokens == null) {
            return null;
        }
        if (windowTokens < MIN_WINDOW || windowTokens > MAX_WINDOW) {
            throw new com.zhiqu.common.BusinessException(
                    "上下文窗口要在 " + MIN_WINDOW + " 到 " + MAX_WINDOW + " token 之间（留空则用保守默认值）");
        }
        return windowTokens;
    }

    /**
     * 从新往旧留下总长不超过预算的那一段，返回保留段的起点下标（时间顺序里最老那条）。
     * 最新那一条总要留着，哪怕它自己就超了 —— 没有「这一轮之前刚说的话」，模型连上下文都接不上。
     */
    public static <T> int keepFrom(java.util.List<T> items, java.util.function.ToIntFunction<T> length, int charBudget) {
        if (charBudget == Integer.MAX_VALUE || items.isEmpty()) {
            return 0;
        }
        long used = 0;
        int from = items.size();
        while (from > 0) {
            int len = Math.max(0, length.applyAsInt(items.get(from - 1)));
            if (from < items.size() && used + len > charBudget) {
                break;
            }
            used += len;
            from--;
        }
        return from;
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
