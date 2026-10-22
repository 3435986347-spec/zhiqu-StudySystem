package com.zhiqu.service.harness;

import com.zhiqu.entity.HarnessDeviceGrant;
import com.zhiqu.entity.UserAccessToken;
import com.zhiqu.mapper.HarnessDeviceGrantMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 设备码登录：命令行不碰密码；一次允许只换得出一张令牌。 */
class DeviceLoginServiceTest {

    /** LambdaUpdateWrapper.set(...) 要读 MyBatis-Plus 的表信息缓存；单元测试里没有 Spring，自己登记一次。 */
    @org.junit.jupiter.api.BeforeAll
    static void tableInfo() {
        com.baomidou.mybatisplus.core.metadata.TableInfoHelper.initTableInfo(
                new org.apache.ibatis.builder.MapperBuilderAssistant(
                        new com.baomidou.mybatisplus.core.MybatisConfiguration(), ""), HarnessDeviceGrant.class);
    }

    private final HarnessDeviceGrantMapper mapper = mock(HarnessDeviceGrantMapper.class);
    private final AccessTokenService tokens = mock(AccessTokenService.class);
    private final DeviceLoginService service = new DeviceLoginService(mapper, tokens);

    private HarnessDeviceGrant grant(String status, LocalDateTime expires) {
        HarnessDeviceGrant g = new HarnessDeviceGrant();
        g.setId(5L);
        g.setUserId(1L);
        g.setStatus(status);
        g.setClientName("命令行");
        g.setExpiresAt(expires);
        when(mapper.selectOne(any())).thenReturn(g);
        return g;
    }

    private void tokenIssues() {
        UserAccessToken row = new UserAccessToken();
        row.setId(9L);
        row.setName("命令行");
        when(tokens.issue(anyLong(), anyString())).thenReturn(new AccessTokenService.Issued(row, "zqp_secret"));
    }

    @Test
    @DisplayName("start：deviceCode 给命令行、库里只存它的哈希；userCode 是 8 位、显示成 XXXX-XXXX")
    void 开始() {
        when(mapper.selectCount(any())).thenReturn(0L);
        Map<String, Object> out = service.start("命令行 · MacBook", "127.0.0.1");
        String device = String.valueOf(out.get("deviceCode"));
        String user = String.valueOf(out.get("userCode"));
        assertTrue(device.length() >= 40, device);
        assertTrue(user.matches("[A-Z2-9]{4}-[A-Z2-9]{4}"), user);
        assertFalse(user.matches(".*[01OIL].*"), "容易看错的字符不该出现：" + user);
        verify(mapper).insert(org.mockito.ArgumentMatchers.<HarnessDeviceGrant>argThat(g ->
                g.getDeviceCodeHash().equals(AccessTokenService.hash(device)) && !g.toString().contains(device)));
    }

    @Test
    @DisplayName("poll：没批 = PENDING；过期 / 不认识 / 已经换过 都是 EXPIRED；拒绝 = DENIED")
    void 状态() {
        grant("PENDING", LocalDateTime.now().plusMinutes(5));
        assertEquals("PENDING", service.poll("dev").get("status"));
        grant("PENDING", LocalDateTime.now().minusSeconds(1));
        assertEquals("EXPIRED", service.poll("dev").get("status"));
        grant("CONSUMED", LocalDateTime.now().plusMinutes(5));
        assertEquals("EXPIRED", service.poll("dev").get("status"));
        grant("DENIED", LocalDateTime.now().plusMinutes(5));
        assertEquals("DENIED", service.poll("dev").get("status"));
        when(mapper.selectOne(any())).thenReturn(null);
        assertEquals("EXPIRED", service.poll("dev").get("status"));
        verify(tokens, never()).issue(anyLong(), anyString());
    }

    @Test
    @DisplayName("允许之后：抢到 APPROVED→CONSUMED 的那一次才签令牌；抢不到（并发的另一次轮询）不签")
    void 只换一次() {
        grant("APPROVED", LocalDateTime.now().plusMinutes(5));
        tokenIssues();
        when(mapper.update(any(), any())).thenReturn(1);
        Map<String, Object> first = service.poll("dev");
        assertEquals("APPROVED", first.get("status"));
        assertEquals("zqp_secret", first.get("token"));

        when(mapper.update(any(), any())).thenReturn(0);   // 另一个请求已经抢走了
        assertEquals("EXPIRED", service.poll("dev").get("status"));
        verify(tokens, times(1)).issue(anyLong(), anyString());
    }

    @Test
    @DisplayName("用户输入的码：大小写、横线、空格都容忍")
    void 规整() {
        assertEquals("ABCDEFGH", DeviceLoginService.normalize(" abcd-efgh "));
        assertEquals("ABCD-EFGH", DeviceLoginService.display("ABCDEFGH"));
    }
}
