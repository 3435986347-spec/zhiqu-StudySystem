package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.List;

/**
 * 把 code agent 的每一次工具调用说成一句人话 —— 执行轨迹与 CLI 里看到的那一行。
 *
 * <p>由来（2026-09-23）：整个工具循环对外只有两条事件，开头「正在查看工作区里的代码」、
 * 结尾「已生成 N 个文件的草稿」。中间读了哪些文件、搜了什么、跑了什么命令、输出是什么，
 * 用户一概看不到 —— 他没法判断它是在认真干活，还是在原地打转，也没法在它读错文件时喊停。
 *
 * <p>纯函数、零依赖：说法改错了只会让轨迹难看，不该要起一个 Spring 上下文才能测。
 */
public final class CodeToolNarration {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** 命令输出在轨迹里最多显示几行 / 几个字符。完整输出仍然交给模型，这里只是给人看。 */
    static final int OUTPUT_MAX_LINES = 30;
    static final int OUTPUT_MAX_CHARS = 2000;

    private CodeToolNarration() {
    }

    /** 调用之前：它要做什么。参数解析不了时不抛 —— 叙述失败不能拖垮工具循环。 */
    public static String describeCall(String tool, String argsJson) {
        JsonNode a = parse(argsJson);
        String path = text(a, "path");
        return switch (tool == null ? "" : tool) {
            case "list_workspace_files" -> "列出目录 " + (path.isEmpty() ? "（根目录）" : path);
            case "read_workspace_file" -> "读取 " + orUnknown(path) + (text(a, "offset").isEmpty() || "1".equals(text(a, "offset")) ? "" : "（从第 " + text(a, "offset") + " 行）");
            case "search_workspace" -> "搜索「" + text(a, "query") + "」" + (path.isEmpty() ? "" : "（在 " + path + " 下）");
            case "write_workspace_file" -> a.hasNonNull("old_string")
                    ? "修改草稿 " + orUnknown(path) + "（替换一段，未落盘）"
                    : "生成草稿 " + orUnknown(path) + "（" + lineCount(text(a, "content")) + " 行，未落盘）";
            case "run_workspace_command" -> "运行 " + commandLine(a) + (path.isEmpty() ? "" : "（在 " + path + " 下）");
            case "search_wiki" -> "查知识库「" + text(a, "query") + "」";
            case "read_wiki_page" -> "读知识页 " + orUnknown(text(a, "title"));
            case "create_wiki_patch" -> "起草知识页改动 " + orUnknown(text(a, "title"));
            case StudyPlanTool.NAME -> "把里程碑排成任务草稿";
            default -> "调用 " + (tool == null || tool.isEmpty() ? "（未知工具）" : tool);
        };
    }

    /**
     * 调用之后：值得给人看的结果；没什么可看的返回 {@code null}。
     *
     * <p>只对两类结果说话：命令输出（这是用户最想看的 —— 跑没跑过、错在哪），
     * 以及被拒绝（它想做的事没做成，人要知道）。读文件的内容不回显：那是给模型看的，
     * 几百行源码刷进轨迹只会把真正的步骤冲掉。
     */
    public static String describeResult(String tool, String result) {
        if (result == null || result.isBlank()) {
            return null;
        }
        if (result.startsWith("操作被拒绝")) {
            return firstLine(result);
        }
        if ("run_workspace_command".equals(tool)) {
            return head(result);
        }
        return null;
    }

    private static String commandLine(JsonNode a) {
        List<String> parts = new ArrayList<>();
        parts.add(text(a, "command"));
        JsonNode args = a.path("args");
        if (args.isArray()) {
            args.forEach(x -> parts.add(x.asText("")));
        }
        return String.join(" ", parts).trim();
    }

    /** 输出截头：先按行、再按字符。截了就说截了 —— 轨迹里的「就这些」和「还有」是两回事。 */
    static String head(String text) {
        String[] lines = text.split("\n", -1);
        StringBuilder out = new StringBuilder();
        int shown = Math.min(lines.length, OUTPUT_MAX_LINES);
        for (int i = 0; i < shown; i++) {
            if (i > 0) out.append('\n');
            out.append(lines[i]);
        }
        boolean cut = lines.length > OUTPUT_MAX_LINES;
        if (out.length() > OUTPUT_MAX_CHARS) {
            out.setLength(OUTPUT_MAX_CHARS);
            cut = true;
        }
        if (cut) {
            out.append("\n…（输出较长，这里只显示开头）");
        }
        return out.toString();
    }

    private static int lineCount(String content) {
        if (content.isEmpty()) return 0;
        int n = 1;
        for (int i = 0; i < content.length(); i++) {
            if (content.charAt(i) == '\n' && i < content.length() - 1) n++;
        }
        return n;
    }

    private static JsonNode parse(String json) {
        try {
            JsonNode n = JSON.readTree(json == null || json.isBlank() ? "{}" : json);
            return n == null ? JSON.createObjectNode() : n;
        } catch (Exception e) {
            return JSON.createObjectNode();
        }
    }

    private static String text(JsonNode a, String field) {
        JsonNode v = a.path(field);
        if (v.isMissingNode() || v.isNull()) return "";
        String s = v.isTextual() ? v.asText() : v.toString();
        return "null".equals(s) ? "" : s.trim();
    }

    private static String firstLine(String s) {
        int nl = s.indexOf('\n');
        return nl < 0 ? s : s.substring(0, nl);
    }

    private static String orUnknown(String path) {
        return path.isEmpty() ? "（未给出路径）" : path;
    }

}
