package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AchievementDef;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.SysUser;
import com.zhiqu.entity.UserAchievement;
import com.zhiqu.mapper.AchievementDefMapper;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserAchievementMapper;
import com.zhiqu.service.AchievementService;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

@Service
public class AchievementServiceImpl implements AchievementService {
    private final AchievementDefMapper achievementDefMapper;
    private final UserAchievementMapper userAchievementMapper;
    private final SysUserMapper sysUserMapper;
    private final StudyTaskMapper studyTaskMapper;

    public AchievementServiceImpl(AchievementDefMapper achievementDefMapper, UserAchievementMapper userAchievementMapper,
                                  SysUserMapper sysUserMapper, StudyTaskMapper studyTaskMapper) {
        this.achievementDefMapper = achievementDefMapper;
        this.userAchievementMapper = userAchievementMapper;
        this.sysUserMapper = sysUserMapper;
        this.studyTaskMapper = studyTaskMapper;
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
    public List<Map<String, Object>> checkAndUnlock(Long userId, String trigger) {
        List<AchievementDef> defs = achievementDefMapper.selectList(new LambdaQueryWrapper<>());
        List<UserAchievement> unlocked = userAchievementMapper.selectList(
                new LambdaQueryWrapper<UserAchievement>().eq(UserAchievement::getUserId, userId)
        );
        Set<Long> unlockedIds = unlocked.stream().map(UserAchievement::getAchievementId).collect(Collectors.toSet());

        SysUser user = sysUserMapper.selectById(userId);
        List<StudyTask> tasks = studyTaskMapper.selectList(new LambdaQueryWrapper<StudyTask>().eq(StudyTask::getUserId, userId));
        long doneTaskCount = tasks.stream().filter(t -> t.getStatus() != null && t.getStatus() == 2).count();

        List<Map<String, Object>> newUnlocked = new ArrayList<>();
        int addedPoints = 0;
        for (AchievementDef def : defs) {
            if (unlockedIds.contains(def.getId())) {
                continue;
            }
            boolean reached = reached(def, user, doneTaskCount);
            if (!reached) {
                continue;
            }
            UserAchievement ua = new UserAchievement();
            ua.setUserId(userId);
            ua.setAchievementId(def.getId());
            ua.setUnlockedAt(LocalDateTime.now());
            userAchievementMapper.insert(ua);
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
            int current = user.getAchievementPoints() == null ? 0 : user.getAchievementPoints();
            user.setAchievementPoints(current + addedPoints);
            sysUserMapper.updateById(user);
        }
        return newUnlocked;
    }

    private boolean reached(AchievementDef def, SysUser user, long doneTaskCount) {
        if (def.getConditionType() == null || def.getConditionValue() == null) {
            return false;
        }
        return switch (def.getConditionType()) {
            case "LOGIN_COUNT" -> def.getConditionValue() <= 1;
            case "TASK_DONE_COUNT" -> doneTaskCount >= def.getConditionValue();
            case "CONSECUTIVE_DAYS" -> (user != null ? Optional.ofNullable(user.getConsecutiveDays()).orElse(0) : 0) >= def.getConditionValue();
            case "TOTAL_STUDY_MINUTES" -> (user != null ? Optional.ofNullable(user.getTotalStudyMinutes()).orElse(0) : 0) >= def.getConditionValue();
            default -> false;
        };
    }
}
