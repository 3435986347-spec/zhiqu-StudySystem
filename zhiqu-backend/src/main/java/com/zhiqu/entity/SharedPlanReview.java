package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("shared_plan_review")
public class SharedPlanReview {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long templateId;
    private Long reviewerId;
    private String action;
    private String note;
    private LocalDateTime createdAt;
}
