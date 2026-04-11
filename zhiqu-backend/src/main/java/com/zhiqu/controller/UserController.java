package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.UpdatePasswordRequest;
import com.zhiqu.dto.UpdateProfileRequest;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.UserService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

@RestController
@RequestMapping("/api/user")
public class UserController {
    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @PutMapping("/profile")
    public Result<Map<String, Object>> updateProfile(@RequestBody @Valid UpdateProfileRequest request) {
        return Result.success(userService.updateProfile(SecurityUtils.getCurrentUserId(), request));
    }

    @PutMapping("/password")
    public Result<Void> updatePassword(@RequestBody @Valid UpdatePasswordRequest request) {
        userService.updatePassword(SecurityUtils.getCurrentUserId(), request);
        return Result.success();
    }

    @PostMapping("/avatar")
    public Result<Map<String, Object>> uploadAvatar(@RequestPart("file") MultipartFile file) {
        return Result.success(userService.uploadAvatar(SecurityUtils.getCurrentUserId(), file));
    }
}
