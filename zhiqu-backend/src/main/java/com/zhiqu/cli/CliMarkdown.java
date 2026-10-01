package com.zhiqu.cli;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 在终端里渲染模型的 Markdown 回答 —— 流式地。
 *
 * <p>由来（2026-09-24）：用户说「CLI 为什么还要输出 Markdown，要么渲染，要么就输出纯文本」。
 * 原来 {@code message.delta} 原样打印，于是表格是一堆 {@code |}、标题是 {@code ##}、加粗是 {@code **}。
 *
 * <h2>两种输出</h2>
 * <ul>
 *   <li>{@code color = true}（交互终端）：标题加粗、列表圆点、引用竖线、代码块加框、表格按列对齐、
 *       行内加粗 / 代码上色。</li>
 *   <li>{@code color = false}（被管道接走、{@code NO_COLOR}）：<b>纯文本</b> —— 标记去掉，结构保留。</li>
 * </ul>
 *
 * <h2>流式怎么不卡</h2>
 *
 * <p>普通段落<b>边收边出</b>：行首几个字符看清不是块标记之后就开始输出，行内的 {@code **} / {@code `}
 * 用一个小状态机处理 —— 标记被拆在两次增量之间（先来一个 {@code *}，下次再来一个）也不会错。
 * 只有需要看全才能排版的才攒：表格攒到表结束再按列对齐，其余块攒到一行结束。
 */
public final class CliMarkdown {

    private final PrintStream out;
    private final boolean color;

    private final StringBuilder line = new StringBuilder();
    /** 这一行已经判定是普通段落、正在边收边出。 */
    private boolean streamingParagraph;
    private boolean inCode;
    private final List<String> table = new ArrayList<>();
    /** 行内状态：加粗、行内代码是否打开；以及一个被拆开的 {@code *} 待定。 */
    private boolean bold;
    private boolean inlineCode;
    private boolean pendingStar;

    public CliMarkdown(PrintStream out, boolean color) {
        this.out = out;
        this.color = color;
    }

    /** 喂一段增量。 */
    public void feed(String delta) {
        if (delta == null) return;
        for (int i = 0; i < delta.length(); i++) {
            char c = delta.charAt(i);
            if (c == '\r') continue;
            if (c == '\n') {
                endLine();
                continue;
            }
            if (streamingParagraph) {
                inline(c);
            } else {
                line.append(c);
                decideParagraph();
            }
        }
        out.flush();
    }

    /** 流结束：把没收完的行和表格都吐出来。 */
    public void finish() {
        if (streamingParagraph || line.length() > 0) {
            endLine();
        }
        flushTable();
        if (inCode) {
            out.println(dim("└─"));
            inCode = false;
        }
        out.flush();
    }

    // ── 行 ────────────────────────────────────────────────────────────────

    private static final Pattern BLOCK_START = Pattern.compile(
            "^(#{1,6}|\\||`{1,3}|[-*+](\\s|$)|>|\\d+[.)]|-{2,}|\\*{2,}|_{3,})");

    /** 行首积累到能判断时：不是块标记就进入「边收边出」。 */
    private void decideParagraph() {
        // 代码块、表格里一律按行攒：它们要看全一行（表格要看全一整块）才能排版
        if (inCode || !table.isEmpty()) return;
        String s = line.toString();
        String t = s.stripLeading();
        if (t.isEmpty()) return;
        // 是块标记，或者还太短、可能长成块标记（只来了「#」「1」「-」）—— 继续攒
        if (BLOCK_START.matcher(t).lookingAt() || couldStillBeBlock(t)) return;
        streamingParagraph = true;
        line.setLength(0);
        for (int i = 0; i < s.length(); i++) inline(s.charAt(i));
    }

    /** 这几个字符还可能长成块标记吗（比如只来了一个「#」或「1」）。 */
    private static boolean couldStillBeBlock(String t) {
        return t.length() < 4 && t.chars().allMatch(ch -> ch == '#' || ch == '-' || ch == '*' || ch == '`'
                || ch == '|' || ch == '>' || ch == '+' || ch == '_' || Character.isDigit(ch) || ch == '.' || ch == ')');
    }

    private void endLine() {
        if (streamingParagraph) {
            closeInline();
            out.println();
            streamingParagraph = false;
            return;
        }
        String s = line.toString();
        line.setLength(0);
        block(s);
    }

    private void block(String s) {
        String t = s.strip();
        if (inCode) {
            if (t.startsWith("```")) {
                out.println(dim("└─"));
                inCode = false;
            } else {
                out.println(dim("│ ") + s);
            }
            return;
        }
        if (t.startsWith("|")) {
            table.add(t);
            return;
        }
        flushTable();
        if (t.startsWith("```")) {
            String lang = t.substring(3).trim();
            out.println(dim("┌─" + (lang.isEmpty() ? "" : " " + lang)));
            inCode = true;
            return;
        }
        if (t.isEmpty()) {
            out.println();
            return;
        }
        Matcher h = Pattern.compile("^(#{1,6})\\s+(.*)$").matcher(t);
        if (h.matches()) {
            String text = inlineAll(h.group(2));
            out.println(color ? "\u001b[1m" + text + "\u001b[0m" : text);
            return;
        }
        if (t.matches("^(-{3,}|\\*{3,}|_{3,})$")) {
            out.println(dim("────────────"));
            return;
        }
        Matcher li = Pattern.compile("^(\\s*)[-*+]\\s+(.*)$").matcher(s);
        if (li.matches()) {
            out.println(li.group(1) + "  • " + inlineAll(li.group(2)));
            return;
        }
        Matcher ol = Pattern.compile("^(\\s*)(\\d+[.)])\\s+(.*)$").matcher(s);
        if (ol.matches()) {
            out.println(ol.group(1) + "  " + ol.group(2) + " " + inlineAll(ol.group(3)));
            return;
        }
        if (t.startsWith(">")) {
            out.println(dim("│ ") + inlineAll(t.substring(1).stripLeading()));
            return;
        }
        out.println(inlineAll(s));
    }

    // ── 表格 ──────────────────────────────────────────────────────────────

    private void flushTable() {
        if (table.isEmpty()) return;
        List<List<String>> rows = new ArrayList<>();
        for (String r : table) {
            String body = r.strip();
            if (body.startsWith("|")) body = body.substring(1);
            if (body.endsWith("|")) body = body.substring(0, body.length() - 1);
            List<String> cells = new ArrayList<>();
            for (String c : body.split("\\|", -1)) cells.add(inlineAll(c.strip()));
            rows.add(cells);
        }
        table.clear();
        int cols = rows.stream().mapToInt(List::size).max().orElse(0);
        int[] width = new int[cols];
        for (List<String> r : rows) {
            if (isSeparator(r)) continue;
            for (int i = 0; i < r.size(); i++) width[i] = Math.max(width[i], displayWidth(r.get(i)));
        }
        boolean header = rows.size() > 1 && isSeparator(rows.get(1));
        for (int ri = 0; ri < rows.size(); ri++) {
            List<String> r = rows.get(ri);
            if (isSeparator(r)) {
                StringBuilder sep = new StringBuilder();
                for (int i = 0; i < cols; i++) {
                    if (i > 0) sep.append("─┼─");
                    sep.append("─".repeat(width[i]));
                }
                out.println(dim(sep.toString()));
                continue;
            }
            StringBuilder row = new StringBuilder();
            for (int i = 0; i < cols; i++) {
                String cell = i < r.size() ? r.get(i) : "";
                if (i > 0) row.append(dim(" │ "));
                String padded = cell + " ".repeat(Math.max(0, width[i] - displayWidth(cell)));
                row.append(header && ri == 0 && color ? "\u001b[1m" + padded + "\u001b[0m" : padded);
            }
            out.println(row.toString().stripTrailing());
        }
    }

    private static boolean isSeparator(List<String> r) {
        return !r.isEmpty() && r.stream().allMatch(c -> c.matches(":?-{2,}:?"));
    }

    /** 终端里占几格：中日韩全角字符占两格，ANSI 转义不占格。 */
    static int displayWidth(String s) {
        String plain = s.replaceAll("\u001b\\[[0-9;]*m", "");
        int w = 0;
        for (int i = 0; i < plain.length(); ) {
            int cp = plain.codePointAt(i);
            w += isWide(cp) ? 2 : 1;
            i += Character.charCount(cp);
        }
        return w;
    }

    private static boolean isWide(int cp) {
        return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3)
                || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60)
                || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF) || (cp >= 0x20000 && cp <= 0x3FFFD);
    }

    // ── 行内 ──────────────────────────────────────────────────────────────

    /** 一整行的行内渲染（块级元素用）。 */
    private String inlineAll(String s) {
        String r = s;
        r = r.replaceAll("\\[([^\\]]+)]\\(([^)]+)\\)", color ? "$1 \u001b[2m($2)\u001b[0m" : "$1 ($2)");
        r = r.replaceAll("\\*\\*([^*]+)\\*\\*", color ? "\u001b[1m$1\u001b[0m" : "$1");
        r = r.replaceAll("`([^`]+)`", color ? "\u001b[36m$1\u001b[0m" : "$1");
        return r;
    }

    /** 边收边出的段落：逐字符处理 {@code **} 与 {@code `}，被拆开的 {@code *} 先挂着。 */
    private void inline(char c) {
        if (pendingStar) {
            pendingStar = false;
            if (c == '*') {
                bold = !bold;
                if (color) out.print(bold ? "\u001b[1m" : "\u001b[22m");
                return;
            }
            out.print('*');
        }
        if (c == '*' && !inlineCode) {
            pendingStar = true;
            return;
        }
        if (c == '`') {
            inlineCode = !inlineCode;
            if (color) out.print(inlineCode ? "\u001b[36m" : "\u001b[39m");
            return;
        }
        out.print(c);
    }

    private void closeInline() {
        if (pendingStar) {
            out.print('*');
            pendingStar = false;
        }
        if (color && (bold || inlineCode)) out.print("\u001b[0m");
        bold = false;
        inlineCode = false;
    }

    private String dim(String s) {
        return color ? "\u001b[2m" + s + "\u001b[0m" : s;
    }
}
