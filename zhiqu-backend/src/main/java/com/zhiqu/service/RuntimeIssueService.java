package com.zhiqu.service;

import com.zhiqu.dto.RuntimeIssueRequest;
import com.zhiqu.entity.RuntimeIssue;
import jakarta.servlet.http.HttpServletRequest;

public interface RuntimeIssueService {
    RuntimeIssue reportClientIssue(Long userId, RuntimeIssueRequest request, HttpServletRequest servletRequest);

    /** 记一条服务器端的运行问题；返回它的编号（记不下来返回 null —— 记录本身绝不能拖垮原来的请求）。 */
    Long reportServerIssue(Exception exception, HttpServletRequest servletRequest);
}
