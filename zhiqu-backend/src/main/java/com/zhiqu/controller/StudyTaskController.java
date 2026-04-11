package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.dto.TaskUpdateRequest;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.StudyTaskService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/task")
public class StudyTaskController {
    private final StudyTaskService studyTaskService;

    public StudyTaskController(StudyTaskService studyTaskService) {
        this.studyTaskService = studyTaskService;
    }

    @PostMapping
    public Result<StudyTask> create(@RequestBody @Valid TaskCreateRequest request) {
        return Result.success(studyTaskService.create(SecurityUtils.getCurrentUserId(), request));
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
