package com.zhiqu.service.privacy;

import com.zhiqu.service.privacy.CryptoKeyRotation.CellResult;
import com.zhiqu.service.privacy.CryptoKeyRotation.Outcome;
import com.zhiqu.service.privacy.CryptoKeyRotation.TableSpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * 主密钥轮换：用旧 key 解、用新 key 重新加密每一格密文，然后退出。
 *
 * <p><b>只在显式要求时才跑</b>（{@code --app.crypto.rotate=true}），正常启动不碰它。
 * 运行时 {@code app.crypto.master-key} 仍是<b>旧</b> key（这样常规服务还能解开现有数据），
 * 新 key 由 {@code --app.crypto.new-key} 单独传入。跑完打印报告并 {@code System.exit}，
 * <b>不继续对外服务</b> —— 因为此刻进程握的还是旧 key，让它接流量没有意义。
 *
 * <h2>操作流程</h2>
 * <ol>
 *   <li>停掉正常服务（维护窗口）。</li>
 *   <li>{@code java -jar app.jar --app.crypto.rotate=true --app.crypto.master-key=<旧>
 *       --app.crypto.new-key=<新>}</li>
 *   <li>看报告：{@code UNDECRYPTABLE} 必须为 0，否则退出码非 0，别继续。</li>
 *   <li>把配置里的 {@code app.crypto.master-key} 改成<b>新</b> key。</li>
 *   <li>正常启动。</li>
 * </ol>
 *
 * <h2>为什么走原生 JDBC 而不是 mapper</h2>
 * <p>轮换只该动加密列那一个字段。走 {@code updateById} 会触发乐观锁 {@code @Version} 自增、
 * 让 {@code MetaObjectHandler} 改写 {@code updatedAt} —— 换个加密密钥不该在业务数据上留下
 * 「被修改过」的痕迹，更不该和用户的并发写抢版本号。原生 {@code UPDATE ... SET 加密列=?
 * WHERE id=?} 精确到列。
 *
 * <h2>可重入 / 崩溃恢复</h2>
 * <p>按批提交。中途崩了再跑一次是安全的：{@link CryptoKeyRotation#classify} 先试新 key，
 * 已经轮换过的行认成 {@link Outcome#ALREADY_NEW} 跳过，不会被叠加密一层。
 */
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
@ConditionalOnProperty(name = "app.crypto.rotate", havingValue = "true")
public class CryptoKeyRotationRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(CryptoKeyRotationRunner.class);
    private static final int BATCH = 500;

    private final DataSource dataSource;
    private final String oldKey;
    private final String newKey;
    private final ApplicationContext context;

    public CryptoKeyRotationRunner(DataSource dataSource,
                                   @Value("${app.crypto.master-key}") String oldKey,
                                   @Value("${app.crypto.new-key:}") String newKey,
                                   ApplicationContext context) {
        this.dataSource = dataSource;
        this.oldKey = oldKey;
        this.newKey = newKey;
        this.context = context;
    }

    @Override
    public void run(ApplicationArguments args) {
        int code = rotate();
        // 无论成败都退出：进程握的是旧 key，不该继续对外服务。
        // SpringApplication.exit 先优雅关闭上下文（放连接池等），再返回退出码。
        System.exit(SpringApplication.exit(context, () -> code));
    }

    /** @return 0 成功、非 0 有 UNDECRYPTABLE 或配置错误。 */
    int rotate() {
        if (newKey == null || newKey.isBlank() || newKey.length() < 24) {
            log.error("轮换中止：--app.crypto.new-key 未配置或短于 24 字符。");
            return 2;
        }
        if (newKey.equals(oldKey)) {
            log.error("轮换中止：新旧 key 相同，没有可轮换的东西。");
            return 2;
        }

        CryptoKeyRotation rotation = new CryptoKeyRotation(new AesGcmCipher(oldKey), new AesGcmCipher(newKey));
        Map<Outcome, Long> totals = new EnumMap<>(Outcome.class);
        List<String> undecryptable = new ArrayList<>();

        log.info("开始主密钥轮换，共 {} 张表。", CryptoKeyRotation.TABLES.size());
        try (Connection conn = dataSource.getConnection()) {
            boolean prevAuto = conn.getAutoCommit();
            conn.setAutoCommit(false);
            try {
                for (TableSpec spec : CryptoKeyRotation.TABLES) {
                    rotateTable(conn, rotation, spec, totals, undecryptable);
                }
                conn.commit();
            } catch (SQLException e) {
                conn.rollback();
                throw e;
            } finally {
                conn.setAutoCommit(prevAuto);
            }
        } catch (SQLException e) {
            log.error("轮换失败（数据库错误），已回滚未提交的部分：{}", e.getMessage(), e);
            return 3;
        }

        log.info("轮换完成：已轮换 {}，已是新 key {}，明文透传 {}，空值 {}。",
                totals.getOrDefault(Outcome.ROTATED, 0L),
                totals.getOrDefault(Outcome.ALREADY_NEW, 0L),
                totals.getOrDefault(Outcome.PLAINTEXT, 0L),
                totals.getOrDefault(Outcome.EMPTY, 0L));

        if (!undecryptable.isEmpty()) {
            // 只报「哪张表哪一行」，不打印值本身 —— 报告会被贴进工单。
            log.error("有 {} 格用新旧两把 key 都解不开，未改动它们。请逐一排查（可能是密文损坏，"
                    + "或旧 key 给错了）：\n  {}", undecryptable.size(), String.join("\n  ", undecryptable));
            return 1;
        }
        return 0;
    }

    private void rotateTable(Connection conn, CryptoKeyRotation rotation, TableSpec spec,
                             Map<Outcome, Long> totals, List<String> undecryptable) throws SQLException {
        String cols = String.join(", ", spec.encryptedColumns());
        String select = "SELECT " + spec.idColumn() + ", " + cols + " FROM " + spec.table();
        String setClause = String.join(", ",
                spec.encryptedColumns().stream().map(c -> c + "=?").toList());
        String update = "UPDATE " + spec.table() + " SET " + setClause
                + " WHERE " + spec.idColumn() + "=?";

        long rotatedInTable = 0;
        int pending = 0;
        try (PreparedStatement read = conn.prepareStatement(select);
             PreparedStatement write = conn.prepareStatement(update);
             ResultSet rs = read.executeQuery()) {
            while (rs.next()) {
                long id = rs.getLong(1);
                String[] newValues = new String[spec.encryptedColumns().size()];
                boolean rowChanged = false;

                for (int i = 0; i < spec.encryptedColumns().size(); i++) {
                    String value = rs.getString(2 + i);
                    CellResult r = rotation.classify(value);
                    totals.merge(r.outcome(), 1L, Long::sum);
                    if (r.outcome() == Outcome.UNDECRYPTABLE) {
                        undecryptable.add(spec.table() + "#" + id + "." + spec.encryptedColumns().get(i));
                    }
                    if (r.outcome() == Outcome.ROTATED) {
                        newValues[i] = r.newCipher();
                        rowChanged = true;
                    } else {
                        newValues[i] = value;   // 原样写回（批量里统一处理，避免部分列更新）
                    }
                }

                if (rowChanged) {
                    for (int i = 0; i < newValues.length; i++) {
                        write.setString(i + 1, newValues[i]);
                    }
                    write.setLong(newValues.length + 1, id);
                    write.addBatch();
                    rotatedInTable++;
                    if (++pending >= BATCH) {
                        write.executeBatch();
                        conn.commit();
                        pending = 0;
                    }
                }
            }
            if (pending > 0) {
                write.executeBatch();
                conn.commit();
            }
        }
        log.info("  {}：轮换 {} 行。", spec.table(), rotatedInTable);
    }
}
