package com.zhiqu.common;

/**
 * 三个被反复用到的文本处理 —— <b>唯一定义</b>。
 *
 * <p>它们原来都是 {@code AiServiceImpl} 的私有方法（分别被用了 33 / 13 / 14 次）。
 * 把「跟模型供应商说话」和「Wiki 工具循环」拆出去时，三处都成了两边都要的东西 ——
 * 与其在新类里各写一个同义的，不如让所有人指向同一份。
 *
 * <p>{@code AiServiceImpl} 里保留了三个一行委托，所以它那 60 个调用点一个都不用改。
 */
public final class Texts {

    /**
     * <b>压掉连续空白</b>再截断。
     *
     * <p>第二件事容易被忽略：一段带换行的错误响应压成一行之后长度会变，
     * 所以「截到 500」指的是压缩之后的 500。给人看的摘要用这个。
     */
    public static String limitCollapsed(String value, int maxLength) {
    if (value == null) {
            return "";
        }
        String text = value.replaceAll("\\s+", " ").trim();
        if (text.length() <= maxLength) {
            return text;
        }
        return text.substring(0, maxLength) + "...";
    }

    /**
     * 只截断，<b>不动空白</b>。
     *
     * <p>给模型看的原文（Markdown、代码、工具返回）用这个：压掉换行会把代码块和列表
     * 压成一坨，模型读到的结构就不是原来的结构了。
     */
    public static String limitRaw(String value, int maxLength) {
        if (value == null) {
            return "";
        }
        if (value.length() <= maxLength) {
            return value;
        }
        return value.substring(0, maxLength) + "...";
    }

    /**
     * 取字符串，<b>null 和空串都回退</b>到默认值。
     *
     * <p>注意它和 {@code java.util.Objects.toString(o, def)} 不等价 ——
     * 后者只处理 null。这里空串也算「没有」，因为它的调用方读的是 JSON 里的可选字段，
     * 而模型给出 {@code ""} 与不给这个字段是同一个意思。
     */
    public static String orDefault(Object v, String def) {
        if (v == null) {
            return def;
        }
        String s = String.valueOf(v);
        return s.isEmpty() ? def : s;
    }

    private Texts() {
    }
}
