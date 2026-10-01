package com.zhiqu.service.impl;

import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.DateRange;
import com.zhiqu.controller.DashboardController;
import com.zhiqu.entity.StudyRoutine;
import com.zhiqu.entity.StudyRoutineCheckin;
import com.zhiqu.mapper.StudyRoutineCheckinMapper;
import com.zhiqu.mapper.StudyRoutineMapper;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.TaskReminderMapper;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.privacy.TaskPrivacyService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 例行计划与首页的两件事：按日期逐天展开的区间有上限；早八那一次查「今天打过卡没有」不再一条一查。
 */
class RoutineRangeAndReminderTest {

    private final StudyRoutineMapper routines = mock(StudyRoutineMapper.class);
    private final StudyRoutineCheckinMapper checkins = mock(StudyRoutineCheckinMapper.class);
    private final RoutineServiceImpl service = new RoutineServiceImpl(routines, checkins, mock(AchievementService.class),
            new BusinessClock("Asia/Shanghai"));

    @AfterEach
    void clearAuth() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("区间上限：正好 366 天可以，多一天拒绝并说清上限")
    void 区间上限() {
        LocalDate from = LocalDate.of(2026, 1, 1);
        assertDoesNotThrow(() -> DateRange.requireWithin(from, from.plusDays(DateRange.MAX_DAYS - 1)));
        BusinessException e = assertThrows(BusinessException.class, () -> DateRange.requireWithin(from, from.plusDays(DateRange.MAX_DAYS)));
        assertTrue(e.getMessage().contains("最多 366 天"), e.getMessage());
    }

    @Test
    @DisplayName("例行计划实例：一百年的区间直接拒绝，一条查询都不发")
    void 例行计划实例区间有上限() {
        assertThrows(BusinessException.class,
                () -> service.instances(1L, LocalDate.of(2000, 1, 1), LocalDate.of(2100, 12, 31)));
        verifyNoInteractions(routines, checkins);
    }

    @Test
    @DisplayName("首页：一百年的区间直接拒绝，一条查询都不发")
    void 首页区间有上限() {
        StudyTaskMapper tasks = mock(StudyTaskMapper.class);
        RoutineService routineService = mock(RoutineService.class);
        DashboardController dashboard = new DashboardController(tasks, mock(TaskReminderMapper.class), routineService,
                mock(TaskPrivacyService.class), new BusinessClock("Asia/Shanghai"));
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(1L, null, List.of()));
        assertThrows(BusinessException.class, () -> dashboard.overview("2000-01-01", "2100-12-31"));
        verifyNoInteractions(tasks, routineService);
    }

    private static StudyRoutine daily(long id, long userId) {
        StudyRoutine r = new StudyRoutine();
        r.setId(id);
        r.setUserId(userId);
        r.setTitle("计划" + id);
        r.setFrequency("DAILY");
        r.setStartDate(LocalDate.of(2026, 1, 1));
        return r;
    }

    private static StudyRoutineCheckin done(long userId, long routineId) {
        StudyRoutineCheckin c = new StudyRoutineCheckin();
        c.setUserId(userId);
        c.setRoutineId(routineId);
        c.setStatus(1);
        return c;
    }

    @Test
    @DisplayName("早八：今天打过卡的不提醒；打卡按一批查，不再一条计划一次查询")
    void 早八打卡批量查() {
        StudyRoutine weekly = daily(3, 1);
        weekly.setFrequency("WEEKLY");
        weekly.setDaysOfWeek("7");   // 只在周日；2026-09-25 是周五
        when(routines.selectList(any())).thenReturn(List.of(daily(1, 1), daily(2, 2), weekly));
        when(checkins.selectList(any())).thenReturn(List.of(done(1, 1)));

        List<Map<String, Object>> due = service.reminderInstances(LocalDate.of(2026, 9, 25));

        assertEquals(List.of(2L), due.stream().map(r -> ((Number) r.get("routineId")).longValue()).toList(),
                "只剩没打卡、今天该做的那一条：" + due);
        verify(checkins, times(1)).selectList(any());
        verify(checkins, never()).selectOne(any());
    }

    @Test
    @DisplayName("别人的打卡不算：同一个计划 id 的打卡属于另一个用户时，照样提醒")
    void 打卡要对上用户() {
        when(routines.selectList(any())).thenReturn(List.of(daily(1, 1)));
        when(checkins.selectList(any())).thenReturn(List.of(done(99, 1)));
        assertEquals(1, service.reminderInstances(LocalDate.of(2026, 9, 25)).size());
    }

    @Test
    @DisplayName("计划很多：按 500 条一批查（IN 列表不无限长）")
    void 分批() {
        List<StudyRoutine> many = new ArrayList<>();
        for (long i = 1; i <= 1200; i++) {
            many.add(daily(i, i));
        }
        when(routines.selectList(any())).thenReturn(many);
        when(checkins.selectList(any())).thenReturn(List.of());
        assertEquals(1200, service.reminderInstances(LocalDate.of(2026, 9, 25)).size());
        verify(checkins, times(3)).selectList(any());
    }
}
