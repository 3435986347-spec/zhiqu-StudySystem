-- harness 网关（P1，见 docs/zhiqu-harness-plan.md）：命令行 zhiqu 的循环与工具跑在用户电脑上，
-- 服务器只管登录、模型网关、对话存档、Wiki / 计划 / 记忆这几个远程工具。四张新表，全是新增，旧行不受影响。

-- 个人访问令牌。只存 SHA-256：令牌本身有 256 位随机熵，不需要慢哈希；库被拖走也拿不到可用的令牌。
-- 令牌只在 /api/harness/** 下有效（JwtAuthenticationFilter 按路径拒），管理令牌的接口不在那下面 ——
-- 泄露的令牌不能给自己续命、也不能撤销别人撤销过的东西。
CREATE TABLE IF NOT EXISTS user_access_token (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id       BIGINT       NOT NULL,
    name          VARCHAR(100) NOT NULL COMMENT '用户看到的名字，如「命令行 · MacBook」',
    token_hash    CHAR(64)     NOT NULL COMMENT 'SHA-256(令牌) 十六进制',
    token_hint    VARCHAR(16)  NOT NULL COMMENT '令牌末 4 位，只用于在列表里认出是哪一个',
    scope         VARCHAR(32)  NOT NULL DEFAULT 'HARNESS',
    last_used_at  DATETIME     NULL,
    last_used_ip  VARCHAR(64)  NULL,
    expires_at    DATETIME     NULL COMMENT '空 = 不过期，靠撤销',
    revoked_at    DATETIME     NULL,
    created_at    DATETIME     NOT NULL,
    UNIQUE KEY uk_user_access_token_hash (token_hash),
    KEY idx_user_access_token_user (user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT ='个人访问令牌（harness 用）';

-- 设备码登录：命令行不接触密码。命令行拿到 device_code（只有它知道，库里存哈希）和一个短的 user_code，
-- 用户在已登录的网页里输入 / 打开 user_code 点「允许」，命令行凭 device_code 轮询换出令牌（只换一次）。
CREATE TABLE IF NOT EXISTS harness_device_grant (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_code_hash CHAR(64)     NOT NULL,
    user_code        VARCHAR(16)  NOT NULL,
    client_name      VARCHAR(100) NULL,
    client_ip        VARCHAR(64)  NULL,
    status           VARCHAR(16)  NOT NULL COMMENT 'PENDING / APPROVED / DENIED / CONSUMED',
    user_id          BIGINT       NULL,
    token_id         BIGINT       NULL,
    expires_at       DATETIME     NOT NULL,
    created_at       DATETIME     NOT NULL,
    UNIQUE KEY uk_harness_device_code (device_code_hash),
    KEY idx_harness_user_code (user_code)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT ='命令行设备码登录';

-- 命令行会话 ↔ 网页里的 Notebook。一段命令行会话在网页里就是一个 Notebook，对话存档进它的会话；
-- 远程工具产出的草稿挂在 agent_run_id 那一轮上，网页打开这个 Notebook 就能看到并确认。
CREATE TABLE IF NOT EXISTS harness_session (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id           BIGINT       NOT NULL,
    client_session_id VARCHAR(64)  NOT NULL COMMENT '命令行本地 .zhiqu/sessions/<id>.jsonl 的 id',
    notebook_id       BIGINT       NOT NULL,
    agent_run_id      BIGINT       NULL,
    title             VARCHAR(200) NULL,
    workspace_name    VARCHAR(200) NULL,
    created_at        DATETIME     NOT NULL,
    updated_at        DATETIME     NOT NULL,
    UNIQUE KEY uk_harness_session_client (user_id, client_session_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT ='命令行会话';

-- 模型网关的用量计量：每次调用一行。供应商没报用量时按字数估算，estimated=1。
CREATE TABLE IF NOT EXISTS harness_usage (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id           BIGINT       NOT NULL,
    model_config_id   BIGINT       NULL,
    model_name        VARCHAR(200) NULL,
    prompt_tokens     INT          NOT NULL DEFAULT 0,
    completion_tokens INT          NOT NULL DEFAULT 0,
    estimated         TINYINT      NOT NULL DEFAULT 0,
    finish_reason     VARCHAR(32)  NULL,
    created_at        DATETIME     NOT NULL,
    KEY idx_harness_usage_user_time (user_id, created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT ='模型网关用量';
