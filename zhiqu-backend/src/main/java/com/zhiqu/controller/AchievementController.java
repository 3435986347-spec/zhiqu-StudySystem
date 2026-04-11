package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.AchievementService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/achievement")
public class AchievementController {
    private final AchievementService achievementService;

    public AchievementController(AchievementService achievementService) {
        this.achievementService = achievementService;
    }

    @GetMapping("/list")
    public Result<List<Map<String, Object>>> list() {
        return Result.success(achievementService.listWithStatus(SecurityUtils.getCurrentUserId()));
    }

    @PostMapping("/check")
    public Result<List<Map<String, Object>>> check(@RequestParam(defaultValue = "manual") String trigger) {
        return Result.success(achievementService.checkAndUnlock(SecurityUtils.getCurrentUserId(), trigger));
    }
}
