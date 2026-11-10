package com.zhiqu.service.ai;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 回答里按顺序列出的每一步（第一百二十七轮，用户要的：「像 codex 那样把思考 - run command - create - edit - ls 等等命令和结果按顺序列出来」）。
 *
 * <p>形状和命令行的 {@code zhiqu-cli/src/steps.js} 同一份：
 * {@code { id, kind, title, target, summary, status: running|ok|error, detail?, ms? }}。
 * 代码模式的步骤由宿主（code-host.js）交来，这里照形状收、按上限截；普通聊天的步骤由各个 runner 在这里直接造。
 *
 * <p>一轮一个实例：<b>线程安全</b>（检索的几个 runner、写完回答后的几个 runner 是并行跑的），按 id 去重 ——
 * 同一步先来 running、后来 ok / error，留后来的那条，位置还是第一次出现时的位置。
 *
 * <h2>为什么要截</h2>
 * 这些东西会进库（{@code ai_message.steps_json}）、会原样回给页面。宿主跑的是模型叫起来的命令，输出可以很长；
 * 一轮上百步也不稀奇。每一样都有上限，超了照实说省掉了多少 —— 页面不靠「看起来不长」来保证不卡。
 */
public final class TraceSteps {

    public static final Set<String> KINDS = Set.of("thinking", "list", "read", "search", "run", "create", "edit", "patch", "delete",
            "web", "retrieve", "tasks", "wiki", "plan", "memory", "check", "agent", "todo", "other");
    private static final Set<String> STATUSES = Set.of("running", "ok", "error");

    /** 一轮最多存多少步；再多的只记个数（页面上说「后面还有 N 步没列出」） */
    public static final int MAX_STEPS = 200;
    static final int TITLE_CHARS = 40;
    static final int TARGET_CHARS = 500;
    static final int SUMMARY_CHARS = 200;
    static final int OUTPUT_CHARS = 16_000;
    public static final int THINKING_CHARS = 6_000;
    static final int HUNK_LINES = 400;
    static final int LINE_CHARS = 400;
    static final int FILES = 20;
    static final int ITEMS = 30;

    private final Map<String, Map<String, Object>> steps = new LinkedHashMap<>();
    /** 没存的那几步的 id（同一步先 running、后收尾，两条只算一次 —— review 查出来原来算两次） */
    private final java.util.Set<String> droppedIds = new java.util.HashSet<>();
    private int dropped;

    /** 收一步（新的追加在后面，同一个 id 的替换掉原来那条、位置不变）。 */
    public synchronized void put(Map<String, Object> step) {
        if (step == null) {
            return;
        }
        String id = String.valueOf(step.get("id"));
        if (!steps.containsKey(id) && steps.size() >= MAX_STEPS) {
            if (droppedIds.size() < 10_000 && droppedIds.add(id)) {
                dropped++;
            }
            return;
        }
        steps.put(id, step);
    }

    /** 别处已经截掉、没交过来的步数（命令行存档时一轮超过 200 步的那些）：和这里收满之后丢的一起说 */
    public synchronized void addDropped(long n) {
        if (n > 0) {
            dropped = (int) Math.min(1_000_000L, dropped + n);
        }
    }

    /** 现在的样子：存库、给 done 事件用（拷一份，调用方改不到这里） */
    public synchronized Map<String, Object> snapshot() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("steps", new ArrayList<>(steps.values()));
        if (dropped > 0) {
            out.put("dropped", dropped);
        }
        return out;
    }

    public synchronized boolean isEmpty() {
        return steps.isEmpty();
    }

    /**
     * 这一轮的事务回滚了（出错路径）：COMMIT 里出的那几步（计划 / 记忆 / 知识库草稿）对应的草稿跟着没了 ——
     * 不能还说「等你确认」（review：失败的消息上列着一份不存在的草稿）。
     */
    public synchronized void voidDrafts(String why) {
        for (Map<String, Object> step : steps.values()) {
            Object kind = step.get("kind");
            if (("plan".equals(kind) || "memory".equals(kind) || "wiki".equals(kind)) && String.valueOf(step.get("summary")).contains("等你确认")) {
                step.put("status", "error");
                step.put("summary", clip(why, SUMMARY_CHARS));
            }
        }
    }

    /** 还停在 running 的（这一轮出错 / 被打断时）收成 error，不让页面上一直转 */
    public synchronized void settleRunning(String why) {
        for (Map<String, Object> step : steps.values()) {
            if ("running".equals(step.get("status"))) {
                step.put("status", "error");
                step.put("summary", clip(why, SUMMARY_CHARS));
            }
        }
    }

    /**
     * 点开有东西可看：思考那一步要有原文才算（第一百二十七轮存的只有字数 {chars}，原来也标 hasDetail ——
     * 点开是空的，页面还因此把那条回答的「思考摘要」藏掉了）。
     */
    static boolean hasBody(Object kind, Object detail) {
        if (!(detail instanceof Map<?, ?> d) || d.isEmpty()) {
            return false;
        }
        return !"thinking".equals(kind) || (d.get("text") instanceof String t && !t.isBlank());
    }

    /**
     * 列表接口给的那一份：每一步只留一行（不带 detail，标一个 hasDetail）—— 一页 50 条回答、每条几十步的输出和 diff，
     * 原来每次拉列表（还有流式中断后每 2 秒一次的轮询）都整份下来，线上 1.5 Mbps（review 量过：20 条典型回答 2.3 MB）。
     * 点开一步时再去拿那一步的 detail（{@code GET /api/ai/messages/{id}/steps}）。
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> summaries(Map<String, Object> stored) {
        Map<String, Object> out = new LinkedHashMap<>();
        List<Map<String, Object>> rows = new ArrayList<>();
        if (stored.get("steps") instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> step) {
                    Map<String, Object> row = new LinkedHashMap<>((Map<String, Object>) step);
                    if (hasBody(row.get("kind"), row.remove("detail"))) {
                        row.put("hasDetail", true);
                    }
                    rows.add(row);
                }
            }
        }
        out.put("steps", rows);
        if (stored.get("dropped") != null) {
            out.put("dropped", stored.get("dropped"));
        }
        return out;
    }

    // ── 普通聊天的各个 runner 用 ─────────────────────────────────────────────

    /** 一步（已经做完的）。id 用 runner 自己的名字，同一个 runner 再报一次就是更新 */
    public static Map<String, Object> step(String id, String kind, String title, String target, String summary, boolean ok) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("id", id);
        s.put("kind", KINDS.contains(kind) ? kind : "other");
        s.put("title", clip(title, TITLE_CHARS));
        s.put("target", clip(target, TARGET_CHARS));
        s.put("summary", clip(summary, SUMMARY_CHARS));
        s.put("status", ok ? "ok" : "error");
        return s;
    }

    public static Map<String, Object> running(String id, String kind, String title, String target) {
        Map<String, Object> s = step(id, kind, title, target, "", true);
        s.put("status", "running");
        return s;
    }

    /** 列表类的 detail（检索到的资料标题、联网的结果……） */
    public static Map<String, Object> items(List<String> items) {
        List<String> shown = new ArrayList<>();
        for (String item : items) {
            if (shown.size() >= ITEMS) {
                break;
            }
            shown.add(clip(item, LINE_CHARS));
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("items", shown);
        detail.put("omitted", Math.max(0, items.size() - shown.size()));
        return detail;
    }

    // ── 宿主交来的：照形状收 ─────────────────────────────────────────────────

    /**
     * 宿主交来的一步：只留认得的字段，字符串截断，认不出的种类 / 状态不要。整条不像样（没有 id）就丢掉（null）。
     * 宿主跑的是同一份命令行代码，按理不会出格 —— 但这是从子进程的 stdout 读进来、要存库、要回给页面的东西，不靠「按理」。
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> sanitize(Map<String, Object> raw) {
        if (raw == null || !(raw.get("id") instanceof String id) || id.isBlank() || id.length() > 40) {
            return null;
        }
        Object kind = raw.get("kind");
        Object status = raw.get("status");
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("id", id);
        s.put("kind", kind instanceof String k && KINDS.contains(k) ? k : "other");
        s.put("title", clip(raw.get("title"), TITLE_CHARS));
        s.put("target", clip(raw.get("target"), TARGET_CHARS));
        s.put("summary", clip(raw.get("summary"), SUMMARY_CHARS));
        s.put("status", status instanceof String st && STATUSES.contains(st) ? st : "ok");
        if (raw.get("ms") instanceof Number ms) {
            s.put("ms", Math.max(0L, ms.longValue()));
        }
        if (raw.get("detail") instanceof Map<?, ?> detail) {
            Map<String, Object> d = detail((Map<String, Object>) detail);
            if (!d.isEmpty()) {
                s.put("detail", d);
            }
        }
        return s;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> detail(Map<String, Object> raw) {
        Map<String, Object> d = new LinkedHashMap<>();
        // 运行
        putText(d, raw, "command", TARGET_CHARS * 2);
        putText(d, raw, "cwd", TARGET_CHARS);
        if (raw.containsKey("exitCode")) {
            d.put("exitCode", raw.get("exitCode") instanceof Number n ? n.intValue() : null);
        }
        if (raw.get("output") instanceof String out) {
            // 太长就留头尾（测试的汇总在结尾），中间说省了多少字 —— 原来从头砍，结尾那段一声不响地没了（review）
            // 头尾加起来比上限少一截，留给那句说明：截完一定不超过 OUTPUT_CHARS
            int head = OUTPUT_CHARS / 4, tail = OUTPUT_CHARS * 3 / 4 - 100;
            d.put("output", out.length() > OUTPUT_CHARS
                    ? out.substring(0, head) + "\n… 中间省掉 " + (out.length() - head - tail) + " 字 …\n" + out.substring(out.length() - tail)
                    : out);
        }
        putCount(d, raw, "omitted");
        putCount(d, raw, "splitAt");
        // 读
        putText(d, raw, "path", TARGET_CHARS);
        // 思考：字数，和点开看的原文（第一百二十八轮）
        putCount(d, raw, "chars");
        putText(d, raw, "text", THINKING_CHARS);
        // 改动
        if (raw.get("files") instanceof List<?> files) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Object f : files) {
                if (out.size() >= FILES) {
                    break;
                }
                if (f instanceof Map<?, ?> file) {
                    out.add(file((Map<String, Object>) file));
                }
            }
            d.put("files", out);
            putCount(d, raw, "omittedFiles");
        }
        if (raw.get("deletes") instanceof List<?> deletes) {
            d.put("deletes", strings(deletes, FILES, TARGET_CHARS));
        }
        // 列目录、搜索
        if (raw.get("items") instanceof List<?> items) {
            d.put("items", strings(items, ITEMS, LINE_CHARS));
        }
        // 任务清单
        if (raw.get("todos") instanceof List<?> todos) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Object t : todos) {
                if (out.size() >= ITEMS) {
                    break;
                }
                if (t instanceof Map<?, ?> todo) {
                    Object st = todo.get("status");
                    Map<String, Object> one = new LinkedHashMap<>();
                    one.put("content", clip(todo.get("content"), LINE_CHARS));
                    one.put("status", st instanceof String x && Set.of("pending", "in_progress", "completed").contains(x) ? x : "pending");
                    out.add(one);
                }
            }
            d.put("todos", out);
        }
        return d;
    }

    private static Map<String, Object> file(Map<String, Object> raw) {
        Map<String, Object> f = new LinkedHashMap<>();
        putText(f, raw, "path", TARGET_CHARS);
        putCount(f, raw, "added");
        putCount(f, raw, "removed");
        putCount(f, raw, "omitted");
        if (Boolean.TRUE.equals(raw.get("creating"))) {
            f.put("creating", true);
        }
        putText(f, raw, "movedFrom", TARGET_CHARS);
        if (raw.get("hunks") instanceof List<?> hunks) {
            f.put("hunks", strings(hunks, HUNK_LINES, LINE_CHARS));
        }
        return f;
    }

    private static List<String> strings(List<?> raw, int max, int chars) {
        List<String> out = new ArrayList<>();
        for (Object o : raw) {
            if (out.size() >= max) {
                break;
            }
            if (o instanceof String str) {
                out.add(clip(str, chars));
            }
        }
        return out;
    }

    private static void putText(Map<String, Object> to, Map<String, Object> from, String key, int max) {
        if (from.get(key) instanceof String v && !v.isEmpty()) {
            to.put(key, clip(v, max));
        }
    }

    private static void putCount(Map<String, Object> to, Map<String, Object> from, String key) {
        if (from.get(key) instanceof Number n) {
            to.put(key, Math.max(0L, n.longValue()));
        }
    }

    static String clip(Object value, int max) {
        String s = value == null ? "" : String.valueOf(value);
        return s.length() > max ? s.substring(0, max) + "…" : s;
    }
}
