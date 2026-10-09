package com.zhiqu.service.notification;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.UserReminderSetting;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.TaskReminderMapper;
import com.zhiqu.mapper.UserReminderSettingMapper;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.impl.ReminderServiceImpl;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import com.zhiqu.service.privacy.TaskPrivacyService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.web.client.RestTemplate;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * 提醒渠道往外发请求：发给谁（企业微信 Webhook 白名单）、等多久（超时）。见 {@link ChannelEndpoints}。
 */
class ChannelEndpointsTest {

    @Test
    @DisplayName("企业微信 Webhook：只认 https://qyapi.weixin.qq.com/cgi-bin/webhook/send；内网、仿冒域名、http、端口、userinfo 都拒")
    void 企业微信地址白名单() {
        for (String ok : List.of(
                "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx",
                "https://QYAPI.weixin.qq.com/cgi-bin/webhook/send?key=abc",
                "https://qyapi.weixin.qq.com:443/cgi-bin/webhook/send?key=abc",
                "  https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc  ")) {
            assertDoesNotThrow(() -> ChannelEndpoints.requireWeComWebhook(ok), ok);
        }
        for (String bad : List.of(
                "http://169.254.169.254/latest/meta-data/",
                "http://127.0.0.1:8001/v1/meta",
                "https://qyapi.weixin.qq.com.evil.example/cgi-bin/webhook/send?key=abc",
                "https://evil.example/qyapi.weixin.qq.com/cgi-bin/webhook/send",
                "https://evil.example@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
                "http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
                "https://qyapi.weixin.qq.com:8443/cgi-bin/webhook/send?key=abc",
                "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=x",
                "file:///etc/passwd",
                "不是网址")) {
            BusinessException e = assertThrows(BusinessException.class, () -> ChannelEndpoints.requireWeComWebhook(bad), bad);
            assertTrue(e.getMessage().contains("qyapi.weixin.qq.com/cgi-bin/webhook/send"), "要告诉用户该填什么：" + e.getMessage());
        }
    }

    @Test
    @DisplayName("库里已经存着一个内网地址：发送时一个连接都不许发出去")
    void 发送时再判一次() throws Exception {
        try (ServerSocket server = new ServerSocket(0)) {
            AtomicInteger accepted = acceptInBackground(server);
            UserReminderSetting setting = new UserReminderSetting();
            setting.setChannel("WECOM");
            setting.setWebhookUrl("http://127.0.0.1:" + server.getLocalPort() + "/cgi-bin/webhook/send?key=x");
            BusinessException e = assertThrows(BusinessException.class,
                    () -> new WeComWebhookNotificationChannel().send(setting, "hi"));
            assertTrue(e.getMessage().contains("企业微信 Webhook 地址不对"), e.getMessage());
            Thread.sleep(200);
            assertEquals(0, accepted.get(), "服务器替用户敲了内网地址");
        }
    }

    @Test
    @DisplayName("保存设置时就拒绝内网地址，并且什么都不写进库")
    void 保存时就拒绝() {
        UserReminderSettingMapper settings = mock(UserReminderSettingMapper.class);
        SensitiveCryptoService crypto = mock(SensitiveCryptoService.class);
        ReminderServiceImpl service = new ReminderServiceImpl(settings, mock(TaskReminderMapper.class),
                mock(StudyTaskMapper.class), mock(RoutineService.class), mock(TaskPrivacyService.class),
                List.of(new WeComWebhookNotificationChannel()), crypto);
        BusinessException e = assertThrows(BusinessException.class, () -> service.saveSettings(1L,
                Map.of("channel", "WECOM", "enabled", true, "webhookUrl", "http://169.254.169.254/latest/meta-data/")));
        assertTrue(e.getMessage().contains("企业微信 Webhook 地址不对"), e.getMessage());
        verify(settings, never()).insert(any(UserReminderSetting.class));
        verify(settings, never()).updateById(any(UserReminderSetting.class));
    }

    @Test
    @DisplayName("推送服务器接了连接却不回话：读超时到点就放弃（原来没有超时，唯一的调度线程会一直挂着）")
    void 对端不回话要超时() throws Exception {
        try (ServerSocket server = new ServerSocket(0)) {
            acceptInBackground(server);
            String url = "http://127.0.0.1:" + server.getLocalPort() + "/send";
            long started = System.nanoTime();
            assertTimeoutPreemptively(Duration.ofSeconds(25), () ->
                    assertThrows(Exception.class, () -> ChannelEndpoints.HTTP.postForEntity(url, new HttpEntity<>("{}"), String.class)));
            long ms = (System.nanoTime() - started) / 1_000_000;
            assertTrue(ms >= ChannelEndpoints.READ_TIMEOUT_MS - 500, "还没到读超时就放弃了：" + ms + " 毫秒");
        }
    }

    @Test
    @DisplayName("每个提醒渠道都用那一个带超时的客户端，没有自己 new 的")
    void 渠道都用共享客户端() throws Exception {
        Path dir = Path.of("src/main/java/com/zhiqu/service/notification");
        List<String> channels = new ArrayList<>();
        try (Stream<Path> files = Files.list(dir)) {
            for (Path f : files.toList()) {
                if (Files.readString(f).contains("implements NotificationChannel")) {
                    channels.add(f.getFileName().toString().replace(".java", ""));
                }
            }
        }
        assertTrue(channels.size() >= 3, "渠道一个都没扫到，判据在空转：" + channels);
        for (String name : channels) {
            Class<?> type = Class.forName("com.zhiqu.service.notification." + name);
            Object channel = type.getDeclaredConstructor().newInstance();
            int restFields = 0;
            for (Field field : type.getDeclaredFields()) {
                if (!RestTemplate.class.isAssignableFrom(field.getType()) || Modifier.isStatic(field.getModifiers())) {
                    continue;
                }
                field.setAccessible(true);
                assertSame(ChannelEndpoints.HTTP, field.get(channel), name + "." + field.getName() + " 不是那个带超时的客户端");
                restFields++;
            }
            assertTrue(restFields >= 1, name + " 里没有找到 RestTemplate 字段 —— 它换了发请求的办法，判据要跟着改");
        }
    }

    /** 只接连接、不读不回：模拟一个挂住的推送服务器。 */
    private static AtomicInteger acceptInBackground(ServerSocket server) {
        AtomicInteger accepted = new AtomicInteger();
        List<Socket> held = new ArrayList<>();
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    held.add(server.accept());
                    accepted.incrementAndGet();
                } catch (Exception e) {
                    return;
                }
            }
        });
        t.setDaemon(true);
        t.start();
        return accepted;
    }
}
