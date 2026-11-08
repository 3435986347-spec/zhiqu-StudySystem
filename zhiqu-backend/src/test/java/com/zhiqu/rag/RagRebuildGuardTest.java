package com.zhiqu.rag;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RagIndexJobMapper;
import com.zhiqu.mapper.RagSourceIndexStateMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 第一百二十二轮：重建索引先看旁路、再看有没有一个已经在重建。
 * 旁路关着的那种情形在 {@code RagIndexIntegrationTest#rebuildRefusesWhenSidecarIsOff}（真库）；这里是旁路好着的两种。
 */
class RagRebuildGuardTest {

    private final RagClient client = mock(RagClient.class);
    private final RagIndexJobService jobService = mock(RagIndexJobService.class);
    private final RagIndexGenerationMapper generations = mock(RagIndexGenerationMapper.class);
    private final RagAdminService admin;

    RagRebuildGuardTest() {
        RagProperties properties = new RagProperties();
        admin = new RagAdminService(properties, client, mock(RagMetricsService.class), jobService, generations,
                mock(RagIndexJobMapper.class), mock(RagSourceIndexStateMapper.class), mock(AiNotebookSourceMapper.class),
                mock(UserKnowledgePageMapper.class));
    }

    private static RagIndexGeneration generation(long id, String status) {
        RagIndexGeneration g = new RagIndexGeneration();
        g.setId(id);
        g.setStatus(status);
        g.setExpectedSourceCount(5);
        g.setIndexedSourceCount(2);
        return g;
    }

    @Test
    @DisplayName("旁路好着、已经有一个在重建：说那一个的进度，不再叠一个")
    void 已经在重建就不叠() {
        when(client.meta()).thenReturn(Map.of("ready", true));
        when(generations.selectOne(any())).thenReturn(generation(7, "BUILDING"));
        BusinessException error = assertThrows(BusinessException.class, admin::rebuild);
        assertTrue(error.getMessage().contains("#7") && error.getMessage().contains("2 / 5"), error.getMessage());
        verify(jobService, never()).createGeneration(anyString());
    }

    @Test
    @DisplayName("旁路好着、没有在重建的：照常建；旁路连不上：说原因、不建")
    void 旁路好着才建() {
        when(client.meta()).thenReturn(Map.of("ready", true));
        when(generations.selectOne(any())).thenReturn(null);
        when(jobService.createGeneration(anyString())).thenReturn(generation(8, "BUILDING"));
        when(generations.selectById(8L)).thenReturn(generation(8, "BUILDING"));
        assertEquals(8L, admin.rebuild().get("id"));

        RagClient down = mock(RagClient.class);
        when(down.meta()).thenReturn(Map.of("ready", false, "reason", "Connection refused"));
        RagIndexJobService jobs = mock(RagIndexJobService.class);
        RagAdminService admin2 = new RagAdminService(new RagProperties(), down, mock(RagMetricsService.class), jobs, generations,
                mock(RagIndexJobMapper.class), mock(RagSourceIndexStateMapper.class), mock(AiNotebookSourceMapper.class),
                mock(UserKnowledgePageMapper.class));
        BusinessException error = assertThrows(BusinessException.class, admin2::rebuild);
        assertTrue(error.getMessage().contains("连不上") && error.getMessage().contains("Connection refused"), error.getMessage());
        verify(jobs, never()).createGeneration(anyString());
    }
}
