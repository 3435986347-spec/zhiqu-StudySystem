package com.zhiqu.service;

import java.util.List;
import java.util.Map;

public interface SharedPlanService {
    Map<String, Object> submit(Long userId, Map<String, Object> body);

    Map<String, Object> submitFromExisting(Long userId, Map<String, Object> body);

    List<Map<String, Object>> publicList(Long userId, String category, String sort, String order);

    /**
     * 我投出去的计划（所有状态），带审核结果。
     *
     * <p><b>补的是一个被许下却没兑现的承诺</b>：后台驳回弹窗写着「驳回原因（可选，将展示给提交者）」，
     * 而在此之前系统里没有任何地方把它展示给提交者 —— publicList 只返回 APPROVED，
     * 带审核意见的 reviews 只在 adminDetail 里，template.rejection_reason 零读取。
     * 管理员以为自己写的解释会送达，实际写完就再无出口。
     */
    List<Map<String, Object>> mySubmissions(Long userId);

    Map<String, Object> detail(Long userId, Long id);

    List<Map<String, Object>> categories();

    Map<String, Object> toggleLike(Long userId, Long id);

    Map<String, Object> apply(Long userId, Long id, Map<String, Object> body);

    List<Map<String, Object>> adminList(String status, String q, String sort, String order);

    Map<String, Object> adminDetail(Long id);

    void review(Long adminUserId, Long id, String action, String note);

    Map<String, Object> adminUpdate(Long id, Map<String, Object> body);

    void deleteByAdmin(Long id);
}
