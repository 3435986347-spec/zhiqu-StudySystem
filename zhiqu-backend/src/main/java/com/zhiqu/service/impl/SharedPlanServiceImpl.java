package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.entity.SharedPlanReview;
import com.zhiqu.entity.SharedPlanRoutineTemplate;
import com.zhiqu.entity.SharedPlanTaskTemplate;
import com.zhiqu.entity.SharedPlanTemplate;
import com.zhiqu.entity.SharedPlanCategory;
import com.zhiqu.entity.SharedPlanLike;
import com.zhiqu.entity.StudyRoutine;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.SharedPlanCategoryMapper;
import com.zhiqu.mapper.SharedPlanLikeMapper;
import com.zhiqu.mapper.SharedPlanReviewMapper;
import com.zhiqu.mapper.SharedPlanRoutineTemplateMapper;
import com.zhiqu.mapper.SharedPlanTaskTemplateMapper;
import com.zhiqu.mapper.SharedPlanTemplateMapper;
import com.zhiqu.mapper.StudyRoutineMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.SharedPlanEventService;
import com.zhiqu.service.SharedPlanService;
import com.zhiqu.service.StudyTaskService;
import com.zhiqu.service.privacy.PrivacySanitizer;
import com.zhiqu.util.UploadPathResolver;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

@Service
public class SharedPlanServiceImpl implements SharedPlanService {
    private final SharedPlanTemplateMapper templateMapper;
    private final SharedPlanTaskTemplateMapper taskTemplateMapper;
    private final SharedPlanRoutineTemplateMapper routineTemplateMapper;
    private final SharedPlanLikeMapper likeMapper;
    private final SharedPlanCategoryMapper categoryMapper;
    private final SharedPlanReviewMapper reviewMapper;
    private final StudyRoutineMapper studyRoutineMapper;
    private final SysUserMapper sysUserMapper;
    private final StudyTaskService studyTaskService;
    private final RoutineService routineService;
    private final SharedPlanEventService eventService;
    private final PrivacySanitizer privacySanitizer;
    private final UploadPathResolver uploadPathResolver;

    public SharedPlanServiceImpl(SharedPlanTemplateMapper templateMapper,
                                 SharedPlanTaskTemplateMapper taskTemplateMapper,
                                 SharedPlanRoutineTemplateMapper routineTemplateMapper,
                                 SharedPlanLikeMapper likeMapper,
                                 SharedPlanCategoryMapper categoryMapper,
                                 SharedPlanReviewMapper reviewMapper,
                                 StudyRoutineMapper studyRoutineMapper,
                                 SysUserMapper sysUserMapper,
                                 StudyTaskService studyTaskService,
                                 RoutineService routineService,
                                 SharedPlanEventService eventService,
                                 PrivacySanitizer privacySanitizer,
                                 UploadPathResolver uploadPathResolver) {
        this.templateMapper = templateMapper;
        this.taskTemplateMapper = taskTemplateMapper;
        this.routineTemplateMapper = routineTemplateMapper;
        this.likeMapper = likeMapper;
        this.categoryMapper = categoryMapper;
        this.reviewMapper = reviewMapper;
        this.studyRoutineMapper = studyRoutineMapper;
        this.sysUserMapper = sysUserMapper;
        this.studyTaskService = studyTaskService;
        this.routineService = routineService;
        this.eventService = eventService;
        this.privacySanitizer = privacySanitizer;
        this.uploadPathResolver = uploadPathResolver;
    }

    @Override
    @Transactional
    public Map<String, Object> submit(Long userId, Map<String, Object> body) {
        if (!Boolean.TRUE.equals(body.get("shareConsent"))) {
            throw new BusinessException("共享计划需要先确认已去除个人隐私信息");
        }
        List<Map<String, Object>> tasks = castList(body.get("tasks"));
        List<Map<String, Object>> routines = castList(body.get("routines"));
        SharedPlanTemplate template = new SharedPlanTemplate();
        template.setUserId(userId);
        template.setTitle(clean(required(body.get("title"), "计划标题不能为空"), 160));
        template.setDescription(clean(value(body.get("description"), ""), 1000));
        template.setCategory(resolveCategory(body, tasks, routines));
        template.setTargetAudience(clean(value(body.get("targetAudience"), ""), 200));
        template.setStatus("PENDING");
        template.setAnonymized(1);
        template.setApplyCount(0);
        template.setLikeCount(0);
        templateMapper.insert(template);
        int order = 0;
        for (Map<String, Object> item : tasks) {
            SharedPlanTaskTemplate task = new SharedPlanTaskTemplate();
            task.setTemplateId(template.getId());
            task.setTitle(clean(required(item.get("title"), "任务标题不能为空"), 200));
            task.setDescription(clean(value(item.get("description"), ""), 1000));
            task.setRelativeStartDay(parseInt(item.get("relativeStartDay")));
            task.setRelativeDeadlineDay(parseInt(item.get("relativeDeadlineDay")));
            task.setPreferredTime(value(item.get("preferredTime"), null));
            task.setDurationMinutes(parseInt(item.get("durationMinutes")));
            task.setTaskType(value(item.get("taskType"), "other"));
            task.setDifficulty(parseInt(item.get("difficulty")));
            task.setQuadrant(defaultInt(item.get("quadrant"), 2));
            task.setPriority(defaultInt(item.get("priority"), 1));
            task.setReminderOffsets(joinOffsets(item.get("reminderOffsets")));
            task.setSortOrder(order++);
            taskTemplateMapper.insert(task);
        }
        order = 0;
        for (Map<String, Object> item : routines) {
            SharedPlanRoutineTemplate routine = new SharedPlanRoutineTemplate();
            routine.setTemplateId(template.getId());
            routine.setTitle(clean(required(item.get("title"), "例行计划标题不能为空"), 200));
            routine.setDescription(clean(value(item.get("description"), ""), 1000));
            routine.setFrequency(value(item.get("frequency"), "DAILY"));
            routine.setDaysOfWeek(joinOffsets(item.get("daysOfWeek")));
            routine.setRelativeStartDay(defaultInt(item.get("relativeStartDay"), 0));
            routine.setRelativeEndDay(defaultInt(item.get("relativeEndDay"), 29));
            routine.setPreferredTime(value(item.get("preferredTime"), "08:00"));
            routine.setDurationMinutes(parseInt(item.get("durationMinutes")));
            routine.setTaskType(value(item.get("taskType"), "course"));
            routine.setDifficulty(parseInt(item.get("difficulty")));
            routine.setQuadrant(defaultInt(item.get("quadrant"), 2));
            routine.setPriority(defaultInt(item.get("priority"), 1));
            routine.setReminderEnabled(Boolean.FALSE.equals(item.get("reminderEnabled")) ? 0 : 1);
            routine.setReminderOffsets(joinOffsets(item.getOrDefault("reminderOffsets", List.of(0))));
            routine.setSortOrder(order++);
            routineTemplateMapper.insert(routine);
        }
        touchCategory(template.getCategory());
        eventService.broadcastAdminChanged("shared-plan-submitted");
        return detail(userId, template.getId());
    }

    @Override
    @Transactional
    public Map<String, Object> submitFromExisting(Long userId, Map<String, Object> body) {
        if (!Boolean.TRUE.equals(body.get("shareConsent"))) {
            throw new BusinessException("共享计划需要先确认已去除个人隐私信息");
        }
        List<Long> taskIds = parseLongList(body.get("taskIds"));
        List<Long> routineIds = parseLongList(body.get("routineIds"));
        if (taskIds.isEmpty() && routineIds.isEmpty()) {
            throw new BusinessException("至少选择一个任务或例行计划");
        }
        SharedPlanTemplate template = new SharedPlanTemplate();
        template.setUserId(userId);
        template.setTitle(clean(required(body.get("title"), "计划标题不能为空"), 160));
        template.setDescription(clean(value(body.get("description"), ""), 1000));
        template.setCategory(resolveCategory(body, List.of(), List.of()));
        template.setTargetAudience(clean(value(body.get("targetAudience"), ""), 200));
        template.setStatus("PENDING");
        template.setAnonymized(1);
        template.setApplyCount(0);
        template.setLikeCount(0);
        templateMapper.insert(template);

        int order = 0;
        for (Long taskId : taskIds) {
            StudyTask source = studyTaskService.detail(userId, taskId);
            Map<String, Object> cfg = itemConfig(body, "task", taskId);
            SharedPlanTaskTemplate task = new SharedPlanTaskTemplate();
            task.setTemplateId(template.getId());
            task.setTitle(clean(source.getTitle(), 200));
            task.setDescription(clean(value(source.getDescription(), ""), 1000));
            task.setRelativeStartDay(parseInt(cfg.get("relativeStartDay")));
            task.setRelativeDeadlineDay(defaultInt(cfg.get("relativeDeadlineDay"), source.getDeadline() == null ? 7 : 0));
            task.setPreferredTime(value(cfg.get("preferredTime"), source.getDeadline() == null ? "23:59" : source.getDeadline().toLocalTime().toString().substring(0, 5)));
            task.setDurationMinutes(source.getDurationMinutes());
            task.setTaskType(value(source.getTaskType(), "other"));
            task.setDifficulty(source.getDifficulty());
            task.setQuadrant(source.getQuadrant());
            task.setPriority(source.getPriority());
            task.setReminderOffsets(joinOffsets(cfg.getOrDefault("reminderOffsets", List.of(7, 2))));
            task.setSortOrder(order++);
            taskTemplateMapper.insert(task);
        }

        order = 0;
        for (Long routineId : routineIds) {
            StudyRoutine source = studyRoutineMapper.selectOne(new LambdaQueryWrapper<StudyRoutine>()
                    .eq(StudyRoutine::getId, routineId)
                    .eq(StudyRoutine::getUserId, userId));
            if (source == null) {
                throw new BusinessException("例行计划不存在或无权访问");
            }
            Map<String, Object> cfg = itemConfig(body, "routine", routineId);
            SharedPlanRoutineTemplate routine = new SharedPlanRoutineTemplate();
            routine.setTemplateId(template.getId());
            routine.setTitle(clean(source.getTitle(), 200));
            routine.setDescription(clean(value(source.getDescription(), ""), 1000));
            routine.setFrequency(value(source.getFrequency(), "DAILY"));
            routine.setDaysOfWeek(value(source.getDaysOfWeek(), "1,2,3,4,5,6,7"));
            routine.setRelativeStartDay(defaultInt(cfg.get("relativeStartDay"), 0));
            routine.setRelativeEndDay(defaultInt(cfg.get("relativeEndDay"), 29));
            routine.setPreferredTime(value(cfg.get("preferredTime"), source.getPreferredTime() == null ? "08:00" : source.getPreferredTime().toString().substring(0, 5)));
            routine.setDurationMinutes(source.getDurationMinutes());
            routine.setTaskType(value(source.getTaskType(), "course"));
            routine.setDifficulty(source.getDifficulty());
            routine.setQuadrant(source.getQuadrant());
            routine.setPriority(source.getPriority());
            routine.setReminderEnabled(source.getReminderEnabled() == null ? 1 : source.getReminderEnabled());
            routine.setReminderOffsets(value(source.getReminderOffsets(), "0"));
            routine.setSortOrder(order++);
            routineTemplateMapper.insert(routine);
        }
        touchCategory(template.getCategory());
        eventService.broadcastAdminChanged("shared-plan-submitted");
        return detail(userId, template.getId());
    }

    @Override
    public List<Map<String, Object>> publicList(Long userId, String category, String sort, String order) {
        LambdaQueryWrapper<SharedPlanTemplate> query = new LambdaQueryWrapper<SharedPlanTemplate>()
                .eq(SharedPlanTemplate::getStatus, "APPROVED");
        if (category != null && !category.isBlank()) {
            query.eq(SharedPlanTemplate::getCategory, category.trim().toUpperCase());
        }
        applyPublicSort(query, sort, order);
        return templateMapper.selectList(query).stream().map(template -> templateRow(template, userId)).toList();
    }

    @Override
    public Map<String, Object> detail(Long userId, Long id) {
        SharedPlanTemplate template = templateMapper.selectById(id);
        if (template == null) {
            throw new BusinessException("共享计划不存在");
        }
        if (!"APPROVED".equals(template.getStatus()) && !Objects.equals(template.getUserId(), userId)) {
            throw new BusinessException("该参考计划暂不可查看");
        }
        Map<String, Object> row = detailRow(template, userId);
        return row;
    }

    private Map<String, Object> detailRow(SharedPlanTemplate template, Long userId) {
        Long id = template.getId();
        Map<String, Object> row = templateRow(template, userId);
        row.put("creator", creatorRow(template.getUserId()));
        row.put("tasks", taskTemplateMapper.selectList(new LambdaQueryWrapper<SharedPlanTaskTemplate>()
                .eq(SharedPlanTaskTemplate::getTemplateId, id)
                .orderByAsc(SharedPlanTaskTemplate::getSortOrder)).stream().map(this::taskRow).toList());
        row.put("routines", routineTemplateMapper.selectList(new LambdaQueryWrapper<SharedPlanRoutineTemplate>()
                .eq(SharedPlanRoutineTemplate::getTemplateId, id)
                .orderByAsc(SharedPlanRoutineTemplate::getSortOrder)).stream().map(this::routineRow).toList());
        return row;
    }

    @Override
    @Transactional
    public Map<String, Object> apply(Long userId, Long id, Map<String, Object> body) {
        SharedPlanTemplate template = templateMapper.selectById(id);
        if (template == null || !"APPROVED".equals(template.getStatus())) {
            throw new BusinessException("该计划暂不可套用");
        }
        LocalDate start = LocalDate.parse(value(body.get("startDate"), LocalDate.now().toString()));
        int createdTasks = 0;
        int createdRoutines = 0;
        for (SharedPlanTaskTemplate taskTemplate : taskTemplateMapper.selectList(new LambdaQueryWrapper<SharedPlanTaskTemplate>()
                .eq(SharedPlanTaskTemplate::getTemplateId, id))) {
            TaskCreateRequest request = new TaskCreateRequest();
            request.setTitle(taskTemplate.getTitle());
            request.setDescription(taskTemplate.getDescription());
            request.setQuadrant(taskTemplate.getQuadrant());
            request.setPriority(taskTemplate.getPriority());
            request.setStatus(0);
            request.setTaskType(taskTemplate.getTaskType());
            request.setDifficulty(taskTemplate.getDifficulty());
            request.setDurationMinutes(taskTemplate.getDurationMinutes());
            request.setReminderOffsets(parseOffsets(taskTemplate.getReminderOffsets()));
            if (taskTemplate.getRelativeStartDay() != null) {
                request.setStartTime(toDateTime(start.plusDays(taskTemplate.getRelativeStartDay()), taskTemplate.getPreferredTime(), LocalTime.of(8, 0)));
            }
            if (taskTemplate.getRelativeDeadlineDay() != null) {
                request.setDeadline(toDateTime(start.plusDays(taskTemplate.getRelativeDeadlineDay()), taskTemplate.getPreferredTime(), LocalTime.of(23, 59)));
            }
            studyTaskService.create(userId, request);
            createdTasks++;
        }
        for (SharedPlanRoutineTemplate routineTemplate : routineTemplateMapper.selectList(new LambdaQueryWrapper<SharedPlanRoutineTemplate>()
                .eq(SharedPlanRoutineTemplate::getTemplateId, id))) {
            Map<String, Object> routine = new LinkedHashMap<>();
            routine.put("title", routineTemplate.getTitle());
            routine.put("description", routineTemplate.getDescription());
            routine.put("frequency", routineTemplate.getFrequency());
            routine.put("daysOfWeek", parseOffsets(routineTemplate.getDaysOfWeek()));
            routine.put("startDate", start.plusDays(defaultInt(routineTemplate.getRelativeStartDay(), 0)).toString());
            routine.put("endDate", start.plusDays(defaultInt(routineTemplate.getRelativeEndDay(), 29)).toString());
            routine.put("preferredTime", routineTemplate.getPreferredTime());
            routine.put("durationMinutes", routineTemplate.getDurationMinutes());
            routine.put("taskType", routineTemplate.getTaskType());
            routine.put("difficulty", routineTemplate.getDifficulty());
            routine.put("quadrant", routineTemplate.getQuadrant());
            routine.put("priority", routineTemplate.getPriority());
            routine.put("reminderEnabled", routineTemplate.getReminderEnabled() != null && routineTemplate.getReminderEnabled() == 1);
            routine.put("reminderOffsets", parseOffsets(routineTemplate.getReminderOffsets()));
            routineService.create(userId, routine);
            createdRoutines++;
        }
        template.setApplyCount((template.getApplyCount() == null ? 0 : template.getApplyCount()) + 1);
        templateMapper.updateById(template);
        return Map.of("createdTasks", createdTasks, "createdRoutines", createdRoutines);
    }

    @Override
    public List<Map<String, Object>> adminList(String status, String q, String sort, String order) {
        LambdaQueryWrapper<SharedPlanTemplate> query = new LambdaQueryWrapper<SharedPlanTemplate>()
                .orderByDesc(SharedPlanTemplate::getCreatedAt);
        if (status != null && !status.isBlank()) {
            query.eq(SharedPlanTemplate::getStatus, status.trim().toUpperCase());
        }
        List<Map<String, Object>> rows = templateMapper.selectList(query).stream()
                .map(template -> {
                    Map<String, Object> row = templateRow(template, null);
                    row.put("creator", creatorAdminRow(template.getUserId()));
                    row.put("searchScore", searchScore(row, q));
                    return row;
                })
                .filter(row -> !hasText(q) || ((Number) row.get("searchScore")).intValue() > 0)
                .toList();
        Comparator<Map<String, Object>> comparator = adminComparator(sort, q);
        if (!"asc".equalsIgnoreCase(order)) {
            comparator = comparator.reversed();
        }
        return rows.stream().sorted(comparator).toList();
    }

    @Override
    public Map<String, Object> adminDetail(Long id) {
        SharedPlanTemplate template = templateMapper.selectById(id);
        if (template == null) {
            throw new BusinessException("共享计划不存在");
        }
        Map<String, Object> row = detailRow(template, null);
        row.put("creator", creatorAdminRow(template.getUserId()));
        row.put("reviews", reviewMapper.selectList(new LambdaQueryWrapper<SharedPlanReview>()
                .eq(SharedPlanReview::getTemplateId, id)
                .orderByDesc(SharedPlanReview::getCreatedAt)).stream().map(this::reviewRow).toList());
        return row;
    }

    @Override
    public List<Map<String, Object>> categories() {
        return categoryMapper.selectList(new LambdaQueryWrapper<SharedPlanCategory>()
                        .orderByDesc(SharedPlanCategory::getTemplateCount)
                        .orderByDesc(SharedPlanCategory::getLastUsedAt))
                .stream().map(this::categoryRow).toList();
    }

    @Override
    @Transactional
    public Map<String, Object> toggleLike(Long userId, Long id) {
        SharedPlanTemplate template = templateMapper.selectById(id);
        if (template == null || !"APPROVED".equals(template.getStatus())) {
            throw new BusinessException("参考计划不存在或暂不可点赞");
        }
        SharedPlanLike existing = likeMapper.selectOne(new LambdaQueryWrapper<SharedPlanLike>()
                .eq(SharedPlanLike::getTemplateId, id)
                .eq(SharedPlanLike::getUserId, userId));
        boolean liked;
        if (existing == null) {
            SharedPlanLike like = new SharedPlanLike();
            like.setTemplateId(id);
            like.setUserId(userId);
            try {
                likeMapper.insert(like);
            } catch (DuplicateKeyException ignored) {
                // Another request already liked it; treat as liked.
            }
            liked = true;
        } else {
            likeMapper.physicalDeleteById(existing.getId());
            liked = false;
        }
        refreshLikeCount(id);
        SharedPlanTemplate updated = templateMapper.selectById(id);
        eventService.broadcastSharedPlanChanged("like", id);
        return Map.of(
                "liked", liked,
                "likeCount", updated == null || updated.getLikeCount() == null ? 0 : updated.getLikeCount()
        );
    }

    @Override
    @Transactional
    public void deleteByAdmin(Long id) {
        SharedPlanTemplate template = templateMapper.selectById(id);
        if (template == null) {
            return;
        }
        templateMapper.deleteById(id);
        eventService.broadcastSharedPlanChanged("delete", id);
    }

    @Override
    @Transactional
    public void review(Long adminUserId, Long id, String action, String note) {
        SharedPlanTemplate template = templateMapper.selectById(id);
        if (template == null) {
            throw new BusinessException("共享计划不存在");
        }
        String normalized;
        if ("APPROVE".equalsIgnoreCase(action) || "APPROVED".equalsIgnoreCase(action)) {
            normalized = "APPROVED";
        } else if ("TAKEDOWN".equalsIgnoreCase(action) || "OFFLINE".equalsIgnoreCase(action)) {
            normalized = "OFFLINE";
        } else if ("REJECT".equalsIgnoreCase(action) || "REJECTED".equalsIgnoreCase(action)) {
            normalized = "REJECTED";
        } else {
            throw new BusinessException("不支持的审核操作：" + action);
        }
        template.setStatus(normalized);
        template.setReviewedBy(adminUserId);
        template.setReviewedAt(LocalDateTime.now());
        template.setRejectionReason("REJECTED".equals(normalized) ? clean(value(note, ""), 500) : null);
        templateMapper.updateById(template);
        SharedPlanReview review = new SharedPlanReview();
        review.setTemplateId(id);
        review.setReviewerId(adminUserId);
        review.setAction(normalized);
        review.setNote(clean(value(note, ""), 500));
        reviewMapper.insert(review);
        if ("APPROVED".equals(normalized)) {
            eventService.broadcastSharedPlanChanged("approve", id);
        } else if ("OFFLINE".equals(normalized)) {
            eventService.broadcastSharedPlanChanged("takedown", id);
        } else {
            eventService.broadcastAdminChanged("shared-plan-review");
        }
    }

    @Override
    @Transactional
    public Map<String, Object> adminUpdate(Long id, Map<String, Object> body) {
        SharedPlanTemplate template = templateMapper.selectById(id);
        if (template == null) {
            throw new BusinessException("共享计划不存在");
        }
        if (body.containsKey("title")) {
            template.setTitle(clean(required(body.get("title"), "计划标题不能为空"), 160));
        }
        if (body.containsKey("description")) {
            template.setDescription(clean(value(body.get("description"), ""), 1000));
        }
        if (body.containsKey("category") && hasText(String.valueOf(body.get("category")))) {
            template.setCategory(clean(value(body.get("category"), template.getCategory()), 40));
        }
        if (body.containsKey("targetAudience")) {
            template.setTargetAudience(clean(value(body.get("targetAudience"), ""), 200));
        }
        templateMapper.updateById(template);
        eventService.broadcastSharedPlanChanged("update", id);
        return adminDetail(id);
    }

    private Map<String, Object> templateRow(SharedPlanTemplate template) {
        return templateRow(template, null);
    }

    private Map<String, Object> templateRow(SharedPlanTemplate template, Long userId) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", template.getId());
        row.put("title", template.getTitle());
        row.put("description", template.getDescription());
        row.put("category", template.getCategory());
        row.put("categoryName", categoryName(template.getCategory()));
        row.put("targetAudience", template.getTargetAudience());
        row.put("status", template.getStatus());
        row.put("applyCount", template.getApplyCount());
        row.put("likeCount", template.getLikeCount() == null ? 0 : template.getLikeCount());
        row.put("liked", userId != null && isLikedBy(userId, template.getId()));
        row.put("createdAt", template.getCreatedAt());
        return row;
    }

    private Map<String, Object> categoryRow(SharedPlanCategory category) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("key", category.getCategoryKey());
        row.put("name", category.getName());
        row.put("description", category.getDescription());
        row.put("templateCount", category.getTemplateCount() == null ? 0 : category.getTemplateCount());
        return row;
    }

    private Map<String, Object> reviewRow(SharedPlanReview review) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", review.getId());
        row.put("reviewerId", review.getReviewerId());
        row.put("action", review.getAction());
        row.put("note", review.getNote());
        row.put("createdAt", review.getCreatedAt());
        return row;
    }

    private boolean isLikedBy(Long userId, Long templateId) {
        return likeMapper.selectCount(new LambdaQueryWrapper<SharedPlanLike>()
                .eq(SharedPlanLike::getUserId, userId)
                .eq(SharedPlanLike::getTemplateId, templateId)) > 0;
    }

    private void refreshLikeCount(Long templateId) {
        SharedPlanTemplate template = templateMapper.selectById(templateId);
        if (template == null) {
            return;
        }
        long count = likeMapper.selectCount(new LambdaQueryWrapper<SharedPlanLike>()
                .eq(SharedPlanLike::getTemplateId, templateId));
        template.setLikeCount((int) count);
        templateMapper.updateById(template);
    }

    private void applyPublicSort(LambdaQueryWrapper<SharedPlanTemplate> query, String sort, String order) {
        boolean asc = "asc".equalsIgnoreCase(order);
        String normalized = value(sort, "createdAt");
        if ("likeCount".equalsIgnoreCase(normalized)) {
            if (asc) query.orderByAsc(SharedPlanTemplate::getLikeCount);
            else query.orderByDesc(SharedPlanTemplate::getLikeCount);
            query.orderByDesc(SharedPlanTemplate::getCreatedAt);
        } else {
            if (asc) query.orderByAsc(SharedPlanTemplate::getCreatedAt);
            else query.orderByDesc(SharedPlanTemplate::getCreatedAt);
        }
    }

    private Comparator<Map<String, Object>> adminComparator(String sort, String q) {
        if (hasText(q)) {
            return Comparator.comparingInt(row -> ((Number) row.getOrDefault("searchScore", 0)).intValue());
        }
        if ("likeCount".equalsIgnoreCase(sort)) {
            return Comparator.comparingInt(row -> ((Number) row.getOrDefault("likeCount", 0)).intValue());
        }
        return Comparator.comparing(row -> String.valueOf(row.getOrDefault("createdAt", "")));
    }

    private int searchScore(Map<String, Object> row, String q) {
        if (!hasText(q)) {
            return 1;
        }
        String query = q.trim().toLowerCase(Locale.ROOT);
        Map<?, ?> creator = row.get("creator") instanceof Map<?, ?> map ? map : Map.of();
        String haystack = (value(row.get("title"), "") + " "
                + value(row.get("description"), "") + " "
                + value(row.get("category"), "") + " "
                + value(creator.get("nickname"), "") + " "
                + value(creator.get("username"), "")).toLowerCase(Locale.ROOT);
        if (haystack.contains(query)) {
            return 100 + query.length();
        }
        int score = 0;
        for (String part : query.split("\\s+")) {
            if (part.length() > 0 && haystack.contains(part)) {
                score += 20;
            }
        }
        return score;
    }

    private String resolveCategory(Map<String, Object> body, List<Map<String, Object>> tasks, List<Map<String, Object>> routines) {
        String requested = value(body.get("category"), "");
        if (hasText(requested) && !"GENERAL".equalsIgnoreCase(requested)) {
            return clean(requested.toUpperCase(Locale.ROOT), 60);
        }
        String source = collectCategoryText(body, tasks, routines).toLowerCase(Locale.ROOT);
        SharedPlanCategory best = null;
        int bestScore = 0;
        for (SharedPlanCategory category : categoryMapper.selectList(new LambdaQueryWrapper<SharedPlanCategory>())) {
            int score = categoryScore(source, category);
            if (score > bestScore) {
                bestScore = score;
                best = category;
            }
        }
        if (best != null && bestScore >= 2) {
            return best.getCategoryKey();
        }
        return ensureGeneratedCategory(source);
    }

    private String collectCategoryText(Map<String, Object> body, List<Map<String, Object>> tasks, List<Map<String, Object>> routines) {
        StringBuilder text = new StringBuilder();
        text.append(value(body.get("title"), "")).append(' ');
        text.append(value(body.get("description"), "")).append(' ');
        text.append(value(body.get("targetAudience"), "")).append(' ');
        for (Map<String, Object> task : tasks) {
            text.append(value(task.get("title"), "")).append(' ')
                    .append(value(task.get("description"), "")).append(' ')
                    .append(value(task.get("taskType"), "")).append(' ');
        }
        for (Map<String, Object> routine : routines) {
            text.append(value(routine.get("title"), "")).append(' ')
                    .append(value(routine.get("description"), "")).append(' ')
                    .append(value(routine.get("taskType"), "")).append(' ');
        }
        return text.toString();
    }

    private int categoryScore(String source, SharedPlanCategory category) {
        int score = 0;
        String keywords = value(category.getKeywords(), "");
        for (String keyword : keywords.split(",")) {
            String normalized = keyword.trim().toLowerCase(Locale.ROOT);
            if (!normalized.isBlank() && source.contains(normalized)) {
                score++;
            }
        }
        if (source.contains(value(category.getName(), "").toLowerCase(Locale.ROOT))) {
            score += 2;
        }
        return score;
    }

    private String ensureGeneratedCategory(String source) {
        String key = "GENERAL";
        String name = "通用规划";
        if (source.contains("考研") || source.contains("考试") || source.contains("备考")) {
            key = "EXAM";
            name = "考试备考";
        } else if (source.contains("算法") || source.contains("编程") || source.contains("计算机") || source.contains("408")) {
            key = "COMPUTER";
            name = "计算机学习";
        } else if (source.contains("英语") || source.contains("单词") || source.contains("阅读")) {
            key = "LANGUAGE";
            name = "语言学习";
        }
        SharedPlanCategory existing = categoryMapper.selectOne(new LambdaQueryWrapper<SharedPlanCategory>()
                .eq(SharedPlanCategory::getCategoryKey, key));
        if (existing == null) {
            SharedPlanCategory category = new SharedPlanCategory();
            category.setCategoryKey(key);
            category.setName(name);
            category.setDescription(name);
            category.setKeywords(name);
            category.setTemplateCount(0);
            category.setLastUsedAt(LocalDateTime.now());
            categoryMapper.insert(category);
        }
        return key;
    }

    private void touchCategory(String categoryKey) {
        if (!hasText(categoryKey)) {
            return;
        }
        SharedPlanCategory category = categoryMapper.selectOne(new LambdaQueryWrapper<SharedPlanCategory>()
                .eq(SharedPlanCategory::getCategoryKey, categoryKey));
        if (category == null) {
            return;
        }
        Long count = templateMapper.selectCount(new LambdaQueryWrapper<SharedPlanTemplate>()
                .eq(SharedPlanTemplate::getCategory, categoryKey));
        category.setTemplateCount(count.intValue());
        category.setLastUsedAt(LocalDateTime.now());
        categoryMapper.updateById(category);
    }

    private String categoryName(String key) {
        if (!hasText(key)) {
            return "通用规划";
        }
        SharedPlanCategory category = categoryMapper.selectOne(new LambdaQueryWrapper<SharedPlanCategory>()
                .eq(SharedPlanCategory::getCategoryKey, key));
        return category == null ? key : category.getName();
    }

    private Map<String, Object> creatorRow(Long userId) {
        if (userId == null) {
            return anonymousCreator();
        }
        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) {
            return anonymousCreator();
        }
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", user.getId());
        row.put("nickname", publicNickname(user));
        row.put("avatar", publicAvatar(user));
        return row;
    }

    private String publicAvatar(SysUser user) {
        String avatar = value(user == null ? null : user.getAvatar(), null);
        if (avatar == null) {
            return null;
        }
        return uploadPathResolver.publicUploadExists(avatar) ? avatar : null;
    }

    private Map<String, Object> creatorAdminRow(Long userId) {
        Map<String, Object> row = creatorRow(userId);
        if (userId != null) {
            SysUser user = sysUserMapper.selectById(userId);
            if (user != null) {
                row.put("username", user.getUsername());
            }
        }
        return row;
    }

    private Map<String, Object> anonymousCreator() {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", null);
        row.put("nickname", "匿名用户");
        row.put("avatar", null);
        return row;
    }

    private String publicNickname(SysUser user) {
        String nickname = value(user.getNickname(), null);
        if (nickname != null) {
            return nickname;
        }
        String username = value(user.getUsername(), null);
        if (username == null) {
            return "匿名用户";
        }
        if (username.contains("@")) {
            return username.charAt(0) + "***";
        }
        if (username.length() <= 2) {
            return username.charAt(0) + "*";
        }
        return username.charAt(0) + "***" + username.charAt(username.length() - 1);
    }

    private Map<String, Object> taskRow(SharedPlanTaskTemplate task) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("title", task.getTitle());
        row.put("description", task.getDescription());
        row.put("relativeStartDay", task.getRelativeStartDay());
        row.put("relativeDeadlineDay", task.getRelativeDeadlineDay());
        row.put("preferredTime", task.getPreferredTime());
        row.put("durationMinutes", task.getDurationMinutes());
        row.put("taskType", task.getTaskType());
        row.put("difficulty", task.getDifficulty());
        row.put("quadrant", task.getQuadrant());
        row.put("priority", task.getPriority());
        row.put("reminderOffsets", parseOffsets(task.getReminderOffsets()));
        return row;
    }

    private Map<String, Object> routineRow(SharedPlanRoutineTemplate routine) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("title", routine.getTitle());
        row.put("description", routine.getDescription());
        row.put("frequency", routine.getFrequency());
        row.put("daysOfWeek", parseOffsets(routine.getDaysOfWeek()));
        row.put("relativeStartDay", routine.getRelativeStartDay());
        row.put("relativeEndDay", routine.getRelativeEndDay());
        row.put("preferredTime", routine.getPreferredTime());
        row.put("durationMinutes", routine.getDurationMinutes());
        row.put("taskType", routine.getTaskType());
        row.put("difficulty", routine.getDifficulty());
        row.put("quadrant", routine.getQuadrant());
        row.put("priority", routine.getPriority());
        row.put("reminderEnabled", routine.getReminderEnabled() != null && routine.getReminderEnabled() == 1);
        row.put("reminderOffsets", parseOffsets(routine.getReminderOffsets()));
        return row;
    }

    private LocalDateTime toDateTime(LocalDate date, String time, LocalTime fallback) {
        LocalTime localTime = fallback;
        if (time != null && !time.isBlank()) {
            localTime = LocalTime.parse(time.length() > 5 ? time.substring(0, 5) : time);
        }
        return LocalDateTime.of(date, localTime);
    }

    private String clean(String value, int max) {
        String sanitized = privacySanitizer.sanitize(value == null ? "" : value)
                .replaceAll("1[3-9]\\d{9}", "[手机号]")
                .replaceAll("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "[邮箱]");
        return sanitized.length() <= max ? sanitized : sanitized.substring(0, max);
    }

    private String required(Object value, String message) {
        String text = value(value, null);
        if (text == null) {
            throw new BusinessException(message);
        }
        return text;
    }

    private String value(Object value, String fallback) {
        if (value == null || value.toString().trim().isBlank()) {
            return fallback;
        }
        return value.toString().trim();
    }

    private boolean hasText(String value) {
        return value != null && !value.trim().isBlank();
    }

    private int defaultInt(Object value, int fallback) {
        Integer parsed = parseInt(value);
        return parsed == null ? fallback : parsed;
    }

    private Integer parseInt(Object value) {
        if (value == null || value.toString().isBlank()) {
            return null;
        }
        try {
            return Integer.parseInt(value.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> castList(Object value) {
        if (!(value instanceof List<?> raw)) {
            return List.of();
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : raw) {
            if (item instanceof Map<?, ?> map) {
                result.add((Map<String, Object>) map);
            }
        }
        return result;
    }

    private String joinOffsets(Object value) {
        return String.join(",", parseOffsets(value).stream().map(String::valueOf).toList());
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> itemConfig(Map<String, Object> body, String type, Long id) {
        Object configs = body.get("itemsConfig");
        if (!(configs instanceof Map<?, ?> raw)) {
            return Map.of();
        }
        Object value = raw.get(type + "-" + id);
        if (value == null) {
            value = raw.get(String.valueOf(id));
        }
        if (value instanceof Map<?, ?> map) {
            return (Map<String, Object>) map;
        }
        return Map.of();
    }

    private List<Long> parseLongList(Object value) {
        List<Long> result = new ArrayList<>();
        if (!(value instanceof List<?> list)) {
            return result;
        }
        for (Object item : list) {
            if (item == null || item.toString().isBlank()) {
                continue;
            }
            try {
                result.add(Long.parseLong(item.toString()));
            } catch (NumberFormatException ignored) {
                // Ignore malformed ids from the client and validate by ownership later.
            }
        }
        return result;
    }

    private List<Integer> parseOffsets(Object value) {
        List<Integer> result = new ArrayList<>();
        if (value == null) {
            return result;
        }
        if (value instanceof List<?> list) {
            for (Object item : list) {
                Integer parsed = parseInt(item);
                if (parsed != null) result.add(parsed);
            }
        } else {
            for (String part : value.toString().split(",")) {
                Integer parsed = parseInt(part.trim());
                if (parsed != null) result.add(parsed);
            }
        }
        return result;
    }
}
