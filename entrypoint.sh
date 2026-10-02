#!/bin/sh
set -e

# 规范化 CRON：若字段数不为 5（如手写漏空格 "*/30* * * *"），
# crontab 会报 "bad minute" 导致安装失败、容器退出。这里兜底回退默认。
if [ -n "${CRON}" ]; then
    _fc=$(printf '%s' "${CRON}" | awk '{print NF}')
    if [ "${_fc}" -ne 5 ]; then
        echo "CRON '${CRON}' 字段数=${_fc} 非法(应为5)，回退默认 '*/30 * * * *'"
        CRON="*/30 * * * *"
    fi
fi

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
# 注意：写成可 source 的 KEY='value' 形式（单引号转义），
# 这样 ACCOUNTS JSON / 含空格或引号的密码都能原样传给 cron 子进程。
# 旧写法 export $(... | xargs) 会按空白切词，导致 JSON 被当成命令执行而丢环境变量。
ENV_FILE="/app/.env.cron"
: > "${ENV_FILE}"
printenv | grep -E '^(BAS_|ACCOUNTS=|CRON=|TZ=|HEADLESS=)' | while IFS= read -r kv; do
    k=${kv%%=*}
    v=$(printf '%s' "${kv#*=}" | sed "s/'/'\\\\''/g")
    printf "%s='%s'\n" "${k}" "${v}" >> "${ENV_FILE}"
done || true

CRON_SCRIPT="/app/run-keepalive.sh"
cat > "${CRON_SCRIPT}" << 'SCRIPT'
#!/bin/sh
# 加载环境变量（source，而不是 export $(... | xargs)）
if [ -f /app/.env.cron ]; then
    set -a
    . /app/.env.cron
    set +a
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
