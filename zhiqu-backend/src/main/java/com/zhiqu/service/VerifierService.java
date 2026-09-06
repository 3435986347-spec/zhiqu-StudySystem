package com.zhiqu.service;

import com.zhiqu.entity.AiVerifierFinding;

import java.util.List;

public interface VerifierService {
    List<AiVerifierFinding> verifyRun(Long runId);

    boolean shouldBlockFinalWrite(List<AiVerifierFinding> findings);
}
