package com.zhiqu.cli;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;

/**
 * 读懂 {@code GET /api/ai/models} 的返回，决定这一轮用哪个模型。
 *
 * <p>返回的是一个<b>对象</b> {@code {systemModels, userModels, defaultModelId, …}}，不是数组。
 * 第一版 {@code /model} 直接 {@code for (JsonNode m : data)} —— 遍历一个 JSON 对象拿到的是它各字段的
 * <b>值</b>（两个数组、一个数字），于是列出来是几行空白，切换也不校验 id 存不存在。
 * 网页那边一直有 {@code normalizeModelList} 在拍平它；这里照同样的形状拍平。
 */
public final class CliModels {

    /**
     * 一个可选的模型。{@code toolCalling} 由后端的 {@code supportsToolCalling} 给出，这里不另猜。
     *
     * <p>它是三态的：{@code true} / {@code false} / {@code null}（后端没说）。CLI 和后端的版本可能对不上 ——
     * 新 CLI 连着一个还没升级的后端（应用没重启、或 {@code --server} 指向旧服务器）时这个字段不存在。
     * 把「没说」当成「不支持」的话，会对一个完全能用的模型报警。
     */
    public record Model(long id, String label, String modelName, boolean system, boolean isDefault,
                        Boolean toolCalling) {
        /** 只有后端<b>明确</b>说不支持时才算。 */
        public boolean knownNoToolCalling() {
            return Boolean.FALSE.equals(toolCalling);
        }
    }

    private CliModels() {
    }

    /** 系统模型在前、自己的在后；{@code isDefault} 以返回里的 {@code defaultModelId} 为准。 */
    public static List<Model> parse(JsonNode data) {
        List<Model> out = new ArrayList<>();
        if (data == null) {
            return out;
        }
        long defaultId = data.path("defaultModelId").asLong(Long.MIN_VALUE);
        for (String group : List.of("systemModels", "userModels")) {
            for (JsonNode m : data.path(group)) {
                if (!m.path("enabled").asBoolean(true)) {
                    continue;   // 停用的模型发过去也只会被拒（「请先在个人中心配置可用的 AI 模型」）
                }
                long id = m.path("id").asLong();
                String label = firstNonEmpty(m.path("displayName").asText(""), m.path("modelName").asText(""), "模型 " + id);
                out.add(new Model(id, label, m.path("modelName").asText(""), "systemModels".equals(group),
                        id == defaultId, m.path("toolCalling").isBoolean() ? m.path("toolCalling").asBoolean() : null));
            }
        }
        return out;
    }

    /**
     * 这一轮实际会用的模型：指定了就是它，没指定就是默认的那个。
     * 指定的 id 不在列表里返回 {@code null} —— 调用方要拒绝，而不是发一个后端会拒的请求。
     */
    public static Model effective(List<Model> models, Long chosenId) {
        for (Model m : models) {
            if (chosenId == null ? m.isDefault() : m.id() == chosenId) {
                return m;
            }
        }
        return null;
    }

    private static String firstNonEmpty(String... xs) {
        for (String x : xs) {
            if (x != null && !x.isEmpty()) return x;
        }
        return "";
    }
}
