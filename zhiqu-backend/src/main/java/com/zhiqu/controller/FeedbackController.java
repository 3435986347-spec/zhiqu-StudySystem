package com.zhiqu.controller;

import com.zhiqu.security.ClientIpResolver;
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
    private final ClientIpResolver clientIpResolver;

    public FeedbackController(FeedbackService feedbackService, ClientIpResolver clientIpResolver) {
        this.feedbackService = feedbackService;
        this.clientIpResolver = clientIpResolver;
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

    /** 客户端 IP 只有一种算法（ClientIpResolver）：只在可信代理后面才认转发头，否则谁都能自己填一个。 */
    private String clientIp(HttpServletRequest request) {
        return clientIpResolver.resolve(request);
    }
}
