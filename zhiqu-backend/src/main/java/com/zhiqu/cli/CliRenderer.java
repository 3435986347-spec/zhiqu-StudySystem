package com.zhiqu.cli;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 把后端的流式事件画到终端上。
 *
 * <p>形状仿照常见的 coding agent CLI：每个 agent 阶段一行灰字，coding agent 的每一次工具调用
 * 一行 {@code ⎿}，命令输出缩进显示在它下面，最后是回答正文。
 *
 * <p>和网页上的执行轨迹是<b>同一份事件</b>（{@code agent.step.start} / {@code agent.step.note} / …），
 * 不为 CLI 另开一套 —— 另开的话两边迟早说不同的话。
 *
 * <p>不碰网络、不碰 stdin，只往一个 {@link PrintStream} 写：这样判据能直接喂事件、比对输出。
 */
public final class CliRenderer {

    private final PrintStream out;
    private final boolean color;

    /** 本轮产出的工件 id（按到达顺序）—— 流结束后用它们去取草稿内容。 */
    private final Set<Long> artifactIds = new LinkedHashSet<>();
    private final List<String> errors = new ArrayList<>();
    private Long agentRunId;
    private boolean answering;
    private boolean atLineStart = true;

    public CliRenderer(PrintStream out, boolean color) {
        this.out = out;
        this.color = color;
    }

    public void onEvent(String name, JsonNode data) {
        if (data != null && data.hasNonNull("agentRunId") && agentRunId == null) {
            agentRunId = data.get("agentRunId").asLong();
        }
        switch (name) {
            case "agent.step.start" -> {
                String summary = text(data, "publicSummary");
                if (!summary.isEmpty()) {
                    line(dim("· " + summary));
                }
            }
            case "agent.step.note" -> note(data);
            case "agent.task.error" -> line(red("✗ " + firstNonEmpty(text(data, "message"), text(data, "error"), "某个阶段失败了")));
            case "artifact.created" -> {
                if (data != null && data.hasNonNull("artifactId")) {
                    artifactIds.add(data.get("artifactId").asLong());
                }
                line(yellow("  ⎿ 草稿：" + firstNonEmpty(text(data, "title"), text(data, "artifactType"))));
            }
            case "message.delta" -> {
                if (!answering) {
                    answering = true;
                    if (!atLineStart) out.println();
                    out.println();
                    atLineStart = true;
                }
                String t = text(data, "text");
                if (!t.isEmpty()) {
                    out.print(t);
                    out.flush();
                    atLineStart = t.endsWith("\n");
                }
            }
            case "done" -> {
                if (!atLineStart) out.println();
                atLineStart = true;
                if ("CANCELED".equals(text(data, "status"))) {
                    line(yellow(firstNonEmpty(text(data, "message"), "本轮已取消")));
                }
            }
            case "error" -> {
                String msg = firstNonEmpty(text(data, "message"), "出错了");
                errors.add(msg);
                line(red("✗ " + msg));
            }
            default -> {
                // reasoning.delta、citations、agent.task.* 等：网页上有各自的位置，终端里不刷屏
            }
        }
    }

    /**
     * coding agent 的一步。{@code phase}：call（要做什么）、result（命令输出或拒绝）、budget（预算用完）。
     * 没有 phase 的是其它 agent 的旁白（比如「第一次检索没命中，换个说法再试」），同样灰字显示。
     */
    private void note(JsonNode data) {
        String phase = text(data, "phase");
        String message = text(data, "message");
        if (message.isEmpty()) return;
        switch (phase) {
            case "call" -> line(cyan("  ⎿ ") + message);
            case "result" -> {
                for (String l : message.split("\n", -1)) {
                    line(dim("    │ " + l));
                }
            }
            case "budget" -> line(yellow("  ⎿ " + message));
            default -> line(dim("  ⎿ " + message));
        }
    }

    public Set<Long> artifactIds() {
        return artifactIds;
    }

    public Long agentRunId() {
        return agentRunId;
    }

    public List<String> errors() {
        return errors;
    }

    private void line(String s) {
        if (!atLineStart) {
            out.println();
        }
        out.println(s);
        out.flush();
        atLineStart = true;
    }

    String dim(String s) { return paint("2", s); }
    String red(String s) { return paint("31", s); }
    String yellow(String s) { return paint("33", s); }
    String cyan(String s) { return paint("36", s); }
    String green(String s) { return paint("32", s); }

    private String paint(String code, String s) {
        return color ? "\u001b[" + code + "m" + s + "\u001b[0m" : s;
    }

    private static String text(JsonNode data, String field) {
        if (data == null) return "";
        JsonNode v = data.get(field);
        return v == null || v.isNull() ? "" : v.asText("");
    }

    private static String firstNonEmpty(String... xs) {
        for (String x : xs) {
            if (x != null && !x.isEmpty()) return x;
        }
        return "";
    }
}
