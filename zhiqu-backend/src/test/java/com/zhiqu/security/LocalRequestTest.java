package com.zhiqu.security;

import com.zhiqu.service.workspace.WorkspaceProperties;
import com.zhiqu.service.workspace.WorkspaceRegistry;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 只认这台电脑上发来的请求（第一百一十五轮）。 */
class LocalRequestTest {

    private static MockHttpServletRequest request(String host) {
        MockHttpServletRequest r = new MockHttpServletRequest("GET", "/api/workspace/settings");
        r.setRemoteAddr("127.0.0.1");
        if (host != null) {
            r.addHeader("Host", host);
        }
        return r;
    }

    @ParameterizedTest
    @ValueSource(strings = {"localhost", "localhost:8080", "LOCALHOST:18082", "127.0.0.1", "127.0.0.1:8080", "127.1.2.3:9", "[::1]", "[::1]:8080"})
    @DisplayName("本机的写法：桌面应用、本机打开的网页")
    void 本机的写法(String host) {
        assertTrue(LocalRequest.isLocal(request(host)), host);
    }

    @ParameterizedTest
    @ValueSource(strings = {"evil.example", "evil.example:8080", "localhost.evil.example", "127.0.0.1.evil.example", "127.evil.example", "evil.localhost",
            "0.0.0.0", "0.0.0.0:8080", "2130706433", "192.168.1.5:8080", "zhiqu.example.com", "[::2]:80", "[::1", "[::1]x", "[::1]:abc", "localhost:abc", "localhost.", "localhost:80:80", ""})
    @DisplayName("DNS 重绑定的样子（Host 是别人的域名）和各种认不准的写法：一律不算本机")
    void 陌生的写法(String host) {
        assertFalse(LocalRequest.isLocal(request(host)), host);
    }

    @Test
    @DisplayName("没有 Host 不算")
    void 没有Host() {
        assertFalse(LocalRequest.isLocal(request(null)));
    }

    @ParameterizedTest
    @ValueSource(strings = {"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP"})
    @DisplayName("经过反向代理的不算：连接来自本机、Host 也可能被改写成本机，但人在外面")
    void 带转发头(String header) {
        MockHttpServletRequest r = request("localhost:8080");
        r.addHeader(header, "203.0.113.9");
        assertFalse(LocalRequest.isLocal(r), header);
    }

    @ParameterizedTest
    @ValueSource(strings = {"192.168.1.20", "203.0.113.9", "10.0.0.1"})
    @DisplayName("连接不是从本机来的不算：别人照着写一个 Host: localhost")
    void 连接不是本机(String peer) {
        MockHttpServletRequest r = request("localhost:8080");
        r.setRemoteAddr(peer);
        assertFalse(LocalRequest.isLocal(r), peer);
    }

    @Test
    @DisplayName("IPv6 的回环连接算本机")
    void IPv6回环() {
        MockHttpServletRequest r = request("[::1]:8080");
        r.setRemoteAddr("0:0:0:0:0:0:0:1");
        assertTrue(LocalRequest.isLocal(r));
    }

    // ── 配置给了默认档位时，整个后端只接本机的请求 ───────────

    private static WorkspaceDefaultLocalFilter filter(boolean open) {
        WorkspaceProperties props = new WorkspaceProperties();
        if (open) {
            props.setMode("EXEC");
        }
        return new WorkspaceDefaultLocalFilter(new WorkspaceRegistry(props, new com.fasterxml.jackson.databind.ObjectMapper(), "unused.json", "127.0.0.1", ""));
    }

    private static MockFilterChain through(WorkspaceDefaultLocalFilter f, MockHttpServletRequest r, MockHttpServletResponse res) throws Exception {
        MockFilterChain chain = new MockFilterChain();
        f.doFilter(r, res, chain);
        return chain;
    }

    @Test
    @DisplayName("默认开着：陌生的 Host 发什么 /api/ 都不接（注册一个账号就有档位，走 /api/ai 叫起 code agent）")
    void 默认开着拒绝陌生请求() throws Exception {
        for (String path : new String[] {"/api/ai/chat/stream", "/api/auth/register", "/api/workspace/settings"}) {
            MockHttpServletRequest r = request("evil.example:8080");
            r.setRequestURI(path);
            MockHttpServletResponse res = new MockHttpServletResponse();
            MockFilterChain chain = through(filter(true), r, res);
            assertNull(chain.getRequest(), path + " 不该往下走");
            assertEquals(403, res.getStatus());
            assertTrue(res.getContentAsString().contains("本机"), res.getContentAsString());
        }
    }

    @Test
    @DisplayName("默认开着：本机的请求照常；静态页不管（陌生 Host 打开页面没关系，调不了接口）")
    void 默认开着放行本机() throws Exception {
        MockHttpServletRequest local = request("localhost:8080");
        local.setRequestURI("/api/ai/chat/stream");
        assertNotNull(through(filter(true), local, new MockHttpServletResponse()).getRequest());
        MockHttpServletRequest page = request("evil.example");
        page.setRequestURI("/ai-assistant.html");
        assertNotNull(through(filter(true), page, new MockHttpServletResponse()).getRequest());
    }

    @Test
    @DisplayName("默认关着（服务器上的部署都是这样）：什么都不管，经过 Caddy 的请求照常")
    void 默认关着不管() throws Exception {
        MockHttpServletRequest r = request("zhiqu.example.com");
        r.addHeader("X-Forwarded-For", "203.0.113.9");
        r.setRequestURI("/api/ai/chat/stream");
        assertNotNull(through(filter(false), r, new MockHttpServletResponse()).getRequest());
    }
}
