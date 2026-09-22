# 轮换 app.crypto.master-key

主密钥（`app.crypto.master-key`）是 AI 密钥、Wiki 正文、任务标题、长期记忆等敏感字段的
加密根。**直接改这个值会让现有密文全部解不开** —— 必须先用「旧 key 解、新 key 重新加密」
把库里的密文迁移一遍。

## 什么时候要做

- 主密钥泄漏了（比如误提交进公开仓库）。
- 定期轮换策略要求。

## 怎么做

> ⚠️ 在维护窗口做，期间停掉正常服务。轮换进程握的是**旧** key，跑完会自动退出，
> 不对外服务。

**1. 备份数据库**（轮换会改动加密列；先有一份能回退的）：

```powershell
# Windows
deploy\windows\backup-zhiqu.ps1
```

**2. 生成一把新 key**（至少 24 字符的随机串；不要经过聊天窗口 / 工单）：

```bash
openssl rand -base64 48 | tr -d '\n/+=' | head -c 64
```

**3. 跑轮换**。`master-key` 仍传**旧** key，新 key 用 `--app.crypto.new-key` 单独给：

```bash
java -jar zhiqu-backend-0.0.1-SNAPSHOT.jar \
  --app.crypto.rotate=true \
  --app.crypto.master-key='<旧 key>' \
  --app.crypto.new-key='<新 key>'
```

它会逐表把密文从旧 key 重加密到新 key，打印一份报告后退出：

```
轮换完成：已轮换 N，已是新 key M，明文透传 K，空值 J。
```

**退出码 0 才算成功。** 非 0 表示：

- `1` —— 有密文用新旧两把 key **都解不开**。报告会列出「哪张表第几行的哪一列」
  （不打印值本身）。可能是密文损坏，也可能是旧 key 给错了。**逐一排查，不要继续。**
  已经能轮换的行这一轮已经落库，修好坏行后**重跑是安全的**（已轮换的行会被认成
  「已是新 key」跳过，不会叠加密）。
- `2` —— 新 key 没配、短于 24 字符、或和旧 key 相同。
- `3` —— 数据库错误，已回滚。

**4. 把配置里的 `app.crypto.master-key` 改成新 key**，正常启动。

## 为什么这样设计

- **可重入 / 崩溃恢复**：轮换先试新 key，已处理的行直接跳过。中途断电再跑一次不会
  把数据叠加密两层。
- **解不开就硬停，不跳过**：一格密文两把 key 都解不开时，进程报错退出而不是悄悄略过。
  跳过会把不可读的数据留在库里、没有任何信号，那比停下来更糟。
- **只动加密列**：走原生 JDBC，不经过 mapper —— 换个加密密钥不该触发乐观锁版本号自增、
  也不该改写业务的 `updated_at`。

代码：`service/privacy/CryptoKeyRotation`（纯逻辑）+ `CryptoKeyRotationRunner`（JDBC）。
覆盖哪些列由 `CryptoKeyRotationTest.轮换清单必须覆盖所有加密列` 扫 entity 反查，新加一个加密列忘了登记会红。
