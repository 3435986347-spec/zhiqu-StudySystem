package com.zhiqu.service.notification;

import com.zhiqu.entity.UserReminderSetting;

public interface NotificationChannel {
    String channel();

    void send(UserReminderSetting setting, String content);
}
