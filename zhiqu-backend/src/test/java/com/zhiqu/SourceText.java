package com.zhiqu;

/**
 * 对源码做文本断言时的共享处理 —— <b>唯一定义</b>。
 *
 * <p>从 {@code AdminPageWiringTest} 提出来，而不是在第二个判据里再抄一份：
 * 抄一份就是这一轮反复在修的那个物种（同一事实两份拷贝，先分叉，后果延后出现）。
 */
public final class SourceText {

    /**
     * 剥掉注释，让判据只看可执行的部分。
     *
     * <p><b>为什么必须剥</b>：{@code contains} 分不出「代码里有」和「文字里提到」。
     * 本仓库已两次被注释满足过判据 —— 一次是解释防护的那句话满足了防护本身
     * （{@code route()} 里的 {@code ZQUI.isAdminPage(}），一次是被注释掉的白名单行
     * 满足了「该页已在白名单」的检查。两次都是扰动逮到的，不是 review 逮到的。
     *
     * <p>{@code //} 的匹配刻意<b>排除前面紧跟冒号</b>的情况，否则 {@code https://…}
     * 会被当成注释起点、把整行后半截吞掉，判据就可能因为一条 URL 而假阴性。
     * 这是个便宜的启发式，不是词法分析：字符串字面量里写的 {@code "/*"} 仍会骗到它。
     * 对这类「某个调用还在不在」的判据够用。
     */
    public static String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("(?<!:)//[^\\n]*", " ");
    }

    private SourceText() {
    }
}
