package com.zhiqu.service.ai;

import com.zhiqu.common.BusinessException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

public final class DecisionPort {

    public static final String OTHER_OPTION = "__other__";
    private final Map<String, Batch> batches = new LinkedHashMap<>();
    private boolean closed;

    public synchronized List<Map<String, Object>> offer(String decisionId, List<Map<String, Object>> raw,
                                                         Consumer<Map<String, Object>> responder) {
        if (closed) {
            throw new BusinessException("这一轮已经结束，不能再提问");
        }
        if (decisionId == null || decisionId.isBlank() || decisionId.length() > 64) {
            throw new BusinessException("决策编号不合法");
        }
        if (batches.containsKey(decisionId)) {
            throw new BusinessException("决策编号重复");
        }
        if (batches.values().stream().anyMatch(batch -> !batch.done)) {
            throw new BusinessException("上一批问题还没有回答");
        }
        List<Map<String, Object>> questions = questions(raw);
        batches.put(decisionId, new Batch(questions, responder));
        return questions;
    }

    public Result answer(String decisionId, Map<String, Object> body) {
        Batch batch;
        synchronized (this) {
            if (closed) {
                return Result.rejected(decisionId, "这一轮已经结束", false);
            }
            batch = batches.get(decisionId);
            if (batch == null) {
                return Result.rejected(decisionId, "这批问题不存在或已经结束", false);
            }
        }
        boolean cancelled = body != null && Boolean.TRUE.equals(body.get("cancelled"));
        List<Map<String, Object>> answers;
        try {
            answers = cancelled ? cancelledAnswers(body) : answers(batch.questions, body == null ? null : body.get("answers"));
        } catch (BusinessException e) {
            synchronized (this) {
                if (batch.done) {
                    return Result.rejected(decisionId, "这批问题已经提交过，第一次提交有效", true);
                }
            }
            throw e;
        }
        synchronized (this) {
            if (batch.done) {
                boolean same = batch.cancelled == cancelled && batch.answers.equals(answers);
                return same ? Result.duplicate(decisionId, batch.cancelled, batch.answers)
                        : Result.rejected(decisionId, "这批问题已经提交过，第一次提交有效", true);
            }
            if (closed) {
                return Result.rejected(decisionId, "这一轮已经结束", false);
            }
            batch.done = true;
            batch.cancelled = cancelled;
            batch.answers = answers;
            return Result.resolved(decisionId, cancelled, answers, batch.responder);
        }
    }

    public void close() {
        List<Result> pending;
        synchronized (this) {
            if (closed) {
                return;
            }
            closed = true;
            pending = new ArrayList<>();
            for (Map.Entry<String, Batch> entry : batches.entrySet()) {
                Batch batch = entry.getValue();
                if (!batch.done) {
                    batch.done = true;
                    batch.cancelled = true;
                    batch.answers = List.of();
                    pending.add(Result.resolved(entry.getKey(), true, List.of(), batch.responder));
                }
            }
        }
        for (Result result : pending) {
            result.deliver();
        }
    }

    private static List<Map<String, Object>> questions(List<Map<String, Object>> raw) {
        if (raw == null || raw.size() < 1 || raw.size() > 4) {
            throw new BusinessException("一次只能提出 1–4 个问题");
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (int qi = 0; qi < raw.size(); qi++) {
            Map<String, Object> source = raw.get(qi);
            if (source == null) {
                throw new BusinessException("问题不能为空");
            }
            String id = text(source.get("id"), 64, "问题编号", false);
            if (!id.equals("q" + (qi + 1))) {
                throw new BusinessException("问题编号不连续");
            }
            Map<String, Object> question = new LinkedHashMap<>();
            question.put("id", id);
            question.put("header", text(source.get("header"), 40, "问题分类", true));
            question.put("question", text(source.get("question"), 1000, "问题内容", false));
            question.put("allowOther", bool(source.get("allowOther"), true, "allowOther"));
            Object optionsValue = source.get("options");
            if (!(optionsValue instanceof List<?> options) || options.size() < 2 || options.size() > 6) {
                throw new BusinessException("每个问题要有 2–6 个方案");
            }
            List<Map<String, Object>> normalizedOptions = new ArrayList<>();
            int recommended = 0;
            for (int oi = 0; oi < options.size(); oi++) {
                if (!(options.get(oi) instanceof Map<?, ?> option)) {
                    throw new BusinessException("方案必须是对象");
                }
                String optionId = text(option.get("id"), 64, "方案编号", false);
                if (!optionId.equals("o" + (oi + 1))) {
                    throw new BusinessException("方案编号不连续");
                }
                boolean marked = bool(option.get("recommended"), false, "recommended");
                if (marked) {
                    recommended++;
                }
                Map<String, Object> normalized = new LinkedHashMap<>();
                normalized.put("id", optionId);
                normalized.put("label", text(option.get("label"), 120, "方案名", false));
                normalized.put("description", text(option.get("description"), 500, "方案说明", true));
                normalized.put("recommended", marked);
                normalizedOptions.add(normalized);
            }
            if (recommended > 1) {
                throw new BusinessException("每题最多一个推荐方案");
            }
            question.put("options", normalizedOptions);
            out.add(question);
        }
        return out;
    }

    private static List<Map<String, Object>> answers(List<Map<String, Object>> questions, Object raw) {
        if (!(raw instanceof List<?> values) || values.size() != questions.size()) {
            throw new BusinessException("要回答全部问题，不能多答或漏答");
        }
        Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
        for (Object value : values) {
            if (!(value instanceof Map<?, ?> answer)) {
                throw new BusinessException("答案必须是对象");
            }
            String questionId = text(answer.get("questionId"), 64, "questionId", false);
            Map<String, Object> copy = new LinkedHashMap<>();
            answer.forEach((key, item) -> copy.put(String.valueOf(key), item));
            if (byId.put(questionId, copy) != null) {
                throw new BusinessException("同一个问题不能重复回答");
            }
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> question : questions) {
            String questionId = String.valueOf(question.get("id"));
            Map<String, Object> answer = byId.get(questionId);
            if (answer == null) {
                throw new BusinessException("还没有回答问题 " + questionId);
            }
            String optionId = text(answer.get("optionId"), 64, "optionId", false);
            Map<String, Object> normalized = new LinkedHashMap<>();
            normalized.put("questionId", questionId);
            normalized.put("optionId", optionId);
            if (OTHER_OPTION.equals(optionId)) {
                if (!Boolean.TRUE.equals(question.get("allowOther"))) {
                    throw new BusinessException("这个问题不允许其他输入");
                }
                normalized.put("otherText", text(answer.get("otherText"), 2000, "其他输入", false));
            } else {
                @SuppressWarnings("unchecked") List<Map<String, Object>> options = (List<Map<String, Object>>) question.get("options");
                boolean exists = options.stream().anyMatch(option -> optionId.equals(option.get("id")));
                if (!exists) {
                    throw new BusinessException("答案里有不存在的方案");
                }
                if (answer.get("otherText") != null && !String.valueOf(answer.get("otherText")).isBlank()) {
                    throw new BusinessException("选择已有方案时不能同时带其他输入");
                }
            }
            out.add(normalized);
        }
        if (byId.size() != questions.size()) {
            throw new BusinessException("答案里有不认识的问题");
        }
        return out;
    }

    private static List<Map<String, Object>> cancelledAnswers(Map<String, Object> body) {
        Object answers = body == null ? null : body.get("answers");
        if (answers instanceof List<?> list && !list.isEmpty()) {
            throw new BusinessException("取消时不能同时提交答案");
        }
        return List.of();
    }

    private static String text(Object value, int max, String name, boolean optional) {
        if (value == null && optional) {
            return "";
        }
        if (!(value instanceof String text)) {
            throw new BusinessException(name + "必须是文字");
        }
        String trimmed = text.trim();
        if (trimmed.isEmpty() && !optional) {
            throw new BusinessException(name + "不能为空");
        }
        if (text.length() > max) {
            throw new BusinessException(name + "最多 " + max + " 字");
        }
        return trimmed;
    }

    private static boolean bool(Object value, boolean fallback, String name) {
        if (value == null) {
            return fallback;
        }
        if (!(value instanceof Boolean bool)) {
            throw new BusinessException(name + "必须是布尔值");
        }
        return bool;
    }

    private static final class Batch {
        private final List<Map<String, Object>> questions;
        private final Consumer<Map<String, Object>> responder;
        private boolean done;
        private boolean cancelled;
        private List<Map<String, Object>> answers = List.of();

        private Batch(List<Map<String, Object>> questions, Consumer<Map<String, Object>> responder) {
            this.questions = questions;
            this.responder = responder;
        }
    }

    public static final class Result {
        private final String decisionId;
        private final boolean accepted;
        private final boolean resolved;
        private final boolean duplicate;
        private final boolean cancelled;
        private final List<Map<String, Object>> answers;
        private final String error;
        private final Consumer<Map<String, Object>> responder;

        private Result(String decisionId, boolean accepted, boolean resolved, boolean duplicate, boolean cancelled,
                       List<Map<String, Object>> answers, String error, Consumer<Map<String, Object>> responder) {
            this.decisionId = decisionId;
            this.accepted = accepted;
            this.resolved = resolved;
            this.duplicate = duplicate;
            this.cancelled = cancelled;
            this.answers = answers;
            this.error = error;
            this.responder = responder;
        }

        private static Result resolved(String id, boolean cancelled, List<Map<String, Object>> answers,
                                       Consumer<Map<String, Object>> responder) {
            return new Result(id, true, true, false, cancelled, answers, null, responder);
        }

        private static Result duplicate(String id, boolean cancelled, List<Map<String, Object>> answers) {
            return new Result(id, true, false, true, cancelled, answers, null, null);
        }

        private static Result rejected(String id, String error, boolean duplicate) {
            return new Result(id, false, false, duplicate, false, List.of(), error, null);
        }

        public boolean resolved() {
            return resolved;
        }

        public Map<String, Object> event() {
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("decisionId", decisionId);
            event.put("cancelled", cancelled);
            event.put("answers", answers);
            return event;
        }

        public Map<String, Object> payload() {
            Map<String, Object> payload = new LinkedHashMap<>(event());
            payload.put("accepted", accepted);
            payload.put("duplicate", duplicate);
            if (error != null) {
                payload.put("error", error);
            }
            return payload;
        }

        public void deliver() {
            if (responder == null) {
                return;
            }
            Map<String, Object> message = new LinkedHashMap<>(event());
            message.put("type", "question_result");
            message.put("id", decisionId);
            try {
                responder.accept(message);
            } catch (RuntimeException ignored) {
            }
        }
    }
}
