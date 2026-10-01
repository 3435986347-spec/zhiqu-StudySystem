package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.SharedPlanLike;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface SharedPlanLikeMapper extends BaseMapper<SharedPlanLike> {
    @Delete("DELETE FROM shared_plan_like WHERE id = #{id}")
    int physicalDeleteById(@Param("id") Long id);
}
