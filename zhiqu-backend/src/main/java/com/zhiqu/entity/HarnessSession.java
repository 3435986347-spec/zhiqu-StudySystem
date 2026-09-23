package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 命令行会话 ↔ 网页 Notebook。见 V36。 */
@Data
@TableName("harness_session")
public class HarnessSession {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String clientSessionId;
    private Long notebookId;
    private Long agentRunId;
    private String title;
    private String workspaceName;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}
