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
import java.util.function.Function;
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

    /**
     * 查一遍还没解锁的成就，达到条件的解锁。
     *
     * <p>登录、建任务、完成任务、记学习、建例行计划、打卡 —— 每一次都会走到这里，而且大多在那次写入的事务里。
     * 原来它把这个人<b>全部</b>任务和学习记录整行取回来（加密的标题、描述、备注一起），只为了数个数：
     * 几千条记录的用户每点一下都要搬几千行，全部成就都解锁了也照搬不误。
     * 现在是 COUNT，而且<b>按需</b>：只查还没解锁的成就用得到的那几种计数，每种最多一次；全解锁了一条都不查。
     */
    @Override
    @Transactional
    @DeadlockRetry
    public List<Map<String, Object>> checkAndUnlock(Long userId, String trigger) {
        List<AchievementDef> defs = achievementDefMapper.selectList(new LambdaQueryWrapper<>());
        List<UserAchievement> unlocked = userAchievementMapper.selectList(
                new LambdaQueryWrapper<UserAchievement>().eq(UserAchievement::getUserId, userId)
        );
        Set<Long> unlockedIds = unlocked.stream().map(UserAchievement::getAchievementId).collect(Collectors.toSet());
        List<AchievementDef> locked = defs.stream().filter(def -> !unlockedIds.contains(def.getId())).toList();
        if (locked.isEmpty()) {
            return List.of();
        }

        SysUser user = sysUserMapper.selectById(userId);
        Map<String, Long> counts = new HashMap<>();
        Function<String, Long> count = type -> counts.computeIfAbsent(type, t -> count(userId, t));

        List<Map<String, Object>> newUnlocked = new ArrayList<>();
        int addedPoints = 0;
        for (AchievementDef def : locked) {
            if (!reached(def, user, count)) {
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

    /** 一种计数一条 COUNT。软删除由 {@code @TableLogic} 照旧排除（学习记录没有软删除，原来也是全算）。 */
    private long count(Long userId, String type) {
        return switch (type) {
            case "TASK_CREATED_COUNT" -> studyTaskMapper.selectCount(new LambdaQueryWrapper<StudyTask>()
                    .eq(StudyTask::getUserId, userId));
            case "TASK_DONE_COUNT" -> studyTaskMapper.selectCount(new LambdaQueryWrapper<StudyTask>()
                    .eq(StudyTask::getUserId, userId)
                    .eq(StudyTask::getStatus, 2));
            case "STUDY_RECORD_COUNT" -> studyRecordMapper.selectCount(new LambdaQueryWrapper<StudyRecord>()
                    .eq(StudyRecord::getUserId, userId));
            case "STUDY_DAY_COUNT" -> studyRecordMapper.countStudyDays(userId);
            case "ROUTINE_COUNT" -> studyRoutineMapper.selectCount(new LambdaQueryWrapper<StudyRoutine>()
                    .eq(StudyRoutine::getUserId, userId));
            case "ROUTINE_CHECKIN_COUNT" -> studyRoutineCheckinMapper.selectCount(new LambdaQueryWrapper<StudyRoutineCheckin>()
                    .eq(StudyRoutineCheckin::getUserId, userId)
                    .eq(StudyRoutineCheckin::getStatus, 1));
            default -> 0L;
        };
    }

    private boolean reached(AchievementDef def, SysUser user, Function<String, Long> count) {
        if (def.getConditionType() == null || def.getConditionValue() == null) {
            return false;
        }
        return switch (def.getConditionType()) {
            case "LOGIN_COUNT" -> def.getConditionValue() <= 1;
            case "TASK_CREATED_COUNT", "TASK_DONE_COUNT", "STUDY_RECORD_COUNT", "STUDY_DAY_COUNT",
                 "ROUTINE_COUNT", "ROUTINE_CHECKIN_COUNT" -> count.apply(def.getConditionType()) >= def.getConditionValue();
            case "CONSECUTIVE_DAYS" -> (user != null ? Optional.ofNullable(user.getConsecutiveDays()).orElse(0) : 0) >= def.getConditionValue();
            case "TOTAL_STUDY_MINUTES" -> (user != null ? Optional.ofNullable(user.getTotalStudyMinutes()).orElse(0) : 0) >= def.getConditionValue();
            default -> false;
        };
    }
}
