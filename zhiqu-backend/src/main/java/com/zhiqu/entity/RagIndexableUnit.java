package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * RAG 可索引单元的投影行（表 {@code rag_indexable_unit}，见 V29）。
 *
 * <p><b>本实体刻意没有 {@code deleted} 字段。</b>生命周期全部走 {@code status}
 * （READY / RETIRED / SKIPPED）。若加上 {@code deleted}，MyBatis-Plus 的全局逻辑删除
 * （application.yml 的 {@code logic-delete-field: deleted}）会立刻对本表生效，于是
 * 「退役」有了两条互不知情的表达方式，而 reconcile 只认其中一条。
 */
@Data
@TableName("rag_indexable_unit")
public class RagIndexableUnit {
    @TableId(type = IdType.AUTO)
    private Long id;

    /**
     * 单元归属用户。<b>必须来自实体行，绝不能取自 {@code SecurityContext}</b> ——
     * 注册可能发生在异步 worker 线程里，那里 SecurityContext 恒为空。写空的后果是一条
     * 三步静默链：回读时的 {@code ref_id + user_id} 双条件命中 0 行 → 记 SKIPPED →
     * 低于 {@code max-skipped-ratio} 时代次照常 READY → 这批内容检索不到且全程无报错。
     */
    private Long userId;

    /** NOTEBOOK_SOURCE | WIKI_PAGE | CONVERSATION_TURN，取值见 {@code RagNamespace}。 */
    private String namespace;

    /** 原始表主键；CONVERSATION_TURN 取助手消息 id。 */
    private Long refId;

    private String scopeKind;
    private Long scopeId;
    private String title;
    private String sourceType;

    /** 规范化全文的 sha256。钩子与 worker 必须算出同一个值，否则同一单元会被无限重建。 */
    private String canonicalHash;

    private Integer chunkCount;

    /** READY | RETIRED | SKIPPED。 */
    private String status;

    private String indexStatus;
    private String indexVersion;
    private String indexError;
    private LocalDateTime indexedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
