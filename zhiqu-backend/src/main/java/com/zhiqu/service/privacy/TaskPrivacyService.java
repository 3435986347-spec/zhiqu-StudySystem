package com.zhiqu.service.privacy;

import com.zhiqu.entity.StudyTask;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Objects;

@Service
public class TaskPrivacyService {
    private static final String PLACEHOLDER_TITLE = "[encrypted]";

    private final SensitiveCryptoService cryptoService;

    public TaskPrivacyService(SensitiveCryptoService cryptoService) {
        this.cryptoService = cryptoService;
    }

    public void protectForWrite(StudyTask task) {
        if (task == null) {
            return;
        }
        if (task.getTitle() != null && !Objects.equals(task.getTitle(), PLACEHOLDER_TITLE)) {
            task.setEncryptedTitle(cryptoService.encrypt(task.getTitle()));
            task.setTitle(PLACEHOLDER_TITLE);
            task.setEncryptionVersion("v1");
        }
        if (task.getDescription() != null) {
            if (task.getDescription().isBlank()) {
                task.setEncryptedDescription(null);
            } else {
                task.setEncryptedDescription(cryptoService.encrypt(task.getDescription()));
                task.setEncryptionVersion("v1");
            }
            task.setDescription(null);
        }
    }

    public StudyTask reveal(StudyTask task) {
        if (task == null) {
            return null;
        }
        if (task.getEncryptedTitle() != null && !task.getEncryptedTitle().isBlank()) {
            task.setTitle(cryptoService.decrypt(task.getEncryptedTitle()));
        }
        if (task.getEncryptedDescription() != null && !task.getEncryptedDescription().isBlank()) {
            task.setDescription(cryptoService.decrypt(task.getEncryptedDescription()));
        }
        return task;
    }

    public List<StudyTask> revealAll(List<StudyTask> tasks) {
        if (tasks != null) {
            tasks.forEach(this::reveal);
        }
        return tasks;
    }
}
