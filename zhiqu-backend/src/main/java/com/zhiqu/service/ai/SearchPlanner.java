package com.zhiqu.service.ai;

import com.zhiqu.entity.AiMessage;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class SearchPlanner {
    public String buildQuery(String question, List<AiMessage> recentMessages) {
        StringBuilder builder = new StringBuilder();
        if (recentMessages != null) {
            recentMessages.stream()
                    .filter(item -> "user".equalsIgnoreCase(item.getRole()))
                    .skip(Math.max(0, recentMessages.size() - 4))
                    .map(AiMessage::getContent)
                    .filter(text -> text != null && !text.isBlank())
                    .forEach(text -> builder.append(text, 0, Math.min(text.length(), 120)).append(' '));
        }
        if (question != null) {
            builder.append(question);
        }
        String query = builder.toString()
                .replaceAll("https?://\\S+", " ")
                .replaceAll("\\s+", " ")
                .trim();
        return query.length() <= 220 ? query : query.substring(query.length() - 220);
    }
}
