package com.zhiqu.controller;

import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.ReminderService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/reminder")
public class ReminderController {
    private final ReminderService reminderService;
    private final BusinessClock clock;

    public ReminderController(ReminderService reminderService, BusinessClock clock) {
        this.reminderService = reminderService;
        this.clock = clock;
    }

    /** 接下来 24 小时的任务提醒（页面开着时在页面里提醒，第二十五轮）。「此刻」是业务时区的 —— 提醒时间是用户的墙上时间。 */
    @GetMapping("/upcoming")
    public Result<List<Map<String, Object>>> upcoming() {
        return Result.success(reminderService.upcoming(SecurityUtils.getCurrentUserId(), clock.now()));
    }

    @GetMapping("/settings")
    public Result<Map<String, Object>> getSettings() {
        return Result.success(reminderService.getSettings(SecurityUtils.getCurrentUserId()));
    }

    @PutMapping("/settings")
    public Result<Void> saveSettings(@RequestBody Map<String, Object> body) {
        reminderService.saveSettings(SecurityUtils.getCurrentUserId(), body);
        return Result.success();
    }

    @PostMapping("/test")
    public Result<Void> test() {
        reminderService.sendTest(SecurityUtils.getCurrentUserId());
        return Result.success();
    }
}
