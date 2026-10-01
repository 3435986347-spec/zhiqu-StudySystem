package com.zhiqu.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.DateRange;
import com.zhiqu.common.Result;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.TaskReminder;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.TaskReminderMapper;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.privacy.TaskPrivacyService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/dashboard")
public class DashboardController {
    private final BusinessClock clock;
    private final StudyTaskMapper studyTaskMapper;
    private final TaskReminderMapper taskReminderMapper;
    private final RoutineService routineService;
    private final TaskPrivacyService taskPrivacyService;

    public DashboardController(StudyTaskMapper studyTaskMapper,
                               TaskReminderMapper taskReminderMapper,
                               RoutineService routineService,
                               TaskPrivacyService taskPrivacyService,
                                BusinessClock clock) {
        this.clock = clock;
        this.studyTaskMapper = studyTaskMapper;
        this.taskReminderMapper = taskReminderMapper;
        this.routineService = routineService;
        this.taskPrivacyService = taskPrivacyService;
    }

    @GetMapping("/overview")
    public Result<Map<String, Object>> overview(@RequestParam String from,
                                                @RequestParam String to) {
        Long userId = SecurityUtils.getCurrentUserId();
        LocalDate start = LocalDate.parse(from);
        LocalDate end = LocalDate.parse(to);
        if (end.isBefore(start)) {
            end = start;
        }
        DateRange.requireWithin(start, end);
        LocalDate today = clock.today();
        return Result.success(build(userId, start, end, today, relevantTasks(userId, start, end, today)));
    }

    /**
     * 首页用得到的任务：没完成的（象限、临近截止、逾期）、日期落在所看的这几天里的、日期是今天的（今日计数）。
     *
     * <p>原来每次打开首页都把这个人<b>全部</b>任务整行取回来、逐条解密标题，再在内存里筛 —— 用得久的人，
     * 绝大多数是早就完成的旧任务，每次都白搬一遍。这里的条件就是 {@link #build} 里每一处筛选的并集，
     * 「日期」照 {@link #taskDate} 的定义：有开始时间看开始时间，没有才看截止时间。
     * 两者输出一致由 {@code DashboardOverviewEquivalenceIntegrationTest} 用真库对照。
     */
    List<StudyTask> relevantTasks(Long userId, LocalDate start, LocalDate end, LocalDate today) {
        LocalDateTime rangeFrom = start.atStartOfDay();
        LocalDateTime rangeUntil = end.plusDays(1).atStartOfDay();
        LocalDateTime todayFrom = today.atStartOfDay();
        LocalDateTime todayUntil = today.plusDays(1).atStartOfDay();
        List<StudyTask> tasks = studyTaskMapper.selectList(new LambdaQueryWrapper<StudyTask>()
                .eq(StudyTask::getUserId, userId)
                .and(w -> w.isNull(StudyTask::getStatus).or().ne(StudyTask::getStatus, 2)
                        .or(x -> x.ge(StudyTask::getStartTime, rangeFrom).lt(StudyTask::getStartTime, rangeUntil))
                        .or(x -> x.isNull(StudyTask::getStartTime).ge(StudyTask::getDeadline, rangeFrom).lt(StudyTask::getDeadline, rangeUntil))
                        .or(x -> x.ge(StudyTask::getStartTime, todayFrom).lt(StudyTask::getStartTime, todayUntil))
                        .or(x -> x.isNull(StudyTask::getStartTime).ge(StudyTask::getDeadline, todayFrom).lt(StudyTask::getDeadline, todayUntil)))
                .orderByAsc(StudyTask::getDeadline)
                .orderByDesc(StudyTask::getPriority)
                .orderByDesc(StudyTask::getUpdatedAt));
        return taskPrivacyService.revealAll(tasks);
    }

    /** 由一批任务拼出首页。任务多给几条（已完成、日期在别处）不改变结果 —— 每一处都会再筛。 */
    Map<String, Object> build(Long userId, LocalDate start, LocalDate end, LocalDate today, List<StudyTask> allTasks) {
        List<Map<String, Object>> routines = routineService.instances(userId, start, end);

        Map<String, List<Map<String, Object>>> dayItems = initDayMap(start, end);
        for (StudyTask task : allTasks) {
            LocalDate basis = taskDate(task);
            if (basis != null && !basis.isBefore(start) && !basis.isAfter(end)) {
                dayItems.get(basis.toString()).add(taskItem(task));
            }
        }
        for (Map<String, Object> routine : routines) {
            String date = String.valueOf(routine.get("date"));
            if (dayItems.containsKey(date)) {
                dayItems.get(date).add(routineItem(routine));
            }
        }
        dayItems.values().forEach(list -> list.sort(Comparator
                .comparing((Map<String, Object> row) -> String.valueOf(row.getOrDefault("time", "")))
                .thenComparing(row -> String.valueOf(row.get("title")))));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("from", start);
        result.put("to", end);
        result.put("today", today);
        result.put("summary", summary(userId, allTasks, routines, today));
        result.put("days", buildDays(start, end, dayItems, today));
        result.put("quadrants", quadrantSummary(allTasks));
        result.put("upcomingDeadlines", upcomingDeadlines(allTasks, today));
        // 原来还回 rangeTasks、routineInstances —— 页面从不读，内容和 days 里的一样：
        // 用了两年、两百个每日例行计划的账号上，看一周的首页回 1.1MB，其中一半是这两份重复（第十七轮）
        return result;
    }

    private Map<String, Object> summary(Long userId, List<StudyTask> tasks, List<Map<String, Object>> routines, LocalDate today) {
        int todayTasks = 0;
        int pendingToday = 0;
        int overdue = 0;
        int routineTotal = 0;
        int routineDone = 0;
        for (StudyTask task : tasks) {
            LocalDate date = taskDate(task);
            boolean done = task.getStatus() != null && task.getStatus() == 2;
            if (date != null && date.equals(today)) {
                todayTasks++;
                if (!done) pendingToday++;
            }
            if (!done && task.getDeadline() != null && task.getDeadline().toLocalDate().isBefore(today)) {
                overdue++;
            }
        }
        for (Map<String, Object> routine : routines) {
            if (today.toString().equals(String.valueOf(routine.get("date")))) {
                routineTotal++;
                if (Boolean.TRUE.equals(routine.get("completed"))) {
                    routineDone++;
                }
            }
        }
        int remindersToday = taskReminderMapper.selectCount(new LambdaQueryWrapper<TaskReminder>()
                .eq(TaskReminder::getUserId, userId)
                .eq(TaskReminder::getStatus, "PENDING")
                .between(TaskReminder::getScheduledAt, today.atStartOfDay(), today.atTime(LocalTime.MAX)))
                .intValue();

        Map<String, Object> row = new LinkedHashMap<>();
        row.put("todayTasks", todayTasks);
        row.put("pendingToday", pendingToday);
        row.put("overdue", overdue);
        row.put("routineTotal", routineTotal);
        row.put("routineDone", routineDone);
        row.put("remindersToday", remindersToday + Math.max(0, routineTotal - routineDone));
        return row;
    }

    private Map<String, List<Map<String, Object>>> initDayMap(LocalDate start, LocalDate end) {
        Map<String, List<Map<String, Object>>> map = new LinkedHashMap<>();
        LocalDate cursor = start;
        while (!cursor.isAfter(end)) {
            map.put(cursor.toString(), new ArrayList<>());
            cursor = cursor.plusDays(1);
        }
        return map;
    }

    private List<Map<String, Object>> buildDays(LocalDate start,
                                                LocalDate end,
                                                Map<String, List<Map<String, Object>>> items,
                                                LocalDate today) {
        List<Map<String, Object>> days = new ArrayList<>();
        LocalDate cursor = start;
        String[] labels = {"一", "二", "三", "四", "五", "六", "日"};
        while (!cursor.isAfter(end)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("date", cursor);
            row.put("day", cursor.getDayOfMonth());
            row.put("weekday", "周" + labels[cursor.getDayOfWeek().getValue() - 1]);
            row.put("today", cursor.equals(today));
            row.put("items", items.getOrDefault(cursor.toString(), List.of()));
            days.add(row);
            cursor = cursor.plusDays(1);
        }
        return days;
    }

    private List<Map<String, Object>> quadrantSummary(List<StudyTask> tasks) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (int q = 1; q <= 4; q++) {
            final int quadrant = q;
            List<StudyTask> filtered = tasks.stream()
                    .filter(task -> task.getQuadrant() != null && task.getQuadrant() == quadrant)
                    .filter(task -> task.getStatus() == null || task.getStatus() != 2)
                    .sorted(Comparator
                            .comparing(StudyTask::getDeadline, Comparator.nullsLast(Comparator.naturalOrder()))
                            .thenComparing(StudyTask::getPriority, Comparator.nullsLast(Comparator.reverseOrder())))
                    .toList();
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("quadrant", quadrant);
            row.put("total", filtered.size());
            row.put("items", filtered.stream().limit(4).map(this::taskItem).toList());
            result.add(row);
        }
        return result;
    }

    private List<Map<String, Object>> upcomingDeadlines(List<StudyTask> tasks, LocalDate today) {
        return tasks.stream()
                .filter(task -> task.getStatus() == null || task.getStatus() != 2)
                .filter(task -> task.getDeadline() != null && !task.getDeadline().toLocalDate().isBefore(today))
                .sorted(Comparator.comparing(StudyTask::getDeadline))
                .limit(6)
                .map(this::taskItem)
                .toList();
    }

    private Map<String, Object> taskItem(StudyTask task) {
        Map<String, Object> row = new HashMap<>();
        row.put("kind", "TASK");
        row.put("id", task.getId());
        row.put("title", task.getTitle());
        row.put("description", task.getDescription());
        row.put("quadrant", task.getQuadrant());
        row.put("priority", task.getPriority());
        row.put("status", task.getStatus());
        row.put("startTime", task.getStartTime());
        row.put("deadline", task.getDeadline());
        row.put("time", displayTime(task));
        row.put("taskType", task.getTaskType());
        row.put("durationMinutes", task.getDurationMinutes());
        return row;
    }

    /**
     * 首页的一条例行计划只带页面用得到的这几项（第十七轮）。原来把例行计划的整行（二十几项：提醒偏移、星期、难度、开始结束日期……）
     * 原样塞进一周里每一天的每一条 —— 两百个每日例行计划的账号，看一周的首页就是半兆多。
     */
    static final List<String> ROUTINE_ITEM_FIELDS = List.of("id", "routineId", "title", "description", "quadrant", "priority",
            "status", "completed", "date", "durationMinutes");

    private Map<String, Object> routineItem(Map<String, Object> routine) {
        Map<String, Object> row = new HashMap<>();
        for (String key : ROUTINE_ITEM_FIELDS) {
            if (routine.containsKey(key)) row.put(key, routine.get(key));
        }
        row.put("kind", "ROUTINE");
        Object preferredTime = routine.get("preferredTime");
        row.put("time", preferredTime == null ? "" : String.valueOf(preferredTime).substring(0, Math.min(5, String.valueOf(preferredTime).length())));
        return row;
    }

    private LocalDate taskDate(StudyTask task) {
        if (task.getStartTime() != null) {
            return task.getStartTime().toLocalDate();
        }
        if (task.getDeadline() != null) {
            return task.getDeadline().toLocalDate();
        }
        return null;
    }

    private String displayTime(StudyTask task) {
        if (task.getStartTime() != null) {
            return task.getStartTime().toLocalTime().toString().substring(0, 5);
        }
        if (task.getDeadline() != null) {
            return task.getDeadline().toLocalTime().toString().substring(0, 5);
        }
        return "";
    }
}
