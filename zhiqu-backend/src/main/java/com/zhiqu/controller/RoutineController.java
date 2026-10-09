package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.entity.StudyRoutine;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.RoutineService;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/routine")
public class RoutineController {
    private final RoutineService routineService;

    public RoutineController(RoutineService routineService) {
        this.routineService = routineService;
    }

    @PostMapping
    public Result<StudyRoutine> create(@RequestBody Map<String, Object> body) {
        return Result.success(routineService.create(SecurityUtils.getCurrentUserId(), body));
    }

    @GetMapping("/list")
    public Result<List<Map<String, Object>>> list() {
        return Result.success(routineService.list(SecurityUtils.getCurrentUserId()));
    }

    @GetMapping("/instances")
    public Result<List<Map<String, Object>>> instances(@RequestParam String from,
                                                       @RequestParam String to) {
        return Result.success(routineService.instances(
                SecurityUtils.getCurrentUserId(),
                LocalDate.parse(from),
                LocalDate.parse(to)
        ));
    }

    @PostMapping("/{id}/checkin")
    public Result<Map<String, Object>> checkin(@PathVariable Long id,
                                               @RequestBody(required = false) Map<String, Object> body) {
        return Result.success(routineService.checkin(SecurityUtils.getCurrentUserId(), id, body == null ? Map.of() : body));
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        routineService.delete(SecurityUtils.getCurrentUserId(), id);
        return Result.success();
    }
}
