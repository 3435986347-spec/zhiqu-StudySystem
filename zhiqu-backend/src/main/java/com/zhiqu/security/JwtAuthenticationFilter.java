package com.zhiqu.security;

import com.zhiqu.entity.SysUser;
import com.zhiqu.entity.UserAccessToken;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.harness.AccessTokenService;
import com.zhiqu.service.harness.HarnessPaths;
import io.jsonwebtoken.Claims;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Collections;
import java.util.List;

@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {
    public static final String AUTH_COOKIE_NAME = "zhiqu_token";

    /** 用个人访问令牌认证的请求带这个权限 —— 控制器据此区分「网页登录」和「命令行令牌」。 */
    public static final String ACCESS_TOKEN_AUTHORITY = "HARNESS_TOKEN";

    private final JwtUtils jwtUtils;
    private final SysUserMapper sysUserMapper;
    private final AccessTokenService accessTokenService;
    private final ClientIpResolver clientIpResolver;

    public JwtAuthenticationFilter(JwtUtils jwtUtils, SysUserMapper sysUserMapper,
                                   AccessTokenService accessTokenService, ClientIpResolver clientIpResolver) {
        this.jwtUtils = jwtUtils;
        this.sysUserMapper = sysUserMapper;
        this.accessTokenService = accessTokenService;
        this.clientIpResolver = clientIpResolver;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String token = resolveToken(request);
        if (AccessTokenService.looksLikeAccessToken(token)) {
            // 个人访问令牌只在 harness 接口下被认（HarnessPaths）。别处带着它来的请求
            // 就是没登录 —— 不报「令牌无效」，也不回落去当 JWT 解析。
            String path = request.getRequestURI().substring(request.getContextPath().length());
            if (HarnessPaths.acceptsAccessToken(path)) {
                authenticateAccessToken(request, token);
            }
            filterChain.doFilter(request, response);
            return;
        }
        if (token != null) {
            try {
                Claims claims = jwtUtils.parseToken(token);
                Long userId = Long.valueOf(claims.getSubject());
                SysUser user = sysUserMapper.selectById(userId);
                if (user == null || (user.getStatus() != null && user.getStatus() == 0)) {
                    // 用户不存在或已被禁用：即使持有旧 token 也拒绝
                    SecurityContextHolder.clearContext();
                    filterChain.doFilter(request, response);
                    return;
                }
                UsernamePasswordAuthenticationToken authentication = new UsernamePasswordAuthenticationToken(
                        userId, null, Collections.emptyList()
                );
                authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
                SecurityContextHolder.getContext().setAuthentication(authentication);
            } catch (Exception ignored) {
                SecurityContextHolder.clearContext();
            }
        }
        filterChain.doFilter(request, response);
    }

    private void authenticateAccessToken(HttpServletRequest request, String token) {
        try {
            UserAccessToken row = accessTokenService.authenticate(token, clientIpResolver.resolve(request));
            if (row == null) {
                SecurityContextHolder.clearContext();
                return;
            }
            SysUser user = sysUserMapper.selectById(row.getUserId());
            if (user == null || (user.getStatus() != null && user.getStatus() == 0)) {
                // 与 JWT 同一条：用户被禁用后，手里的令牌一并失效
                SecurityContextHolder.clearContext();
                return;
            }
            UsernamePasswordAuthenticationToken authentication = new UsernamePasswordAuthenticationToken(
                    row.getUserId(), null, List.of(new SimpleGrantedAuthority(ACCESS_TOKEN_AUTHORITY)));
            authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
            SecurityContextHolder.getContext().setAuthentication(authentication);
        } catch (Exception e) {
            SecurityContextHolder.clearContext();
        }
    }

    private String resolveToken(HttpServletRequest request) {
        String authHeader = request.getHeader("Authorization");
        if (authHeader != null && authHeader.startsWith("Bearer ")) {
            return authHeader.substring(7);
        }
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        for (Cookie cookie : cookies) {
            if (AUTH_COOKIE_NAME.equals(cookie.getName()) && cookie.getValue() != null && !cookie.getValue().isBlank()) {
                return cookie.getValue();
            }
        }
        return null;
    }
}
