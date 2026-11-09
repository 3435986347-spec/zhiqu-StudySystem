package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.AiMessage;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface AiMessageMapper extends BaseMapper<AiMessage> {

    /**
     * 把流式进行中的正文<b>阶段性</b>写进库，让刷新页面能看到已经生成的部分。
     *
     * <p>此前这一列在整轮结束前一直是空串：行是流开始时就建的（status=STREAMING、content=""），
     * 正文只在最后的事务里写一次。于是刷新一下，用户看到的是一个永远停在「正在生成…」的气泡，
     * 而后端其实还在正常生成 —— 内容并没有丢，只是页面再也拿不到它。
     *
     * <h2>三个 WHERE 条件都不是装饰</h2>
     *
     * <ul>
     *   <li>{@code deleted = 0} —— 用户可能在生成途中清空会话。少了它，这次写入会把一条
     *       已经软删的消息重新填上内容；虽然列表查询会过滤掉，但「清空必须获胜」的语义
     *       （ADR-0002）就被一次后台写悄悄破坏了。</li>
     *   <li>{@code status = 'STREAMING'} —— 终态消息不得被回退。没有它，一个迟到的
     *       flush 会覆盖掉最终事务刚写好的完整正文，把 DONE 的消息改回半截。
     *       这不是假想：flush 在流线程上、完成写在提交事务里，两者天然可能错序。</li>
     *   <li>{@code user_id} —— 与全仓库其余写路径一致，不靠主键单独定位。</li>
     * </ul>
     *
     * <p>不写 {@code updated_at}：这是同一条消息生成过程中的中间态，不是一次用户可见的修改。
     *
     * @return 实际更新的行数；0 表示消息已被清空或已进入终态，调用方应当停止再 flush
     */
    @Update("""
            UPDATE ai_message
            SET content = #{content}
            WHERE id = #{id}
              AND user_id = #{userId}
              AND status = 'STREAMING'
              AND deleted = 0
            """)
    int flushStreamingContent(@Param("id") Long id,
                              @Param("userId") Long userId,
                              @Param("content") String content);

    /**
     * 回答里的每一步（第一百二十七轮）：一轮收尾时写一次（成功、失败都写）。单独一条 UPDATE、只动这一列：
     * 实体上这一列不读（select = false），整行 updateById 永远碰不到它。
     *
     * <p>{@code deleted = 0}：生成途中清空了会话，不给已经软删的消息填上东西（和 flushStreamingContent 同一条理由）。
     */
    @Update("""
            UPDATE ai_message
            SET steps_json = #{stepsJson}
            WHERE id = #{id}
              AND user_id = #{userId}
              AND deleted = 0
            """)
    int saveSteps(@Param("id") Long id,
                  @Param("userId") Long userId,
                  @Param("stepsJson") String stepsJson);

    /**
     * 生成途中阶段性写一份步骤（review：流式中断 / 刷新后页面轮询列表，原来这时候步骤一条都没有，要等整轮完才出来）。
     * 和 flushStreamingContent 同样三个条件：终态的不回退（收尾那次 saveSteps 才是最后的），删了的不填。
     */
    @Update("""
            UPDATE ai_message
            SET steps_json = #{stepsJson}
            WHERE id = #{id}
              AND user_id = #{userId}
              AND status = 'STREAMING'
              AND deleted = 0
            """)
    int flushStreamingSteps(@Param("id") Long id,
                            @Param("userId") Long userId,
                            @Param("stepsJson") String stepsJson);

    /** 一批消息的步骤（列表接口用：实体上不读这一列）。id → steps_json */
    @org.apache.ibatis.annotations.Select("""
            <script>
            SELECT id, steps_json FROM ai_message
            WHERE user_id = #{userId} AND deleted = 0 AND steps_json IS NOT NULL AND id IN
            <foreach collection="ids" item="id" open="(" separator="," close=")">#{id}</foreach>
            </script>
            """)
    java.util.List<java.util.Map<String, Object>> stepsOf(@Param("userId") Long userId, @Param("ids") java.util.Collection<Long> ids);
}
