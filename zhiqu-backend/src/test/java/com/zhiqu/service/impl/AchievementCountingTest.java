package com.zhiqu.service.impl;

import com.zhiqu.entity.AchievementDef;
import com.zhiqu.entity.SysUser;
import com.zhiqu.entity.UserAchievement;
import com.zhiqu.mapper.AchievementDefMapper;
import com.zhiqu.mapper.StudyRecordMapper;
import com.zhiqu.mapper.StudyRoutineCheckinMapper;
import com.zhiqu.mapper.StudyRoutineMapper;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserAchievementMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 成就检查的代价：登录、建任务、完成任务、记学习、打卡都会走到它，大多在那次写入的事务里。
 * 这里钉的是「花多少」—— 不把整行取回来数、全解锁了一条都不查、每种计数最多查一次。
 * 「算得对不对」由 {@code AchievementCountEquivalenceIntegrationTest} 用真库对照原来的算法。
 */
class AchievementCountingTest {

    private final AchievementDefMapper defs = mock(AchievementDefMapper.class);
    private final UserAchievementMapper unlocked = mock(UserAchievementMapper.class);
    private final SysUserMapper users = mock(SysUserMapper.class);
    private final StudyTaskMapper tasks = mock(StudyTaskMapper.class);
    private final StudyRecordMapper records = mock(StudyRecordMapper.class);
    private final StudyRoutineMapper routines = mock(StudyRoutineMapper.class);
    private final StudyRoutineCheckinMapper checkins = mock(StudyRoutineCheckinMapper.class);
    private final AchievementServiceImpl service = new AchievementServiceImpl(defs, unlocked, users, tasks, records, routines, checkins);

    private static AchievementDef def(long id, String type, int value) {
        AchievementDef d = new AchievementDef();
        d.setId(id);
        d.setCode("a" + id);
        d.setName("成就" + id);
        d.setPoints(10);
        d.setConditionType(type);
        d.setConditionValue(value);
        return d;
    }

    private static final List<AchievementDef> EVERY_TYPE = List.of(
            def(1, "TASK_CREATED_COUNT", 3), def(2, "TASK_DONE_COUNT", 1), def(3, "STUDY_RECORD_COUNT", 1),
            def(4, "STUDY_DAY_COUNT", 7), def(5, "ROUTINE_COUNT", 1), def(6, "ROUTINE_CHECKIN_COUNT", 7),
            def(7, "CONSECUTIVE_DAYS", 3), def(8, "TOTAL_STUDY_MINUTES", 600), def(9, "LOGIN_COUNT", 1));

    @Test
    @DisplayName("数个数用 COUNT：不把这个人的任务、学习记录整行取回来")
    void 不把整行取回来数() {
        when(defs.selectList(any())).thenReturn(EVERY_TYPE);
        when(users.selectById(anyLong())).thenReturn(new SysUser());
        when(tasks.selectCount(any())).thenReturn(5L);
        when(records.selectCount(any())).thenReturn(5L);
        when(records.countStudyDays(anyLong())).thenReturn(7L);
        when(routines.selectCount(any())).thenReturn(1L);
        when(checkins.selectCount(any())).thenReturn(0L);
        when(unlocked.insertIgnore(anyLong(), anyLong(), any())).thenReturn(1);

        List<String> got = new ArrayList<>();
        service.checkAndUnlock(1L, "test").forEach(m -> got.add(String.valueOf(m.get("code"))));

        verify(tasks, never()).selectList(any());
        verify(records, never()).selectList(any());
        assertEquals(List.of("a1", "a2", "a3", "a4", "a5", "a9"), got, "计数到了的解锁、没到的不解锁");
    }

    @Test
    @DisplayName("成就全解锁了：一条计数都不查（原来照样把全部任务和记录搬一遍）")
    void 全解锁了一条都不查() {
        when(defs.selectList(any())).thenReturn(EVERY_TYPE);
        List<UserAchievement> all = new ArrayList<>();
        for (AchievementDef d : EVERY_TYPE) {
            UserAchievement ua = new UserAchievement();
            ua.setAchievementId(d.getId());
            all.add(ua);
        }
        when(unlocked.selectList(any())).thenReturn(all);

        assertTrue(service.checkAndUnlock(1L, "task_created").isEmpty());
        verifyNoInteractions(tasks, records, routines, checkins, users);
    }

    @Test
    @DisplayName("按需：只查还没解锁的成就用得到的计数，同一种只查一次")
    void 按需而且每种一次() {
        when(defs.selectList(any())).thenReturn(List.of(def(1, "TASK_CREATED_COUNT", 3), def(2, "TASK_CREATED_COUNT", 10)));
        when(tasks.selectCount(any())).thenReturn(4L);
        when(unlocked.insertIgnore(anyLong(), anyLong(), any())).thenReturn(1);

        assertEquals(1, service.checkAndUnlock(1L, "task_created").size());
        verify(tasks, times(1)).selectCount(any());
        verifyNoInteractions(records, routines, checkins);
    }
}
