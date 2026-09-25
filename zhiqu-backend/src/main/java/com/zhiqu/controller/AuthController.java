package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.LoginRequest;
import com.zhiqu.dto.RegisterRequest;
import com.zhiqu.security.AuthCookies;
import com.zhiqu.security.JwtUtils;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.AuthService;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService authService;
    private final JwtUtils jwtUtils;
    private final AuthCookies cookies;

    public AuthController(AuthService authService, JwtUtils jwtUtils, AuthCookies cookies) {
        this.authService = authService;
        this.jwtUtils = jwtUtils;
        this.cookies = cookies;
    }

    @PostMapping("/register")
    public Result<Map<String, Object>> register(@RequestBody @Valid RegisterRequest request) {
        return Result.success(authService.register(request));
    }

    @PostMapping("/login")
    public Result<Map<String, Object>> login(@RequestBody @Valid LoginRequest request,
                                             HttpServletResponse response) {
        Map<String, Object> result = authService.login(request);
        if (Boolean.TRUE.equals(request.getRememberMe())) {
            cookies.set(response, String.valueOf(result.get("token")), Duration.ofMillis(jwtUtils.getRememberExpiration()));
        } else {
            cookies.clear(response);
        }
        return Result.success(result);
    }

    @PostMapping("/logout")
    public Result<Void> logout(HttpServletResponse response) {
        cookies.clear(response);
        return Result.success();
    }

    @GetMapping("/info")
    public Result<Map<String, Object>> info() {
        return Result.success(authService.info(SecurityUtils.getCurrentUserId()));
    }
}
