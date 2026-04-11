package com.zhiqu.service;

import java.util.List;
import java.util.Map;

public interface AchievementService {
    List<Map<String, Object>> listWithStatus(Long userId);

    List<Map<String, Object>> checkAndUnlock(Long userId, String trigger);
}
