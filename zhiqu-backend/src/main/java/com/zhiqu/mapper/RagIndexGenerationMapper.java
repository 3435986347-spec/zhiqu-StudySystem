package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.RagIndexGeneration;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.util.List;

@Mapper
public interface RagIndexGenerationMapper extends BaseMapper<RagIndexGeneration> {
    @Select("SELECT * FROM rag_index_generation WHERE id = #{id} FOR UPDATE")
    RagIndexGeneration lockById(@Param("id") Long id);

    @Select("SELECT * FROM rag_index_generation ORDER BY id FOR UPDATE")
    List<RagIndexGeneration> lockAll();

    @Update("UPDATE rag_index_generation SET status='PURGING' " +
            "WHERE id=#{id} AND status IN ('RETIRED','FAILED')")
    int claimForPurge(@Param("id") Long id);
}
