package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.AiArtifactFile;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

@Mapper
public interface AiArtifactFileMapper extends BaseMapper<AiArtifactFile> {

    /** 这个账号存了多少字节（上限用） */
    @Select("SELECT COALESCE(SUM(size_bytes), 0) FROM ai_artifact_file WHERE user_id = #{userId}")
    long totalBytes(@Param("userId") Long userId);

    /** 这段对话生成过的文件，每个路径最新的那一份，不带内容（产物面板用：换一轮、刷新之后还点得到） */
    @Select("SELECT id, artifact_id, path, size_bytes FROM ai_artifact_file WHERE id IN ("
            + "SELECT MAX(id) FROM ai_artifact_file WHERE user_id = #{userId} AND conversation_id = #{conversationId} GROUP BY path"
            + ") ORDER BY path LIMIT 500")
    List<AiArtifactFile> latestRows(@Param("userId") Long userId, @Param("conversationId") Long conversationId);

    /** 这段对话里每个路径最新的那一份（恢复临时空间用）。只要 id，内容一个一个取，不一次全读进内存 */
    @Select("SELECT MAX(id) FROM ai_artifact_file WHERE user_id = #{userId} AND conversation_id = #{conversationId} GROUP BY path")
    List<Long> latestIds(@Param("userId") Long userId, @Param("conversationId") Long conversationId);
}
