package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.RagSourceIndexState;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface RagSourceIndexStateMapper extends BaseMapper<RagSourceIndexState> {
    /**
     * UNIT 方言的行锁。
     *
     * <p>1B-2 的 1c 之后这是<b>唯一</b>的一把 —— 按 {@code source_id} 锁的那把随
     * LEGACY 索引记账一起删了（{@code UPSERT_SOURCE} 已无生产端）。两把并存过一阵，
     * 而它们不是重载关系：UNIT 行的 {@code source_id} 恒为 NULL，
     * 且 {@code source_id = NULL} 在 SQL 里永远不成立 —— 拿旧那把去锁 UNIT 行
     * 会稳定地拿到 0 行，于是每次都走「不存在 → INSERT」分支去撞唯一键。
     */
    @Select("SELECT * FROM rag_source_index_state " +
            "WHERE unit_id = #{unitId} AND generation_id = #{generationId} FOR UPDATE")
    RagSourceIndexState lockByUnitAndGeneration(@Param("unitId") Long unitId,
                                                @Param("generationId") Long generationId);
}
