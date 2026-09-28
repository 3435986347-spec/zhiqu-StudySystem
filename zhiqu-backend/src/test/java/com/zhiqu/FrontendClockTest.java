package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 页面的「今天」是业务日期（第二十一轮）。
 *
 * <p>原来 {@code today()} 是浏览器所在时区的日历日，又被当成数据发给服务端 —— 打卡的 checkDate、番茄钟记到哪天、新建例行计划的开始日期。
 * 真浏览器实测：UTC+14 的浏览器给今天列表里「周一三五」的例行计划打卡，发的是周二，服务器拒了、页面一声不吭；比东八区晚的浏览器
 * 过了北京时间零点，打卡成功地记到了昨天。行为判据在 node 上跑发布的那段业务时钟（{@code clock-check.js}）：六个时区、本机时钟快一年 /
 * 慢一天、零点那一秒、周日深夜、跨年、闰日、夏令时。
 */
class FrontendClockTest {

    private static final Path HARNESS = Path.of("src/test/resources/js/clock-check.js");

    @Test
    @DisplayName("业务时钟：六个时区、本机时钟不准、零点、周界、跨年、闰日、夏令时 —— 今天 / 这一周 / 服务端时间都按业务时区")
    void 业务时钟行为判据必须全绿() throws Exception {
        NodeRunner.run(HARNESS, NodeRunner.API_JS);
    }

    /** 时钟算对了还不够：它得真的被用上 —— 每页启动时拿服务端给的，发给服务端的日期不再由浏览器自己算。 */
    @Test
    @DisplayName("接线：/auth/info 回来就校时；看板的打卡用那一行的日期；番茄钟、例行计划页的打卡不带日期（服务端定）")
    void 接线() throws Exception {
        String js = SourceText.stripComments(Files.readString(NodeRunner.API_JS, StandardCharsets.UTF_8));
        assertTrue(js.contains("state.user = await api.get('/auth/info');\n    applyServerClock(state.user && state.user.clock, sentAt, Date.now());"),
                "initAuth 拿到 /auth/info 之后没有 applyServerClock —— 业务时钟一直是默认值、本机的钟");
        assertTrue(js.contains("checkDate: btn.getAttribute('data-date') || today()"), "看板的打卡没有用那一行（服务端给的）日期");
        assertTrue(js.contains("renderToday(todayRow ? todayRow.items || [] : [], todayRow ? todayRow.date : null);"), "renderToday 没拿到那一行的日期");
        assertTrue(js.contains("headerDate.textContent = (todayRow ? todayRow.date + ' · ' + todayRow.weekday : today())"),
                "看板标题的日期不是服务端那一行的（原来是浏览器的日期拼服务端的星期）");
        assertFalse(js.contains("'/checkin', { checkDate: today()"), "还有地方拿浏览器算的 today() 去打卡");
        String dashboard = Files.readString(Path.of("src/main/resources/static/dashboard.html"), StandardCharsets.UTF_8);
        String record = dashboard.substring(dashboard.indexOf("function zqPomoRecord("), dashboard.indexOf("elMin.addEventListener"));
        assertFalse(record.contains("studyDate"), "番茄钟又自己算日期了 —— 浏览器的钟在一次专注里走快了，算出来的「明天」会被拒、记录就丢了");
        assertTrue(record.contains(".catch(function(e){ window.zqApi.toast("), "番茄钟没记上时要说出来（原来 catch 了什么都不说）");
        assertTrue(dashboard.contains("endAt=lastNow+secs*1000") && dashboard.contains("secs=Math.max(0,Math.ceil((endAt-now)/1000))"),
                "番茄钟又变回「每跳一次减一秒」了 —— 后台标签页、合上笔记本时会停");
    }
}
