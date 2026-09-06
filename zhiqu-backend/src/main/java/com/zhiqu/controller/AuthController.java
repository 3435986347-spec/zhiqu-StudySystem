package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.LoginRequest;
import com.zhiqu.dto.RegisterRequest;
import com.zhiqu.security.JwtAuthenticationFilter;
import com.zhiqu.security.JwtUtils;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.AuthService;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService authService;
    private final JwtUtils jwtUtils;

    @Value("${app.cookie.secure:false}")
    private boolean secureCookie;

    public AuthController(AuthService authService, JwtUtils jwtUtils) {
        this.authService = authService;
        this.jwtUtils = jwtUtils;
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
            response.addHeader(HttpHeaders.SET_COOKIE, authCookie(
                    String.valueOf(result.get("token")),
                    Duration.ofMillis(jwtUtils.getRememberExpiration())
            ).toString());
        } else {
            response.addHeader(HttpHeaders.SET_COOKIE, clearAuthCookie().toString());
        }
        return Result.success(result);
    }

    @PostMapping("/logout")
    public Result<Void> logout(HttpServletResponse response) {
        response.addHeader(HttpHeaders.SET_COOKIE, clearAuthCookie().toString());
        return Result.success();
    }

    @GetMapping("/info")
    public Result<Map<String, Object>> info() {
        return Result.success(authService.info(SecurityUtils.getCurrentUserId()));
    }

    private ResponseCookie authCookie(String token, Duration maxAge) {
        return ResponseCookie.from(JwtAuthenticationFilter.AUTH_COOKIE_NAME, token)
                .httpOnly(true)
                .secure(secureCookie)
                .sameSite("Lax")
                .path("/")
                .maxAge(maxAge)
                .build();
    }

    private ResponseCookie clearAuthCookie() {
        return ResponseCookie.from(JwtAuthenticationFilter.AUTH_COOKIE_NAME, "")
                .httpOnly(true)
                .secure(secureCookie)
                .sameSite("Lax")
                .path("/")
                .maxAge(Duration.ZERO)
                .build();
    }
}
