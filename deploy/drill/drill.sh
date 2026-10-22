#!/usr/bin/env bash
# 回滚演练第 1–3 步。API 载荷一律 ASCII：Git Bash 会把中文按 GBK 传出去，
# 而演练是对照实验，不该顺带引入一个编码变量（中文正文由 Java 侧单元测试覆盖）。
#第 0 步（旧 JAR 能否启动）已单独验过，结论见 README.md。
#
# 判据全部机器可检，不 grep 日志文本 —— 那些措辞会随 Flyway/Spring 版本变。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NEW_JAR="$(cygpath -m "$ROOT/zhiqu-backend/target/zhiqu-backend-0.0.1-SNAPSHOT.jar")"
OLD_JAR="$(cygpath -m "$ROOT/../zhiqu-rollback-target/zhiqu-backend/target/zhiqu-backend-0.0.1-SNAPSHOT.jar")"
# Git Bash 的 /c/... 形式 Java 认不了，必须转成 C:/... （cygpath -m）
CONF_PATH="$(cygpath -m "$ROOT/deploy/drill/application-drill.yml")"
CONF="--spring.config.additional-location=file:$CONF_PATH"
BASE="http://127.0.0.1:18080"
MYSQL="docker exec zhiqu-drill-mysql mysql -uroot -pdrill -N -B zhiqu_drill -e"

start() {  # start <jar> <logfile>
  java -jar "$1" $CONF > "$2" 2>&1 &
  echo $! > /tmp/drill.pid
  for _ in $(seq 1 60); do
    grep -q "Started ZhiquApplication" "$2" 2>/dev/null && return 0
    grep -q "APPLICATION FAILED TO START" "$2" 2>/dev/null && return 1
    sleep 2
  done
  return 1
}
# 必须按端口杀 Windows 侧的 JVM：$! 拿到的是 Git Bash 的 PID，kill 它不会停掉 java.exe，
# 下一次 start 会撞「Port 18080 was already in use」——而那读起来像「新 JAR 起不来」。
stop() {
  powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 18080 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }" 2>/dev/null
  sleep 5
}
sql()  { $MYSQL "$1" 2>/dev/null; }

api() { # api <method> <path> <token> [body]
  if [ -n "${4:-}" ]; then
    curl -s -X "$1" "$BASE$2" -H "Content-Type: application/json" -H "Authorization: Bearer $3" -d "$4"
  else
    curl -s -X "$1" "$BASE$2" -H "Authorization: Bearer $3"
  fi
}

# 每个业务调用都必须自证成功。此前所有响应都进了 /dev/null，于是建页失败是静默的，
# 而演练最终报的红（第 3 步「投影没追上」）看起来像代码缺陷——实际上根本没有数据被造出来。
# 这与 grep -c 判绿、容器瞬时故障读成 RED 是同一类：观察不到的失败被归因到了别处。
apiOk() { # apiOk <说明> <method> <path> <token> [body]
  local label="$1"; shift
  local out; out="$(api "$@")"
  case "$out" in
    *'"code":200'*) : ;;
    *) echo "！$label 失败，演练无法继续：$out"; stop; exit 1 ;;
  esac
}

# 登录必须是一处实现。曾经四处各写一份 sed，其中一处的替换部分在文件里存的不是 `\1`
# 这两个字符，而是一个**裸的 0x01 控制字节**（编辑器里不可见，grep `\\1` 也搜不到它）。
# 于是 sed 抽出的 TOKEN 是 "\x01" —— 不是空串，守卫 `[ -n ]` 拦不住；
# 它被拼进 `Authorization: Bearer \x01`，Tomcat 在**进入 Spring 之前**就以非法头字节
# 拒掉，返回一个 HTML 的 400。所以症状既不是登录报错，也不是 401，而是一个
# 与登录毫无关系的 400 —— 错误归因的成本全在这里。
# 这与本仓库此前 CanonicalTextCharacterizationTest 里混进裸 U+001E 是同一物种：
# shell 桥接会吃掉反斜杠，把 `\1` 变成它的控制字符。写这类脚本时不要用 heredoc 传
# 含反斜杠的 sed 表达式。
# 三处有 `[ -n "$TOKEN" ] ||` 守卫，坏掉的那一处恰好没有 —— 但注意守卫本来也救不了它。
# 这与 apiOk 是同一件事，只差一层：apiOk 让每个 API 调用自证成功，但 token 抽取不是
# API 调用，是一个没有自检的中间步骤。收成一个自带守卫的函数，守卫就不可能被漏掉。
#
# 刻意写全局 TOKEN 而不是 `TOKEN=$(login ...)`：命令替换起子 shell，里面的 `exit 1`
# 只退出子 shell，守卫会照常打印却拦不住脚本 —— 那就退回成「打印一行没人看的警告，
# 然后继续用空 token」，正是这次要修掉的形状。
login() { # login <username> -> 设置全局 TOKEN
  TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" \
            -d "{\"username\":\"$1\",\"password\":\"Drill#12345\"}" \
          | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  # 校验形状而不是「非空」：非空判据的定义域比它声称报告的性质窄 —— 它只认得
  # 「什么都没抽到」，认不得「抽到了垃圾」，而这次坏的正是后者。
  # JWT 的字符集是 [A-Za-z0-9._-] 且恰有两个点，任何控制字节/空白都会在这里被逮住。
  case "$TOKEN" in
    *[!A-Za-z0-9._-]*|"") echo "！登录失败（$1）：token 不是合法 JWT 形状，抽到的是 [$TOKEN]"; stop; exit 1 ;;
    *.*.*) : ;;
    *) echo "！登录失败（$1）：token 缺少 JWT 分段，抽到的是 [$TOKEN]"; stop; exit 1 ;;
  esac
}

echo "=== 准备：新 JAR 起，建基线页并对账 ==="
start "$NEW_JAR" /tmp/d_new1.log || { echo "新 JAR 启动失败"; exit 1; }

U="drill_$(date +%s)"
curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" \
  -d "{\"username\":\"$U\",\"password\":\"Drill#12345\",\"confirmPassword\":\"Drill#12345\",\"nickname\":\"drill\"}" > /dev/null
login "$U"

# 所有查询必须按本次演练的用户限定。演练库不在每轮之间清空（清空会破坏第 0 步要验的
# flyway 历史），而每轮都注册一个新用户、建同名的 baseline-page —— 不限定就会跨轮取到
# 多行：`SELECT id ... WHERE title='baseline-page'` 返回 "1\n2"，`canonical_hash` 同理
# 返回两行。后者尤其阴：两轮内容相同则两行哈希相同，肉眼看不出 BASE_HASH 是多行字符串，
# 而末尾的 `[ "$BASE_HASH" != "$NEW_HASH" ]` 一直在拿多行值做比较。
DRILL_UID=$(sql "SELECT id FROM sys_user WHERE username='$U';")
case "$DRILL_UID" in ''|*[!0-9]*) echo "！取演练用户 id 失败，抽到的是 [$DRILL_UID]"; stop; exit 1 ;; esac

apiOk '建基线页' POST /api/knowledge/pages "$TOKEN" '{"title":"baseline-page","content":"content before rollback"}'
sql "UPDATE sys_user SET role='ADMIN' WHERE username='$U';"
login "$U"   # 提权后必须重新登录：角色进 JWT，旧 token 仍是 USER
apiOk '准备阶段对账' POST /api/admin/rag/reconcile-units "$TOKEN"
for _ in $(seq 1 30); do
  [ "$(sql "SELECT status FROM rag_index_job WHERE operation='RECONCILE_UNITS' ORDER BY id DESC LIMIT 1;")" = "COMPLETED" ] && break
  sleep 3
done
sleep 6
BASE_HASH=$(sql "SELECT canonical_hash FROM rag_indexable_unit WHERE user_id=$DRILL_UID AND namespace='WIKI_PAGE' AND title='baseline-page';")
case "$BASE_HASH" in
  *[!0-9a-f]*|'') echo "！基线页投影哈希异常（多行或缺失），抽到的是 [$BASE_HASH]"; stop; exit 1 ;;
esac
echo "基线页投影哈希: $BASE_HASH"
# 回滚前的作业基数。第 1 步要断言的是「回滚期间**没有新增**」，不是「总数为 0」——
# 准备阶段建基线页本身就会经 Wiki 钩子入一条 UPSERT_UNIT，总数从来就不是 0。
JOBS_BEFORE=$(sql "SELECT COUNT(*) FROM rag_index_job WHERE user_id=$DRILL_UID AND operation IN ('UPSERT_UNIT','DELETE_UNIT');")
stop

echo "=== 第 0 步：起旧 JAR（库在 V30，代码在 V28）==="
ROWS_BEFORE=$(sql "SELECT COUNT(*) FROM flyway_schema_history;")
start "$OLD_JAR" /tmp/d_old.log && echo "旧 JAR 启动：成功" || { echo "旧 JAR 启动：失败"; exit 1; }
ROWS_AFTER=$(sql "SELECT COUNT(*) FROM flyway_schema_history;")
echo "flyway_schema_history 行数 $ROWS_BEFORE -> $ROWS_AFTER（应相等）"

echo "=== 第 1 步：回滚期间造两类数据变更 ==="
login "$U"
# 类型一：新增页 —— 投影里根本没有这一行，滚回后走 ensureRow 建行
apiOk '回滚期建新页' POST /api/knowledge/pages "$TOKEN" '{"title":"created-during-rollback","content":"written during rollback"}'
# 类型二：编辑已有页 —— 投影里有行但内容旧了，滚回后走 applyContent 比哈希
PID=$(sql "SELECT id FROM user_knowledge_page WHERE user_id=$DRILL_UID AND title='baseline-page' AND deleted=0;")
# 同 login 的理由：中间步骤也要自检。PID 为空会让下一条 SQL 变成 `WHERE id=` 语法错误，
# 而错误进了 2>/dev/null，最终以判据②「哈希没变」的形式冒出来——又一次错误归因。
case "$PID" in ''|*[!0-9]*) echo "！取基线页 id 失败，抽到的是 [$PID]"; stop; exit 1 ;; esac
VER=$(sql "SELECT version FROM user_knowledge_page WHERE id=$PID;")
case "$VER" in ''|*[!0-9]*) echo "！取基线页 version 失败，抽到的是 [$VER]"; stop; exit 1 ;; esac
apiOk '回滚期改基线页' PUT "/api/knowledge/pages/$PID" "$TOKEN" \
  "{\"title\":\"baseline-page\",\"content\":\"content edited during rollback\",\"version\":$VER}"

JOBS_AFTER=$(sql "SELECT COUNT(*) FROM rag_index_job WHERE user_id=$DRILL_UID AND operation IN ('UPSERT_UNIT','DELETE_UNIT');")
echo "回滚期间新增的 RAG 作业数（应为 0，旧 JAR 没有钩子）: $JOBS_BEFORE -> $JOBS_AFTER"
[ "$JOBS_BEFORE" = "$JOBS_AFTER" ] && echo "   未新增 ✓" || echo "   有新增 ✗"
echo "新增页此刻的投影行数（应为 0）: $(sql "SELECT COUNT(*) FROM rag_indexable_unit WHERE user_id=$DRILL_UID AND title='created-during-rollback';")"
stop

echo "=== 第 2 步：滚回新 JAR ==="
start "$NEW_JAR" /tmp/d_new2.log && echo "新 JAR 启动：成功" || { echo "新 JAR 启动：失败"; exit 1; }

echo "=== 第 3 步：全量对账，验投影追上 ==="
sql "UPDATE sys_user SET role='ADMIN' WHERE username='$U';"
login "$U"
# 扰动开关：`DRILL_SKIP_RECONCILE=1 bash drill.sh` 跳过对账。
# 本演练只声称钉住一条性质——「滚回流程必须包含一次 reconcileAll」——所以恰好配一次扰动。
# 跳过后判据①②**必须双双转红**；若仍绿，说明投影是被别的东西更新的，整个演练是空跑。
# 实测（2026-08-08，与主干同一份脚本、同一套容器）：
#   主干  ① 1  ② bfa69b… -> fc3b8d…  变了 ✓
#   扰动  ① 0  ② bfa69b… -> bfa69b…  未变 ✗
# 两条判据都对「有没有对账」敏感，演练不是空跑。
if [ "${DRILL_SKIP_RECONCILE:-0}" = "1" ]; then
  echo "对账作业终态: <扰动：本轮刻意跳过对账>"
  ST=SKIPPED
else
  apiOk '第 3 步全量对账' POST /api/admin/rag/reconcile-units "$TOKEN"
  for _ in $(seq 1 40); do
    ST=$(sql "SELECT status FROM rag_index_job WHERE operation='RECONCILE_UNITS' ORDER BY id DESC LIMIT 1;")
    [ "$ST" = "COMPLETED" ] && break
    [ "$ST" = "DEAD" ] && break
    sleep 3
  done
  echo "对账作业终态: $ST"
fi
echo "--- 判据 ---"
echo "① 新增页已建投影行（应为 1）: $(sql "SELECT COUNT(*) FROM rag_indexable_unit WHERE user_id=$DRILL_UID AND title='created-during-rollback' AND status='READY';")"
NEW_HASH=$(sql "SELECT canonical_hash FROM rag_indexable_unit WHERE user_id=$DRILL_UID AND namespace='WIKI_PAGE' AND title='baseline-page';")
echo "② 已有页哈希已更新: $BASE_HASH -> $NEW_HASH"
[ -n "$BASE_HASH" ] && [ "$BASE_HASH" != "$NEW_HASH" ] && echo "   变了 ✓" || echo "   未变 ✗"
stop
