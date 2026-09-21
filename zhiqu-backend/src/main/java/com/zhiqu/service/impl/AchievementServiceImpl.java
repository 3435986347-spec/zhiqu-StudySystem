package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AchievementDef;
import com.zhiqu.entity.StudyRecord;
import com.zhiqu.entity.StudyRoutine;
import com.zhiqu.entity.StudyRoutineCheckin;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.SysUser;
import com.zhiqu.entity.UserAchievement;
import com.zhiqu.mapper.AchievementDefMapper;
import com.zhiqu.mapper.StudyRecordMapper;
import com.zhiqu.mapper.StudyRoutineCheckinMapper;
import com.zhiqu.mapper.StudyRoutineMapper;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserAchievementMapper;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.concurrency.DeadlockRetry;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

@Service
public class AchievementServiceImpl implements AchievementService {
    private final AchievementDefMapper achievementDefMapper;
    private final UserAchievementMapper userAchievementMapper;
    private final SysUserMapper sysUserMapper;
    private final StudyTaskMapper studyTaskMapper;
    private final StudyRecordMapper studyRecordMapper;
    private final StudyRoutineMapper studyRoutineMapper;
    private final StudyRoutineCheckinMapper studyRoutineCheckinMapper;

    public AchievementServiceImpl(AchievementDefMapper achievementDefMapper, UserAchievementMapper userAchievementMapper,
                                  SysUserMapper sysUserMapper,
                                  StudyTaskMapper studyTaskMapper,
                                  StudyRecordMapper studyRecordMapper,
                                  StudyRoutineMapper studyRoutineMapper,
                                  StudyRoutineCheckinMapper studyRoutineCheckinMapper) {
        this.achievementDefMapper = achievementDefMapper;
        this.userAchievementMapper = userAchievementMapper;
        this.sysUserMapper = sysUserMapper;
        this.studyTaskMapper = studyTaskMapper;
        this.studyRecordMapper = studyRecordMapper;
        this.studyRoutineMapper = studyRoutineMapper;
        this.studyRoutineCheckinMapper = studyRoutineCheckinMapper;
    }

    @Override
    public List<Map<String, Object>> listWithStatus(Long userId) {
        List<AchievementDef> defs = achievementDefMapper.selectList(new LambdaQueryWrapper<>());
        List<UserAchievement> unlocked = userAchievementMapper.selectList(
                new LambdaQueryWrapper<UserAchievement>().eq(UserAchievement::getUserId, userId)
        );
        Set<Long> unlockedIds = unlocked.stream().map(UserAchievement::getAchievementId).collect(Collectors.toSet());
        Map<Long, LocalDateTime> unlockedTimeMap = unlocked.stream()
                .collect(Collectors.toMap(UserAchievement::getAchievementId, UserAchievement::getUnlockedAt, (a, _b) -> a));

        List<Map<String, Object>> result = new ArrayList<>();
        for (AchievementDef def : defs) {
            Map<String, Object> item = new HashMap<>();
            item.put("id", def.getId());
            item.put("code", def.getCode());
            item.put("name", def.getName());
            item.put("description", def.getDescription());
            item.put("icon", def.getIcon() == null ? "" : def.getIcon());
            item.put("points", def.getPoints() == null ? 0 : def.getPoints());
            item.put("unlocked", unlockedIds.contains(def.getId()));
            item.put("unlockedAt", unlockedTimeMap.get(def.getId()));
            result.add(item);
        }
        return result;
    }

    @Override
    @Transactional
    @DeadlockRetry
    public List<Map<String, Object>> checkAndUnlock(Long userId, String trigger) {
        List<AchievementDef> defs = achievementDefMapper.selectList(new LambdaQueryWrapper<>());
        List<UserAchievement> unlocked = userAchievementMapper.selectList(
                new LambdaQueryWrapper<UserAchievement>().eq(UserAchievement::getUserId, userId)
        );
        Set<Long> unlockedIds = unlocked.stream().map(UserAchievement::getAchievementId).collect(Collectors.toSet());

        SysUser user = sysUserMapper.selectById(userId);
        List<StudyTask> tasks = studyTaskMapper.selectList(new LambdaQueryWrapper<StudyTask>().eq(StudyTask::getUserId, userId));
        List<StudyRecord> records = studyRecordMapper.selectList(new LambdaQueryWrapper<StudyRecord>().eq(StudyRecord::getUserId, userId));
        long doneTaskCount = tasks.stream().filter(t -> t.getStatus() != null && t.getStatus() == 2).count();
        long createdTaskCount = tasks.size();
        long studyRecordCount = records.size();
        long studyDayCount = records.stream()
                .map(StudyRecord::getStudyDate)
                .filter(Objects::nonNull)
                .distinct()
                .count();
        long routineCount = studyRoutineMapper.selectCount(new LambdaQueryWrapper<StudyRoutine>()
                .eq(StudyRoutine::getUserId, userId));
        long routineCheckinCount = studyRoutineCheckinMapper.selectCount(new LambdaQueryWrapper<StudyRoutineCheckin>()
                .eq(StudyRoutineCheckin::getUserId, userId)
                .eq(StudyRoutineCheckin::getStatus, 1));

        List<Map<String, Object>> newUnlocked = new ArrayList<>();
        int addedPoints = 0;
        for (AchievementDef def : defs) {
            if (unlockedIds.contains(def.getId())) {
                continue;
            }
            boolean reached = reached(def, user, doneTaskCount, createdTaskCount, studyRecordCount, studyDayCount, routineCount, routineCheckinCount);
            if (!reached) {
                continue;
            }
            LocalDateTime unlockedAt = LocalDateTime.now();
            int inserted = userAchievementMapper.insertIgnore(userId, def.getId(), unlockedAt);
            if (inserted <= 0) {
                continue;
            }
            addedPoints += def.getPoints() == null ? 0 : def.getPoints();
            newUnlocked.add(Map.of(
                    "achievementId", def.getId(),
                    "code", def.getCode(),
                    "name", def.getName(),
                    "points", def.getPoints() == null ? 0 : def.getPoints(),
                    "trigger", trigger == null ? "" : trigger
            ));
        }

        if (addedPoints > 0 && user != null) {
            sysUserMapper.addAchievementPoints(userId, addedPoints);
        }
        return newUnlocked;
    }

    private boolean reached(AchievementDef def,
                            SysUser user,
                            long doneTaskCount,
                            long createdTaskCount,
                            long studyRecordCount,
                            long studyDayCount,
                            long routineCount,
                            long routineCheckinCount) {
        if (def.getConditionType() == null || def.getConditionValue() == null) {
            return false;
        }
        return switch (def.getConditionType()) {
            case "LOGIN_COUNT" -> def.getConditionValue() <= 1;
            case "TASK_CREATED_COUNT" -> createdTaskCount >= def.getConditionValue();
            case "TASK_DONE_COUNT" -> doneTaskCount >= def.getConditionValue();
            case "STUDY_RECORD_COUNT" -> studyRecordCount >= def.getConditionValue();
            case "STUDY_DAY_COUNT" -> studyDayCount >= def.getConditionValue();
            case "ROUTINE_COUNT" -> routineCount >= def.getConditionValue();
            case "ROUTINE_CHECKIN_COUNT" -> routineCheckinCount >= def.getConditionValue();
            case "CONSECUTIVE_DAYS" -> (user != null ? Optional.ofNullable(user.getConsecutiveDays()).orElse(0) : 0) >= def.getConditionValue();
            case "TOTAL_STUDY_MINUTES" -> (user != null ? Optional.ofNullable(user.getTotalStudyMinutes()).orElse(0) : 0) >= def.getConditionValue();
            default -> false;
        };
    }
}
