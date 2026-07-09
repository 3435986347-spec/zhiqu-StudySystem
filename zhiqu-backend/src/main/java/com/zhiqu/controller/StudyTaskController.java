package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.dto.TaskUpdateRequest;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.TaskReminder;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.StudyTaskService;
import com.zhiqu.service.concurrency.IdempotencyService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/task")
public class StudyTaskController {
    private final StudyTaskService studyTaskService;
    private final ReminderPlanService reminderPlanService;
    private final IdempotencyService idempotencyService;

    public StudyTaskController(StudyTaskService studyTaskService,
                               ReminderPlanService reminderPlanService,
                               IdempotencyService idempotencyService) {
        this.studyTaskService = studyTaskService;
        this.reminderPlanService = reminderPlanService;
        this.idempotencyService = idempotencyService;
    }

    @PostMapping
    public Result<StudyTask> create(@RequestBody @Valid TaskCreateRequest request,
                                    @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        Long userId = SecurityUtils.getCurrentUserId();
        return idempotencyService.execute(userId, idempotencyKey,
                () -> Result.success(studyTaskService.create(userId, request)));
    }

    /** 创建周期重复任务：按 repeatWeeks 展开为多条 */
    @PostMapping({"/create-with-repeat", "/repeat"})
    public Result<Map<String, Object>> createWithRepeat(@RequestBody @Valid TaskCreateRequest request,
                                                        @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        Long userId = SecurityUtils.getCurrentUserId();
        return idempotencyService.execute(userId, idempotencyKey, () -> {
            List<StudyTask> tasks = studyTaskService.createRepeated(userId, request);
            return Result.success(Map.of(
                    "created", tasks.size(),
                    "groupId", tasks.isEmpty() ? "" : (tasks.get(0).getRepeatGroupId() == null ? "" : tasks.get(0).getRepeatGroupId())
            ));
        });
    }

    @PutMapping("/{id}")
    public Result<StudyTask> update(@PathVariable Long id, @RequestBody @Valid TaskUpdateRequest request) {
        return Result.success(studyTaskService.update(SecurityUtils.getCurrentUserId(), id, request));
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        studyTaskService.delete(SecurityUtils.getCurrentUserId(), id);
        return Result.success();
    }

    @GetMapping("/{id}")
    public Result<StudyTask> detail(@PathVariable Long id) {
        return Result.success(studyTaskService.detail(SecurityUtils.getCurrentUserId(), id));
    }

    @GetMapping("/{id}/reminders")
    public Result<List<TaskReminder>> reminders(@PathVariable Long id) {
        Long userId = SecurityUtils.getCurrentUserId();
        studyTaskService.detail(userId, id);
        return Result.success(reminderPlanService.listTaskReminders(userId, id));
    }

    @GetMapping("/list")
    public Result<List<StudyTask>> list(@RequestParam(required = false) Integer quadrant,
                                        @RequestParam(required = false) Integer status,
                                        @RequestParam(required = false) Integer priority,
                                        @RequestParam(required = false) String sortBy,
                                        @RequestParam(required = false) String sortOrder) {
        return Result.success(studyTaskService.list(SecurityUtils.getCurrentUserId(), quadrant, status, priority, sortBy, sortOrder));
    }

    @GetMapping("/quadrant")
    public Result<Map<String, List<StudyTask>>> quadrant() {
        return Result.success(studyTaskService.quadrant(SecurityUtils.getCurrentUserId()));
    }

    @PutMapping("/{id}/status")
    public Result<StudyTask> updateStatus(@PathVariable Long id, @RequestParam Integer status) {
        return Result.success(studyTaskService.updateStatus(SecurityUtils.getCurrentUserId(), id, status));
    }
}
