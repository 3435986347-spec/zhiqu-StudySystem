package com.zhiqu.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import com.zhiqu.entity.RuntimeIssue;
import com.zhiqu.entity.SysUser;
import com.zhiqu.entity.UserFeedback;
import com.zhiqu.mapper.RuntimeIssueMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserFeedbackMapper;
import com.zhiqu.rag.RagAdminService;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.AdminGuard;
import com.zhiqu.service.SharedPlanEventService;
import com.zhiqu.service.SharedPlanService;
import com.zhiqu.service.TrafficMonitorService;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/admin")
public class AdminController {
    private final AdminGuard adminGuard;
    private final TrafficMonitorService trafficMonitorService;
    private final SysUserMapper userMapper;
    private final UserFeedbackMapper feedbackMapper;
    private final RuntimeIssueMapper runtimeIssueMapper;
    private final SharedPlanService sharedPlanService;
    private final SharedPlanEventService eventService;
    private final PasswordEncoder passwordEncoder;
    private final RagAdminService ragAdminService;

    public AdminController(AdminGuard adminGuard,
                           TrafficMonitorService trafficMonitorService,
                           SysUserMapper userMapper,
                           UserFeedbackMapper feedbackMapper,
                           RuntimeIssueMapper runtimeIssueMapper,
                           SharedPlanService sharedPlanService,
                           SharedPlanEventService eventService,
                           PasswordEncoder passwordEncoder,
                           RagAdminService ragAdminService) {
        this.adminGuard = adminGuard;
        this.trafficMonitorService = trafficMonitorService;
        this.userMapper = userMapper;
        this.feedbackMapper = feedbackMapper;
        this.runtimeIssueMapper = runtimeIssueMapper;
        this.sharedPlanService = sharedPlanService;
        this.eventService = eventService;
        this.passwordEncoder = passwordEncoder;
        this.ragAdminService = ragAdminService;
    }

    @GetMapping("/overview")
    public Result<Map<String, Object>> overview() {
        requireAdmin();
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("traffic", trafficMonitorService.snapshot());
        data.put("userCount", userMapper.selectCount(new LambdaQueryWrapper<SysUser>()));
        data.put("feedbackOpenCount", feedbackMapper.selectCount(new LambdaQueryWrapper<UserFeedback>()
                .eq(UserFeedback::getStatus, "OPEN")));
        data.put("runtimeIssueOpenCount", runtimeIssueMapper.selectCount(new LambdaQueryWrapper<RuntimeIssue>()
                .eq(RuntimeIssue::getStatus, "OPEN")));
        return Result.success(data);
    }

    @GetMapping("/traffic")
    public Result<Map<String, Object>> traffic() {
        requireAdmin();
        return Result.success(trafficMonitorService.snapshot());
    }

    @GetMapping("/users")
    public Result<Map<String, Object>> users(@RequestParam(defaultValue = "1") long page,
                                             @RequestParam(defaultValue = "20") long size,
                                             @RequestParam(required = false) String keyword,
                                             @RequestParam(required = false) String role,
                                             @RequestParam(required = false) Integer status) {
        requireAdmin();
        long safePage = Math.max(1, page);
        long safeSize = Math.min(100, Math.max(10, size));
        LambdaQueryWrapper<SysUser> query = new LambdaQueryWrapper<SysUser>()
                .orderByDesc(SysUser::getCreatedAt);
        if (keyword != null && !keyword.isBlank()) {
            String kw = keyword.trim();
            query.and(q -> q.like(SysUser::getUsername, kw).or().like(SysUser::getNickname, kw));
        }
        if (role != null && !role.isBlank()) {
            query.eq(SysUser::getRole, role.trim().toUpperCase());
        }
        if (status != null) {
            query.eq(SysUser::getStatus, status);
        }
        Page<SysUser> result = userMapper.selectPage(new Page<>(safePage, safeSize), query);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("records", result.getRecords().stream().map(this::userRow).toList());
        data.put("total", result.getTotal());
        data.put("page", result.getCurrent());
        data.put("size", result.getSize());
        data.put("pages", result.getPages());
        return Result.success(data);
    }

    @GetMapping("/users/{id}")
    public Result<Map<String, Object>> userDetail(@PathVariable Long id) {
        requireAdmin();
        SysUser user = userMapper.selectById(id);
        return Result.success(user == null ? new LinkedHashMap<>() : userRow(user));
    }

    @PutMapping("/users/{id}/status")
    public Result<Void> updateUserStatus(@PathVariable Long id, @RequestParam Integer status) {
        requireAdmin();
        Long currentUserId = SecurityUtils.getCurrentUserId();
        if (id != null && id.equals(currentUserId)) {
            throw new BusinessException("不能禁用当前登录的管理员账号");
        }
        SysUser user = userMapper.selectById(id);
        if (user == null) {
            throw new BusinessException("账号不存在或已删除");
        }
        user.setStatus(status != null && status == 0 ? 0 : 1);
        userMapper.updateById(user);
        return Result.success();
    }

    @PostMapping("/users/{id}/reset-password")
    public Result<Map<String, Object>> resetPassword(@PathVariable Long id) {
        requireAdmin();
        SysUser user = userMapper.selectById(id);
        if (user == null) {
            throw new BusinessException("账号不存在或已删除");
        }
        String tempPassword = randomPassword();
        user.setPassword(passwordEncoder.encode(tempPassword));
        userMapper.updateById(user);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("tempPassword", tempPassword);
        return Result.success(data);
    }

    @DeleteMapping("/users/{id}")
    public Result<Void> deleteUser(@PathVariable Long id) {
        requireAdmin();
        Long currentUserId = SecurityUtils.getCurrentUserId();
        if (id != null && id.equals(currentUserId)) {
            throw new BusinessException("不能删除当前登录的管理员账号");
        }
        SysUser user = userMapper.selectById(id);
        if (user == null) {
            throw new BusinessException("账号不存在或已删除");
        }
        userMapper.deleteById(id);
        return Result.success();
    }

    @GetMapping("/users/{id}/feedback")
    public Result<List<UserFeedback>> userFeedback(@PathVariable Long id,
                                                   @RequestParam(required = false) String status) {
        requireAdmin();
        LambdaQueryWrapper<UserFeedback> query = new LambdaQueryWrapper<UserFeedback>()
                .eq(UserFeedback::getUserId, id)
                .orderByDesc(UserFeedback::getCreatedAt);
        applyStatus(query, UserFeedback::getStatus, status);
        return Result.success(feedbackMapper.selectList(query));
    }

    @GetMapping("/users/{id}/runtime-issues")
    public Result<List<RuntimeIssue>> userRuntimeIssues(@PathVariable Long id,
                                                        @RequestParam(required = false) String status) {
        requireAdmin();
        LambdaQueryWrapper<RuntimeIssue> query = new LambdaQueryWrapper<RuntimeIssue>()
                .eq(RuntimeIssue::getUserId, id)
                .orderByDesc(RuntimeIssue::getCreatedAt);
        applyStatus(query, RuntimeIssue::getStatus, status);
        return Result.success(runtimeIssueMapper.selectList(query));
    }

    @GetMapping("/feedback")
    public Result<List<UserFeedback>> feedback(@RequestParam(required = false) String status) {
        requireAdmin();
        LambdaQueryWrapper<UserFeedback> query = new LambdaQueryWrapper<UserFeedback>()
                .orderByDesc(UserFeedback::getCreatedAt);
        if (status != null && !status.isBlank()) {
            query.eq(UserFeedback::getStatus, status.trim().toUpperCase());
        }
        return Result.success(feedbackMapper.selectList(query));
    }

    @PutMapping("/feedback/{id}/close")
    public Result<Void> closeFeedback(@PathVariable Long id) {
        requireAdmin();
        UserFeedback feedback = feedbackMapper.selectById(id);
        if (feedback != null) {
            feedback.setStatus("CLOSED");
            feedbackMapper.updateById(feedback);
        }
        return Result.success();
    }

    @GetMapping("/runtime-issues")
    public Result<List<RuntimeIssue>> runtimeIssues(@RequestParam(required = false) String status) {
        requireAdmin();
        LambdaQueryWrapper<RuntimeIssue> query = new LambdaQueryWrapper<RuntimeIssue>()
                .orderByDesc(RuntimeIssue::getCreatedAt);
        if (status != null && !status.isBlank()) {
            query.eq(RuntimeIssue::getStatus, status.trim().toUpperCase());
        }
        return Result.success(runtimeIssueMapper.selectList(query));
    }

    @PutMapping("/runtime-issues/{id}/close")
    public Result<Void> closeRuntimeIssue(@PathVariable Long id) {
        requireAdmin();
        RuntimeIssue issue = runtimeIssueMapper.selectById(id);
        if (issue != null) {
            issue.setStatus("CLOSED");
            runtimeIssueMapper.updateById(issue);
        }
        return Result.success();
    }

    @GetMapping("/shared-plans")
    public Result<List<Map<String, Object>>> sharedPlans(@RequestParam(required = false) String status,
                                                        @RequestParam(required = false) String q,
                                                        @RequestParam(required = false) String sort,
                                                        @RequestParam(required = false) String order) {
        requireAdmin();
        return Result.success(sharedPlanService.adminList(status, q, sort, order));
    }

    @GetMapping("/shared-plans/{id}")
    public Result<Map<String, Object>> sharedPlanDetail(@PathVariable Long id) {
        requireAdmin();
        return Result.success(sharedPlanService.adminDetail(id));
    }

    @PutMapping("/shared-plans/{id}/review")
    public Result<Void> reviewSharedPlan(@PathVariable Long id,
                                         @RequestParam String action,
                                         @RequestParam(required = false) String note) {
        requireAdmin();
        sharedPlanService.review(SecurityUtils.getCurrentUserId(), id, action, note);
        return Result.success();
    }

    @PutMapping("/shared-plans/{id}")
    public Result<Map<String, Object>> updateSharedPlan(@PathVariable Long id,
                                                        @RequestBody Map<String, Object> body) {
        requireAdmin();
        return Result.success(sharedPlanService.adminUpdate(id, body));
    }

    @DeleteMapping("/shared-plans/{id}")
    public Result<Void> deleteSharedPlan(@PathVariable Long id) {
        requireAdmin();
        sharedPlanService.deleteByAdmin(id);
        return Result.success();
    }

    @GetMapping("/rag/status")
    public Result<Map<String, Object>> ragStatus() {
        requireAdmin();
        return Result.success(ragAdminService.status());
    }

    @GetMapping("/rag/jobs")
    public Result<List<Map<String, Object>>> ragJobs(@RequestParam(required = false) String status) {
        requireAdmin();
        return Result.success(ragAdminService.jobs(status));
    }

    @PostMapping("/rag/jobs/{id}/retry")
    public Result<Map<String, Object>> retryRagJob(@PathVariable Long id) {
        requireAdmin();
        return Result.success(ragAdminService.retry(id));
    }

    @PostMapping("/rag/sources/{id}/reindex")
    public Result<Map<String, Object>> reindexRagSource(@PathVariable Long id) {
        requireAdmin();
        return Result.success(ragAdminService.reindexSource(id));
    }

    @PostMapping("/rag/rebuild")
    public Result<Map<String, Object>> rebuildRagIndex() {
        requireAdmin();
        return Result.success(ragAdminService.rebuild());
    }

    @PostMapping("/rag/generations/{id}/activate")
    public Result<Map<String, Object>> activateRagGeneration(@PathVariable Long id) {
        requireAdmin();
        return Result.success(ragAdminService.activate(id));
    }

    @PostMapping("/rag/generations/{id}/discard")
    public Result<Map<String, Object>> discardFailedRagGeneration(@PathVariable Long id) {
        requireAdmin();
        return Result.success(ragAdminService.discardFailedGeneration(id));
    }

    @GetMapping("/events")
    public SseEmitter events() {
        requireAdmin();
        return eventService.subscribeAdmin();
    }

    private void requireAdmin() {
        adminGuard.requireAdmin(SecurityUtils.getCurrentUserId());
    }

    private static final char[] PWD_ALPHABET =
            "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789".toCharArray();

    private String randomPassword() {
        SecureRandom random = new SecureRandom();
        StringBuilder sb = new StringBuilder(10);
        for (int i = 0; i < 10; i++) {
            sb.append(PWD_ALPHABET[random.nextInt(PWD_ALPHABET.length)]);
        }
        return sb.toString();
    }

    private Map<String, Object> userRow(SysUser user) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", user.getId());
        row.put("username", user.getUsername());
        row.put("nickname", user.getNickname());
        row.put("role", user.getRole() == null ? "USER" : user.getRole());
        row.put("status", user.getStatus() == null ? 1 : user.getStatus());
        row.put("email", user.getEmail());
        row.put("avatar", user.getAvatar());
        row.put("achievementPoints", user.getAchievementPoints());
        row.put("totalStudyMinutes", user.getTotalStudyMinutes());
        row.put("consecutiveDays", user.getConsecutiveDays());
        row.put("feedbackCount", feedbackMapper.selectCount(new LambdaQueryWrapper<UserFeedback>()
                .eq(UserFeedback::getUserId, user.getId())));
        row.put("feedbackOpenCount", feedbackMapper.selectCount(new LambdaQueryWrapper<UserFeedback>()
                .eq(UserFeedback::getUserId, user.getId())
                .eq(UserFeedback::getStatus, "OPEN")));
        row.put("runtimeIssueCount", runtimeIssueMapper.selectCount(new LambdaQueryWrapper<RuntimeIssue>()
                .eq(RuntimeIssue::getUserId, user.getId())));
        row.put("runtimeIssueOpenCount", runtimeIssueMapper.selectCount(new LambdaQueryWrapper<RuntimeIssue>()
                .eq(RuntimeIssue::getUserId, user.getId())
                .eq(RuntimeIssue::getStatus, "OPEN")));
        row.put("createdAt", user.getCreatedAt());
        row.put("updatedAt", user.getUpdatedAt());
        return row;
    }

    private <T> void applyStatus(LambdaQueryWrapper<T> query,
                                 com.baomidou.mybatisplus.core.toolkit.support.SFunction<T, String> column,
                                 String status) {
        if (status != null && !status.isBlank()) {
            query.eq(column, status.trim().toUpperCase());
        }
    }
}
