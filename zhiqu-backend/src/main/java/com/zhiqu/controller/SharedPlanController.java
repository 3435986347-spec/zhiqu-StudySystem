package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.SharedPlanEventService;
import com.zhiqu.service.SharedPlanService;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/shared-plans")
public class SharedPlanController {
    private final SharedPlanService sharedPlanService;
    private final SharedPlanEventService eventService;

    public SharedPlanController(SharedPlanService sharedPlanService,
                                SharedPlanEventService eventService) {
        this.sharedPlanService = sharedPlanService;
        this.eventService = eventService;
    }

    @PostMapping
    public Result<Map<String, Object>> submit(@RequestBody Map<String, Object> body) {
        return Result.success(sharedPlanService.submit(SecurityUtils.getCurrentUserId(), body));
    }

    @PostMapping("/from-existing")
    public Result<Map<String, Object>> submitFromExisting(@RequestBody Map<String, Object> body) {
        return Result.success(sharedPlanService.submitFromExisting(SecurityUtils.getCurrentUserId(), body));
    }

    @GetMapping
    public Result<List<Map<String, Object>>> list(@RequestParam(required = false) String category,
                                                  @RequestParam(required = false) String sort,
                                                  @RequestParam(required = false) String order) {
        return Result.success(sharedPlanService.publicList(SecurityUtils.getCurrentUserId(), category, sort, order));
    }

    @GetMapping("/categories")
    public Result<List<Map<String, Object>>> categories() {
        return Result.success(sharedPlanService.categories());
    }

    @GetMapping("/events")
    public SseEmitter events() {
        SecurityUtils.getCurrentUserId();
        return eventService.subscribePublic();
    }

    @PostMapping("/{id}/like")
    public Result<Map<String, Object>> like(@PathVariable Long id) {
        return Result.success(sharedPlanService.toggleLike(SecurityUtils.getCurrentUserId(), id));
    }

    @GetMapping("/{id}")
    public Result<Map<String, Object>> detail(@PathVariable Long id) {
        return Result.success(sharedPlanService.detail(SecurityUtils.getCurrentUserId(), id));
    }

    @PostMapping("/{id}/apply")
    public Result<Map<String, Object>> apply(@PathVariable Long id,
                                             @RequestBody Map<String, Object> body) {
        return Result.success(sharedPlanService.apply(SecurityUtils.getCurrentUserId(), id, body));
    }
}
