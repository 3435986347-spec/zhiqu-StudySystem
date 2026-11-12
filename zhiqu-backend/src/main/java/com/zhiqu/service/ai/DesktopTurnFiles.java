package com.zhiqu.service.ai;

import com.zhiqu.common.BusinessException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 桌面应用把本机这一轮存回网站（第一百三十一轮）。文件在用户自己的电脑上，这里只存草稿正文，
 * 确认时由外壳写盘。路径只收相对路径：服务器不拿它去碰磁盘，但存进库的形状要和网页那份草稿一样，不能是 {@code ../}。
 */
public final class DesktopTurnFiles {

    public static final int MAX_FILES = 40;
    public static final int MAX_FILE_CHARS = 1_000_000;
    public static final int MAX_TOTAL_CHARS = 8_000_000;
    public static final String ABSENT = "ABSENT";

    private DesktopTurnFiles() {
    }

    public record Parsed(String message, String conclusion, Long notebookId, Map<String, Object> steps,
                         List<Map<String, Object>> files, String folder, String command) {
    }

    /** 相对路径：没有 {@code ..}、没有盘符、没有反斜杠。空段也不行 */
    public static boolean relativePath(String path) {
        if (path == null || path.isEmpty() || path.length() > 512) {
            return false;
        }
        if (path.indexOf('\0') >= 0 || path.indexOf('\\') >= 0 || path.charAt(0) == '/') {
            return false;
        }
        for (String part : path.split("/", -1)) {
        if (part.isEmpty() || ".".equals(part) || "..".equals(part)) {
            return false;
        }
        }
        return true;
    }

    @SuppressWarnings("unchecked")
    public static Parsed parse(Map<String, Object> body) {
        if (body == null) {
            throw new BusinessException("消息不能为空");
        }
        String message = text(body.get("message"));
        if (message.isBlank()) {
            throw new BusinessException("消息不能为空");
        }
        if (message.length() > 200_000) {
            throw new BusinessException("这句话太长了");
        }
        String conclusion = text(body.get("conclusion"));
        if (conclusion.length() > 100_000) {
            conclusion = conclusion.substring(0, 100_000);
        }
        List<Map<String, Object>> files = files(body.get("drafts"));
        String folder = text(body.get("folder"));
        if (!files.isEmpty() && (folder.isBlank() || folder.length() > 1024 || folder.indexOf('\n') >= 0 || folder.indexOf('\0') >= 0)) {
            throw new BusinessException("没说写进哪个文件夹");
        }
        String command = text(body.get("command"));
        if (!command.equals("init") && !command.equals("review")) {
            command = "";
        }
        return new Parsed(message, conclusion, notebookId(body.get("notebookId")), steps(body.get("steps")), files, folder, command);
    }

    private static Long notebookId(Object raw) {
        String text = raw == null ? "" : String.valueOf(raw).trim();
        if (text.isEmpty() || "null".equals(text)) {
            return null;
        }
        try {
            return Long.valueOf(text);
        } catch (NumberFormatException e) {
            throw new BusinessException("Notebook 不存在");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> steps(Object raw) {
        TraceSteps steps = new TraceSteps();
        Object list = raw instanceof Map<?, ?> map ? map.get("steps") : raw;
        if (list instanceof List<?> rows) {
            for (Object row : rows) {
                if (row instanceof Map<?, ?> map) {
                    Map<String, Object> clean = TraceSteps.sanitize((Map<String, Object>) map);
                    if (clean != null) {
                        steps.put(clean);
                    }
                }
            }
        }
        if (raw instanceof Map<?, ?> map && map.get("dropped") instanceof Number n) {
            steps.addDropped(n.longValue());
        }
        return steps.snapshot();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> files(Object raw) {
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list)) {
            throw new BusinessException("草稿的格式不对");
        }
        if (list.size() > MAX_FILES) {
            throw new BusinessException("一次最多 " + MAX_FILES + " 个文件");
        }
        List<Map<String, Object>> out = new ArrayList<>();
        Set<String> seen = new java.util.HashSet<>();
        long total = 0;
        for (Object row : list) {
            if (!(row instanceof Map<?, ?> map)) {
                throw new BusinessException("草稿的格式不对");
            }
            String path = text(map.get("path"));
            if (!relativePath(path)) {
                throw new BusinessException("这个路径不能存：" + path);
            }
            if (!seen.add(path)) {
                throw new BusinessException("同一个文件出现了两次：" + path);
            }
            String content = map.get("content") == null ? "" : String.valueOf(map.get("content"));
            if (content.length() > MAX_FILE_CHARS) {
                throw new BusinessException(path + " 太大了");
            }
            total += content.length();
            if (total > MAX_TOTAL_CHARS) {
                throw new BusinessException("这一批草稿太大了");
            }
            String baseline = text(map.get("baseline"));
            if (baseline.isEmpty()) {
                baseline = ABSENT;
            }
            if (!ABSENT.equals(baseline) && !baseline.matches("[0-9a-f]{64}")) {
                throw new BusinessException("基线不对：" + path);
            }
            Map<String, Object> file = new LinkedHashMap<>();
            file.put("path", path);
            file.put("content", content);
            file.put("baseline", baseline);
            file.put("creating", Boolean.TRUE.equals(map.get("creating")) || ABSENT.equals(baseline));
            if (map.get("newDirectories") instanceof List<?> dirs) {
                List<String> kept = new ArrayList<>();
                for (Object dir : dirs) {
                    String one = text(dir);
                    if (relativePath(one)) {
                        kept.add(one);
                    }
                }
                file.put("newDirectories", kept);
            } else {
                file.put("newDirectories", List.of());
            }
            out.add(file);
        }
        return out;
    }

    private static String text(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }
}
