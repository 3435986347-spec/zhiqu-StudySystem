-- Run once if smart reminders were already installed before PushPlus support.

ALTER TABLE user_reminder_setting ADD COLUMN pushplus_token VARCHAR(500) DEFAULT NULL AFTER qq_sandbox;
