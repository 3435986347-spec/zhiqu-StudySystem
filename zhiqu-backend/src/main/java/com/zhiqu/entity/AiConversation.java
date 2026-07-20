package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_conversation")
public class AiConversation {

    /** notebook 专属会话的 conversation_key 约定，读写两侧共用，避免字面量漂移 */
    public static String notebookKey(Long notebookId) {
        return "notebook-" + notebookId;
    }

    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String conversationKey;
    private String title;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
