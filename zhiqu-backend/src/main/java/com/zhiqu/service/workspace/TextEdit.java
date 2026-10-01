package com.zhiqu.service.workspace;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 「按原文替换一段」—— 纯函数，不碰文件。网页 code agent 的 {@code write_workspace_file} 替换用法走它；
 * npm 版 zhiqu 的 {@code write_file} 替换用法（{@code zhiqu-cli/src/tools/edit.js}）是同一套规矩，
 * 两边跑同一份 {@code conformance/text-edit.json}（{@code TextEditConformanceTest} 与 {@code edit-conformance.test.js}）。
 *
 * <h2>为什么网页这边要有它（第十轮）</h2>
 * <p>原来 {@code write_workspace_file} 只收「修改后的完整内容」：改一个 800 行文件里的三行，模型要把 800 行一字不差地
 * 重写一遍 —— 顺手改掉别处、漏掉一段、撞上单次输出上限被截断，都是这里来的。改一小段就该只给那一小段。
 *
 * <h2>规矩</h2>
 * <ul>
 *   <li>old 必须一字不差、只出现一次；出现几处时说出行号，{@code replaceAll} 才全换；</li>
 *   <li>全是 {@code \r\n} 的文件在统一成 {@code \n} 的文本里比、换，写回去变回 {@code \r\n}；混着两种换行的照原样比；</li>
 *   <li>没找到时给线索：先按「忽略空白」找同样的几行，找到就说第几行、原文是什么；找不到再看第一行在哪。</li>
 * </ul>
 */
public final class TextEdit {

    private TextEdit() {
    }

    /** 两边一样的空白集合 —— 写死，不用 {@code \s}：Java 与 JS 的 {@code \s} 范围不同，一致性用例会分叉。 */
    private static final Pattern WS = Pattern.compile("[ \\t\\n\\r\\f\\u000B\\u00A0\\u3000]+");
    private static final Pattern LONE_LF = Pattern.compile("(^|[^\\r])\\n");
    private static final int SHOW_CHARS = 2000;

    public enum Kind { EMPTY_OLD, NOT_FOUND, AMBIGUOUS }

    /** 没找到时的线索。{@code kind} 是 {@code whitespace}（只差空白，{@code from..to} 行）或 {@code first_line}（第一行在 {@code at}）。 */
    public record Hint(String kind, int from, int to, int at, String text) {
    }

    public record Error(Kind kind, Hint hint, int count, List<Integer> lines) {
    }

    /** 成功时 {@code error == null}。 */
    public record Result(String text, int replaced, Error error) {
        public boolean ok() {
            return error == null;
        }
    }

    public static Result apply(String text, String oldStr, String newStr, boolean replaceAll) {
        String old = oldStr == null ? "" : oldStr;
        if (old.isEmpty()) {
            return new Result(null, 0, new Error(Kind.EMPTY_OLD, null, 0, List.of()));
        }
        boolean crlf = text.contains("\r\n") && !LONE_LF.matcher(text).find();
        String hay = crlf ? text.replace("\r\n", "\n") : text;
        String needle = crlf ? old.replace("\r\n", "\n") : old;
        String replacement = newStr == null ? "" : (crlf ? newStr.replace("\r\n", "\n") : newStr);
        List<Integer> at = new ArrayList<>();
        for (int i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length())) {
            at.add(i);
        }
        if (at.isEmpty()) {
            return new Result(null, 0, new Error(Kind.NOT_FOUND, hintFor(hay, needle), 0, List.of()));
        }
        if (at.size() > 1 && !replaceAll) {
            List<Integer> lines = at.stream().map(i -> lineAt(hay, i)).toList();
            return new Result(null, 0, new Error(Kind.AMBIGUOUS, null, at.size(), lines));
        }
        StringBuilder out = new StringBuilder(hay.length());
        int from = 0;
        for (int i : at) {
            out.append(hay, from, i).append(replacement);
            from = i + needle.length();
        }
        out.append(hay, from, hay.length());
        String next = out.toString();
        return new Result(crlf ? next.replace("\n", "\r\n") : next, at.size(), null);
    }

    /** 拒绝的原因说给模型听：在哪、原文是什么、该怎么改。 */
    public static String describe(Error error, String path) {
        return switch (error.kind()) {
            case EMPTY_OLD -> "old_string 不能为空";
            case AMBIGUOUS -> {
                List<Integer> shown = error.lines().subList(0, Math.min(12, error.lines().size()));
                yield "old_string 在 " + path + " 里出现了 " + error.count() + " 处（第 "
                        + String.join("、", shown.stream().map(String::valueOf).toList())
                        + (error.lines().size() > 12 ? " …" : "") + " 行）。"
                        + "只改其中一处就多带几行上下文让它唯一；要全部替换就加 replace_all: true。";
            }
            case NOT_FOUND -> {
                Hint h = error.hint();
                if (h != null && "whitespace".equals(h.kind())) {
                    yield "old_string 在 " + path + " 里没有一字不差的原文，但第 " + h.from() + "–" + h.to()
                            + " 行只差空白（缩进、空格或行尾空白不一样）。那几行的原文是（照这个抄，缩进也要一样）：\n" + h.text();
                }
                if (h != null && "first_line".equals(h.kind())) {
                    yield "old_string 在 " + path + " 里没找到。它的第一行出现在第 " + h.at()
                            + " 行，但后面对不上 —— 那一段可能已经被改过了。第 " + h.at() + " 行起现在是：\n" + h.text()
                            + "\n先按现在的内容重新拼 old_string。";
                }
                yield "old_string 在 " + path + " 里没找到（空格、缩进、换行都要一字不差）。"
                        + "先 read_workspace_file 看一下现在的原文，不要凭记忆拼。";
            }
        };
    }

    private static String squash(String line) {
        return WS.matcher(line).replaceAll(" ").replaceAll("^ +| +$", "");
    }

    private static int lineAt(String text, int index) {
        int n = 1;
        for (int i = 0; i < index; i++) {
            if (text.charAt(i) == '\n') {
                n++;
            }
        }
        return n;
    }

    private static Hint hintFor(String text, String needle) {
        // split(…, -1)：保留末尾的空串，和 JS 的 split('\n') 一样
        List<String> lines = Arrays.asList(text.split("\n", -1));
        List<String> want = new ArrayList<>(Arrays.stream(needle.split("\n", -1)).map(TextEdit::squash).toList());
        while (!want.isEmpty() && want.get(0).isEmpty()) {
            want.remove(0);
        }
        while (!want.isEmpty() && want.get(want.size() - 1).isEmpty()) {
            want.remove(want.size() - 1);
        }
        if (want.isEmpty()) {
            return null;
        }
        for (int i = 0; i + want.size() <= lines.size(); i++) {
            boolean same = true;
            for (int k = 0; k < want.size() && same; k++) {
                same = squash(lines.get(i + k)).equals(want.get(k));
            }
            if (same) {
                return new Hint("whitespace", i + 1, i + want.size(), 0, show(lines, i, i + want.size()));
            }
        }
        String first = want.get(0);
        for (int i = 0; i < lines.size(); i++) {
            String s = squash(lines.get(i));
            if (s.equals(first) || (first.length() >= 8 && s.contains(first))) {
                return new Hint("first_line", 0, 0, i + 1, show(lines, i, i + want.size() + 2));
            }
        }
        return null;
    }

    private static String show(List<String> lines, int from, int to) {
        String block = String.join("\n", lines.subList(from, Math.min(to, lines.size())));
        return block.length() > SHOW_CHARS ? block.substring(0, SHOW_CHARS) + "\n…" : block;
    }
}
