package com.zhiqu.service.impl;

import com.zhiqu.security.ClientIpResolver;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 监管后台「近 15 分钟请求量」的桶（第七十七轮）：原来只给有请求的那几分钟，柱状图只画出两三根挨在一起的柱子，时间轴是断的。
 * 现在一分钟一个桶、没有请求的记 0、按时间先后、最后一个是现在这一分钟。
 */
class TrafficMinuteBucketsTest {

    @Test
    @DisplayName("近 15 分钟：15 个桶按时间先后、没有请求的分钟记 0、最后一个是现在这一分钟、请求都数进去了")
    @SuppressWarnings("unchecked")
    void 十五个桶() {
        InMemoryTrafficMonitorService monitor = new InMemoryTrafficMonitorService(new ClientIpResolver());
        for (int i = 0; i < 3; i++) {
            MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/task/list");
            request.setRemoteAddr("127.0.0.1");
            monitor.record(request, 200, 5);
        }
        DateTimeFormatter hhmm = DateTimeFormatter.ofPattern("HH:mm");
        String before = LocalDateTime.now(ZoneId.systemDefault()).format(hhmm);
        Map<String, Long> buckets = (Map<String, Long>) monitor.snapshot().get("minuteBuckets");
        String after = LocalDateTime.now(ZoneId.systemDefault()).format(hhmm);
        List<String> keys = new ArrayList<>(buckets.keySet());
        assertEquals(15, keys.size(), "不是 15 个桶：" + keys);
        String last = keys.get(14);
        assertTrue(last.equals(before) || last.equals(after), "最后一个桶不是现在这一分钟：" + keys + "（现在 " + before + "）");
        LocalDateTime t = LocalDateTime.now(ZoneId.systemDefault()).withSecond(0).withNano(0);
        if (!last.equals(t.format(hhmm))) t = t.minusMinutes(1);   // 正好跨过一分钟
        for (int i = 14; i >= 0; i--, t = t.minusMinutes(1)) {
            assertEquals(t.format(hhmm), keys.get(i), "桶不是一分钟一个、按先后排：" + keys);
        }
        assertEquals(3L, buckets.values().stream().mapToLong(Long::longValue).sum(), "三个请求没有都数进去：" + buckets);
        assertEquals(14L, buckets.values().stream().filter(v -> v == 0L).count(), "没有请求的分钟应当记 0（14 个）：" + buckets);
    }
}
