package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 可索引单元的切分边界（表 {@code rag_unit_chunk}，见 V29）。
 *
 * <p><b>只存边界与哈希，永不存正文。</b>Wiki 正文在库里是密文，解密只在 JVM 内短暂发生；
 * 在这里落一份明文等于把整条加密边界打穿。
 *
 * <p>{@link #charStart}/{@link #charEnd} 的单位是 <b>Unicode code point</b>，不是 Java 的
 * UTF-16 code unit —— 回读必须走 {@code RagUnitChunker.sliceByCodePoints}，用 substring
 * 会在含星平面字符的文本上静默错位。
 */
@Data
@TableName("rag_unit_chunk")
public class RagUnitChunk {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long unitId;
    private Integer chunkIndex;
    private Integer charStart;
    private Integer charEnd;
    private String contentHash;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
