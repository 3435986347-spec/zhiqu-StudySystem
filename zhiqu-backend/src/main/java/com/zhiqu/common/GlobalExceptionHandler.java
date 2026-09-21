package com.zhiqu.common;

import com.zhiqu.service.RuntimeIssueService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.validation.BindException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class GlobalExceptionHandler {
    private final RuntimeIssueService runtimeIssueService;

    public GlobalExceptionHandler(RuntimeIssueService runtimeIssueService) {
        this.runtimeIssueService = runtimeIssueService;
    }

    @ExceptionHandler(BusinessException.class)
    public Result<Void> handleBusiness(BusinessException e) {
        return Result.fail(e.getMessage());
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, BindException.class, IllegalArgumentException.class})
    public Result<Void> handleBadRequest(Exception e) {
        return new Result<>(400, e.getMessage(), null);
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public Result<Void> handleMissingStaticResource(NoResourceFoundException e) {
        return new Result<>(404, "Resource not found", null);
    }

    @ExceptionHandler(Exception.class)
    public Result<Void> handleOther(Exception e, HttpServletRequest request) {
        runtimeIssueService.reportServerIssue(e, request);
        return Result.fail(e.getMessage());
    }
}
