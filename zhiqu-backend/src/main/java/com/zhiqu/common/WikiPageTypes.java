package com.zhiqu.common;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 知识 Wiki 页面类型的中文名 —— 只在这里定义一次。
 *
 * <p>原来 {@code KnowledgeServiceImpl} 里有一份（写 index 页、Markdown 导出用），{@code search_wiki} 不认类型（第四十五轮：用户有一页
 * 「27考研」是目标页，命令行里问「我有哪些计划」，模型按「目标」「GOAL」去搜，搜不到 —— 匹配只看标题、摘要和正文）。
 * 老数据里还有 SCHEDULE / REMINDER / MATERIAL，归到对应的中文名下。
 */
public final class WikiPageTypes {

    /** 中文名 → 这一类在库里可能的写法（第一个是现在新建时用的） */
    private static final Map<String, String[]> BY_LABEL = new LinkedHashMap<>();
    static {
        BY_LABEL.put("目标", new String[]{"GOAL"});
        BY_LABEL.put("计划", new String[]{"PROJECT", "SCHEDULE"});
        BY_LABEL.put("偏好", new String[]{"PREFERENCE", "REMINDER"});
        BY_LABEL.put("薄弱点", new String[]{"WEAKNESS"});
        BY_LABEL.put("资料", new String[]{"RESOURCE", "MATERIAL"});
        BY_LABEL.put("对话摘要", new String[]{"MEMORY"});
        BY_LABEL.put("日志", new String[]{"LOG"});
        BY_LABEL.put("规则", new String[]{"SCHEMA"});
        BY_LABEL.put("备注", new String[]{"NOTE"});
    }

    private WikiPageTypes() {
    }

    /** 库里的类型 → 中文名；认不出的（含 null、INDEX）算「备注」 */
    public static String label(String type) {
        String t = type == null ? "" : type.trim().toUpperCase(Locale.ROOT);
        for (Map.Entry<String, String[]> e : BY_LABEL.entrySet()) {
            for (String code : e.getValue()) {
                if (code.equals(t)) return e.getKey();
            }
        }
        return "备注";
    }

    /**
     * 模型 / 用户给的类型（代码或中文名，大小写不论）→ 中文名；认不出返回 null。
     * 「项目」也算「计划」（PROJECT 的直译，模型常这么说），「笔记」算「备注」。
     */
    public static String parse(String text) {
        if (text == null || text.isBlank()) return null;
        String t = text.trim();
        if (BY_LABEL.containsKey(t)) return t;
        if ("项目".equals(t)) return "计划";
        if ("笔记".equals(t)) return "备注";
        String upper = t.toUpperCase(Locale.ROOT);
        for (Map.Entry<String, String[]> e : BY_LABEL.entrySet()) {
            for (String code : e.getValue()) {
                if (code.equals(upper)) return e.getKey();
            }
        }
        return null;
    }

    /** 给模型看的可用类型，例如「GOAL（目标）、PROJECT（计划）……」 */
    public static String choices() {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String[]> e : BY_LABEL.entrySet()) {
            if (sb.length() > 0) sb.append("、");
            sb.append(e.getValue()[0]).append("（").append(e.getKey()).append("）");
        }
        return sb.toString();
    }
}
