package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.StudyTask;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;
import java.util.Map;

@Mapper
public interface StudyTaskMapper extends BaseMapper<StudyTask> {

    /** 统计页用：按象限、状态数任务。手写 SQL 不走 @TableLogic，软删除要自己排除。 */
    @Select("SELECT quadrant, status, COUNT(*) AS n FROM study_task "
            + "WHERE user_id = #{userId} AND deleted = 0 GROUP BY quadrant, status")
    List<Map<String, Object>> countByQuadrantAndStatus(@Param("userId") Long userId);
}
