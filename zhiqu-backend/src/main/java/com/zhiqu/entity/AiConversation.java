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

    /**
     * 滚动摘要密文 —— 覆盖 {@code id <= summaryUptoMessageId} 的那段历史。
     *
     * <p>{@code summaryLiveCount} 是它的<b>读侧指纹</b>：取用时数一次区间内的存活消息，
     * 对不上就判脏重算。选读侧而不是写侧标脏，不是因为写入落点多（实测只有
     * {@code deleteChatMessage} 一处能让已摘要区间失真），而是因为写侧的正确性<b>分散在调用点</b>，
     * 取决于将来每条新增删除路径都记得挂钩子；而读侧这一处检查可以整个去掉、看同一场景变绿，
     * 写侧分散的正确性没法这么扰动，那条判据就永远无法自证。
     *
     * <p>指纹为什么只有一维、覆盖不到什么，见 {@code V31__conversation_summary.sql} 的表头注释。
     */
    private String encryptedSummary;
    private Long summaryUptoMessageId;
    private Integer summaryLiveCount;
    private LocalDateTime summaryUpdatedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
