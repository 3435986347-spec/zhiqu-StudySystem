package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.ReminderService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/reminder")
public class ReminderController {
    private final ReminderService reminderService;

    public ReminderController(ReminderService reminderService) {
        this.reminderService = reminderService;
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
