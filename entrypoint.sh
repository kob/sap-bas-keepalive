#!/bin/sh
set -e

# 规范化 CRON：绝不让容器因 bad minute 退出。
# 策略：先用用户值尝试安装进 crontab；安装失败（任何非法语法，含 "*/30*" 这种
# 字段数正确但字段内容非法的写法）就回退默认 "*/30 * * * *"。
DEFAULT_CRON="*/30 * * * *"
if [ -z "${CRON}" ]; then
    CRON="${DEFAULT_CRON}"
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

# 生成 cron 配置：用 crontab 自身校验，装不上就回退默认（彻底杜绝 bad minute 致容器退出）
CRON_LINE="${CRON} ${CRON_SCRIPT} >> /var/log/keepalive.log 2>&1"
if ! printf '%s\n' "${CRON_LINE}" | crontab - 2>/dev/null; then
    echo "CRON '${CRON}' 安装失败(bad minute 等)，回退默认 '${DEFAULT_CRON}'"
    CRON="${DEFAULT_CRON}"
    CRON_LINE="${CRON} ${CRON_SCRIPT} >> /var/log/keepalive.log 2>&1"
    printf '%s\n' "${CRON_LINE}" | crontab -
fi

echo "Cron 已配置: ${CRON}"
echo "日志文件: /var/log/keepalive.log"
echo "查看日志: docker exec <container> tail -f /var/log/keepalive.log"

# 启动时先执行一次
echo "启动时先执行一次..."
${CRON_SCRIPT} || true

# 启动健康探针 + 状态页 HTTP server（后台，监听 PORT 或 7860，供 HF 探活 / 外部 ping 防休眠）
echo "启动状态页 HTTP server (端口 ${PORT:-7860})..."
node -e '
const http=require("http"), fs=require("fs");
const port=process.env.PORT||7860;
function buildHtml(){
  let log="(暂无日志)";
  try{ log=fs.readFileSync("/var/log/keepalive.log","utf8"); }catch(e){}
  const tail=log.split("\n").slice(-60).join("\n");
  const accs=[];
  for(let i=1;i<=9;i++){ const u=process.env["BAS_URL_"+i]; if(u) accs.push({n:process.env["BAS_NAME_"+i]||("账号"+i),u}); }
  if(process.env.ACCOUNTS){ try{ const a=JSON.parse(process.env.ACCOUNTS); a.forEach(x=>accs.push({n:x.name||x.url,u:x.url})); }catch(e){} }
  const cron=process.env.CRON||"(默认)";
  const rows=accs.map(a=>"<li><b>"+String(a.n).replace(/</g,"&lt;")+"</b> — "+String(a.u).replace(/</g,"&lt;")+"</li>").join("");
  return "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>SAP BAS Keep-Alive</title>"+
    "<style>body{font-family:-apple-system,Segoe UI,Roboto,monospace;background:#0d1117;color:#c9d1d9;max-width:820px;margin:30px auto;padding:0 16px}h1{color:#58a6ff}pre{background:#161b22;padding:12px;border-radius:6px;overflow:auto;max-height:320px}.ok{color:#3fb950}.box{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin:14px 0}ul{line-height:1.8}</style></head><body>"+
    "<h1>SAP BAS Keep-Alive 状态</h1>"+
    "<div class=box><p>服务状态: <span class=ok>● 运行中</span></p><p>当前时间: "+new Date().toLocaleString()+"</p><p>调度(CRON): "+cron.replace(/</g,"&lt;")+"</p><p>账号数: "+accs.length+"</p></div>"+
    "<div class=box><h3>账号清单</h3><ul>"+(rows||"<li>(未配置)</li>")+"</ul></div>"+
    "<div class=box><h3>最近保活日志</h3><pre>"+tail.replace(/</g,"&lt;")+"</pre></div>"+
    "<p style=\"color:#8b949e;font-size:12px\">/healthz 返回 ok（供外部探活）</p>"+
    "</body></html>";
}
http.createServer((req,res)=>{
  if(req.url==="/healthz"||req.url==="/health"){ res.writeHead(200,{"Content-Type":"text/plain"}); return res.end("ok"); }
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
  res.end(buildHtml());
}).listen(port,"0.0.0.0",()=>console.log("status server listening on :"+port));
' &

# 启动 cron 前台进程
echo "启动定时调度器..."
cron -f
