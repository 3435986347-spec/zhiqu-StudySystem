package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.SharedPlanTemplate;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface SharedPlanTemplateMapper extends BaseMapper<SharedPlanTemplate> {

    /*
     * 两个计数只改自己那一列。原来是「读出整个模板 → 改计数 → updateById 整个写回去」：
     * 两个人同时套用，后写的覆盖先写的，少记一次；更糟的是写回的是<b>读的时候</b>的状态 ——
     * 管理员恰好在这中间驳回或下架了这个计划，点一下赞、套用一次，它就又变回「已通过」。
     */

    /** 套用次数 +1，在库里原地加。 */
    @Update("UPDATE shared_plan_template SET apply_count = COALESCE(apply_count, 0) + 1 WHERE id = #{id}")
    int incrementApplyCount(@Param("id") Long id);

    /** 点赞数按点赞表重新数（不是 +1 / -1：连点、并发时自己会对上）。 */
    @Update("UPDATE shared_plan_template SET like_count = "
            + "(SELECT COUNT(*) FROM shared_plan_like WHERE template_id = #{id} AND deleted = 0) WHERE id = #{id}")
    int refreshLikeCount(@Param("id") Long id);
}
