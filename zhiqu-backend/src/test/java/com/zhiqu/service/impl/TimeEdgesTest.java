package com.zhiqu.service.impl;

import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.ProcessTimeZone;
import com.zhiqu.controller.AuthController;
import com.zhiqu.dto.StudyRecordCreateRequest;
import com.zhiqu.entity.StudyRoutine;
import com.zhiqu.entity.StudyRoutineCheckin;
import com.zhiqu.mapper.StudyRecordMapper;
import com.zhiqu.mapper.StudyRoutineCheckinMapper;
import com.zhiqu.mapper.StudyRoutineMapper;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.AuthService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 时间的极端（第二十一轮）：服务端这一半。浏览器那一半（它自己的「今天」、页面开着跨过零点、番茄钟）在真浏览器里量，
 * 见 docs/rounds/round-21.md；这里钉的是服务端不再相信浏览器算的日期、日历边界上的行为，以及进程的默认时区。
 */
class TimeEdgesTest {

    private static final String ZONE = "Asia/Shanghai";

    @AfterEach
    void clearAuth() {
        SecurityContextHolder.clearContext();
    }

    // ── 打卡 ──────────────────────────────────────────────────────────────

    private final StudyRoutineMapper routines = mock(StudyRoutineMapper.class);
    private final StudyRoutineCheckinMapper checkins = mock(StudyRoutineCheckinMapper.class);

    private RoutineServiceImpl routinesAt(String when, StudyRoutine routine) {
        when(routines.selectOne(any())).thenReturn(routine);
        return new RoutineServiceImpl(routines, checkins, mock(AchievementService.class), BusinessClock.fixedAt(ZONE, when));
    }

    private static StudyRoutine daily(LocalDate start) {
        StudyRoutine r = new StudyRoutine();
        r.setId(7L);
        r.setUserId(1L);
        r.setTitle("晨读");
        r.setFrequency("DAILY");
        r.setStartDate(start);
        r.setEndDate(start.plusDays(60));
        r.setDurationMinutes(20);
        return r;
    }

    private LocalDate insertedCheckDate() {
        ArgumentCaptor<StudyRoutineCheckin> row = ArgumentCaptor.forClass(StudyRoutineCheckin.class);
        verify(checkins).insert(row.capture());
        return row.getValue().getCheckDate();
    }

    @Test
    @DisplayName("打卡：还没到的日子不收（原来什么日期都收 —— UTC+14 的浏览器发来的「明天」照样记上，连续天数跟着乱）")
    void 不给将来打卡() {
        RoutineServiceImpl service = routinesAt("2026-12-31T23:59:59", daily(LocalDate.of(2026, 12, 1)));
        BusinessException e = assertThrows(BusinessException.class,
                () -> service.checkin(1L, 7L, new HashMap<>(Map.of("checkDate", "2027-01-01"))));
        assertTrue(e.getMessage().contains("还没到") && e.getMessage().contains("2026-12-31"), e.getMessage());
        verify(checkins, never()).insert(any(StudyRoutineCheckin.class));
    }

    @Test
    @DisplayName("打卡：跨年那一秒 —— 12-31 23:59:59 的「今天」是 12-31，1-1 00:00:00 的「今天」是 1-1；不给日期就记到服务端的今天")
    void 跨年那一秒() {
        RoutineServiceImpl before = routinesAt("2026-12-31T23:59:59", daily(LocalDate.of(2026, 12, 1)));
        before.checkin(1L, 7L, new HashMap<>());
        assertEquals(LocalDate.of(2026, 12, 31), insertedCheckDate());

        StudyRoutineCheckinMapper fresh = mock(StudyRoutineCheckinMapper.class);
        when(routines.selectOne(any())).thenReturn(daily(LocalDate.of(2026, 12, 1)));
        RoutineServiceImpl after = new RoutineServiceImpl(routines, fresh, mock(AchievementService.class),
                BusinessClock.fixedAt(ZONE, "2027-01-01T00:00:00"));
        assertDoesNotThrow(() -> after.checkin(1L, 7L, new HashMap<>(Map.of("checkDate", "2027-01-01"))));
        ArgumentCaptor<StudyRoutineCheckin> row = ArgumentCaptor.forClass(StudyRoutineCheckin.class);
        verify(fresh).insert(row.capture());
        assertEquals(LocalDate.of(2027, 1, 1), row.getValue().getCheckDate());
    }

    @Test
    @DisplayName("打卡：补打过去的照旧可以（零点过后补昨晚的）")
    void 补打昨天() {
        RoutineServiceImpl service = routinesAt("2027-01-01T00:05:00", daily(LocalDate.of(2026, 12, 1)));
        assertDoesNotThrow(() -> service.checkin(1L, 7L, new HashMap<>(Map.of("checkDate", "2026-12-31"))));
        assertEquals(LocalDate.of(2026, 12, 31), insertedCheckDate());
    }

    // ── 学习记录（番茄钟） ──────────────────────────────────────────────────

    private final SysUserMapper users = mock(SysUserMapper.class);

    private StudyRecordServiceImpl recordsAt(String when) {
        return new StudyRecordServiceImpl(mock(StudyRecordMapper.class), users, mock(StudyTaskMapper.class),
                mock(AchievementService.class), BusinessClock.fixedAt(ZONE, when));
    }

    private static StudyRecordCreateRequest record(LocalDate day) {
        StudyRecordCreateRequest r = new StudyRecordCreateRequest();
        r.setStudyDate(day);
        r.setDurationMinutes(25);
        return r;
    }

    @Test
    @DisplayName("学习记录：不给日期记到服务端的今天（番茄钟不再自己算日期）；记到将来的不收 —— 连续天数的 SQL 只往前挪，一条将来的记录会把它冻住")
    void 学习记录的日期() {
        StudyRecordServiceImpl service = recordsAt("2028-02-29T23:30:00");
        service.create(1L, record(null));
        verify(users).addStudyMinutesAndRefreshStreak(eq(1L), eq(25), eq(LocalDate.of(2028, 2, 29)));

        BusinessException e = assertThrows(BusinessException.class, () -> service.create(1L, record(LocalDate.of(2028, 3, 1))));
        assertTrue(e.getMessage().contains("还没到"), e.getMessage());
        BusinessException far = assertThrows(BusinessException.class, () -> service.create(1L, record(LocalDate.of(2029, 2, 28))));
        assertTrue(far.getMessage().contains("2028-02-29"), "电脑时钟快一年：要说出服务端的今天 —— " + far.getMessage());
        verify(users, never()).addStudyMinutesAndRefreshStreak(anyLong(), anyInt(), eq(LocalDate.of(2028, 3, 1)));
    }

    // ── /auth/info 的业务时钟 ─────────────────────────────────────────────

    @Test
    @DisplayName("/auth/info 带回业务时钟：时区、今天、此刻（毫秒）、偏移 —— 页面据此算「今天」、本机时钟差多少、把服务端的时间换成时刻")
    void 业务时钟给页面() {
        AuthService auth = mock(AuthService.class);
        when(auth.info(1L)).thenReturn(Map.of("id", 1L, "username", "u"));
        BusinessClock clock = BusinessClock.fixedAt(ZONE, "2026-12-31T23:59:59");
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(1L, null, List.of()));
        Map<String, Object> data = new AuthController(auth, null, null, clock).info().getData();
        @SuppressWarnings("unchecked")
        Map<String, Object> c = (Map<String, Object>) data.get("clock");
        assertEquals("Asia/Shanghai", c.get("zone"));
        assertEquals("2026-12-31", c.get("today"));
        assertEquals(480, c.get("offsetMinutes"));
        long now = ((Number) c.get("now")).longValue();
        assertTrue(Math.abs(now - System.currentTimeMillis()) < 60_000, "now 是服务器此刻的毫秒：" + now);
        assertEquals("u", data.get("username"), "原来的字段照旧都在");
    }

    // ── 进程默认时区 ──────────────────────────────────────────────────────

    @Test
    @DisplayName("启动时进程默认时区 = 业务时区（原来跟着机器走：Docker 默认 UTC，晚上 21:38 提交的东西页面上写 13:38）")
    void 进程时区钉成业务时区() {
        TimeZone saved = TimeZone.getDefault();
        String savedProp = System.getProperty("user.timezone");
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
            assertEquals(ZoneId.of("Asia/Shanghai"), ProcessTimeZone.apply(new MockEnvironment()), "没配就是默认业务时区");
            assertEquals("Asia/Shanghai", TimeZone.getDefault().getID());
            LocalDateTime wall = LocalDateTime.now();
            assertTrue(Math.abs(java.time.Duration.between(wall, LocalDateTime.now(ZoneId.of("Asia/Shanghai"))).toMinutes()) < 1,
                    "裸的 LocalDateTime.now() 就是业务时区的钟面");
            ProcessTimeZone.apply(new MockEnvironment().withProperty("app.timezone", "Pacific/Kiritimati"));
            assertEquals("Pacific/Kiritimati", TimeZone.getDefault().getID(), "配了什么就是什么（和 BusinessClock 同一个键）");
        } finally {
            TimeZone.setDefault(saved);
            if (savedProp == null) System.clearProperty("user.timezone"); else System.setProperty("user.timezone", savedProp);
        }
    }

    @Test
    @DisplayName("数据库会话时区默认设成业务时区的偏移（MySQL 自己填的 created_at 原来按数据库的时区，UTC 时和 Java 写的差 8 小时）；部署自己配了就不动")
    void 数据库会话时区() {
        MockEnvironment env = new MockEnvironment();
        ProcessTimeZone.defaultDatabaseSessionZone(env, ZoneId.of("Asia/Shanghai"));
        assertEquals("SET time_zone = '+08:00'", env.getProperty("spring.datasource.hikari.connection-init-sql"));
        MockEnvironment utc = new MockEnvironment();
        ProcessTimeZone.defaultDatabaseSessionZone(utc, ZoneId.of("UTC"));
        assertEquals("SET time_zone = '+00:00'", utc.getProperty("spring.datasource.hikari.connection-init-sql"), "UTC 的偏移写成 +00:00（MySQL 不认 Z）");
        MockEnvironment own = new MockEnvironment().withProperty("spring.datasource.hikari.connection-init-sql", "SELECT 1");
        ProcessTimeZone.defaultDatabaseSessionZone(own, ZoneId.of("Asia/Shanghai"));
        assertEquals("SELECT 1", own.getProperty("spring.datasource.hikari.connection-init-sql"), "部署自己配的不能被换掉");
    }

    @Test
    @DisplayName("main 真的挂上了 ProcessTimeZone（只测它自己的话，删掉 main 里那一行照样绿）")
    void main挂上了() throws Exception {
        String main = com.zhiqu.SourceText.stripComments(java.nio.file.Files.readString(
                java.nio.file.Path.of("src/main/java/com/zhiqu/ZhiquApplication.java")));
        assertTrue(main.contains(".addListeners(new ProcessTimeZone())"), "ZhiquApplication.main 没有挂 ProcessTimeZone");
        assertTrue(main.indexOf(".addListeners(new ProcessTimeZone())") < main.indexOf(".run(args)"), "要在 run 之前挂");
    }
}
