package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 页面上常驻的新建表单，建好要清空（第十四轮）。
 *
 * <p>「同一个写请求没回来前不重发」（{@code request()}，判据在 request-check.js）挡的是并发的那几下；
 * 请求回来之后多点的那一下是新的一次 —— 弹窗一建就关了，点不到；常驻的表单不清空的话，
 * 同一个标题 / 同一批勾选就再建一份。真浏览器里双击后又补了一下，例行计划建出两个同名的，就是这么来的。
 */
class InlineFormResetTest {

    private static String functionBody(String code, String name) {
        Matcher m = Pattern.compile("async function " + Pattern.quote(name) + "\\(\\)\\s*\\{").matcher(code);
        assertTrue(m.find(), "找不到 " + name + " —— 改名了？");
        int start = m.end();
        int end = code.indexOf("\n  async function ", start);
        int endSync = code.indexOf("\n  function ", start);
        if (end < 0 || (endSync >= 0 && endSync < end)) end = endSync;
        return code.substring(start, end < 0 ? code.length() : end);
    }

    private static String api() throws Exception {
        return SourceText.stripComments(Files.readString(Path.of("src/main/resources/static/assets/zhiqu-api.js")));
    }

    @Test
    @DisplayName("新建例行计划：建好之后清空标题和说明（在提交之后，不是之前）")
    void 新建例行计划建好清空() throws Exception {
        String body = functionBody(api(), "createRoutineFromForm");
        int post = body.indexOf("api.post('/routine'");
        assertTrue(post >= 0, "表单不再用 api.post('/routine') 提交了？这条判据要跟着改");
        String after = body.substring(post);
        assertTrue(after.contains("$('input[placeholder*=\"英语单词\"]', section).value = ''"), "建好之后标题没清空：回来之后多点一下就再建一个同名的");
        assertTrue(after.contains("$('textarea', section).value = ''"), "建好之后说明没清空");
    }

    @Test
    @DisplayName("从任务生成例行计划：生成完把勾去掉")
    void 从任务生成完去勾() throws Exception {
        String body = functionBody(api(), "generateRoutinesFromTasks");
        int post = body.indexOf("api.post('/routine'");
        assertTrue(post >= 0, "不再用 api.post('/routine') 生成了？这条判据要跟着改");
        assertTrue(body.substring(post).contains("c.checked = false"), "生成完勾还在：回来之后再点一下就把同一批任务又生成一遍");
    }
}
