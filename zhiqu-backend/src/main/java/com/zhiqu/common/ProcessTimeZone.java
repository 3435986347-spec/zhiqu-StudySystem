package com.zhiqu.common;

import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.Environment;
import org.springframework.core.env.MapPropertySource;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.TimeZone;

/**
 * 把<b>进程的</b>默认时区钉成业务时区（第二十一轮）。
 *
 * <p>{@link BusinessClock} 把「今天是哪一天」收成了一处，但它的类注释里有一句「{@code created_at} 这类审计时间戳只要在同一个 JVM 内
 * 自洽即可」—— 这句话只在没人看这些时间的时候成立。它们是显示给用户看的：消息的时间、参考计划「审核于 …」、登录记录、反馈、打卡的完成时间，
 * 以及页面拿消息的 createdAt 算「已等 N 秒」。{@code LocalDateTime.now()} 用的是 JVM 默认时区，而 JVM 默认时区跟着机器走：
 * Windows 服务的配置里写了 {@code TZ=Asia/Shanghai}，Docker / Linux 服务器默认 UTC，桌面应用跟着那台 Mac。第二十轮在 UTC 的机器上实测：
 * 晚上 21:38 提交的参考计划，页面上写着「2026-09-28 13:38」。
 *
 * <p>所以启动时让 JVM 默认时区等于业务时区：审计时间戳、业务日期、页面解析服务端时间用的是同一个时区。
 * 挂在 {@link ApplicationEnvironmentPreparedEvent} 上 —— 这时配置文件（包括外部的 application-prod.yml）已经读进来、
 * 还没有任何 bean 和数据库连接；只在 {@code main} 里挂（测试不经过 main，不会互相改掉对方 JVM 的时区）。
 *
 * <p>数据库那一半：有几列是 MySQL 自己填的（{@code DEFAULT CURRENT_TIMESTAMP}、SQL 里的 {@code NOW()}）—— 参考计划的审核记录
 * 显示的就是这样一列，和旁边 Java 写的「审核于」差 8 小时（数据库在 UTC 时）。所以连接建立时把会话时区设成业务时区的偏移
 * （{@code SET time_zone = '+08:00'}；用偏移不用时区名 —— MySQL 没装时区表时不认名字，Docker 镜像默认就没装）。
 * 作为<b>最低优先级</b>的默认值放进去：部署自己配了 {@code spring.datasource.hikari.connection-init-sql} 就用部署的。
 * 有夏令时的业务时区只取启动那一刻的偏移（Asia/Shanghai 没有夏令时）。
 */
public class ProcessTimeZone implements ApplicationListener<ApplicationEnvironmentPreparedEvent> {

    static final String INIT_SQL_KEY = "spring.datasource.hikari.connection-init-sql";

    @Override
    public void onApplicationEvent(ApplicationEnvironmentPreparedEvent event) {
        ZoneId zone = apply(event.getEnvironment());
        defaultDatabaseSessionZone(event.getEnvironment(), zone);
    }

    /**
     * 数据库会话时区的默认值：放在最低优先级（addLast），部署自己配了就是部署的。只靠这一道 —— 原来前面还有一道「配了就不加」，
     * 两道互相替对方挡着，删掉哪一道判据都不红（扰动照出来的）。
     */
    public static void defaultDatabaseSessionZone(ConfigurableEnvironment env, ZoneId zone) {
        ZoneOffset offset = zone.getRules().getOffset(Instant.now());
        String id = offset.getTotalSeconds() == 0 ? "+00:00" : offset.getId();
        env.getPropertySources().addLast(new MapPropertySource("zhiqu-process-time-zone",
                Map.of(INIT_SQL_KEY, "SET time_zone = '" + id + "'")));
    }

    /** 读 app.timezone（和 BusinessClock 同一个键、同一个默认值），设成进程默认时区。返回设上的那个。 */
    public static ZoneId apply(Environment env) {
        String configured = env.getProperty("app.timezone");
        ZoneId zone = ZoneId.of(configured == null || configured.isBlank() ? BusinessClock.DEFAULT_ZONE : configured.trim());
        TimeZone.setDefault(TimeZone.getTimeZone(zone));
        System.setProperty("user.timezone", zone.getId());
        return zone;
    }
}
