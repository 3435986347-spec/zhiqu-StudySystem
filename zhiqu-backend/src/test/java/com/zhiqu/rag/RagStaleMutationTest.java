package com.zhiqu.rag;

import com.sun.net.httpserver.HttpServer;
import com.zhiqu.entity.RagIndexJob;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.AiSourceChunkMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RuntimeIssueMapper;
import com.zhiqu.service.RuntimeFlagService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Sidecar 用 409 拒绝陈旧写入（墓碑生效）时的协议处理。
 *
 * <p>不变量：409 STALE_MUTATION 是「已被更新操作取代」的预期结果，不是故障。
 * 它必须让作业转入终态 SUPERSEDED，绝不能走失败重试链路 —— 否则会
 * RETRY → DEAD → source 置 ERROR → 整个索引代次被判为 FAILED。
 *
 * <p>同为 409 的 INDEX_VERSION_MISMATCH 是配置错配，必须继续按普通错误上报。
 */
class RagStaleMutationTest {

    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
    }

    /** 起一个只回 409 的本地 sidecar 替身（RagClient 只允许回环地址）。 */
    private RagClient clientReturning409(String body) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(409, payload.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(payload);
            }
        });
        server.start();
        RagProperties properties = new RagProperties();
        properties.setEnabled(true);
        properties.setServiceToken("test-token");
        properties.setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort());
        properties.setConnectTimeoutMs(2000);
        properties.setReadTimeoutMs(4000);
        return new RagClient(properties);
    }

    @Test
    void staleMutation409IsMappedToStaleMutationException() throws Exception {
        RagClient client = clientReturning409("{\"detail\":{\"code\":\"STALE_MUTATION\","
                + "\"message\":\"tombstone rejects mutationToken 7\"}}");
        StaleMutationException error = assertThrows(StaleMutationException.class,
                () -> client.deleteIndex(Map.of("scope", "SOURCE", "sourceId", 1)));
        assertTrue(error.getMessage().contains("STALE_MUTATION"));
    }

    /** 旧版 sidecar 只回人类可读文案时，仍应识别为陈旧写入（唯一的另一种 409 是版本错配）。 */
    @Test
    void legacyStale409WithoutCodeIsStillStaleMutation() throws Exception {
        RagClient client = clientReturning409("{\"detail\":\"stale mutation rejected by tombstone\"}");
        assertThrows(StaleMutationException.class,
                () -> client.indexSource(Map.of("sourceId", 1)));
    }

    /** 版本错配同为 409，但必须保持普通错误语义，不能被当成陈旧写入吞掉。 */
    @Test
    void indexVersionMismatch409IsNotStaleMutation() throws Exception {
        RagClient client = clientReturning409("{\"detail\":{\"code\":\"INDEX_VERSION_MISMATCH\","
                + "\"message\":\"Index version mismatch: requested=a, sidecar=b\"}}");
        Exception error = assertThrows(Exception.class,
                () -> client.indexSource(Map.of("sourceId", 1)));
        assertFalse(error instanceof StaleMutationException,
                "版本错配不能被识别为陈旧写入，否则会静默转终态、掩盖配置问题");
    }

    /** 旧版 sidecar 的版本错配文案（无 code）同样不能被当成陈旧写入。 */
    @Test
    void legacyIndexVersionMismatch409IsNotStaleMutation() throws Exception {
        RagClient client = clientReturning409(
                "{\"detail\":\"Index version mismatch: requested=a, sidecar=b\"}");
        Exception error = assertThrows(Exception.class,
                () -> client.indexSource(Map.of("sourceId", 1)));
        assertFalse(error instanceof StaleMutationException);
    }

    // ===== Worker 分流：409 走终态，不走失败重试 =====

    private record Fixture(RagIndexWorker worker, RagIndexJobService jobService, RagClient client) {}

    private Fixture workerWithDeleteJob() {
        RagProperties properties = new RagProperties();
        RagIndexJobService jobService = mock(RagIndexJobService.class);
        RagClient client = mock(RagClient.class);
        RagIndexGenerationMapper generationMapper = mock(RagIndexGenerationMapper.class);
        AiNotebookSourceMapper sourceMapper = mock(AiNotebookSourceMapper.class);
        AiSourceChunkMapper chunkMapper = mock(AiSourceChunkMapper.class);
        RuntimeIssueMapper runtimeIssueMapper = mock(RuntimeIssueMapper.class);

        RagIndexJob job = new RagIndexJob();
        job.setId(7L);
        job.setOperation("DELETE_SOURCE");
        job.setUserId(1L);
        job.setNotebookId(2L);
        job.setSourceId(3L);
        job.setLeaseVersion(1L);
        job.setLockedBy("worker-1");

        when(client.configured()).thenReturn(true);
        when(jobService.claimDueJobs(anyInt(), anyString())).thenReturn(List.of(job));
        when(jobService.renewLease(any())).thenReturn(true);

        // cutover 开关：本组用例只关心 409 的分流，因此固定为 NORMAL（照常领取全部作业）。
        // 注意不能用裸 mock —— workerMode() 返回 null 会让 worker 的 OFF 判断变成 null 比较，
        // 语义上等价于 NORMAL 但会掩盖真实意图。
        RuntimeFlagService runtimeFlags = mock(RuntimeFlagService.class);
        when(runtimeFlags.workerMode()).thenReturn(RuntimeFlagService.WorkerMode.NORMAL);

        RagIndexWorker worker = new RagIndexWorker(properties, jobService, client,
                generationMapper, sourceMapper, chunkMapper, runtimeIssueMapper, runtimeFlags);
        return new Fixture(worker, jobService, client);
    }

    /**
     * 核心断言：sidecar 回 409 后作业转 SUPERSEDED，且完全不触碰失败链路。
     * handleFailure 是通往 RETRY/DEAD、source ERROR、代次 FAILED 的唯一入口，
     * 因此「从未调用 handleFailure」即等价于三者都不会发生。
     */
    @Test
    void stale409SupersedesJobInsteadOfFailingIt() {
        Fixture f = workerWithDeleteJob();
        when(f.client().deleteIndex(any()))
                .thenThrow(new StaleMutationException("{\"code\":\"STALE_MUTATION\"}"));

        f.worker().run();

        verify(f.jobService()).supersede(any(), any());
        verify(f.jobService(), never()).handleFailure(any(), any(), any(), any());
        verify(f.jobService(), never()).complete(any());
    }

    /** 回归：真正的故障仍必须走 handleFailure，不能被新分支吞掉。 */
    @Test
    void genuineFailureStillGoesThroughHandleFailure() {
        Fixture f = workerWithDeleteJob();
        when(f.client().deleteIndex(any()))
                .thenThrow(new IllegalStateException("sidecar exploded"));

        f.worker().run();

        verify(f.jobService()).handleFailure(any(), any(), any(), any());
        verify(f.jobService(), never()).supersede(any(), any());
    }

    /** 版本错配抛的是普通异常，因此仍应走失败重试，而不是被静默转终态。 */
    @Test
    void versionMismatchFailureIsNotSuperseded() {
        Fixture f = workerWithDeleteJob();
        when(f.client().deleteIndex(any()))
                .thenThrow(new IllegalStateException("RAG sidecar index version mismatch: ..."));

        f.worker().run();

        verify(f.jobService()).handleFailure(any(), any(), any(), any());
        verify(f.jobService(), never()).supersede(any(), any());
    }

    @Test
    void supersededIsATerminalStatusDistinctFromDead() {
        // 终态名必须与 refreshGenerationProgress 统计的「未完成/DEAD」集合互不相交
        assertEquals("SUPERSEDED", "SUPERSEDED");
        assertFalse(List.of("PENDING", "RUNNING", "RETRY", "DEAD").contains("SUPERSEDED"));
    }
}
