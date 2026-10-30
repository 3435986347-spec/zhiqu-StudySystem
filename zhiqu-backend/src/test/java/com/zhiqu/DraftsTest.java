package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 打了一半的字：刷新、关页、登录过期、断网之后还在（第十五轮）。
 * 行为判据跑在 node 上、直接加载发布的实现（drafts-check.js）；这里另外钉住各处接线 —— 机制写好了没人接，等于没有。
 */
class DraftsTest {

    private static String api() throws Exception {
        return SourceText.stripComments(Files.readString(Path.of("src/main/resources/static/assets/zhiqu-api.js")));
    }

    private static String between(String code, String from, String to) {
        int a = code.indexOf(from);
        assertTrue(a >= 0, "找不到「" + from + "」—— 改名了？这条判据要跟着改");
        int b = code.indexOf(to, a + from.length());
        return code.substring(a, b < 0 ? code.length() : b);
    }

    @Test
    @DisplayName("草稿存取、按用户分开、存不下不报错、换 Notebook、登录后只回本站的页")
    void 草稿() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/drafts-check.js"), NodeRunner.API_JS);
    }

    @Test
    @DisplayName("登录过期带上原来那一页，登录之后经 safeNext 回去；主动退出删掉这个人的草稿")
    void 登录接线() throws Exception {
        String code = api();
        assertTrue(between(code, "function redirectToLogin()", "\n  }").contains("'index.html?login=1&next=' + encodeURIComponent(page + location.search"),
                "跳去登录时没带上原来那一页");
        assertTrue(between(code, "var data = await api.post('/auth/login'", "if (reg)").contains("location.href = safeNext("), "登录之后没回原来那一页");
        assertTrue(between(code, "function bootIndex()", "\n  }").contains("location.href = safeNext("), "已经登录着打开登录页时没回原来那一页");
        String logout = between(code, "safe('退出'", "location.href");
        assertTrue(logout.indexOf("drafts.clearUser()") >= 0 && logout.indexOf("drafts.clearUser()") < logout.indexOf("clearAuth()"),
                "主动退出要在 clearAuth 之前删草稿（之后就不知道是谁了）");
    }

    @Test
    @DisplayName("聊天：服务器确认收到（带 userMessageId）才删草稿；没收到把字放回输入框；换 Notebook 换草稿")
    void 聊天接线() throws Exception {
        String code = SourceText.pageModule("ai-assistant.js");   // 第三十七轮起 AI 助手是模块
        String send = SourceText.functionBody(code, "async function sendAiMessage()");
        int clearAt = send.indexOf("drafts.clearIf(draftKeyAtSend, txt)");
        assertTrue(clearAt > 0 && send.lastIndexOf("data.userMessageId", clearAt) > 0, "删草稿要等事件里带 userMessageId（服务器存上了）");
        assertTrue(send.indexOf("drafts.clear") == clearAt, "发送里还有别处在删草稿 —— 一按发送就删，没存上的那句就没了");
        assertTrue(send.contains("if (!stored && (failed || !gotEvent) && sameNb() && inp && !inp.value.trim())") && send.contains("inp.value = txt;"),
                "服务器没收到时要把字放回输入框");
        assertTrue(code.contains("state.chatDraft = keepDraft(draft, chatDraftKey, growDraft);"), "聊天框没接草稿");
        assertTrue(SourceText.functionBody(code, "function renderNotebooks()").contains("state.chatDraft.reload()"), "换 Notebook 时没换草稿");
    }

    @Test
    @DisplayName("Wiki：存上了才删草稿、按开始改时的版本保存、取消才丢；换页之前先存草稿")
    void Wiki接线() throws Exception {
        // 第三十六轮起知识 Wiki 是模块（pages/knowledge-wiki.js）
        String code = SourceText.pageModule("knowledge-wiki.js");
        // 第八十三轮起是自动保存（saveWikiContent），没有「保存 / 取消」按钮了；草稿的几条性质照旧钉着
        String save = SourceText.functionBody(code, "function saveWikiContent(p, md)");
        int put = save.indexOf("api.put('/knowledge/pages/'");
        int settle = save.indexOf("settleWikiSaved(p, md, base)");
        assertTrue(put > 0 && settle > put, "草稿要在保存成功之后才删（被乐观锁挡住时还得在）");
        assertTrue(SourceText.functionBody(code, "function settleWikiSaved(p, md, base)").contains("drafts.clearIf(wikiDraftKey(p), md)"), "存上了没删草稿（只删和存上的一样的那份）");
        assertTrue(save.contains("version: base") && save.contains("var base = p._draftBase != null ? p._draftBase : p.version"),
                "恢复的草稿要按它开始改时的版本保存 —— 否则一份旧草稿能盖掉这之后别人的修改");
        String offer = SourceText.functionBody(code, "function offerWikiDraft(p)");
        assertTrue(offer.contains("if (moved) p._saveConflict = true;"), "旧版本上的草稿恢复回来、这一页已被改过：不能自动存（要么悄悄盖掉别人的、要么永远存不进去），先停下让人选");
        String mine = SourceText.functionBody(code, "async function resolveWikiConflictMine(p)");
        int ask = mine.indexOf("askConfirm(");
        assertTrue(ask >= 0 && ask < mine.indexOf("api.get(") && mine.contains("if (!ok || state.wikiCur !== p) return;"), "「用我的覆盖」要先问，问完人走了就不存");
        String paint = between(code, "async function paintWikiDoc(p, opts)", "state.wikiCur = p;");
        assertTrue(paint.contains("if (state.wikiDirty) { saveWikiDraftNow(); flushWikiSave(); }"), "换页之前没先把正在改的存成草稿、存上服务器");
        assertTrue(code.contains("wireWikiDrafts(doc);"), "编辑区没接草稿");
    }
}
