package com.zhiqu.service;

import com.zhiqu.dto.FeedbackRequest;
import com.zhiqu.entity.UserFeedback;

public interface FeedbackService {
    UserFeedback submit(Long userId, FeedbackRequest request, String ipAddress, String userAgent);
}
