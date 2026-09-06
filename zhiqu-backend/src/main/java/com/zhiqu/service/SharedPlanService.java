package com.zhiqu.service;

import java.util.List;
import java.util.Map;

public interface SharedPlanService {
    Map<String, Object> submit(Long userId, Map<String, Object> body);

    Map<String, Object> submitFromExisting(Long userId, Map<String, Object> body);

    List<Map<String, Object>> publicList(Long userId, String category, String sort, String order);

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
