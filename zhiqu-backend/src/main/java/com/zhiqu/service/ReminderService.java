package com.zhiqu.service;

import java.time.LocalDateTime;
import java.util.Map;

public interface ReminderService {
    Map<String, Object> getSettings(Long userId);

    void saveSettings(Long userId, Map<String, Object> body);

    void sendTest(Long userId);

    int processDueReminders(LocalDateTime now);

    int processDueTaskReminders(LocalDateTime now);
}
