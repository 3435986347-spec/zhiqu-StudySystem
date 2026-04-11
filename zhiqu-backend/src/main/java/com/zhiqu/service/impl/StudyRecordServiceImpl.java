package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.dto.StudyRecordCreateRequest;
import com.zhiqu.dto.StudyStatisticsVO;
import com.zhiqu.entity.StudyRecord;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.StudyRecordMapper;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.StudyRecordService;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.temporal.WeekFields;
import java.util.*;
import java.util.stream.Collectors;

@Service
public class StudyRecordServiceImpl implements StudyRecordService {
    private final StudyRecordMapper studyRecordMapper;
    private final SysUserMapper sysUserMapper;
    private final StudyTaskMapper studyTaskMapper;
    private final AchievementService achievementService;

    public StudyRecordServiceImpl(StudyRecordMapper studyRecordMapper, SysUserMapper sysUserMapper,
                                  StudyTaskMapper studyTaskMapper, AchievementService achievementService) {
        this.studyRecordMapper = studyRecordMapper;
        this.sysUserMapper = sysUserMapper;
        this.studyTaskMapper = studyTaskMapper;
        this.achievementService = achievementService;
    }

    @Override
    public StudyRecord create(Long userId, StudyRecordCreateRequest request) {
        StudyRecord record = new StudyRecord();
        record.setUserId(userId);
        record.setTaskId(request.getTaskId());
        record.setStudyDate(request.getStudyDate());
        record.setDurationMinutes(request.getDurationMinutes());
        record.setNote(request.getNote());
        studyRecordMapper.insert(record);

        SysUser user = sysUserMapper.selectById(userId);
        if (user != null) {
            int oldTotal = user.getTotalStudyMinutes() == null ? 0 : user.getTotalStudyMinutes();
            user.setTotalStudyMinutes(oldTotal + request.getDurationMinutes());

            LocalDate last = user.getLastStudyDate();
            LocalDate current = request.getStudyDate();
            int days = user.getConsecutiveDays() == null ? 0 : user.getConsecutiveDays();
            if (last == null) {
                days = 1;
            } else if (current.equals(last)) {
                days = Math.max(days, 1);
            } else if (current.equals(last.plusDays(1))) {
                days = days + 1;
            } else if (current.isAfter(last.plusDays(1))) {
                days = 1;
            }
            if (last == null || current.isAfter(last)) {
                user.setLastStudyDate(current);
                user.setConsecutiveDays(days);
            }
            sysUserMapper.updateById(user);
        }
        achievementService.checkAndUnlock(userId, "study_record_added");
        return record;
    }

    @Override
    public List<StudyRecord> list(Long userId) {
        return studyRecordMapper.selectList(new LambdaQueryWrapper<StudyRecord>()
                .eq(StudyRecord::getUserId, userId)
                .orderByDesc(StudyRecord::getStudyDate));
    }

    @Override
    public StudyStatisticsVO statistics(Long userId) {
        SysUser user = sysUserMapper.selectById(userId);
        List<StudyTask> tasks = studyTaskMapper.selectList(new LambdaQueryWrapper<StudyTask>()
                .eq(StudyTask::getUserId, userId));

        Map<Integer, Long> distribution = tasks.stream()
                .collect(Collectors.groupingBy(StudyTask::getQuadrant, Collectors.counting()));
        for (int i = 1; i <= 4; i++) {
            distribution.putIfAbsent(i, 0L);
        }

        long totalTask = tasks.size();
        long completedTask = tasks.stream().filter(t -> t.getStatus() != null && t.getStatus() == 2).count();

        return StudyStatisticsVO.builder()
                .consecutiveDays(user == null || user.getConsecutiveDays() == null ? 0 : user.getConsecutiveDays())
                .totalStudyMinutes(user == null || user.getTotalStudyMinutes() == null ? 0 : user.getTotalStudyMinutes())
                .completedTaskCount(completedTask)
                .totalTaskCount(totalTask)
                .quadrantDistribution(distribution)
                .build();
    }

    @Override
    public List<Map<String, Object>> trend(Long userId, String type) {
        List<StudyRecord> records = list(userId);
        Map<String, Integer> map = new TreeMap<>();

        for (StudyRecord record : records) {
            String key;
            LocalDate d = record.getStudyDate();
            if ("week".equalsIgnoreCase(type)) {
                WeekFields wf = WeekFields.of(Locale.getDefault());
                key = d.getYear() + "-W" + d.get(wf.weekOfWeekBasedYear());
            } else if ("month".equalsIgnoreCase(type)) {
                key = d.getYear() + "-" + String.format("%02d", d.getMonthValue());
            } else {
                key = d.toString();
            }
            map.put(key, map.getOrDefault(key, 0) + record.getDurationMinutes());
        }

        List<Map<String, Object>> result = new ArrayList<>();
        for (Map.Entry<String, Integer> entry : map.entrySet()) {
            result.add(Map.of("period", entry.getKey(), "minutes", entry.getValue()));
        }
        return result;
    }
}
