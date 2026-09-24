package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.TaskReminder;
import com.zhiqu.entity.UserReminderSetting;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.TaskReminderMapper;
import com.zhiqu.mapper.UserReminderSettingMapper;
import com.zhiqu.service.ReminderService;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.concurrency.DeadlockRetry;
import com.zhiqu.service.notification.ChannelEndpoints;
import com.zhiqu.service.notification.NotificationChannel;
import com.zhiqu.service.privacy.TaskPrivacyService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

@Service
public class ReminderServiceImpl implements ReminderService {
    private static final Logger log = LoggerFactory.getLogger(ReminderServiceImpl.class);

    private static final String CHANNEL_WECOM = "WECOM";
    private static final String CHANNEL_QQ = "QQ";
    private static final String CHANNEL_PUSHPLUS = "PUSHPLUS";
    private static final String DEFAULT_CHANNEL = CHANNEL_PUSHPLUS;
    private static final String STATUS_PENDING = "PENDING";
    private static final String STATUS_PROCESSING = "PROCESSING";
    private static final String STATUS_SENT = "SENT";
    private static final String STATUS_FAILED = "FAILED";
    private static final String STATUS_SKIPPED = "SKIPPED";
    private static final DateTimeFormatter DISPLAY_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    private final SensitiveCryptoService cryptoService;
    private final UserReminderSettingMapper settingMapper;
    private final TaskReminderMapper taskReminderMapper;
    private final StudyTaskMapper studyTaskMapper;
    private final RoutineService routineService;
    private final TaskPrivacyService taskPrivacyService;
    private final Map<String, NotificationChannel> channels;

    public ReminderServiceImpl(UserReminderSettingMapper settingMapper,
                               TaskReminderMapper taskReminderMapper,
                               StudyTaskMapper studyTaskMapper,
                               RoutineService routineService,
                               TaskPrivacyService taskPrivacyService,
                               List<NotificationChannel> channels,
                               SensitiveCryptoService cryptoService) {
        this.cryptoService = cryptoService;
        this.settingMapper = settingMapper;
        this.taskReminderMapper = taskReminderMapper;
        this.studyTaskMapper = studyTaskMapper;
        this.routineService = routineService;
        this.taskPrivacyService = taskPrivacyService;
        this.channels = channels.stream().collect(Collectors.toMap(NotificationChannel::channel, c -> c));
    }

    @Override
    public Map<String, Object> getSettings(Long userId) {
        UserReminderSetting setting = getOrDefaultSetting(userId);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("channel", setting.getChannel());
        result.put("enabled", setting.getEnabled() != null && setting.getEnabled() == 1);
        result.put("webhookUrl", mask(setting.getWebhookUrl()));
        result.put("qqAppId", setting.getQqAppId() == null ? "" : setting.getQqAppId());
        result.put("qqAppSecret", mask(setting.getQqAppSecret()));
        result.put("qqGroupOpenid", setting.getQqGroupOpenid() == null ? "" : setting.getQqGroupOpenid());
        result.put("qqSandbox", setting.getQqSandbox() != null && setting.getQqSandbox() == 1);
        result.put("pushplusToken", mask(setting.getPushplusToken()));
        return result;
    }

    @Override
    @Transactional
    @DeadlockRetry
    public void saveSettings(Long userId, Map<String, Object> body) {
        UserReminderSetting setting = findSetting(userId);
        if (setting == null) {
            setting = new UserReminderSetting();
            setting.setUserId(userId);
            setting.setChannel(DEFAULT_CHANNEL);
            setting.setEnabled(0);
        }
        Object channel = body.get("channel");
        setting.setChannel(channel == null || channel.toString().isBlank()
                ? DEFAULT_CHANNEL
                : channel.toString().trim().toUpperCase());

        if (body.containsKey("enabled")) {
            setting.setEnabled(Boolean.parseBoolean(String.valueOf(body.get("enabled"))) ? 1 : 0);
        }
        if (body.containsKey("webhookUrl")) {
            String webhook = Optional.ofNullable(body.get("webhookUrl")).map(Object::toString).orElse("").trim();
            if (!webhook.isBlank() && !cryptoService.isMasked(webhook)) {
                setting.setWebhookUrl(ChannelEndpoints.requireWeComWebhook(webhook));
            }
        }
        if (body.containsKey("qqAppId")) {
            setting.setQqAppId(blankToNull(body.get("qqAppId")));
        }
        if (body.containsKey("qqAppSecret")) {
            String secret = Optional.ofNullable(body.get("qqAppSecret")).map(Object::toString).orElse("").trim();
            if (!secret.isBlank() && !cryptoService.isMasked(secret)) {
                setting.setQqAppSecret(secret);
            }
        }
        if (body.containsKey("qqGroupOpenid")) {
            setting.setQqGroupOpenid(blankToNull(body.get("qqGroupOpenid")));
        }
        if (body.containsKey("qqSandbox")) {
            setting.setQqSandbox(Boolean.parseBoolean(String.valueOf(body.get("qqSandbox"))) ? 1 : 0);
        }
        if (body.containsKey("pushplusToken")) {
            String token = Optional.ofNullable(body.get("pushplusToken")).map(Object::toString).orElse("").trim();
            if (!token.isBlank() && !cryptoService.isMasked(token)) {
                setting.setPushplusToken(token);
            }
        }

        if (setting.getId() == null) {
            settingMapper.insert(setting);
        } else {
            settingMapper.updateById(setting);
        }
    }

    @Override
    public void sendTest(Long userId) {
        UserReminderSetting setting = getEnabledSetting(userId);
        getChannel(setting).send(setting, "知趣提醒测试：如果你看到这条消息，早八 DDL 提醒已经连通。");
    }

    @Override
    public int processDueReminders(LocalDateTime now) {
        return processDueReminders(now, true);
    }

    @Override
    public int processDueTaskReminders(LocalDateTime now) {
        return processDueReminders(now, false);
    }

    /**
     * 认领之后多久还没结果，就当作发送途中断了（进程被杀、重启）。发一批的正常耗时是秒级 ——
     * 每个渠道请求最多 15 秒（{@code ChannelEndpoints} 的超时），留足余量。
     */
    static final int STALE_PROCESSING_MINUTES = 60;
    static final String REQUEUED_MARKER = "上次发送中断，已重新排队";
    static final String GAVE_UP_REASON = "两次发送都中断了（服务重启或异常），不再重试；没法确认是否送达";

    /**
     * 把中断在 {@code PROCESSING} 的提醒收回来：第一次放回队列再发（早八提醒晚一点到，好过永远不到），
     * 第二次就标失败 —— 同一条反复中断说明问题不在运气，每小时重发一遍只会刷屏。
     *
     * <p>原来没有这一步：{@code PROCESSING} 是只进不出的状态，一次中断就让那几条提醒永远停在「处理中」。
     */
    public int recoverInterrupted() {
        int gaveUp = taskReminderMapper.failStaleRequeued(STALE_PROCESSING_MINUTES, REQUEUED_MARKER, GAVE_UP_REASON);
        int requeued = taskReminderMapper.requeueStale(STALE_PROCESSING_MINUTES, REQUEUED_MARKER);
        if (gaveUp + requeued > 0) {
            log.warn("收回中断的提醒：重新排队 {} 条，放弃 {} 条", requeued, gaveUp);
        }
        return gaveUp + requeued;
    }

    private int processDueReminders(LocalDateTime now, boolean includeRoutines) {
        recoverInterrupted();
        // 例行计划在认领之前取：它出错不能连累已经认领的任务提醒（认领之后抛出去，那一批就停在 PROCESSING）
        Map<Long, List<Map<String, Object>>> routinesByUser = includeRoutines ? routinesByUser(now) : Map.of();

        List<TaskReminder> due = taskReminderMapper.selectList(new LambdaQueryWrapper<TaskReminder>()
                .eq(TaskReminder::getStatus, STATUS_PENDING)
                .le(TaskReminder::getScheduledAt, now)
                .orderByAsc(TaskReminder::getScheduledAt));
        List<TaskReminder> claimed = new ArrayList<>();
        for (TaskReminder reminder : due) {
            if (taskReminderMapper.claimPending(reminder.getId()) == 1) {
                reminder.setStatus(STATUS_PROCESSING);
                claimed.add(reminder);
            }
        }
        Map<Long, List<TaskReminder>> byUser = claimed.stream()
                .collect(Collectors.groupingBy(TaskReminder::getUserId, LinkedHashMap::new, Collectors.toList()));
        for (Long userId : routinesByUser.keySet()) {
            byUser.putIfAbsent(userId, List.of());
        }

        // 每个用户各自兜底：一个人的坏数据、一次查询失败，不能让排在他后面的人都收不到，
        // 也不能让他自己那几条停在 PROCESSING —— 原来这里没有兜底，一个异常就让整批停在「处理中」
        int sentCount = 0;
        for (Map.Entry<Long, List<TaskReminder>> entry : byUser.entrySet()) {
            try {
                sentCount += dispatch(entry.getKey(), entry.getValue(),
                        routinesByUser.getOrDefault(entry.getKey(), List.of()), now);
            } catch (Exception e) {
                log.error("用户 {} 的提醒处理出错，这一批标为失败", entry.getKey(), e);
                failUnfinished(entry.getValue(), "处理出错：" + e.getMessage());
            }
        }
        return sentCount;
    }

    private Map<Long, List<Map<String, Object>>> routinesByUser(LocalDateTime now) {
        try {
            return routineService.reminderInstances(LocalDate.from(now))
                    .stream()
                    .collect(Collectors.groupingBy(row -> Long.parseLong(String.valueOf(row.get("userId"))),
                            LinkedHashMap::new,
                            Collectors.toList()));
        } catch (Exception e) {
            log.error("例行计划提醒取不出来，这一轮只发任务提醒", e);
            return Map.of();
        }
    }

    private int dispatch(Long userId, List<TaskReminder> reminders, List<Map<String, Object>> routineLines,
                         LocalDateTime now) {
        UserReminderSetting setting = findSetting(userId);
        if (!isEnabled(setting)) {
            markAll(reminders, STATUS_FAILED, "提醒渠道未启用或未配置");
            return 0;
        }

        List<ReminderLine> lines = new ArrayList<>();
        for (TaskReminder reminder : reminders) {
            StudyTask task;
            try {
                task = taskPrivacyService.reveal(studyTaskMapper.selectById(reminder.getTaskId()));
            } catch (Exception e) {
                // 一条任务读不出来（比如密文坏了）只影响这一条，同一个人的其他提醒照发
                mark(reminder, STATUS_FAILED, "任务内容读不出来：" + e.getMessage());
                continue;
            }
            if (task == null) {
                mark(reminder, STATUS_SKIPPED, "任务不存在");
            } else if (task.getStatus() != null && task.getStatus() == 2) {
                mark(reminder, STATUS_SKIPPED, "任务已完成");
            } else {
                lines.add(new ReminderLine(reminder, task));
            }
        }

        if (lines.isEmpty() && routineLines.isEmpty()) {
            return 0;
        }
        lines.sort(Comparator.comparing(line -> line.task().getDeadline(), Comparator.nullsLast(Comparator.naturalOrder())));
        try {
            getChannel(setting).send(setting, buildMessage(lines, routineLines));
            for (ReminderLine line : lines) {
                TaskReminder reminder = line.reminder();
                reminder.setStatus(STATUS_SENT);
                reminder.setSentAt(now);
                reminder.setFailureReason(null);
                taskReminderMapper.updateById(reminder);
            }
            return lines.size() + routineLines.size();
        } catch (Exception e) {
            for (ReminderLine line : lines) {
                mark(line.reminder(), STATUS_FAILED, e.getMessage());
            }
            return 0;
        }
    }

    /** 兜底：还停在 PROCESSING 的标失败。这里再出错（数据库断了）就只记日志 —— 那几条交给 {@link #recoverInterrupted}。 */
    private void failUnfinished(List<TaskReminder> reminders, String reason) {
        for (TaskReminder reminder : reminders) {
            if (!STATUS_PROCESSING.equals(reminder.getStatus())) {
                continue;
            }
            try {
                mark(reminder, STATUS_FAILED, reason);
            } catch (Exception e) {
                log.error("提醒 {} 标记失败也没成功，等下一轮收回", reminder.getId(), e);
            }
        }
    }

    private String buildMessage(List<ReminderLine> lines, List<Map<String, Object>> routineLines) {
        StringBuilder sb = new StringBuilder();
        sb.append("知趣 DDL 早八提醒\n\n");
        sb.append("今天有 ").append(lines.size() + routineLines.size()).append(" 个提醒需要看一眼：\n");
        int index = 1;
        for (ReminderLine line : lines) {
            StudyTask task = line.task();
            TaskReminder reminder = line.reminder();
            sb.append("\n").append(index++).append(". ").append(task.getTitle());
            if (task.getDeadline() != null) {
                sb.append("\n   截止：").append(DISPLAY_TIME.format(task.getDeadline()));
            }
            if (reminder.getOffsetDays() != null) {
                sb.append("\n   节点：提前 ").append(reminder.getOffsetDays()).append(" 天");
            } else {
                sb.append("\n   节点：自定义提醒");
            }
            if (task.getAiReminderReason() != null && !task.getAiReminderReason().isBlank()) {
                sb.append("\n   依据：").append(task.getAiReminderReason());
            }
            sb.append("\n");
        }
        for (Map<String, Object> routine : routineLines) {
            sb.append("\n").append(index++).append(". ").append(routine.get("title"));
            sb.append("\n   类型：今日例行计划");
            Object preferredTime = routine.get("preferredTime");
            if (preferredTime != null && !preferredTime.toString().isBlank()) {
                sb.append("\n   建议时间：").append(preferredTime.toString(), 0, Math.min(5, preferredTime.toString().length()));
            }
            Object duration = routine.get("durationMinutes");
            if (duration != null) {
                sb.append("\n   预计：").append(duration).append(" 分钟");
            }
            sb.append("\n");
        }
        return sb.toString();
    }

    private UserReminderSetting getOrDefaultSetting(Long userId) {
        UserReminderSetting setting = findSetting(userId);
        if (setting != null) {
            return setting;
        }
        UserReminderSetting empty = new UserReminderSetting();
        empty.setUserId(userId);
        empty.setChannel(DEFAULT_CHANNEL);
        empty.setEnabled(0);
        return empty;
    }

    private UserReminderSetting getEnabledSetting(Long userId) {
        UserReminderSetting setting = findSetting(userId);
        if (!isEnabled(setting)) {
            throw new BusinessException("请先启用并配置企业微信 Webhook");
        }
        return setting;
    }

    private UserReminderSetting findSetting(Long userId) {
        return settingMapper.selectOne(new LambdaQueryWrapper<UserReminderSetting>()
                .eq(UserReminderSetting::getUserId, userId));
    }

    private boolean isEnabled(UserReminderSetting setting) {
        return setting != null
                && setting.getEnabled() != null
                && setting.getEnabled() == 1
                && hasRequiredChannelConfig(setting);
    }

    private NotificationChannel getChannel(UserReminderSetting setting) {
        String channel = setting.getChannel() == null ? DEFAULT_CHANNEL : setting.getChannel();
        NotificationChannel notificationChannel = channels.get(channel);
        if (notificationChannel == null) {
            throw new BusinessException("暂不支持的提醒渠道：" + channel);
        }
        return notificationChannel;
    }

    private boolean hasRequiredChannelConfig(UserReminderSetting setting) {
        String channel = setting.getChannel() == null ? DEFAULT_CHANNEL : setting.getChannel();
        if (CHANNEL_QQ.equals(channel)) {
            return setting.getQqAppId() != null && !setting.getQqAppId().isBlank()
                    && setting.getQqAppSecret() != null && !setting.getQqAppSecret().isBlank()
                    && setting.getQqGroupOpenid() != null && !setting.getQqGroupOpenid().isBlank();
        }
        if (CHANNEL_PUSHPLUS.equals(channel)) {
            return setting.getPushplusToken() != null && !setting.getPushplusToken().isBlank();
        }
        return setting.getWebhookUrl() != null && !setting.getWebhookUrl().isBlank();
    }

    private void markAll(List<TaskReminder> reminders, String status, String reason) {
        for (TaskReminder reminder : reminders) {
            mark(reminder, status, reason);
        }
    }

    private void mark(TaskReminder reminder, String status, String reason) {
        reminder.setStatus(status);
        reminder.setFailureReason(limit(reason));
        taskReminderMapper.updateById(reminder);
    }

    /**
     * 脱敏 —— 委托给唯一那套实现。
     *
     * <p>这里原本是<b>第二套</b>：{@code substring(0, 12) + "****" + substring(len - 6)}，
     * 带着和旧 {@code maskSecret} 同一类的重叠 bug —— 长度 17/18 时前后两段相交，
     * 整个值都会露出来；32 位的 PushPlus token 会露 18 位。
     * 同一件事写两遍，就会像这样各自坏一次。
     */
    private String mask(String secret) {
        return cryptoService.maskSecret(secret);
    }

    private String limit(String text) {
        if (text == null) {
            return null;
        }
        return text.length() > 480 ? text.substring(0, 480) : text;
    }

    private String blankToNull(Object value) {
        if (value == null) {
            return null;
        }
        String text = value.toString().trim();
        return text.isBlank() ? null : text;
    }

    private record ReminderLine(TaskReminder reminder, StudyTask task) {
    }
}
