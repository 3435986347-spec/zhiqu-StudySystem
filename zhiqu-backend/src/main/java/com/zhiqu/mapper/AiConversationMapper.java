package com.zhiqu.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhiqu.entity.AiConversation;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface AiConversationMapper extends BaseMapper<AiConversation> {

    /**
     * 并发安全地确保 (user_id, conversation_key) 存在一条活动会话。
     * 唯一键 uk_ai_conversation_user_key 覆盖软删行：被“清空记忆”逻辑删除的同 key 行仍占用唯一键，
     * 普通 insert 会撞键；这里用 upsert 把软删行复活为 deleted=0，同时天然消除“先查后插”的并发竞态。
     */
    @Insert("INSERT INTO ai_conversation (user_id, conversation_key, title, deleted) "
            + "VALUES (#{userId}, #{conversationKey}, #{title}, 0) "
            + "ON DUPLICATE KEY UPDATE deleted = 0")
    int upsertActive(@Param("userId") Long userId,
                     @Param("conversationKey") String conversationKey,
                     @Param("title") String title);
}
