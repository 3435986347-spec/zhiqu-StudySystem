package com.zhiqu.service.impl;

import com.zhiqu.common.BusinessClock;
import com.zhiqu.mapper.StudyRecordMapper;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.AchievementService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 学习时长趋势：连续的一段、没学的那格是 0、周按 ISO 且跨年不串、键排得对、与服务器语言无关。
 * 窗口的计算用固定的「今天」判；SQL 那一半在 {@code StudyCountingIntegrationTest}。
 */
class StudyTrendTest {

    private final StudyRecordMapper records = mock(StudyRecordMapper.class);
    private final StudyRecordServiceImpl service = new StudyRecordServiceImpl(records, mock(SysUserMapper.class),
            mock(StudyTaskMapper.class), mock(AchievementService.class), new BusinessClock("Asia/Shanghai"));

    private static Map<String, Object> day(LocalDate date, int minutes, boolean sqlDate) {
        return Map.of("studyDate", sqlDate ? java.sql.Date.valueOf(date) : date, "minutes", java.math.BigDecimal.valueOf(minutes));
    }

    private static List<Object> column(List<Map<String, Object>> rows, String key) {
        List<Object> out = new ArrayList<>();
        rows.forEach(r -> out.add(r.get(key)));
        return out;
    }

    @Test
    @DisplayName("周：跨年那一周（2024-12-30 属于 2025 年第 1 周）归到一起，不会和一年前的第 1 周合并；与服务器语言无关")
    void 周视图跨年() {
        Locale saved = Locale.getDefault();
        Locale.setDefault(Locale.US);   // en_US 的一周从周日开始 —— 原来的实现会跟着它变
        try {
            LocalDate today = LocalDate.of(2025, 1, 8);
            when(records.minutesByDay(anyLong(), any(), any())).thenReturn(List.of(
                    day(LocalDate.of(2024, 11, 25), 5, true),
                    day(LocalDate.of(2024, 12, 31), 30, false),
                    day(LocalDate.of(2025, 1, 5), 20, true)));   // 周日：ISO 里属于 12-30 那一周
            List<Map<String, Object>> got = service.trend(1L, "week", today);

            assertEquals(List.of("2024-W48", "2024-W49", "2024-W50", "2024-W51", "2024-W52", "2025-W01", "2025-W02"),
                    column(got, "period"));
            assertEquals(List.of(5, 0, 0, 0, 0, 50, 0), column(got, "minutes"));
            assertEquals(List.of("第48周", "第49周", "第50周", "第51周", "第52周", "第1周", "第2周"), column(got, "label"));
            verify(records).minutesByDay(eq(1L), eq(LocalDate.of(2024, 11, 25)), eq(today));
        } finally {
            Locale.setDefault(saved);
        }
    }

    @Test
    @DisplayName("日：最近 14 天连续排好，没学的那天是 0，窗口外的不查")
    void 日视图连续补零() {
        LocalDate today = LocalDate.of(2026, 9, 25);
        when(records.minutesByDay(anyLong(), any(), any())).thenReturn(List.of(
                day(LocalDate.of(2026, 9, 12), 10, true),
                day(LocalDate.of(2026, 9, 24), 50, true),
                day(LocalDate.of(2026, 9, 25), 60, false)));
        List<Map<String, Object>> got = service.trend(1L, "day", today);

        assertEquals(StudyRecordServiceImpl.TREND_DAYS, got.size());
        assertEquals("2026-09-12", got.get(0).get("period"));
        assertEquals("9/12", got.get(0).get("label"));
        assertEquals(10, got.get(0).get("minutes"));
        assertEquals(0, got.get(8).get("minutes"), "没学的那天要占一格、是 0");
        assertEquals(List.of(50, 60), column(got, "minutes").subList(12, 14));
        List<Object> periods = column(got, "period");
        List<Object> sorted = new ArrayList<>(periods);
        sorted.sort(null);
        assertEquals(sorted, periods, "按时间顺序排");
        verify(records).minutesByDay(eq(1L), eq(LocalDate.of(2026, 9, 12)), eq(today));
    }

    @Test
    @DisplayName("月：最近 6 个月跨年连续，键补零、按时间排")
    void 月视图跨年() {
        LocalDate today = LocalDate.of(2026, 3, 15);
        when(records.minutesByDay(anyLong(), any(), any())).thenReturn(List.of(day(LocalDate.of(2025, 12, 31), 40, true)));
        List<Map<String, Object>> got = service.trend(1L, "month", today);

        assertEquals(List.of("2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"), column(got, "period"));
        assertEquals(List.of("10月", "11月", "12月", "1月", "2月", "3月"), column(got, "label"));
        assertEquals(List.of(0, 0, 40, 0, 0, 0), column(got, "minutes"));
    }

    @Test
    @DisplayName("周的键补零：W05 … W11 按字符串排也是时间顺序（原来 W10 排在 W5 前面）")
    void 周键补零() {
        List<Map<String, Object>> got = service.trend(1L, "week", LocalDate.of(2026, 3, 11));
        assertEquals(List.of("2026-W05", "2026-W06", "2026-W07", "2026-W08", "2026-W09", "2026-W10", "2026-W11"),
                column(got, "period"));
    }
}
