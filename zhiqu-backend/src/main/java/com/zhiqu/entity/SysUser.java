package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("sys_user")
public class SysUser {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String username;
    private String password;
    private String nickname;
    private String avatar;
    private String school;
    private String major;
    private String email;
    private String role;
    private Integer status;
    private Integer totalStudyMinutes;
    private Integer consecutiveDays;
    private LocalDate lastStudyDate;
    private Integer achievementPoints;

    /**
     * 记忆纪元 —— 清空记忆时递增，用来判定「这份产物来自你已经清空掉的那段对话」。
     *
     * <p>V27 建了这一列却从未接线（Java 侧零引用），而迁移注释写得像已经生效。
     * 现在真的接上了：{@code clearMemory} 递增它，{@code beginRun} 快照它到
     * {@code ai_agent_run.memory_epoch}，记忆草稿确认时比对两者。
     */
    private Long memoryEpoch;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @Version
    private Integer version;

    @TableLogic
    private Integer deleted;
}
