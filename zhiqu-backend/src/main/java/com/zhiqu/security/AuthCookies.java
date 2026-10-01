package com.zhiqu.security;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Component;

import java.time.Duration;

/**
 * 「记住我」那个登录 Cookie 的唯一写法。登录时写它；改完密码时，如果这次请求带着它，就换成新令牌 ——
 * 否则 Cookie 里还是作废了的旧令牌，下次只靠 Cookie 进来的页面就被踢回登录。
 */
@Component
public class AuthCookies {

    @Value("${app.cookie.secure:false}")
    private boolean secureCookie;

    public void set(HttpServletResponse response, String token, Duration maxAge) {
        response.addHeader(HttpHeaders.SET_COOKIE, build(token, maxAge).toString());
    }

    public void clear(HttpServletResponse response) {
        response.addHeader(HttpHeaders.SET_COOKIE, build("", Duration.ZERO).toString());
    }

    public boolean present(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return false;
        }
        for (Cookie cookie : cookies) {
            if (JwtAuthenticationFilter.AUTH_COOKIE_NAME.equals(cookie.getName()) && cookie.getValue() != null
                    && !cookie.getValue().isBlank()) {
                return true;
            }
        }
        return false;
    }

    private ResponseCookie build(String token, Duration maxAge) {
        return ResponseCookie.from(JwtAuthenticationFilter.AUTH_COOKIE_NAME, token)
                .httpOnly(true)
                .secure(secureCookie)
                .sameSite("Lax")
                .path("/")
                .maxAge(maxAge)
                .build();
    }
}
