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
        assertTrue(between(code, "function redirectToLogin()", "\n  }").contains("'index.html?login=1&next=' + encodeURIComponent(page + location.search)"),
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
        String code = api();
        String send = between(code, "async function sendAiMessage()", "\n  async function ");
        int clearAt = send.indexOf("drafts.clearIf(draftKeyAtSend, txt)");
        assertTrue(clearAt > 0 && send.lastIndexOf("data.userMessageId", clearAt) > 0, "删草稿要等事件里带 userMessageId（服务器存上了）");
        assertTrue(send.indexOf("drafts.clear") == clearAt, "发送里还有别处在删草稿 —— 一按发送就删，没存上的那句就没了");
        assertTrue(send.contains("if (!stored && (failed || !gotEvent) && sameNb() && inp && !inp.value.trim())") && send.contains("inp.value = txt;"),
                "服务器没收到时要把字放回输入框");
        assertTrue(code.contains("state.chatDraft = keepDraft(draft, chatDraftKey, growDraft);"), "聊天框没接草稿");
        assertTrue(between(code, "function renderNotebooks()", "\n  }").contains("state.chatDraft.reload()"), "换 Notebook 时没换草稿");
    }

    @Test
    @DisplayName("Wiki：存上了才删草稿、按开始改时的版本保存、取消才丢；换页之前先存草稿")
    void Wiki接线() throws Exception {
        String code = api();
        String save = between(code, "async function saveWikiEdit()", "\n  }\n");
        int put = save.indexOf("await api.put('/knowledge/pages/'");
        int clear = save.indexOf("drafts.clear(wikiDraftKey(p))");
        assertTrue(put > 0 && clear > put, "草稿要在保存成功之后才删（被乐观锁挡住时还得在）");
        assertTrue(save.contains("version: baseVersion") && save.contains("var baseVersion = p._draftBase != null ? p._draftBase : p.version;"),
                "恢复的草稿要按它开始改时的版本保存 —— 否则一份旧草稿能盖掉这之后别人的修改");
        int ask = save.indexOf("askConfirm(");
        assertTrue(ask >= 0 && ask < save.indexOf("safe('保存知识页'") && save.contains("if (!replace) return;")
                        && save.contains("if (p._draftBase != null && p.version != null && Number(p._draftBase) !== Number(p.version))"),
                "旧版本上的草稿遇到这一页已被改过：保存前要先问（否则要么悄悄盖掉别人的、要么永远存不进去）");
        String paint = between(code, "async function paintWikiDoc(p, opts)", "state.wikiCur = p;");
        assertTrue(paint.contains("if (state.wikiDirty) saveWikiDraftNow();"), "换页之前没先把正在改的存成草稿");
        assertTrue(between(code, "$('#zq-wiki-cancel').onclick", "};").contains("drafts.clear(wikiDraftKey(cur))"), "取消编辑要丢掉草稿");
        assertTrue(code.contains("wireWikiDrafts(doc);"), "编辑区没接草稿");
    }
}
