package com.zhiqu.service.harness;

import com.zhiqu.entity.UserAccessToken;
import com.zhiqu.mapper.UserAccessTokenMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.LocalDateTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AccessTokenServiceTest {

    @Test
    @DisplayName("签发：明文只返回一次；库里存的是它的 SHA-256 和末 4 位，没有明文")
    void 只存哈希() {
        UserAccessTokenMapper mapper = mock(UserAccessTokenMapper.class);
        AccessTokenService.Issued issued = new AccessTokenService(mapper).issue(1L, "命令行 · MacBook");
        ArgumentCaptor<UserAccessToken> row = ArgumentCaptor.forClass(UserAccessToken.class);
        verify(mapper).insert(row.capture());
        String token = issued.token();
        assertTrue(token.startsWith("zqp_") && token.length() >= 40, token);
        assertEquals(AccessTokenService.hash(token), row.getValue().getTokenHash());
        assertEquals(64, row.getValue().getTokenHash().length());
        assertFalse(row.getValue().toString().contains(token.substring(4)), "库里的行不该含令牌明文");
        assertEquals(token.substring(token.length() - 4), row.getValue().getTokenHint());
        assertNotEquals(token, new AccessTokenService(mock(UserAccessTokenMapper.class)).issue(1L, "x").token());
    }

    @Test
    @DisplayName("能不能用：撤销了不行、过期了不行、没过期限的一直行")
    void 可用性() {
        LocalDateTime now = LocalDateTime.of(2026, 9, 24, 12, 0);
        UserAccessToken t = new UserAccessToken();
        assertTrue(AccessTokenService.usable(t, now));
        t.setExpiresAt(now.plusMinutes(1));
        assertTrue(AccessTokenService.usable(t, now));
        t.setExpiresAt(now.minusSeconds(1));
        assertFalse(AccessTokenService.usable(t, now));
        UserAccessToken revoked = new UserAccessToken();
        revoked.setRevokedAt(now.minusDays(1));
        assertFalse(AccessTokenService.usable(revoked, now));
        assertFalse(AccessTokenService.usable(null, now));
    }

    @Test
    @DisplayName("认证：不是 zqp_ 开头的（比如 JWT）连库都不查；撤销过的令牌认不出来")
    void 认证() {
        UserAccessTokenMapper mapper = mock(UserAccessTokenMapper.class);
        AccessTokenService service = new AccessTokenService(mapper);
        assertNull(service.authenticate("eyJhbGciOiJIUzI1NiJ9.x.y", "1.2.3.4"));
        verify(mapper, never()).selectOne(any());
        UserAccessToken revoked = new UserAccessToken();
        revoked.setId(3L);
        revoked.setRevokedAt(LocalDateTime.now());
        when(mapper.selectOne(any())).thenReturn(revoked);
        assertNull(service.authenticate("zqp_abc", "1.2.3.4"));
    }

    @Test
    @DisplayName("名字里的控制字符去掉（它会显示在网页上）；空名字给默认值")
    void 名字() {
        assertEquals("命令行", AccessTokenService.cleanName("  "));
        assertEquals("a b", AccessTokenService.cleanName("a\u001b b").replace("  ", " ").replace("a b", "a b"));
        assertFalse(AccessTokenService.cleanName("x\u0007y").contains("\u0007"));
        assertEquals(100, AccessTokenService.cleanName("长".repeat(300)).length());
    }
}
