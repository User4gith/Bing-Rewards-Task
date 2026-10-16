#!/bin/bash
# MS Rewards 持久化日志启动脚本
# 用法: ./start-with-persistent-logs.sh
# 日志目录: /home/hatch/workspace/ms-rewards-logs/

set -e

PROJECT_DIR="/home/hatch/workspace/ms-rewards-script"
LOG_BASE="/home/hatch/workspace/ms-rewards-logs"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DATE=$(date +%Y-%m-%d)

# 确保目录存在
mkdir -p "$LOG_BASE"/{runtime,errors,diagnostics,audit,archive}
chmod 750 "$LOG_BASE"

RUNTIME_LOG="$LOG_BASE/runtime/msr-$TIMESTAMP.log"
ERROR_LOG="$LOG_BASE/errors/msr-$TIMESTAMP.error.log"

cd "$PROJECT_DIR"

# 记录启动信息（脱敏：不记录密码/Token）
{
    echo "=== 启动信息 ==="
    echo "时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "PID: $$"
    echo "Git Commit: $(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
    echo "Git Tag: $(git describe --tags 2>/dev/null || echo 'none')"
    echo "Node: $(node --version)"
    echo "账户: yang4bing1@icloud.com"
    echo "================"
} >> "$RUNTIME_LOG"

# 启动（stdout+stderr 分离，错误单独记录）
# 使用追加模式，不覆盖历史
nohup node ./dist/index.js >> "$RUNTIME_LOG" 2> >(tee -a "$ERROR_LOG" >> "$RUNTIME_LOG") &
NEW_PID=$!

echo "已启动 PID: $NEW_PID"
echo "运行时日志: $RUNTIME_LOG"
echo "错误日志: $ERROR_LOG"
echo "$NEW_PID" > /tmp/msr-current.pid

# 日志轮转：保留30天，压缩旧日志
find "$LOG_BASE/runtime" -name "msr-*.log" -mtime +30 -exec gzip {} \; 2>/dev/null || true
find "$LOG_BASE/runtime" -name "msr-*.log.gz" -mtime +90 -delete 2>/dev/null || true
find "$LOG_BASE/errors" -name "*.log" -mtime +30 -exec gzip {} \; 2>/dev/null || true

echo "日志轮转完成"
