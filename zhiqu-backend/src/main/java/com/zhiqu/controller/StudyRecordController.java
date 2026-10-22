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

    /** from / to（含两端）可选；不给就是全部。看板数「今天学了几个番茄钟」只要今天的（第十七轮：原来取回全部记录）。 */
    @GetMapping("/list")
    public Result<List<StudyRecord>> list(@RequestParam(required = false) java.time.LocalDate from,
                                          @RequestParam(required = false) java.time.LocalDate to) {
        return Result.success(studyRecordService.list(SecurityUtils.getCurrentUserId(), from, to));
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
