package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.mapper.AiAgentTaskMapper;
import com.zhiqu.service.AgentTaskExecutor;
import com.zhiqu.service.AgentTaskGraphService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;

@Service
public class AgentTaskGraphServiceImpl implements AgentTaskGraphService, AgentTaskExecutor {
    private final AiAgentTaskMapper taskMapper;
    private final ObjectMapper objectMapper;

    public AgentTaskGraphServiceImpl(AiAgentTaskMapper taskMapper, ObjectMapper objectMapper) {
        this.taskMapper = taskMapper;
        this.objectMapper = objectMapper;
    }

    @Override
    @Transactional
    public AiAgentTask createTask(Long runId, Long parentTaskId, String agentType, String taskType,
                                  int priority, String parallelGroupId, List<Long> dependsOn,
                                  Map<String, Object> input, String publicSummary) {
        AiAgentTask task = new AiAgentTask();
        task.setRunId(runId);
        task.setParentTaskId(parentTaskId);
        task.setAgentType(agentType);
        task.setTaskType(taskType);
        task.setStatus("PENDING");
        task.setPriority(priority);
        task.setParallelGroupId(parallelGroupId);
        task.setDependsOnJson(toJson(dependsOn == null ? List.of() : dependsOn));
        task.setInputJson(toJson(input == null ? Map.of() : input));
        task.setPublicSummary(limit(publicSummary, 500));
        taskMapper.insert(task);
        return task;
    }

    @Override
    @Transactional
    public AiAgentTask startTask(AiAgentTask task) {
        if (task == null) {
            return null;
        }
        task.setStatus("RUNNING");
        task.setStartedAt(LocalDateTime.now());
        taskMapper.updateById(task);
        return task;
    }

    @Override
    @Transactional
    public void completeTask(AiAgentTask task, Map<String, Object> output, String publicSummary) {
        if (task == null) {
            return;
        }
        task.setStatus("DONE");
        task.setPublicSummary(limit(publicSummary, 500));
        task.setOutputJson(toJson(output == null ? Map.of() : output));
        task.setCompletedAt(LocalDateTime.now());
        taskMapper.updateById(task);
    }

    @Override
    @Transactional
    public AiAgentTask skipTask(Long runId, String agentType, String taskType, String publicSummary) {
        AiAgentTask task = createTask(runId, null, agentType, taskType, 0, null, List.of(), Map.of(), publicSummary);
        task.setStatus("SKIPPED");
        task.setCompletedAt(LocalDateTime.now());
        taskMapper.updateById(task);
        return task;
    }

    @Override
    @Transactional
    public void skipTask(AiAgentTask task, String publicSummary) {
        if (task == null) {
            return;
        }
        task.setStatus("SKIPPED");
        task.setPublicSummary(limit(publicSummary, 500));
        task.setCompletedAt(LocalDateTime.now());
        taskMapper.updateById(task);
    }

    @Override
    @Transactional
    public void errorTask(AiAgentTask task, Exception error) {
        if (task == null) {
            return;
        }
        task.setStatus("ERROR");
        task.setErrorMessage(limit(error == null || error.getMessage() == null ? "Task failed" : error.getMessage(), 1000));
        task.setCompletedAt(LocalDateTime.now());
        taskMapper.updateById(task);
    }

    @Override
    public List<AiAgentTask> listTasks(Long runId) {
        return taskMapper.selectList(new LambdaQueryWrapper<AiAgentTask>()
                .eq(AiAgentTask::getRunId, runId)
                .orderByAsc(AiAgentTask::getPriority)
                .orderByAsc(AiAgentTask::getId));
    }

    @Override
    public List<Map<String, Object>> listTaskRows(Long runId) {
        return listTasks(runId).stream().map(this::taskRow).toList();
    }

    @Override
    public AiAgentTask start(AiAgentTask task) {
        return startTask(task);
    }

    @Override
    public void complete(AiAgentTask task, String publicSummary) {
        completeTask(task, Map.of(), publicSummary);
    }

    @Override
    public void fail(AiAgentTask task, Exception error) {
        errorTask(task, error);
    }

    private Map<String, Object> taskRow(AiAgentTask task) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", task.getId());
        row.put("runId", task.getRunId());
        row.put("parentTaskId", task.getParentTaskId());
        row.put("agentType", task.getAgentType());
        row.put("taskType", task.getTaskType());
        row.put("status", task.getStatus());
        row.put("priority", task.getPriority());
        row.put("parallelGroupId", task.getParallelGroupId());
        row.put("dependsOn", parse(task.getDependsOnJson(), List.class, List.of()));
        row.put("publicSummary", task.getPublicSummary());
        row.put("errorMessage", task.getErrorMessage());
        row.put("startedAt", task.getStartedAt());
        row.put("completedAt", task.getCompletedAt());
        row.put("createdAt", task.getCreatedAt());
        return row;
    }

    @SuppressWarnings("unchecked")
    private <T> T parse(String json, Class<T> type, T fallback) {
        if (json == null || json.isBlank()) {
            return fallback;
        }
        try {
            return objectMapper.readValue(json, type);
        } catch (Exception e) {
            return fallback;
        }
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            return "{}";
        }
    }

    private String limit(String value, int max) {
        String text = value == null ? "" : value;
        return text.length() <= max ? text : text.substring(0, max);
    }
}
