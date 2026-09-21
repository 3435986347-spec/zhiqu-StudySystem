package com.zhiqu.service.impl;

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

@Service
public class RuntimeIssueServiceImpl implements RuntimeIssueService {
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
        RuntimeIssue issue = baseIssue(userId, servletRequest);
        issue.setSource("CLIENT");
        issue.setSeverity(clean(request.getSeverity(), 20, "ERROR"));
        issue.setCategory(clean(request.getCategory(), 80, "JS_RUNTIME"));
        issue.setMessage(clean(privacySanitizer.sanitize(request.getMessage()), 1000, "客户端运行异常"));
        issue.setDetail(clean(privacySanitizer.sanitize(request.getDetail()), 8000, null));
        issue.setPageUrl(clean(privacySanitizer.sanitize(request.getPageUrl()), 1000, servletRequest.getHeader("Referer")));
        issue.setApiPath(clean(privacySanitizer.sanitize(request.getApiPath()), 500, null));
        issueMapper.insert(issue);
        return issue;
    }

    @Override
    public void reportServerIssue(Exception exception, HttpServletRequest servletRequest) {
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
        } catch (Exception ignored) {
            // Reporting must never break the original request.
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
