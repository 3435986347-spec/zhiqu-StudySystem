package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.LoginRequest;
import com.zhiqu.dto.RegisterRequest;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.AuthService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    @PostMapping("/register")
    public Result<Map<String, Object>> register(@RequestBody @Valid RegisterRequest request) {
        return Result.success(authService.register(request));
    }

    @PostMapping("/login")
    public Result<Map<String, Object>> login(@RequestBody @Valid LoginRequest request) {
        return Result.success(authService.login(request));
    }

    @PostMapping("/logout")
    public Result<Void> logout() {
        return Result.success();
    }

    @GetMapping("/info")
    public Result<Map<String, Object>> info() {
        return Result.success(authService.info(SecurityUtils.getCurrentUserId()));
    }
}
