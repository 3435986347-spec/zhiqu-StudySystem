package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.StudyRoutine;
import com.zhiqu.entity.StudyRoutineCheckin;
import com.zhiqu.mapper.StudyRoutineCheckinMapper;
import com.zhiqu.mapper.StudyRoutineMapper;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.concurrency.DeadlockRetry;
import org.springframework.dao.DuplicateKeyException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@Service
public class RoutineServiceImpl implements RoutineService {
    private static final Logger log = LoggerFactory.getLogger(RoutineServiceImpl.class);
    private static final String FREQ_DAILY = "DAILY";
    private static final String FREQ_WEEKLY = "WEEKLY";

    private final StudyRoutineMapper routineMapper;
    private final StudyRoutineCheckinMapper checkinMapper;
    private final AchievementService achievementService;

    public RoutineServiceImpl(StudyRoutineMapper routineMapper,
                              StudyRoutineCheckinMapper checkinMapper,
                              AchievementService achievementService) {
        this.routineMapper = routineMapper;
        this.checkinMapper = checkinMapper;
        this.achievementService = achievementService;
    }

    @Override
    @Transactional
    @DeadlockRetry
    public StudyRoutine create(Long userId, Map<String, Object> body) {
        StudyRoutine routine = new StudyRoutine();
        routine.setUserId(userId);
        routine.setTitle(requiredText(body.get("title"), "例行计划标题不能为空"));
        routine.setDescription(text(body.get("description")));
        routine.setFrequency(normalizeFrequency(text(body.get("frequency"))));
        routine.setDaysOfWeek(normalizeDaysOfWeek(body.get("daysOfWeek"), routine.getFrequency()));
        routine.setStartDate(parseDate(body.get("startDate"), LocalDate.now()));
        routine.setEndDate(parseDate(body.get("endDate"), routine.getStartDate().plusDays(29)));
        routine.setPreferredTime(parseTime(body.get("preferredTime")));
        routine.setDurationMinutes(parseInt(body.get("durationMinutes"), null));
        routine.setTaskType(defaultText(body.get("taskType"), "other"));
        routine.setDifficulty(clamp(parseInt(body.get("difficulty"), 3), 1, 5));
        routine.setQuadrant(clamp(parseInt(firstNonNull(body.get("quadrant"), body.get("suggestedQuadrant")), 2), 1, 4));
        routine.setPriority(clamp(parseInt(body.get("priority"), 1), 0, 3));
        routine.setReminderEnabled(parseBoolean(body.get("reminderEnabled"), true) ? 1 : 0);
        routine.setReminderOffsets(normalizeOffsets(body.get("reminderOffsets")));
        routineMapper.insert(routine);
        achievementService.checkAndUnlock(userId, "routine_created");
        return routine;
    }

    @Override
    @Transactional
    @DeadlockRetry
    public List<StudyRoutine> createBatch(Long userId, List<Map<String, Object>> routines) {
        List<StudyRoutine> created = new ArrayList<>();
        if (routines == null) {
            return created;
        }
        for (Map<String, Object> routine : routines) {
            try {
                created.add(create(userId, routine));
            } catch (Exception e) {
                log.warn("Routine batch item creation failed, userId={}, title={}, reason={}",
                        userId, routine == null ? null : routine.get("title"), e.getMessage());
            }
        }
        return created;
    }

    @Override
    public List<Map<String, Object>> list(Long userId) {
        List<StudyRoutine> routines = routineMapper.selectList(new LambdaQueryWrapper<StudyRoutine>()
                .eq(StudyRoutine::getUserId, userId)
                .orderByDesc(StudyRoutine::getUpdatedAt));
        List<Map<String, Object>> result = new ArrayList<>();
        for (StudyRoutine routine : routines) {
            result.add(routineRow(routine));
        }
        return result;
    }

    @Override
    public List<Map<String, Object>> instances(Long userId, LocalDate from, LocalDate to) {
        LocalDate safeFrom = from == null ? LocalDate.now() : from;
        LocalDate safeTo = to == null ? safeFrom.plusDays(6) : to;
        if (safeTo.isBefore(safeFrom)) {
            safeTo = safeFrom;
        }
        List<StudyRoutine> routines = routineMapper.selectList(new LambdaQueryWrapper<StudyRoutine>()
                .eq(StudyRoutine::getUserId, userId)
                .le(StudyRoutine::getStartDate, safeTo)
                .and(w -> w.isNull(StudyRoutine::getEndDate).or().ge(StudyRoutine::getEndDate, safeFrom))
                .orderByAsc(StudyRoutine::getPreferredTime)
                .orderByAsc(StudyRoutine::getId));
        Map<String, StudyRoutineCheckin> checkins = loadCheckins(userId, safeFrom, safeTo);
        List<Map<String, Object>> result = new ArrayList<>();
        LocalDate cursor = safeFrom;
        while (!cursor.isAfter(safeTo)) {
            for (StudyRoutine routine : routines) {
                if (occursOn(routine, cursor)) {
                    result.add(instanceRow(routine, cursor, checkins.get(checkKey(routine.getId(), cursor))));
                }
            }
            cursor = cursor.plusDays(1);
        }
        result.sort(Comparator
                .comparing((Map<String, Object> row) -> String.valueOf(row.get("date")))
                .thenComparing(row -> String.valueOf(row.getOrDefault("preferredTime", "")))
                .thenComparing(row -> String.valueOf(row.get("title"))));
        return result;
    }

    @Override
    @Transactional
    @DeadlockRetry
    public Map<String, Object> checkin(Long userId, Long routineId, Map<String, Object> body) {
        StudyRoutine routine = ownedRoutine(userId, routineId);
        LocalDate checkDate = parseDate(body == null ? null : body.get("checkDate"), LocalDate.now());
        if (!occursOn(routine, checkDate)) {
            throw new BusinessException("该日期不在例行计划范围内");
        }
        boolean completed = parseBoolean(body == null ? null : body.get("completed"), true);
        StudyRoutineCheckin checkin = checkinMapper.selectOne(new LambdaQueryWrapper<StudyRoutineCheckin>()
                .eq(StudyRoutineCheckin::getUserId, userId)
                .eq(StudyRoutineCheckin::getRoutineId, routineId)
                .eq(StudyRoutineCheckin::getCheckDate, checkDate));
        if (checkin == null) {
            checkin = new StudyRoutineCheckin();
            checkin.setUserId(userId);
            checkin.setRoutineId(routineId);
            checkin.setCheckDate(checkDate);
        }
        checkin.setStatus(completed ? 1 : 0);
        checkin.setCompletedAt(completed ? LocalDateTime.now() : null);
        checkin.setActualMinutes(parseInt(body == null ? null : body.get("actualMinutes"), routine.getDurationMinutes()));
        if (checkin.getId() == null) {
            try {
                checkinMapper.insert(checkin);
            } catch (DuplicateKeyException e) {
                StudyRoutineCheckin existing = checkinMapper.selectOne(new LambdaQueryWrapper<StudyRoutineCheckin>()
                        .eq(StudyRoutineCheckin::getUserId, userId)
                        .eq(StudyRoutineCheckin::getRoutineId, routineId)
                        .eq(StudyRoutineCheckin::getCheckDate, checkDate));
                if (existing == null) {
                    throw e;
                }
                checkin.setId(existing.getId());
                checkinMapper.updateById(checkin);
            }
        } else {
            checkinMapper.updateById(checkin);
        }
        if (completed) {
            achievementService.checkAndUnlock(userId, "routine_checkin");
        }
        return instanceRow(routine, checkDate, checkin);
    }

    @Override
    @Transactional
    @DeadlockRetry
    public void delete(Long userId, Long routineId) {
        StudyRoutine routine = ownedRoutine(userId, routineId);
        routineMapper.deleteById(routine.getId());
    }

    @Override
    public List<Map<String, Object>> reminderInstances(LocalDate date) {
        LocalDate target = date == null ? LocalDate.now() : date;
        List<StudyRoutine> routines = routineMapper.selectList(new LambdaQueryWrapper<StudyRoutine>()
                .eq(StudyRoutine::getReminderEnabled, 1)
                .le(StudyRoutine::getStartDate, target)
                .and(w -> w.isNull(StudyRoutine::getEndDate).or().ge(StudyRoutine::getEndDate, target))
                .orderByAsc(StudyRoutine::getPreferredTime)
                .orderByAsc(StudyRoutine::getId));
        List<Map<String, Object>> result = new ArrayList<>();
        for (StudyRoutine routine : routines) {
            if (occursOn(routine, target) && !isCompleted(routine.getUserId(), routine.getId(), target)) {
                result.add(instanceRow(routine, target, null));
            }
        }
        return result;
    }

    private StudyRoutine ownedRoutine(Long userId, Long routineId) {
        StudyRoutine routine = routineMapper.selectOne(new LambdaQueryWrapper<StudyRoutine>()
                .eq(StudyRoutine::getId, routineId)
                .eq(StudyRoutine::getUserId, userId));
        if (routine == null) {
            throw new BusinessException("例行计划不存在或无权访问");
        }
        return routine;
    }

    private boolean occursOn(StudyRoutine routine, LocalDate date) {
        if (routine == null || date == null || routine.getStartDate() == null) {
            return false;
        }
        if (date.isBefore(routine.getStartDate())) {
            return false;
        }
        if (routine.getEndDate() != null && date.isAfter(routine.getEndDate())) {
            return false;
        }
        if (FREQ_DAILY.equalsIgnoreCase(routine.getFrequency())) {
            return true;
        }
        Set<Integer> days = parseDays(routine.getDaysOfWeek());
        return days.contains(date.getDayOfWeek().getValue());
    }

    private Map<String, StudyRoutineCheckin> loadCheckins(Long userId, LocalDate from, LocalDate to) {
        List<StudyRoutineCheckin> checkins = checkinMapper.selectList(new LambdaQueryWrapper<StudyRoutineCheckin>()
                .eq(StudyRoutineCheckin::getUserId, userId)
                .between(StudyRoutineCheckin::getCheckDate, from, to));
        Map<String, StudyRoutineCheckin> result = new HashMap<>();
        for (StudyRoutineCheckin checkin : checkins) {
            result.put(checkKey(checkin.getRoutineId(), checkin.getCheckDate()), checkin);
        }
        return result;
    }

    private boolean isCompleted(Long userId, Long routineId, LocalDate date) {
        StudyRoutineCheckin checkin = checkinMapper.selectOne(new LambdaQueryWrapper<StudyRoutineCheckin>()
                .eq(StudyRoutineCheckin::getUserId, userId)
                .eq(StudyRoutineCheckin::getRoutineId, routineId)
                .eq(StudyRoutineCheckin::getCheckDate, date));
        return checkin != null && checkin.getStatus() != null && checkin.getStatus() == 1;
    }

    private Map<String, Object> routineRow(StudyRoutine routine) {
        Map<String, Object> row = new HashMap<>();
        row.put("id", routine.getId());
        row.put("userId", routine.getUserId());
        row.put("title", routine.getTitle());
        row.put("description", routine.getDescription());
        row.put("frequency", routine.getFrequency());
        row.put("daysOfWeek", parseDays(routine.getDaysOfWeek()));
        row.put("startDate", routine.getStartDate());
        row.put("endDate", routine.getEndDate());
        row.put("preferredTime", routine.getPreferredTime());
        row.put("durationMinutes", routine.getDurationMinutes());
        row.put("taskType", routine.getTaskType());
        row.put("difficulty", routine.getDifficulty());
        row.put("quadrant", routine.getQuadrant());
        row.put("priority", routine.getPriority());
        row.put("reminderEnabled", routine.getReminderEnabled() != null && routine.getReminderEnabled() == 1);
        row.put("reminderOffsets", parseOffsets(routine.getReminderOffsets()));
        return row;
    }

    private Map<String, Object> instanceRow(StudyRoutine routine, LocalDate date, StudyRoutineCheckin checkin) {
        Map<String, Object> row = routineRow(routine);
        row.put("kind", "ROUTINE");
        row.put("routineId", routine.getId());
        row.put("date", date);
        row.put("status", checkin != null && checkin.getStatus() != null ? checkin.getStatus() : 0);
        row.put("completed", checkin != null && checkin.getStatus() != null && checkin.getStatus() == 1);
        row.put("completedAt", checkin == null ? null : checkin.getCompletedAt());
        row.put("actualMinutes", checkin == null ? null : checkin.getActualMinutes());
        return row;
    }

    private String checkKey(Long routineId, LocalDate date) {
        return routineId + "#" + date;
    }

    private String normalizeFrequency(String frequency) {
        String value = frequency == null ? "" : frequency.trim().toUpperCase(Locale.ROOT);
        if (FREQ_WEEKLY.equals(value)) {
            return FREQ_WEEKLY;
        }
        return FREQ_DAILY;
    }

    private String normalizeDaysOfWeek(Object raw, String frequency) {
        if (!FREQ_WEEKLY.equalsIgnoreCase(frequency)) {
            return "";
        }
        Set<Integer> days = parseDays(raw);
        if (days.isEmpty()) {
            days.add(LocalDate.now().getDayOfWeek().getValue());
        }
        return joinInts(days);
    }

    private Set<Integer> parseDays(Object raw) {
        Set<Integer> days = new LinkedHashSet<>();
        if (raw instanceof Iterable<?> iterable) {
            for (Object item : iterable) {
                addDay(days, item);
            }
        } else if (raw != null) {
            String text = raw.toString().replace("[", "").replace("]", "");
            for (String part : text.split(",")) {
                addDay(days, part);
            }
        }
        return days;
    }

    private void addDay(Set<Integer> days, Object item) {
        Integer day = parseInt(item, null);
        if (day != null && day >= DayOfWeek.MONDAY.getValue() && day <= DayOfWeek.SUNDAY.getValue()) {
            days.add(day);
        }
    }

    private String normalizeOffsets(Object raw) {
        return joinInts(parseOffsets(raw));
    }

    private Set<Integer> parseOffsets(Object raw) {
        Set<Integer> values = new LinkedHashSet<>();
        if (raw instanceof Iterable<?> iterable) {
            for (Object item : iterable) {
                addOffset(values, item);
            }
        } else if (raw != null) {
            String text = raw.toString().replace("[", "").replace("]", "");
            for (String part : text.split(",")) {
                addOffset(values, part);
            }
        }
        if (values.isEmpty()) {
            values.add(0);
        }
        return values;
    }

    private void addOffset(Set<Integer> values, Object item) {
        Integer offset = parseInt(item, null);
        if (offset != null && offset >= 0 && offset <= 365) {
            values.add(offset);
        }
    }

    private String joinInts(Set<Integer> values) {
        List<String> parts = new ArrayList<>();
        for (Integer value : values) {
            parts.add(String.valueOf(value));
        }
        return String.join(",", parts);
    }

    private LocalDate parseDate(Object value, LocalDate defaultValue) {
        String text = text(value);
        if (text == null) {
            return defaultValue;
        }
        try {
            return LocalDate.parse(text.length() > 10 ? text.substring(0, 10) : text);
        } catch (Exception e) {
            return defaultValue;
        }
    }

    private LocalTime parseTime(Object value) {
        String text = text(value);
        if (text == null) {
            return null;
        }
        try {
            return LocalTime.parse(text.length() >= 5 ? text.substring(0, 5) : text);
        } catch (Exception e) {
            return null;
        }
    }

    private Integer parseInt(Object value, Integer defaultValue) {
        if (value == null || value.toString().isBlank()) {
            return defaultValue;
        }
        try {
            return Integer.parseInt(value.toString().trim());
        } catch (Exception e) {
            return defaultValue;
        }
    }

    private boolean parseBoolean(Object value, boolean defaultValue) {
        if (value == null) {
            return defaultValue;
        }
        if (value instanceof Boolean b) {
            return b;
        }
        String text = value.toString().trim();
        if ("1".equals(text)) return true;
        if ("0".equals(text)) return false;
        return Boolean.parseBoolean(text);
    }

    private int clamp(Integer value, int min, int max) {
        int v = value == null ? min : value;
        return Math.max(min, Math.min(max, v));
    }

    private Object firstNonNull(Object first, Object second) {
        return first != null ? first : second;
    }

    private String requiredText(Object value, String message) {
        String text = text(value);
        if (text == null) {
            throw new BusinessException(message);
        }
        return text;
    }

    private String defaultText(Object value, String defaultValue) {
        String text = text(value);
        return text == null ? defaultValue : text;
    }

    private String text(Object value) {
        if (value == null) {
            return null;
        }
        String text = value.toString().trim();
        return text.isBlank() ? null : text;
    }
}
