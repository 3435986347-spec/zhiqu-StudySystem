package com.zhiqu.security;

import com.zhiqu.service.workspace.WorkspaceRegistry;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * 配置里把工作区默认打开了（{@code app.workspace.mode} 不是 OFF）时，整个后端只接本机的请求。
 *
 * <p>档位分账号之后，新账号默认是关的、又开不了（{@link com.zhiqu.controller.WorkspaceController} 只认本机），
 * 陌生网页注册的账号用不了代码功能。唯一的例外是配置给了默认值：新账号一注册就有档位，
 * 发一句话就能叫起 code agent，走的是 {@code /api/ai/**}，工作区接口那道门管不到。
 * 默认配置（OFF）下这里什么都不做。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 19)
public class WorkspaceDefaultLocalFilter extends OncePerRequestFilter {

    private final boolean active;

    public WorkspaceDefaultLocalFilter(WorkspaceRegistry workspaces) {
        this.active = workspaces.openByDefault();
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !active || !request.getRequestURI().startsWith("/api/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (LocalRequest.isLocal(request)) {
            chain.doFilter(request, response);
            return;
        }
        response.setStatus(403);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"code\":403,\"message\":\"这个后端开着代码工作区，只接受本机的请求\",\"data\":null}");
    }
}
