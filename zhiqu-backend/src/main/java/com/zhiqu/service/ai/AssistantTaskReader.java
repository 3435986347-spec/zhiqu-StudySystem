package com.zhiqu.service.ai;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.service.privacy.TaskPrivacyService;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * AI 助手读用户的任务（第二十七轮）。只读、只读这个人的、只读没完成的；拼成什么样在 {@link AssistantTaskContext}。
 *
 * <p>读不读由 {@code AgentPlanDecision.needsTaskReader} 决定（说到了安排 / 今天 / 这周、开关开着、不是纯聊天），
 * 不在这里再判一遍。
 */
@Component
public class AssistantTaskReader {

    /** 从库里最多取几条再排序截断：够排出前 {@link AssistantTaskContext#MAX_SHOWN} 条，又不至于把几千条旧任务整个搬出来解密。 */
    static final int FETCH = 200;

    public record Read(String block, int shown, long total) {
    }

    private final StudyTaskMapper taskMapper;
    private final TaskPrivacyService privacy;
    private final BusinessClock clock;

    public AssistantTaskReader(StudyTaskMapper taskMapper, TaskPrivacyService privacy, BusinessClock clock) {
        this.taskMapper = taskMapper;
        this.privacy = privacy;
        this.clock = clock;
    }

    public Read read(Long userId) {
        return read(userId, false);
    }

    /** @param withIds 每条带 {@code #编号}（命令行 / MCP 的 {@code list_tasks}，好拿去改状态）。 */
    public Read read(Long userId, boolean withIds) {
        long total = taskMapper.selectCount(open(userId));
        // 与 AssistantTaskContext.ORDER 同一个顺序（有日期的先、日期早的先、再按优先级），否则取回来的 200 条不一定是该列的那些
        List<StudyTask> tasks = taskMapper.selectList(open(userId)
                .last("ORDER BY COALESCE(deadline, start_time) IS NULL, COALESCE(deadline, start_time), priority DESC, id LIMIT " + FETCH));
        privacy.revealAll(tasks);
        String block = AssistantTaskContext.block(tasks, total, clock.now(), withIds);
        return new Read(block, (int) Math.min(tasks.size(), AssistantTaskContext.MAX_SHOWN), total);
    }

    /** 这个人没完成的任务（软删除由 @TableLogic 排除）。 */
    private static LambdaQueryWrapper<StudyTask> open(Long userId) {
        return new LambdaQueryWrapper<StudyTask>()
                .eq(StudyTask::getUserId, userId)
                .and(w -> w.isNull(StudyTask::getStatus).or().ne(StudyTask::getStatus, 2));
    }
}
