package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.StudyRecord;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

@Mapper
public interface StudyRecordMapper extends BaseMapper<StudyRecord> {

    /** 学过的不同日期有几天 —— 走 (user_id, study_date) 索引就能答，不用把记录取回来数。 */
    @Select("SELECT COUNT(DISTINCT study_date) FROM study_record WHERE user_id = #{userId}")
    long countStudyDays(@Param("userId") Long userId);

    /** 趋势图那一段日期里每天学了多少分钟（同一天多条记录在库里就加好）。窗口有界，走 (user_id, study_date) 索引。 */
    @Select("SELECT study_date AS studyDate, SUM(duration_minutes) AS minutes FROM study_record "
            + "WHERE user_id = #{userId} AND study_date BETWEEN #{from} AND #{to} GROUP BY study_date")
    List<Map<String, Object>> minutesByDay(@Param("userId") Long userId, @Param("from") LocalDate from, @Param("to") LocalDate to);
}
