package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 一个语料单元在某个索引代次里的索引状态。
 *
 * <p><b>两套行共存，靠两个可空列区分</b>（V29 起）：
 * LEGACY 行填 {@code sourceId}、{@code unitId} 为 NULL；UNIT 行反之。
 * 表上有两把唯一键（{@code uk_rag_source_generation} 与 {@code uk_rag_source_state_unit}），
 * 而 MySQL 的唯一键允许多个 NULL，所以两套行互不干扰，也不会各自内部撞车。
 *
 * <p>类名保留 {@code SourceIndexState} 不改：表名不动，重命名实体只会让
 * 「日志里叫 A、表叫 B」多一层翻译。承重的是下面两个字段的互斥关系，不是名字。
 */
@Data
@TableName("rag_source_index_state")
public class RagSourceIndexState {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long sourceId;

    /**
     * 投影行 id（{@code rag_indexable_unit.id}）。
     *
     * <p>V29 建了这一列，但实体直到 1B-2 的 1c 才补上 —— 在那之前
     * {@code bySource.put(state.getSourceId(), state)} 是唯一的索引方式，
     * 而 UNIT 行的 {@code sourceId} 恒为 NULL：HashMap 只允许一个 null 键，
     * 全部 UNIT 行会塌成一个条目、互相覆盖，且不抛任何异常。
     */
    private Long unitId;

    private Long generationId;
    private String indexVersion;
    private String contentHash;
    private String status;
    private Integer vectorCount;
    private String lastError;
    private LocalDateTime indexedAt;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
