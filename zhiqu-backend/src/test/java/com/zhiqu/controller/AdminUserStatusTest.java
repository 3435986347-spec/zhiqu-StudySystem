package com.zhiqu.controller;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.RuntimeIssueMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserFeedbackMapper;
import com.zhiqu.rag.RagAdminService;
import com.zhiqu.rag.RagIndexJobService;
import com.zhiqu.service.AdminGuard;
import com.zhiqu.service.RuntimeFlagService;
import com.zhiqu.service.SharedPlanEventService;
import com.zhiqu.service.SharedPlanService;
import com.zhiqu.service.TrafficMonitorService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 管理员禁用 / 启用账号：只改 status 那一列，并且看行数。
 *
 * <p>真正要挡的是一个竞态 —— 管理员这次请求读出整行之后、写回之前，这个人自己改了点什么（版本号 +1），
 * 原来的 {@code updateById} 于是 0 行，而接口回「成功」。这个窗口在一次 HTTP 请求的中间，集成测试摆不进去
 * （扰动 U8 照出来的：在请求之前改版本号，请求里读到的已经是新的，整行写回照样成功）。所以这里钉的是机制本身。
 */
class AdminUserStatusTest {

    private final SysUserMapper users = mock(SysUserMapper.class);
    private final AdminController admin = new AdminController(mock(AdminGuard.class), mock(TrafficMonitorService.class), users,
            mock(UserFeedbackMapper.class), mock(RuntimeIssueMapper.class), mock(SharedPlanService.class),
            mock(SharedPlanEventService.class), new BCryptPasswordEncoder(4), mock(RagAdminService.class),
            mock(RagIndexJobService.class), mock(RuntimeFlagService.class));

    @BeforeEach
    void loggedInAsAdmin() {
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(1L, null, List.of()));
        SysUser target = new SysUser();
        target.setId(7L);
        target.setStatus(1);
        target.setVersion(3);
        when(users.selectById(7L)).thenReturn(target);
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("禁用只改 status 那一列，不把读到的整行写回去")
    void 只改状态列() {
        when(users.updateStatus(anyLong(), anyInt())).thenReturn(1);
        admin.updateUserStatus(7L, 0);
        verify(users).updateStatus(7L, 0);
        verify(users, never()).updateById(any(SysUser.class));
    }

    @Test
    @DisplayName("没改成（0 行）要说出来 —— 管理员不能以为账号已经禁用了")
    void 没改成要说() {
        when(users.updateStatus(anyLong(), anyInt())).thenReturn(0);
        assertThrows(BusinessException.class, () -> admin.updateUserStatus(7L, 0));
    }
}
