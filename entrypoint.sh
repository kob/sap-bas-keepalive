#!/bin/sh
set -e

# 如果设置了 NO_CRON=1 或没有设置 CRON，直接执行一次脚本后退出
if [ "${NO_CRON}" = "1" ] || [ -z "${CRON}" ]; then
    echo "单次执行模式"
    exec node keepalive.js
fi

# 定时模式：用 cron 定时执行
echo "定时执行模式: ${CRON} (时区: ${TZ:-UTC})"

# 更新时区
if [ -n "${TZ}" ]; then
    ln -sf /usr/share/zoneinfo/${TZ} /etc/localtime
    echo "${TZ}" > /etc/timezone
fi

# 写入 cron 任务
# 将环境变量导出到脚本中，以便 cron job 能读取
ENV_FILE="/app/.env.cron"
printenv | grep -E '^(BAS_|ACCOUNTS|CRON|TZ)' > "${ENV_FILE}" 2>/dev/null || true

CRON_SCRIPT="/app/run-keepalive.sh"
cat > "${CRON_SCRIPT}" << 'SCRIPT'
#!/bin/sh
# 加载环境变量
if [ -f /app/.env.cron ]; then
    export $(grep -v '^#' /app/.env.cron | xargs) 2>/dev/null || true
fi
echo "$(date '+%Y-%m-%d %H:%M:%S') 开始执行保活..."
node /app/keepalive.js
echo "$(date '+%Y-%m-%d %H:%M:%S') 执行完成"
SCRIPT
chmod +x "${CRON_SCRIPT}"

# 生成 cron 配置
echo "${CRON} ${CRON_SCRIPT} >> /var/log/keepalive.log 2>&1" | crontab -

echo "Cron 已配置: ${CRON}"
echo "日志文件: /var/log/keepalive.log"
echo "查看日志: docker exec <container> tail -f /var/log/keepalive.log"

# 启动时先执行一次
echo "启动时先执行一次..."
${CRON_SCRIPT} || true

# 启动 cron 前台进程
echo "启动定时调度器..."
cron -f
