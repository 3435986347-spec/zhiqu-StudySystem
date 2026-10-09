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

    /** 改密码时 +1；登录令牌里带着签发时的值，不一样就失效（见 V37、JwtAuthenticationFilter）。 */
    private Integer tokenEpoch;

    /**
     * AI 助手能不能读这个人的任务（V42，第二十七轮）。空 = 开 —— 用户定的是「让它读，给一个开关」；
     * 是不是开着只在 {@link #aiReadsTasks()} 一处判。
     */
    private Integer aiReadTasks;

    public boolean aiReadsTasks() {
        return aiReadTasks == null || aiReadTasks != 0;
    }

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @Version
    private Integer version;

    @TableLogic
    private Integer deleted;
}
