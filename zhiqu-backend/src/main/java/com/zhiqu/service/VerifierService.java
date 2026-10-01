package com.zhiqu.service;

import com.zhiqu.entity.AiVerifierFinding;

import java.util.List;

public interface VerifierService {

    /**
     * 校验本轮<b>检索到的证据</b>（不是答案 —— 本服务跑在答案生成之前）。
     *
     * @param selectedSourcesWithoutEvidence 用户显式勾了资料源、本轮却一条证据都没取到。
     *        这是本服务<b>唯一</b>会产出 BLOCKER 的情形，调用方必须据实传入 ——
     *        它决定 {@link #shouldBlockFinalWrite} 能不能为真。
     */
    List<AiVerifierFinding> verifyRun(Long runId, boolean selectedSourcesWithoutEvidence);

    /**
     * 答案生成之后：核对模型带出来的引用是否出自本轮真实取到的证据。
     *
     * @param citationRows 模型/提供方在流式里回的引用行（含 {@code url}）
     * @param trustedUrls  本轮真实取到的来源 URL 集合
     */
    List<AiVerifierFinding> verifyAnswerCitations(Long runId, List<java.util.Map<String, Object>> citationRows,
                                                  java.util.Set<String> trustedUrls);

    boolean shouldBlockFinalWrite(List<AiVerifierFinding> findings);
}
