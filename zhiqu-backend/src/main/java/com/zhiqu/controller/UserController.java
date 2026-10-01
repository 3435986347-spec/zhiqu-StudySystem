package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.UpdatePasswordRequest;
import com.zhiqu.dto.UpdateProfileRequest;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.security.AuthCookies;
import com.zhiqu.security.JwtAuthenticationFilter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import java.util.Date;
import com.zhiqu.service.UserService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/user")
public class UserController {
    private final UserService userService;
    private final AuthCookies cookies;

    public UserController(UserService userService, AuthCookies cookies) {
        this.userService = userService;
        this.cookies = cookies;
    }

    @PutMapping("/profile")
    public Result<Map<String, Object>> updateProfile(@RequestBody @Valid UpdateProfileRequest request) {
        return Result.success(userService.updateProfile(SecurityUtils.getCurrentUserId(), request));
    }

    /**
     * 改密码：别的设备上的登录、被偷走的令牌一并失效；这个会话拿到一张新令牌（到期时间不变）。
     * 这次请求带着「记住我」的 Cookie 的话也换成新令牌 —— 否则 Cookie 里是作废的旧令牌。
     */
    @PutMapping("/password")
    public Result<Map<String, Object>> updatePassword(@RequestBody @Valid UpdatePasswordRequest request,
                                                      HttpServletRequest http, HttpServletResponse response) {
        Object expires = http.getAttribute(JwtAuthenticationFilter.TOKEN_EXPIRES_AT);
        Date keep = expires instanceof Date d ? d : null;
        Map<String, Object> fresh = userService.updatePassword(SecurityUtils.getCurrentUserId(), request, keep);
        if (cookies.present(http)) {
            long left = ((Number) fresh.get("expiresAt")).longValue() - System.currentTimeMillis();
            cookies.set(response, String.valueOf(fresh.get("token")), Duration.ofMillis(Math.max(0, left)));
        }
        return Result.success(fresh);
    }

    @PostMapping("/avatar")
    public Result<Map<String, Object>> uploadAvatar(@RequestPart("file") MultipartFile file) {
        return Result.success(userService.uploadAvatar(SecurityUtils.getCurrentUserId(), file));
    }

    @GetMapping("/login-history")
    public Result<List<Map<String, Object>>> loginHistory(@RequestParam(defaultValue = "10") int limit) {
        return Result.success(userService.loginHistory(SecurityUtils.getCurrentUserId(), limit));
    }
}
