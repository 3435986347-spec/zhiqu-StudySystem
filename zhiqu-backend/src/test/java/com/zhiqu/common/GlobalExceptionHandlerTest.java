package com.zhiqu.common;

import com.zhiqu.service.RuntimeIssueService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 异常 → 回包（第十一轮）。全接口暴力测试（{@code EndpointFuzzIntegrationTest}）管「坏输入不许变成运行问题」；
 * 这里管另外两件它看不见的事：给用户的话说清哪里不对，以及<b>真正的意外不把异常原文回给用户</b>。
 */
class GlobalExceptionHandlerTest {

    private final RuntimeIssueService issues = mock(RuntimeIssueService.class);
    private final GlobalExceptionHandler handler = new GlobalExceptionHandler(issues);

    @Test
    @DisplayName("真正的意外：记成运行问题；回给用户的是一句话加编号，不含异常原文（SQL、表名、类名）")
    void 意外不泄露原文() {
        when(issues.reportServerIssue(any(), any())).thenReturn(42L);
        Result<Void> r = handler.handleOther(new RuntimeException(
                "### Error updating database.  Cause: com.mysql.cj.jdbc.exceptions.MysqlDataTruncation: Data too long for column 'username'"),
                new MockHttpServletRequest());
        assertEquals(500, r.getCode());
        assertTrue(r.getMessage().contains("编号 42"), r.getMessage());
        assertFalse(r.getMessage().contains("mysql") || r.getMessage().contains("username") || r.getMessage().contains("Error"), r.getMessage());
    }

    @Test
    @DisplayName("路径里的 id 给了字母：400，说清是哪个参数、应当是数字；不记成运行问题")
    void 类型不对() throws Exception {
        MethodArgumentTypeMismatchException e = new MethodArgumentTypeMismatchException("abc", Long.class, "id",
                new org.springframework.core.MethodParameter(Object.class.getMethod("wait", long.class), 0), new NumberFormatException());
        Result<Void> r = handler.handleTypeMismatch(e);
        assertEquals(400, r.getCode());
        assertEquals("参数 id 的值「abc」不对，应当是数字", r.getMessage());
        verify(issues, never()).reportServerIssue(any(), any());
    }

    @Test
    @DisplayName("日期写错：400，说出写错的原文和正确的样子")
    void 日期不对() {
        DateTimeParseException e = org.junit.jupiter.api.Assertions.assertThrows(DateTimeParseException.class,
                () -> LocalDate.parse("2026-02-30"));
        Result<Void> r = handler.handleDate(e);
        assertEquals(400, r.getCode());
        assertTrue(r.getMessage().contains("2026-02-30") && r.getMessage().contains("2026-09-28"), r.getMessage());
    }

    @Test
    @DisplayName("类型名说人话：数字 / 日期 / 列表 / 枚举的取值")
    void 类型名() {
        assertEquals("数字", GlobalExceptionHandler.typeName(Long.class));
        assertEquals("数字", GlobalExceptionHandler.typeName(int.class));
        assertTrue(GlobalExceptionHandler.typeName(LocalDate.class).startsWith("日期"));
        assertEquals("一个列表", GlobalExceptionHandler.typeName(java.util.List.class));
        assertTrue(GlobalExceptionHandler.typeName(java.time.DayOfWeek.class).contains("MONDAY"));
    }

    @Test
    @DisplayName("密码超过 72 字节拒绝：这一版 BCrypt 对超出的部分静默截断（实测 30 个汉字的密码，前 24 个字加别的也能登）")
    void 密码按字节限长() {
        PasswordRules.requireStorable("a".repeat(72));
        PasswordRules.requireStorable("密".repeat(24));
        BusinessException e = org.junit.jupiter.api.Assertions.assertThrows(BusinessException.class,
                () -> PasswordRules.requireStorable("密".repeat(25)));
        assertTrue(e.getMessage().contains("72 字节"), e.getMessage());
        org.junit.jupiter.api.Assertions.assertThrows(BusinessException.class, () -> PasswordRules.requireStorable("a".repeat(73)));
        // 截断确实存在（这一条要是哪天绿不了，说明 Spring Security 改了行为，上面的限制可以重新评估）
        var bcrypt = new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder(4);
        String hash = bcrypt.encode("密".repeat(30));
        assertTrue(bcrypt.matches("密".repeat(24) + "完全不同的结尾", hash), "BCrypt 不再截断了 —— 重新看看 PasswordRules 还要不要");
    }

    @Test
    @DisplayName("对面已经断开（刷新、关页面）：不记运行问题 —— 那不是服务器的问题（第十三轮：AI 回答到一半刷新，每次一条 Broken pipe）")
    void 客户端走了不记() {
        for (Exception e : new Exception[]{new java.io.IOException("Broken pipe"),
                new RuntimeException("写回包失败", new java.io.IOException("Connection reset by peer")),
                new org.springframework.web.context.request.async.AsyncRequestNotUsableException("Response not usable")}) {
            handler.handleOther(e, new MockHttpServletRequest());
        }
        verify(issues, never()).reportServerIssue(any(), any());
        handler.handleOther(new java.io.IOException("No space left on device"), new MockHttpServletRequest());
        verify(issues).reportServerIssue(any(), any());
    }
}
