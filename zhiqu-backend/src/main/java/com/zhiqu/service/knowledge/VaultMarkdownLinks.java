package com.zhiqu.service.knowledge;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The vault and graph use the same link grammar; examples in code remain literal. */
public final class VaultMarkdownLinks {
    private static final Pattern LINKS = Pattern.compile("(!?)\\[\\[([^\\]\\n]+)]]|(!?)\\[([^\\]\\n]*)]\\(((?:<[^>\\n]+>|(?:[^()\\n]|\\([^()\\n]*\\))+))\\)");
    private static final Pattern FENCE = Pattern.compile("^ {0,3}(`{3,}|~{3,}).*$");
    private VaultMarkdownLinks() { }

    public record Link(boolean image, boolean wiki, String target, String anchor, String label, String original) { }

    public static List<Link> read(String markdown) {
        List<Link> links = new ArrayList<>();
        rewrite(markdown, link -> { links.add(link); return link.original(); });
        return links;
    }

    public static String rewrite(String markdown, Function<Link, String> mapper) {
        if (markdown == null || markdown.isEmpty()) return markdown == null ? "" : markdown;
        StringBuilder out = new StringBuilder();
        char fence = 0;
        int fenceLength = 0;
        for (String line : markdown.split("(?<=\\n)", -1)) {
            Matcher fm = FENCE.matcher(line.stripTrailing());
            if (fm.matches()) {
                String marker = fm.group(1);
                if (fence == 0) { fence = marker.charAt(0); fenceLength = marker.length(); }
                else if (marker.charAt(0) == fence && marker.length() >= fenceLength
                        && line.strip().matches("[" + fence + "]+")) { fence = 0; }
                out.append(line);
            } else if (fence != 0) {
                out.append(line);
            } else {
                int start = 0;
                for (int i = 0; i < line.length(); i++) {
                    if (line.charAt(i) != '`' || escaped(line, i)) continue;
                    int end = i;
                    while (end < line.length() && line.charAt(end) == '`') end++;
                    String marker = line.substring(i, end);
                    int close = line.indexOf(marker, end);
                    if (close < 0) continue;
                    out.append(rewriteText(line.substring(start, i), mapper));
                    out.append(line, i, close + marker.length());
                    i = close + marker.length() - 1;
                    start = i + 1;
                }
                out.append(rewriteText(line.substring(start), mapper));
            }
        }
        return out.toString();
    }

    private static String rewriteText(String text, Function<Link, String> mapper) {
        Matcher matcher = LINKS.matcher(text);
        StringBuilder out = new StringBuilder();
        int end = 0;
        while (matcher.find()) {
            if (escaped(text, matcher.start())) continue;
            boolean wiki = matcher.group(2) != null;
            boolean image = "!".equals(matcher.group(wiki ? 1 : 3));
            String raw = matcher.group(wiki ? 2 : 5).trim();
            String label = wiki ? null : matcher.group(4);
            if (wiki && raw.contains("|")) {
                label = raw.substring(raw.indexOf('|') + 1);
                raw = raw.substring(0, raw.indexOf('|'));
            }
            if (!wiki && raw.startsWith("<") && raw.endsWith(">")) raw = raw.substring(1, raw.length() - 1);
            if (!wiki && raw.matches(".*\\s+[\"'].+")) continue; // Optional Markdown title: keep rather than mis-resolve.
            String anchor = raw.contains("#") ? raw.substring(raw.indexOf('#')) : "";
            String target = raw.contains("#") ? raw.substring(0, raw.indexOf('#')) : raw;
            out.append(text, end, matcher.start());
            String replacement = mapper.apply(new Link(image, wiki, target.trim(), anchor, label, matcher.group()));
            out.append(replacement == null ? matcher.group() : replacement);
            end = matcher.end();
        }
        return out.append(text, end, text.length()).toString();
    }

    private static boolean escaped(String text, int offset) {
        int slashes = 0;
        while (--offset >= 0 && text.charAt(offset) == '\\') slashes++;
        return (slashes & 1) != 0;
    }
}
