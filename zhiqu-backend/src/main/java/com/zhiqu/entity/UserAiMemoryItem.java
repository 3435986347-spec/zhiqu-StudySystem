package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 长期记忆的一条（V49）。正文只存密文；作废不删（{@code invalidatedAt}），被改掉的记着被哪条取代（{@code supersededBy}）。
 * 时间列由 {@link com.zhiqu.service.memory.LongTermMemoryStore} 自己填（业务时钟），不走自动填充。
 */
@Data
@TableName("user_ai_memory_item")
public class UserAiMemoryItem {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String category;
    private String encryptedText;
    /** MANUAL（设置里手写的 / 旧数据拆进来的）、WEB（网页对话的草稿）、CLI（命令行的草稿）。 */
    private String source;
    private Integer pinned;
    private Long supersededBy;
    private LocalDateTime invalidatedAt;
    private LocalDateTime lastUsedAt;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}
