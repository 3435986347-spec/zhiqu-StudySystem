-- Run once if smart reminders were already installed before QQ bot support.

ALTER TABLE user_reminder_setting ADD COLUMN qq_app_id VARCHAR(100) DEFAULT NULL AFTER webhook_url;
ALTER TABLE user_reminder_setting ADD COLUMN qq_app_secret VARCHAR(500) DEFAULT NULL AFTER qq_app_id;
ALTER TABLE user_reminder_setting ADD COLUMN qq_group_openid VARCHAR(200) DEFAULT NULL AFTER qq_app_secret;
ALTER TABLE user_reminder_setting ADD COLUMN qq_sandbox TINYINT DEFAULT 0 AFTER qq_group_openid;
