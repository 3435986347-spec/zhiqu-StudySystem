package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.UserAiMemory;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UserAiMemoryMapper extends BaseMapper<UserAiMemory> {

    /**
     * 加锁读当前用户的记忆行。
     *
     * <p><b>必须用它、不能用普通 select 来做读—改—写。</b>MySQL 默认 REPEATABLE READ 下，
     * 普通 SELECT 读的是<b>事务开始时的快照</b>：confirmArtifact 的事务早在进入这里之前就开始了，
     * 于是它看不到另一个并发确认刚刚提交的行 —— 即使已经拿到了用户行锁，合并仍然基于过期数据，
     * 首次写入还会照样 INSERT 然后撞唯一键。{@code FOR UPDATE} 是加锁读，读最新已提交版本。
     */
    @Select("SELECT * FROM user_ai_memory WHERE user_id = #{userId} FOR UPDATE")
    UserAiMemory selectForUpdate(@Param("userId") Long userId);
}
