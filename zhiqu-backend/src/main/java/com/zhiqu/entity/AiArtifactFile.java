package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 代码模式生成的一个文件（第一百一十六轮）。挂在一个 GENERATED_FILES 产物上。 */
@Data
@TableName("ai_artifact_file")
public class AiArtifactFile {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long artifactId;
    private Long userId;
    private Long conversationId;
    private String path;
    private Long sizeBytes;
    private String sha256;
    private byte[] content;
    private LocalDateTime createdAt;
}
