package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.RuntimeIssueRequest;
import com.zhiqu.entity.RuntimeIssue;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.RuntimeIssueService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/runtime-issue")
public class RuntimeIssueController {
    private final RuntimeIssueService runtimeIssueService;

    public RuntimeIssueController(RuntimeIssueService runtimeIssueService) {
        this.runtimeIssueService = runtimeIssueService;
    }

    @PostMapping("/client")
    public Result<RuntimeIssue> reportClient(@RequestBody @Valid RuntimeIssueRequest request,
                                             HttpServletRequest servletRequest) {
        Long userId = SecurityUtils.getCurrentUserIdOrNull();
        return Result.success(runtimeIssueService.reportClientIssue(userId, request, servletRequest));
    }
}
