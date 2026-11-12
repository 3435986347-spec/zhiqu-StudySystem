package com.zhiqu.service.ai;

import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 桌面这一轮存回网站时的草稿（第一百三十一轮）。路径出得了项目文件夹的，不能进库。
 */
class DesktopTurnFilesTest {

    @Test
    @DisplayName("相对路径才收：..、绝对路径、反斜杠、空段都拒；正常的留下，基线空的记成 ABSENT")
    void 路径() {
        assertTrue(DesktopTurnFiles.relativePath("src/a.txt"));
        assertFalse(DesktopTurnFiles.relativePath("../etc/passwd"), ".. 出得去");
        assertFalse(DesktopTurnFiles.relativePath("foo/../../x"), "中间的 .. 出得去");
        assertFalse(DesktopTurnFiles.relativePath("/tmp/x"), "绝对路径");
        assertFalse(DesktopTurnFiles.relativePath("foo\\bar"), "反斜杠");
        assertFalse(DesktopTurnFiles.relativePath("foo//bar"), "空段");
        assertFalse(DesktopTurnFiles.relativePath(""), "空路径");

        DesktopTurnFiles.Parsed ok = DesktopTurnFiles.parse(Map.of(
                "message", "改一下",
                "conclusion", "好了",
                "folder", "/Users/me/proj",
                "drafts", List.of(Map.of("path", "src/a.txt", "content", "next\n"))));
        assertEquals("src/a.txt", ok.files().get(0).get("path"));
        assertEquals(DesktopTurnFiles.ABSENT, ok.files().get(0).get("baseline"));
        assertEquals(true, ok.files().get(0).get("creating"));

        assertThrows(BusinessException.class, () -> DesktopTurnFiles.parse(Map.of(
                "message", "改一下",
                "folder", "/Users/me/proj",
                "drafts", List.of(Map.of("path", "../secret", "content", "no")))));
    }
}
