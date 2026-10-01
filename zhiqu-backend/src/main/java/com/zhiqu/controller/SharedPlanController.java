package com.zhiqu.controller;

import com.zhiqu.service.concurrency.IdempotencyService;
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
    private final IdempotencyService idempotencyService;

    public SharedPlanController(SharedPlanService sharedPlanService,
                                SharedPlanEventService eventService,
                                IdempotencyService idempotencyService) {
        this.sharedPlanService = sharedPlanService;
        this.eventService = eventService;
        this.idempotencyService = idempotencyService;
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

    /** 我投出去的计划（所有状态），驳回的带上理由 —— 后台那句「将展示给提交者」的落地处。 */
    @GetMapping("/mine")
    public Result<List<Map<String, Object>>> mySubmissions() {
        return Result.success(sharedPlanService.mySubmissions(SecurityUtils.getCurrentUserId()));
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

    /**
     * 套用一个参考计划 = 把它的任务、例行计划一条条建进这个人的日历。原来没有任何去重：连点两下（或者等得不耐烦又点一次）
     * 就是两整份任务。页面在打开这个计划时生成一个 Idempotency-Key（带上开始日期），同一次的重复提交只执行一次、
     * 回第一次的结果；换个日期、重新打开再套用，是另一次。scope 带上计划 id：同一个键不会串到别的计划上。
     */
    @PostMapping("/{id}/apply")
    public Result<Map<String, Object>> apply(@PathVariable Long id,
                                             @RequestBody Map<String, Object> body,
                                             @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        Long userId = SecurityUtils.getCurrentUserId();
        return idempotencyService.execute(userId, "sharedPlan.apply:" + id, idempotencyKey,
                () -> Result.success(sharedPlanService.apply(userId, id, body)));
    }
}
