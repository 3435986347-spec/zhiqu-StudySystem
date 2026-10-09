package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.AppRuntimeFlag;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface AppRuntimeFlagMapper extends BaseMapper<AppRuntimeFlag> {

    /**
     * 写入开关值。用 upsert 而非「先查后插」：cutover 期间管理员可能连续翻转同一个开关，
     * 先查后插会在并发下撞主键。
     */
    @Insert("INSERT INTO app_runtime_flag (flag_key, flag_value, updated_by) "
            + "VALUES (#{flagKey}, #{flagValue}, #{updatedBy}) "
            + "ON DUPLICATE KEY UPDATE flag_value = VALUES(flag_value), updated_by = VALUES(updated_by)")
    int upsert(@Param("flagKey") String flagKey,
               @Param("flagValue") String flagValue,
               @Param("updatedBy") String updatedBy);
}
