package com.zhiqu.service.ai;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 写回答那一次调用的输出上限（{@code max_tokens}），网页 / 桌面应用和命令行同一套（第五十四轮）。
 *
 * <p>网页原来写死 4096：深度思考时思考也算在 {@code max_tokens} 里，DeepSeek 想完 4096 就没地方写回答了 ——
 * 用户 2026-10-09 在桌面应用里看到「模型把这次的输出额度全用在了思考上」，同一个模型在命令行里没事（命令行 16384）。
 * 供应商不收这么大的（有的只给 8192、本地小模型窗口才 8K）就一档档降，和命令行原来的做法一样 —— 那一份挪到了这里。
 */
public final class OutputLimits {

    /** 写回答的那一次：和命令行的默认一样 */
    public static final int ANSWER_MAX_TOKENS = 16_384;

    private OutputLimits() {
    }

    /** 回退的几档：从要的那档往下，8192、4096。 */
    public static List<Integer> fallbackLimits(int maxTokens) {
        List<Integer> out = new ArrayList<>();
        out.add(maxTokens);
        for (int step : new int[]{8_192, 4_096}) {
            if (step < out.get(out.size() - 1)) out.add(step);
        }
        return out;
    }

    /** 这个 400 / 422 是不是在说「输出上限太大」（或者上限加输入超过了窗口）。 */
    public static boolean rejectsMaxTokens(int status, String body) {
        if (status != 400 && status != 422) return false;
        String b = body == null ? "" : body.toLowerCase(Locale.ROOT);
        return b.contains("max_tokens") || b.contains("max_output_tokens") || b.contains("max_completion_tokens")
                || b.contains("maximum") && b.contains("token");
    }
}
