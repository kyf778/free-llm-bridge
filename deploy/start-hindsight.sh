#!/bin/bash
# Hindsight 启动包装：先把内嵌 postgres 拉起来并等它就绪，再交给官方 entrypoint。
#
# 为什么需要这一层（2026-10-06 在 J1800 NAS 上实测定案）：
#
# Hindsight 走 `pg0://` 分支时，pg0.py 的 EmbeddedPostgres.start() 是这样取值：
#
#     info = await loop.run_in_executor(None, pg0.start)   # 子进程返回
#     uri  = info.uri                                      # 紧接着再查一次 pg0 info
#     return uri                                           # 不检查 None、不重试
#
# 而 info.uri 来自 `pg0 info -o json`。在慢机器上这次查询可能还没看到
# running:true，于是 uri=None → db_url=None → memory_engine 抛
# `ValueError: Database URL is required for migrations` → 容器退出 → 重启循环。
#
# 与此同时，写成显式 `postgresql://...` 又会让 Hindsight **跳过 pg0 启动**，
# 它只去连一个"应该已经存在"的库——于是没人负责启动 postgres，
# 容器一重建就 Connection refused。两条路各自都是坑。
#
# 本脚本把两件事拆开做，各自可靠：
#   1) 由脚本负责启动 postgres 并轮询到 running:true（这里的等待是显式的）；
#   2) Hindsight 侧配显式 `postgresql://...`，完全不进 pg0 的探测代码路径。
#
# 用法（Hindsight 的 compose）：
#   entrypoint: ["/bin/bash", "/app/start-hindsight.sh"]
#   volumes:
#     - hindsight-data:/home/hindsight/.pg0
#     - ./start-hindsight.sh:/app/start-hindsight.sh:ro
#   environment:
#     - HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight
set -u

PG0=/app/api/.venv/lib/python3.11/site-packages/pg0/bin/pg0
log() { echo "[start-hindsight] $*"; }

if [ -x "$PG0" ]; then
    log "starting embedded PostgreSQL (name=hindsight)..."
    # 幂等：已经在跑时 pg0 会回 "already running"，那不是错误，忽略即可。
    "$PG0" start --name hindsight \
        --username hindsight --password hindsight --database hindsight \
        --port 5432 >/tmp/pg0-start.log 2>&1 || true

    ready=no
    for i in $(seq 1 60); do
        if "$PG0" info --name hindsight -o json 2>/dev/null | grep -q '"running": true'; then
            log "postgres ready after $((i * 2))s"
            ready=yes
            break
        fi
        sleep 2
    done

    if [ "$ready" != "yes" ]; then
        log "WARNING: postgres 120s 内未报 ready，仍然继续（让 Hindsight 自己报错更好排查）"
        tail -20 /tmp/pg0-start.log 2>/dev/null || true
    fi
else
    log "WARNING: 未找到 pg0 二进制（$PG0），跳过预启动"
fi

log "handing off to /app/start-all.sh"
exec /app/start-all.sh
