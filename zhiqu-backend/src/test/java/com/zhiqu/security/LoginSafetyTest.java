package com.zhiqu.security;

import com.zhiqu.SourceText;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.LoginRequest;
import com.zhiqu.entity.LoginLog;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.LoginLogMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.impl.AuthServiceImpl;
import com.zhiqu.util.UploadPathResolver;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 登录这一步的两件事：用户名存不存在不能从响应时间看出来；登录记录里的 IP 不能由请求方自己填。
 */
class LoginSafetyTest {

    private final SysUserMapper users = mock(SysUserMapper.class);
    private final LoginLogMapper logs = mock(LoginLogMapper.class);
    private final BCryptPasswordEncoder encoder = spy(new BCryptPasswordEncoder(4));
    private final ClientIpResolver ips = new ClientIpResolver();
    private final AuthServiceImpl auth;

    LoginSafetyTest() {
        JwtUtils jwt = new JwtUtils();
        ReflectionTestUtils.setField(jwt, "secret", "0123456789abcdef0123456789abcdef-login-safety-test");
        ReflectionTestUtils.setField(jwt, "expiration", 3_600_000L);
        ReflectionTestUtils.setField(jwt, "rememberExpiration", 7_200_000L);
        auth = new AuthServiceImpl(users, encoder, jwt, mock(AchievementService.class), mock(UploadPathResolver.class), logs, ips);
    }

    @AfterEach
    void clearRequest() {
        RequestContextHolder.resetRequestAttributes();
    }

    private static LoginRequest request(String name, String password) {
        LoginRequest r = new LoginRequest();
        r.setUsername(name);
        r.setPassword(password);
        return r;
    }

    @Test
    @DisplayName("用户名不存在：照样做一次密码比对（和存在时花一样的时间），报错文字一样")
    void 不存在的用户名也要比一次密码() {
        when(users.selectOne(any())).thenReturn(null);
        BusinessException e = assertThrows(BusinessException.class, () -> auth.login(request("nobody", "x")));
        assertEquals("用户名或密码错误", e.getMessage());
        verify(encoder, times(1)).matches(anyString(), anyString());
    }

    private SysUser user() {
        SysUser u = new SysUser();
        u.setId(7L);
        u.setUsername("alice");
        u.setPassword(encoder.encode("right-pass"));
        u.setStatus(1);
        return u;
    }

    private String loggedIp(String remoteAddr, String forwardedFor) {
        SysUser alice = user();   // 先建好：在 when(...) 里调 spy 的方法会打乱 Mockito 的打桩
        when(users.selectOne(any())).thenReturn(alice);
        MockHttpServletRequest http = new MockHttpServletRequest();
        http.setRemoteAddr(remoteAddr);
        http.addHeader("X-Forwarded-For", forwardedFor);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(http));
        auth.login(request("alice", "right-pass"));
        ArgumentCaptor<LoginLog> saved = ArgumentCaptor.forClass(LoginLog.class);
        verify(logs, org.mockito.Mockito.atLeastOnce()).insert(saved.capture());
        return saved.getValue().getIp();
    }

    @Test
    @DisplayName("登录记录的 IP：没开可信代理时不认 X-Forwarded-For（原来谁都能给自己的登录记录填一个假 IP）")
    void 登录记录不认伪造的转发头() {
        assertEquals("198.51.100.7", loggedIp("198.51.100.7", "6.6.6.6"));
    }

    @Test
    @DisplayName("开了可信代理、而且对端是本机代理时，才用转发头里的那个 —— 证明登录记录走的是 ClientIpResolver")
    void 可信代理后面才认转发头() {
        ReflectionTestUtils.setField(ips, "trustForwardedHeaders", true);
        assertEquals("6.6.6.6", loggedIp("127.0.0.1", "6.6.6.6"));
    }

    @Test
    @DisplayName("客户端 IP 只有一种算法：src/main 里只有 ClientIpResolver 读 X-Forwarded-For")
    void 只有一处读转发头() throws Exception {
        List<String> readers = new ArrayList<>();
        int files = 0;
        try (Stream<Path> all = Files.walk(Path.of("src/main/java"))) {
            for (Path f : all.filter(p -> p.toString().endsWith(".java")).toList()) {
                files++;
                if (SourceText.stripComments(Files.readString(f)).contains("\"X-Forwarded-For\"")) {
                    readers.add(f.getFileName().toString());
                }
            }
        }
        assertTrue(files > 100, "扫到的源文件太少，判据在空转：" + files);
        assertEquals(List.of("ClientIpResolver.java"), readers);
    }

    @Test
    @DisplayName("昵称为空的账号照样能登录（原来 Map.of 遇到 null 直接抛，每次登录都是 500）")
    void 昵称为空也能登录() {
        SysUser noNickname = user();
        when(users.selectOne(any())).thenReturn(noNickname);
        java.util.Map<String, Object> r = auth.login(request("alice", "right-pass"));
        assertEquals("alice", r.get("nickname"));
    }
}
