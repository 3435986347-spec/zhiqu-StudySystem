package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.RuntimeIssueRequest;
import com.zhiqu.entity.RuntimeIssue;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.RuntimeIssueMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.security.ClientIpResolver;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.RuntimeIssueService;
import com.zhiqu.service.privacy.PrivacySanitizer;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Service;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.LocalDateTime;

@Service
public class RuntimeIssueServiceImpl implements RuntimeIssueService {
    static final int CLIENT_DEDUPE_MINUTES = 10;
    static final int CLIENT_HOURLY_CAP = 30;

    private final RuntimeIssueMapper issueMapper;
    private final SysUserMapper userMapper;
    private final PrivacySanitizer privacySanitizer;
    private final ClientIpResolver clientIpResolver;

    public RuntimeIssueServiceImpl(RuntimeIssueMapper issueMapper,
                                   SysUserMapper userMapper,
                                   PrivacySanitizer privacySanitizer,
                                   ClientIpResolver clientIpResolver) {
        this.issueMapper = issueMapper;
        this.userMapper = userMapper;
        this.privacySanitizer = privacySanitizer;
        this.clientIpResolver = clientIpResolver;
    }

    @Override
    public RuntimeIssue reportClientIssue(Long userId, RuntimeIssueRequest request, HttpServletRequest servletRequest) {
        // 第十一轮暴力测试查出：这个接口原来不登录也能调、不去重、不限量（每条最多 8000 字），而现在的页面根本不调它 ——
        // 它唯一的实际用途是让任何人往管理员的「运行问题」里灌垃圾。要登录由 SecurityConfig 管（放行名单里去掉了，
        // 只留那一道：两道一起挡着的话，删掉任何一道判据都看不出来）；这里管去重与限量。
        String category = clean(request.getCategory(), 80, "JS_RUNTIME");
        String message = clean(privacySanitizer.sanitize(request.getMessage()), 1000, "客户端运行异常");
        LocalDateTime now = LocalDateTime.now();
        // 同一个页面错误，用户每刷新一次就报一次：10 分钟内同一条只记一次，回原来那条
        RuntimeIssue same = issueMapper.selectOne(new LambdaQueryWrapper<RuntimeIssue>()
                .eq(RuntimeIssue::getUserId, userId).eq(RuntimeIssue::getSource, "CLIENT")
                .eq(RuntimeIssue::getCategory, category).eq(RuntimeIssue::getMessage, message)
                .ge(RuntimeIssue::getCreatedAt, now.minusMinutes(CLIENT_DEDUPE_MINUTES))
                .orderByDesc(RuntimeIssue::getId).last("LIMIT 1"));
        if (same != null) {
            return same;
        }
        Long lastHour = issueMapper.selectCount(new LambdaQueryWrapper<RuntimeIssue>()
                .eq(RuntimeIssue::getUserId, userId).eq(RuntimeIssue::getSource, "CLIENT")
                .ge(RuntimeIssue::getCreatedAt, now.minusHours(1)));
        if (lastHour != null && lastHour >= CLIENT_HOURLY_CAP) {
            throw new BusinessException("这一小时上报的问题太多了，先不收了");
        }
        RuntimeIssue issue = baseIssue(userId, servletRequest);
        issue.setSource("CLIENT");
        issue.setSeverity(clean(request.getSeverity(), 20, "ERROR"));
        issue.setCategory(category);
        issue.setMessage(message);
        issue.setDetail(clean(privacySanitizer.sanitize(request.getDetail()), 8000, null));
        issue.setPageUrl(clean(privacySanitizer.sanitize(request.getPageUrl()), 1000, servletRequest.getHeader("Referer")));
        issue.setApiPath(clean(privacySanitizer.sanitize(request.getApiPath()), 500, null));
        issueMapper.insert(issue);
        return issue;
    }

    @Override
    public Long reportServerIssue(Exception exception, HttpServletRequest servletRequest) {
        try {
            RuntimeIssue issue = baseIssue(SecurityUtils.getCurrentUserIdOrNull(), servletRequest);
            issue.setSource("SERVER");
            issue.setSeverity("ERROR");
            issue.setCategory(exception.getClass().getSimpleName());
            issue.setMessage(clean(privacySanitizer.sanitize(exception.getMessage()), 1000, exception.getClass().getName()));
            issue.setDetail(clean(privacySanitizer.sanitize(stackTrace(exception)), 8000, null));
            issue.setPageUrl(clean(privacySanitizer.sanitize(servletRequest.getHeader("Referer")), 1000, null));
            issue.setApiPath(clean(privacySanitizer.sanitize(servletRequest.getMethod() + " " + servletRequest.getRequestURI()), 500, null));
            issueMapper.insert(issue);
            return issue.getId();
        } catch (Exception ignored) {
            // Reporting must never break the original request.
            return null;
        }
    }

    private RuntimeIssue baseIssue(Long userId, HttpServletRequest request) {
        RuntimeIssue issue = new RuntimeIssue();
        issue.setUserId(userId);
        if (userId != null) {
            SysUser user = userMapper.selectById(userId);
            if (user != null) {
                issue.setUsername(user.getUsername());
            }
        }
        issue.setIpAddress(clean(clientIpResolver.resolve(request), 80, null));
        issue.setUserAgent(clean(request.getHeader("User-Agent"), 500, null));
        issue.setStatus("OPEN");
        return issue;
    }

    private String stackTrace(Exception exception) {
        StringWriter writer = new StringWriter();
        exception.printStackTrace(new PrintWriter(writer));
        return writer.toString();
    }

    private String clean(String value, int maxLength, String fallback) {
        String result = value == null || value.isBlank() ? fallback : value.trim();
        if (result == null) {
            return null;
        }
        return result.length() <= maxLength ? result : result.substring(0, maxLength);
    }
}
