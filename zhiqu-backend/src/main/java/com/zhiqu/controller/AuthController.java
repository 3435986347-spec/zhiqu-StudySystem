package com.zhiqu.controller;

import com.zhiqu.common.BusinessClock;
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
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService authService;
    private final JwtUtils jwtUtils;
    private final AuthCookies cookies;
    private final BusinessClock clock;

    public AuthController(AuthService authService, JwtUtils jwtUtils, AuthCookies cookies, BusinessClock clock) {
        this.authService = authService;
        this.jwtUtils = jwtUtils;
        this.cookies = cookies;
        this.clock = clock;
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
        Map<String, Object> data = new LinkedHashMap<>(authService.info(SecurityUtils.getCurrentUserId()));
        data.put("clock", clockInfo());
        return Result.success(data);
    }

    /**
     * 页面的「今天」以服务端的业务日期为准（第二十一轮）。页面原来用浏览器所在时区的日历日，而且当成数据发回来（打卡日期、
     * 番茄钟记到哪天、新建例行计划的开始日期）—— 在国外、时区设错的电脑上差一天：UTC+14 的浏览器给今天列表里的「周一三五」打卡，
     * 发的是周二，服务器拒；比东八区晚的浏览器过了北京时间零点，打卡悄悄记到昨天。
     * 每个页面启动时都先取 /auth/info，所以业务时区、此刻（毫秒，页面据此算出本机时钟快慢）放在这里；
     * offsetMinutes 给页面把服务端不带时区的时间（createdAt 之类）换成时刻用。
     */
    private Map<String, Object> clockInfo() {
        Instant now = Instant.now();
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("zone", clock.zone().getId());
        c.put("today", clock.today().toString());
        c.put("now", now.toEpochMilli());
        c.put("offsetMinutes", clock.zone().getRules().getOffset(now).getTotalSeconds() / 60);
        return c;
    }
}
