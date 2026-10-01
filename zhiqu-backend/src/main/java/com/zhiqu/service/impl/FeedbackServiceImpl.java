package com.zhiqu.service.impl;

import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.FeedbackRequest;
import com.zhiqu.entity.SysUser;
import com.zhiqu.entity.UserFeedback;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserFeedbackMapper;
import com.zhiqu.service.FeedbackService;
import org.springframework.stereotype.Service;

@Service
public class FeedbackServiceImpl implements FeedbackService {
    private final UserFeedbackMapper feedbackMapper;
    private final SysUserMapper userMapper;

    public FeedbackServiceImpl(UserFeedbackMapper feedbackMapper, SysUserMapper userMapper) {
        this.feedbackMapper = feedbackMapper;
        this.userMapper = userMapper;
    }

    @Override
    public UserFeedback submit(Long userId, FeedbackRequest request, String ipAddress, String userAgent) {
        SysUser user = userMapper.selectById(userId);
        if (user == null) {
            throw new BusinessException("用户不存在");
        }
        UserFeedback feedback = new UserFeedback();
        feedback.setUserId(userId);
        feedback.setUsername(user.getUsername());
        feedback.setNickname(user.getNickname());
        feedback.setContent(request.getContent().trim());
        feedback.setStatus("OPEN");
        feedback.setIpAddress(limit(ipAddress, 80));
        feedback.setUserAgent(limit(userAgent, 500));
        feedbackMapper.insert(feedback);
        return feedback;
    }

    private String limit(String value, int maxLength) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.length() <= maxLength ? trimmed : trimmed.substring(0, maxLength);
    }
}
