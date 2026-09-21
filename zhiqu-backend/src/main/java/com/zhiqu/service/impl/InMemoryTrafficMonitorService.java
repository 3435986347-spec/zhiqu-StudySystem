package com.zhiqu.service.impl;

import com.zhiqu.service.TrafficMonitorService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class InMemoryTrafficMonitorService implements TrafficMonitorService {
    private static final int MAX_EVENTS = 800;
    private static final DateTimeFormatter MINUTE_FORMAT = DateTimeFormatter.ofPattern("HH:mm");
    private final Object lock = new Object();
    private final ArrayDeque<TrafficEvent> events = new ArrayDeque<>();

    @Override
    public void record(HttpServletRequest request, int status, long durationMs) {
        String path = request.getRequestURI();
        if (shouldIgnore(path)) {
            return;
        }
        TrafficEvent event = new TrafficEvent(
                System.currentTimeMillis(),
                request.getMethod(),
                path,
                status,
                durationMs,
                clientIp(request),
                limit(request.getHeader("User-Agent"), 180)
        );
        synchronized (lock) {
            events.addLast(event);
            while (events.size() > MAX_EVENTS) {
                events.removeFirst();
            }
        }
    }

    @Override
    public Map<String, Object> snapshot() {
        List<TrafficEvent> copy;
        synchronized (lock) {
            copy = new ArrayList<>(events);
        }
        long now = System.currentTimeMillis();
        long oneMinuteAgo = now - 60_000;
        long fifteenMinutesAgo = now - 15 * 60_000;
        long oneHourAgo = now - 60 * 60_000;

        long total = copy.size();
        long lastMinute = copy.stream().filter(e -> e.timestamp >= oneMinuteAgo).count();
        long last15Minutes = copy.stream().filter(e -> e.timestamp >= fifteenMinutesAgo).count();
        long errors = copy.stream().filter(e -> e.status >= 400).count();
        double averageLatency = copy.stream().mapToLong(e -> e.durationMs).average().orElse(0);
        Set<String> ips = new HashSet<>();
        copy.stream().filter(e -> e.timestamp >= oneHourAgo).forEach(e -> ips.add(e.ip));

        Map<Integer, Long> statusMap = new LinkedHashMap<>();
        copy.forEach(e -> statusMap.merge(statusBucket(e.status), 1L, Long::sum));

        Map<String, Long> minuteMap = new LinkedHashMap<>();
        copy.stream()
                .filter(e -> e.timestamp >= fifteenMinutesAgo)
                .forEach(e -> minuteMap.merge(formatMinute(e.timestamp), 1L, Long::sum));

        Map<String, Long> pathMap = new HashMap<>();
        copy.forEach(e -> pathMap.merge(e.method + " " + e.path, 1L, Long::sum));
        List<Map<String, Object>> hotPaths = pathMap.entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                .limit(8)
                .map(e -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("path", e.getKey());
                    row.put("count", e.getValue());
                    return row;
                })
                .toList();

        List<Map<String, Object>> recent = copy.stream()
                .sorted(Comparator.comparingLong((TrafficEvent e) -> e.timestamp).reversed())
                .limit(80)
                .map(this::toMap)
                .toList();

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("totalRecorded", total);
        result.put("lastMinute", lastMinute);
        result.put("last15Minutes", last15Minutes);
        result.put("errorCount", errors);
        result.put("averageLatencyMs", Math.round(averageLatency));
        result.put("uniqueIpLastHour", ips.size());
        result.put("statusBuckets", statusMap);
        result.put("minuteBuckets", minuteMap);
        result.put("hotPaths", hotPaths);
        result.put("recent", recent);
        return result;
    }

    private boolean shouldIgnore(String path) {
        return path.startsWith("/css/")
                || path.startsWith("/js/")
                || path.startsWith("/uploads/")
                || path.endsWith(".ico")
                || path.endsWith(".png")
                || path.endsWith(".jpg")
                || path.endsWith(".jpeg")
                || path.endsWith(".webp");
    }

    private Map<String, Object> toMap(TrafficEvent event) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("time", LocalDateTime.ofInstant(java.time.Instant.ofEpochMilli(event.timestamp), ZoneId.systemDefault()).toString());
        row.put("method", event.method);
        row.put("path", event.path);
        row.put("status", event.status);
        row.put("durationMs", event.durationMs);
        row.put("ip", event.ip);
        row.put("userAgent", event.userAgent);
        return row;
    }

    private int statusBucket(int status) {
        return Math.max(1, status / 100) * 100;
    }

    private String formatMinute(long timestamp) {
        return LocalDateTime.ofInstant(java.time.Instant.ofEpochMilli(timestamp), ZoneId.systemDefault()).format(MINUTE_FORMAT);
    }

    private String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        String realIp = request.getHeader("X-Real-IP");
        if (realIp != null && !realIp.isBlank()) {
            return realIp.trim();
        }
        return request.getRemoteAddr();
    }

    private String limit(String value, int maxLength) {
        if (value == null) {
            return "";
        }
        return value.length() <= maxLength ? value : value.substring(0, maxLength);
    }

    private record TrafficEvent(long timestamp, String method, String path, int status, long durationMs, String ip, String userAgent) {
    }
}
