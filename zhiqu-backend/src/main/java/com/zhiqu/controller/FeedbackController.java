package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.FeedbackRequest;
import com.zhiqu.entity.UserFeedback;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.FeedbackService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/feedback")
public class FeedbackController {
    private final FeedbackService feedbackService;

    public FeedbackController(FeedbackService feedbackService) {
        this.feedbackService = feedbackService;
    }

    @PostMapping
    public Result<UserFeedback> submit(@RequestBody @Valid FeedbackRequest request,
                                       HttpServletRequest servletRequest) {
        return Result.success(feedbackService.submit(
                SecurityUtils.getCurrentUserId(),
                request,
                clientIp(servletRequest),
                servletRequest.getHeader("User-Agent")
        ));
    }

    private String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        String realIp = request.getHeader("X-Real-IP");
        if (realIp != null && !realIp.isBlank()) {
            return realIp.trim();
        }
        return request.getRemoteAddr();
    }
}
