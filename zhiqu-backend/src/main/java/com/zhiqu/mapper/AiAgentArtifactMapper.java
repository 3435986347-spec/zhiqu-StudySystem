package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.AiAgentArtifact;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface AiAgentArtifactMapper extends BaseMapper<AiAgentArtifact> {
    @Select("SELECT * FROM ai_agent_artifact WHERE id = #{id} FOR UPDATE")
    AiAgentArtifact selectByIdForUpdate(@Param("id") Long id);
}
