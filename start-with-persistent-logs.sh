#!/bin/bash
# MS Rewards 持久化日志启动脚本
# 用法: ./start-with-persistent-logs.sh
# 日志目录默认项目 logs/，可用 MS_REWARDS_LOG_DIR 修改。
# 启动成功只表示进程存在，最终验收读取 logs/task-reports/*-latest.json。

set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LOG_BASE="${MS_REWARDS_LOG_DIR:-$PROJECT_DIR/logs}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# 确保目录存在
mkdir -p "$LOG_BASE"/{runtime,errors,diagnostics,audit,archive}
mkdir -p "$PROJECT_DIR/logs"
chmod 750 "$LOG_BASE"

RUNTIME_LOG="$LOG_BASE/runtime/msr-$TIMESTAMP.log"
ERROR_LOG="$LOG_BASE/errors/msr-$TIMESTAMP.error.log"

cd "$PROJECT_DIR"
if [ ! -f dist/index.js ]; then
    echo "缺少构建产物，请先执行 npm run build" >&2
    exit 1
fi

# 记录启动信息（脱敏：不记录密码/Token）
{
    echo "=== 启动信息 ==="
    echo "时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "Launcher PID: $$"
    echo "Git Commit: $(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
    echo "Git Tag: $(git describe --tags 2>/dev/null || echo 'none')"
    echo "Node: $(node --version)"
    echo "================"
} >> "$RUNTIME_LOG"

# 启动（stdout+stderr 分离，错误单独记录）
# 使用追加模式，不覆盖历史
nohup node ./dist/index.js >> "$RUNTIME_LOG" 2> >(tee -a "$ERROR_LOG" >> "$RUNTIME_LOG") &
NEW_PID=$!

echo "已启动 PID: $NEW_PID"
echo "运行时日志: $RUNTIME_LOG"
echo "错误日志: $ERROR_LOG"
echo "$NEW_PID" > "$PROJECT_DIR/logs/current.pid"
echo "最终逐项结果: $PROJECT_DIR/logs/task-reports/"

# 日志轮转：保留30天，压缩旧日志
find "$LOG_BASE/runtime" -name "msr-*.log" -mtime +30 -exec gzip {} \; 2>/dev/null || true
find "$LOG_BASE/runtime" -name "msr-*.log.gz" -mtime +90 -delete 2>/dev/null || true
find "$LOG_BASE/errors" -name "*.log" -mtime +30 -exec gzip {} \; 2>/dev/null || true

echo "日志轮转完成"
