package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.StudyRecordCreateRequest;
import com.zhiqu.dto.StudyStatisticsVO;
import com.zhiqu.entity.StudyRecord;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.StudyRecordService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/record")
public class StudyRecordController {
    private final StudyRecordService studyRecordService;

    public StudyRecordController(StudyRecordService studyRecordService) {
        this.studyRecordService = studyRecordService;
    }

    @PostMapping
    public Result<StudyRecord> create(@RequestBody @Valid StudyRecordCreateRequest request) {
        return Result.success(studyRecordService.create(SecurityUtils.getCurrentUserId(), request));
    }

    @GetMapping("/list")
    public Result<List<StudyRecord>> list() {
        return Result.success(studyRecordService.list(SecurityUtils.getCurrentUserId()));
    }

    @GetMapping("/statistics")
    public Result<StudyStatisticsVO> statistics() {
        return Result.success(studyRecordService.statistics(SecurityUtils.getCurrentUserId()));
    }

    @GetMapping("/trend")
    public Result<List<Map<String, Object>>> trend(@RequestParam(defaultValue = "day") String type) {
        return Result.success(studyRecordService.trend(SecurityUtils.getCurrentUserId(), type));
    }
}
