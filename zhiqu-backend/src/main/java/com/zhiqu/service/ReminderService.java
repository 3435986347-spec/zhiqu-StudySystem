package com.zhiqu.service;

import java.time.LocalDateTime;
import java.util.Map;

public interface ReminderService {
    Map<String, Object> getSettings(Long userId);

    void saveSettings(Long userId, Map<String, Object> body);

    void sendTest(Long userId);

    int processDueReminders(LocalDateTime now);

    int processDueTaskReminders(LocalDateTime now);

    /**
     * 这个人接下来 24 小时（含刚过去 15 分钟）的任务提醒，给页面开着时在页面里提醒用（第二十五轮）。
     * 已跳过的（任务完成、提醒重排）和已完成任务的不给。不管第三方渠道配没配、发没发出去 —— 页面里的提醒是另一条路。
     */
    java.util.List<Map<String, Object>> upcoming(Long userId, LocalDateTime now);
}
