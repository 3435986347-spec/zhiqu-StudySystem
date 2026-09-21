package com.zhiqu.common;

/**
 * 文本截断 —— <b>唯一定义</b>。
 *
 * <p>原来是 {@code AiServiceImpl} 的一个私有方法，被那个类用了 33 次。
 * 把「跟模型供应商说话」那一层拆出去时它成了两边都要的东西，
 * 于是提到这里：与其在新类里再写一个同义的，不如让两边指向同一份。
 *
 * <p>它同时做两件事：<b>压掉所有连续空白</b>再截断。第二件容易被忽略 ——
 * 一段带换行的错误响应压成一行之后长度会变，所以「截到 500」指的是压缩后的 500。
 */
public final class TextLimits {

    public static String limit(String value, int maxLength) {
    if (value == null) {
            return "";
        }
        String text = value.replaceAll("\\s+", " ").trim();
        if (text.length() <= maxLength) {
            return text;
        }
        return text.substring(0, maxLength) + "...";
    }

    private TextLimits() {
    }
}
