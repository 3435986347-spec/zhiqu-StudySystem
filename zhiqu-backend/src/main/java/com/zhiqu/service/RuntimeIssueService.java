package com.zhiqu.service;

import com.zhiqu.dto.RuntimeIssueRequest;
import com.zhiqu.entity.RuntimeIssue;
import jakarta.servlet.http.HttpServletRequest;

public interface RuntimeIssueService {
    RuntimeIssue reportClientIssue(Long userId, RuntimeIssueRequest request, HttpServletRequest servletRequest);

    void reportServerIssue(Exception exception, HttpServletRequest servletRequest);
}
