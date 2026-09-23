package com.zhiqu.cli;

import java.util.ArrayList;
import java.util.List;

/**
 * 逐行 diff（最长公共子序列），输出成带上下文的分块 —— 终端里的草稿确认看的就是它。
 *
 * <p>与网页确认框（{@code zhiqu-api.js} 的 {@code diffLines}）同一个算法、同一个预算：
 * 行数乘积超过 {@link #BUDGET} 就不逐行比，退回「整份新内容」并<b>明说</b>退回了。
 * O(n·m) 的表在大文件上会把终端卡住，而卡住比没有 diff 糟得多。
 */
public final class LineDiff {

    public static final long BUDGET = 2000L * 2000L;

    /** 一行：{@code ' '} 不变、{@code '-'} 删去、{@code '+'} 新增。 */
    public record Op(char kind, String text) {
    }

    private LineDiff() {
    }

    /** 逐行比较；超出预算返回 {@code null}。 */
    public static List<Op> diff(String oldText, String newText) {
        String[] a = split(oldText);
        String[] b = split(newText);
        if ((long) a.length * b.length > BUDGET) {
            return null;
        }
        int m = a.length, n = b.length;
        int[][] t = new int[m + 1][n + 1];
        for (int i = m - 1; i >= 0; i--) {
            for (int j = n - 1; j >= 0; j--) {
                t[i][j] = a[i].equals(b[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
            }
        }
        List<Op> out = new ArrayList<>();
        int i = 0, j = 0;
        while (i < m && j < n) {
            if (a[i].equals(b[j])) {
                out.add(new Op(' ', a[i++]));
                j++;
            } else if (t[i + 1][j] >= t[i][j + 1]) {
                out.add(new Op('-', a[i++]));
            } else {
                out.add(new Op('+', b[j++]));
            }
        }
        while (i < m) out.add(new Op('-', a[i++]));
        while (j < n) out.add(new Op('+', b[j++]));
        return out;
    }

    /**
     * 可打印的分块：{@code @@ 第 N 行 @@} 起头，每块前后各带 {@code context} 行不变的上下文。
     * 两处改动之间隔得近（≤ 2·context 行）就并成一块。内容完全相同时返回空列表。
     */
    public static List<String> hunks(String oldText, String newText, int context) {
        List<Op> ops = diff(oldText, newText);
        List<String> out = new ArrayList<>();
        if (ops == null) {
            out.add("（文件太大，不逐行比较 —— 以下是完整的新内容）");
            for (String line : split(newText)) out.add("+" + line);
            return out;
        }
        // 每一行在旧文件里的行号（新增行记「它插在哪一行之前」），分块标题就用它
        int[] oldNo = new int[ops.size()];
        int line = 1;
        for (int x = 0; x < ops.size(); x++) {
            oldNo[x] = line;
            if (ops.get(x).kind() != '+') line++;
        }
        int x = 0;
        while (x < ops.size()) {
            if (ops.get(x).kind() == ' ') {
                x++;
                continue;
            }
            int from = Math.max(0, x - context);
            int lastChange = x;
            int y = x;
            while (y < ops.size()) {
                if (ops.get(y).kind() != ' ') {
                    lastChange = y;
                } else if (y - lastChange > 2 * context) {
                    break;
                }
                y++;
            }
            int to = Math.min(ops.size(), lastChange + context + 1);
            out.add("@@ 第 " + oldNo[from] + " 行 @@");
            for (int z = from; z < to; z++) {
                out.add(ops.get(z).kind() + ops.get(z).text());
            }
            x = to;
        }
        return out;
    }

    private static String[] split(String text) {
        String s = text == null ? "" : text;
        if (s.isEmpty()) return new String[0];
        if (s.endsWith("\n")) s = s.substring(0, s.length() - 1);
        return s.split("\n", -1);
    }
}
