package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.DevicePushService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/device")
public class DeviceController {
    private final DevicePushService devicePushService;

    public DeviceController(DevicePushService devicePushService) {
        this.devicePushService = devicePushService;
    }

    @PostMapping("/register")
    public Result<Map<String, Object>> register(@RequestBody Map<String, Object> body,
                                                HttpServletRequest request) {
        return Result.success(devicePushService.register(SecurityUtils.getCurrentUserId(), body, request));
    }

    @GetMapping("/list")
    public Result<List<Map<String, Object>>> list() {
        return Result.success(devicePushService.list(SecurityUtils.getCurrentUserId()));
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        devicePushService.delete(SecurityUtils.getCurrentUserId(), id);
        return Result.success();
    }
}
