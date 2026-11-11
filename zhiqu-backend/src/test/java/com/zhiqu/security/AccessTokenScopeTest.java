package com.zhiqu.security;

import com.zhiqu.controller.AccessTokenController;
import com.zhiqu.controller.HarnessController;
import com.zhiqu.entity.SysUser;
import com.zhiqu.entity.UserAccessToken;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.harness.AccessTokenService;
import com.zhiqu.service.harness.HarnessPaths;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.RequestMapping;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 个人访问令牌只在 {@code /api/harness/} 下被认。一张泄露的令牌够不着别的接口 ——
 * 尤其够不着管理令牌的接口（不能给自己续命、不能批准别的设备）。
 */
class AccessTokenScopeTest {

    private static final String TOKEN = "zqp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
    private final AccessTokenService tokens = mock(AccessTokenService.class);
    private final SysUserMapper users = mock(SysUserMapper.class);
    private final JwtAuthenticationFilter filter = new JwtAuthenticationFilter(
            mock(JwtUtils.class), users, tokens, mock(ClientIpResolver.class));

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    private Authentication run(String path) throws Exception {
        return run("GET", path, AccessTokenService.SCOPE_HARNESS);
    }

    private Authentication run(String method, String path, String scope) throws Exception {
        UserAccessToken row = new UserAccessToken();
        row.setId(1L);
        row.setUserId(42L);
        row.setScope(scope);
        when(tokens.authenticate(anyString(), any())).thenReturn(row);
        SysUser user = new SysUser();
        user.setId(42L);
        user.setStatus(1);
        when(users.selectById(42L)).thenReturn(user);
        MockHttpServletRequest request = new MockHttpServletRequest(method, path);
        request.addHeader("Authorization", "Bearer " + TOKEN);
        Authentication[] seen = new Authentication[1];
        filter.doFilter(request, new MockHttpServletResponse(), new MockFilterChain() {
            @Override
            public void doFilter(jakarta.servlet.ServletRequest req, jakarta.servlet.ServletResponse res) {
                seen[0] = SecurityContextHolder.getContext().getAuthentication();
            }
        });
        SecurityContextHolder.clearContext();
        return seen[0];
    }

    /**
     * 第一百二十九轮：桌面版本机代码的令牌经页面 → 外壳 → node 进程，多走两手，只给它本机代码要的四个接口。
     * 命令行的令牌（HARNESS）照旧整个 /api/harness 都认（对照组：同一批路径它都认，说明挡下来的是范围，不是路径本身不存在）。
     */
    @Test
    @DisplayName("桌面版本机代码的令牌：只认挑模型 / 调模型 / 远程工具四个接口（方法也要对）；会话存档、用量、/me、改上下文窗口不认；认不出的范围不认")
    void 本机代码令牌的范围() throws Exception {
        String desk = AccessTokenService.SCOPE_DESKTOP_CODE;
        for (String[] ok : new String[][]{{"GET", "/api/harness/models"}, {"POST", "/api/harness/model/stream"},
                {"GET", "/api/harness/tools"}, {"POST", "/api/harness/tools/call"}}) {
            Authentication auth = run(ok[0], ok[1], desk);
            assertTrue(auth != null && Long.valueOf(42L).equals(auth.getPrincipal()), "本机代码要用 " + ok[0] + " " + ok[1] + "，令牌却不认");
        }
        for (String[] no : new String[][]{{"GET", "/api/harness/me"}, {"GET", "/api/harness/usage"}, {"GET", "/api/harness/sessions"},
                {"POST", "/api/harness/sessions"}, {"POST", "/api/harness/sessions/s1/messages"}, {"POST", "/api/harness/models/1/context-window"},
                {"GET", "/api/harness/model/stream"}, {"DELETE", "/api/harness/tools/call"}, {"GET", "/api/harness/models/"}}) {
            assertNull(run(no[0], no[1], desk), "本机代码的令牌不该在 " + no[0] + " " + no[1] + " 被认");
            assertTrue(run(no[0], no[1], AccessTokenService.SCOPE_HARNESS) != null, "对照组：命令行的令牌在 " + no[1] + " 照样认");
        }
        assertNull(run("GET", "/api/harness/models", "ADMIN"), "认不出的范围要一律不认");
        assertTrue(run("GET", "/api/harness/me", null) != null, "老的行范围是空的：照 HARNESS 认");
        assertNull(run("POST", "/api/access-tokens/desktop-code", desk), "令牌换不来令牌");
    }

    @Test
    @DisplayName("harness 接口下：令牌认得出，带 HARNESS_TOKEN 权限")
    void harness下认() throws Exception {
        Authentication auth = run("/api/harness/models");
        assertEquals(42L, auth.getPrincipal());
        assertTrue(auth.getAuthorities().stream().anyMatch(a -> "HARNESS_TOKEN".equals(a.getAuthority())));
    }

    @Test
    @DisplayName("别处一律不认：管理令牌、网页 AI 接口、用户资料、路径穿越 —— 连库都不查")
    void 别处不认() throws Exception {
        for (String path : new String[]{"/api/access-tokens", "/api/access-tokens/device/ABCD-EFGH/approve",
                "/api/ai/models", "/api/user/profile", "/api/harness/../access-tokens", "/api/harnessx/models",
                "/api/harness/device/poll"}) {
            assertNull(run(path), "令牌不该在 " + path + " 被认");
        }
        verify(tokens, never()).authenticate(TOKEN, null);
    }

    @Test
    @DisplayName("被禁用的用户：手里的令牌一并失效")
    void 禁用() throws Exception {
        UserAccessToken row = new UserAccessToken();
        row.setUserId(42L);
        when(tokens.authenticate(anyString(), any())).thenReturn(row);
        SysUser user = new SysUser();
        user.setStatus(0);
        when(users.selectById(42L)).thenReturn(user);
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/harness/models");
        request.addHeader("Authorization", "Bearer " + TOKEN);
        Authentication[] seen = new Authentication[1];
        filter.doFilter(request, new MockHttpServletResponse(), new MockFilterChain() {
            @Override
            public void doFilter(jakarta.servlet.ServletRequest req, jakarta.servlet.ServletResponse res) {
                seen[0] = SecurityContextHolder.getContext().getAuthentication();
            }
        });
        assertNull(seen[0]);
    }

    @Test
    @DisplayName("结构：管理令牌的控制器不在 /api/harness 下；harness 控制器在；放行名单里没有 /api/harness/** 通配")
    void 结构() throws Exception {
        String tokensPath = AccessTokenController.class.getAnnotation(RequestMapping.class).value()[0];
        String harnessPath = HarnessController.class.getAnnotation(RequestMapping.class).value()[0];
        assertFalse(HarnessPaths.acceptsAccessToken(tokensPath + "/"), tokensPath);
        assertTrue(HarnessPaths.acceptsAccessToken(harnessPath + "/models"), harnessPath);
        String config = Files.readString(Path.of("src/main/java/com/zhiqu/config/SecurityConfig.java"));
        assertFalse(config.contains("\"/api/harness/**\""), "harness 整个放行的话，令牌和登录都不用了");
        assertTrue(config.contains("\"/api/harness/device/poll\""));
    }
}
