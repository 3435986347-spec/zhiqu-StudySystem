package com.zhiqu.service.ai;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * OpenAI 函数调用的 schema 形状 —— <b>唯一定义</b>。
 *
 * <p>这是纯协议，不含任何业务：一个工具长什么样、参数怎么描述。
 * Wiki 工具、工作区工具、学习计划工具都用它拼，所以它不该住在其中任何一个里面。
 *
 * <p>形状错了不会报错 —— 模型只是收到一个它看不懂的工具声明，然后<b>不调用</b>它。
 * 表现是「这个功能好像没生效」，而日志里什么都没有。所以这里只留一份定义。
 */
public final class ToolSchemas {

    public static Map<String, Object> schemaProp(String type, String description) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        m.put("description", description);
        return m;
    }

    public static Map<String, Object> schemaArray(String itemType, String description) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "array");
        m.put("items", Map.of("type", itemType));
        m.put("description", description);
        return m;
    }

    public static Map<String, Object> schemaArrayOf(Map<String, Object> item, String description) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "array");
        m.put("items", item);
        m.put("description", description);
        return m;
    }

    public static Map<String, Object> schemaEnum(String description, String... values) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "string");
        m.put("enum", List.of(values));
        m.put("description", description);
        return m;
    }

    public static Map<String, Object> functionTool(String name, String description, Map<String, Object> props, List<String> required) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("type", "object");
        params.put("properties", props);
        params.put("required", required);
        Map<String, Object> function = new LinkedHashMap<>();
        function.put("name", name);
        function.put("description", description);
        function.put("parameters", params);
        Map<String, Object> tool = new LinkedHashMap<>();
        tool.put("type", "function");
        tool.put("function", function);
        return tool;
    }

    /**
     * 把模型给的工具参数（一段 JSON）解析成键值表。解析不了返回空表，<b>不抛</b> ——
     * 参数坏了是模型的事，执行器会按「缺参数」如实回给它，而不是让整个工具循环中断。
     */
    public static Map<String, Object> argsOf(com.fasterxml.jackson.databind.ObjectMapper objectMapper, String json) {
        if (json == null || json.isBlank()) {
            return Map.of();
        }
        try {
            Object value = objectMapper.readValue(json, Map.class);
            if (value instanceof Map<?, ?> map) {
                Map<String, Object> result = new LinkedHashMap<>();
                map.forEach((key, v) -> result.put(String.valueOf(key), v));
                return result;
            }
        } catch (Exception ignored) {
            // 落到下面的空表
        }
        return Map.of();
    }

    private ToolSchemas() {
    }
}
