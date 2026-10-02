# SAP BAS Keepalive

通过 Playwright 自动登录 SAP Business Application Studio，检查并启动工作区，防止因不活跃而停止。支持多账号并行保活。

## 功能

- 自动登录 BAS 账户
- 自动勾选"保持登录"
- 自动处理隐私声明弹窗
- 检查工作区状态，STOPPED 时自动启动
- **多账号并行保活**，总耗时≈单账号耗时
- 支持 GitHub Actions 定时执行 / 本地运行 / Docker 运行

## Hugging Face Spaces 部署（推荐，纯环境变量）

账号**全部走 HF 的 Variables and secrets（即容器内的 Docker 环境变量），不需要也不读取任何 `.env` 文件**。

> 路径：Space 页面 → **Settings** → **Variables and secrets** → 逐条 **New variable** 添加。
> 改完必须点右上角 **⋯ → Factory rebuild**（只 Restart 不会重读 secret）。

### 多账号（最稳，推荐）：索引式环境变量

每个账号一组**短变量**，没有长 JSON，绝不会被粘贴截断：

| 变量 | 说明 | 必填 |
|------|------|------|
| `BAS_URL_1` | 账号1 的 BAS 首页 URL | ✅ |
| `BAS_EMAIL_1` | 账号1 邮箱 | ✅ |
| `BAS_PASSWORD_1` | 账号1 密码 | ✅ |
| `BAS_WSID_1` | 账号1 工作区 ID（形如 `ws-abc`） | ✅ |
| `BAS_NAME_1` | 账号1 别名（可选） | ⬜ |

账号 2、3 … 把下标改成 `2`、`3` 即可（`BAS_URL_2` / `BAS_EMAIL_2` …）。脚本从 `1` 自动递增检测，遇到第一个缺失的 `BAS_URL_N` 停止。

```env
BAS_URL_1=https://39a6e423trial.ap21cf.trial.applicationstudio.cloud.sap/index.html
BAS_EMAIL_1=3966513219@qq.com
BAS_PASSWORD_1=Tclz6080313
BAS_WSID_1=ws-j6w4r
BAS_NAME_1=账号1-hsd

BAS_URL_2=https://e1c92090trial.ap21cf.trial.applicationstudio.cloud.sap/index.html
BAS_EMAIL_2=kob8283@gmail.com
BAS_PASSWORD_2=你的密码2
BAS_WSID_2=ws-v146p
BAS_NAME_2=账号2-kobsg
```

### 单账号：直接变量

```env
BAS_URL=https://xxx.cloud.sap
BAS_EMAIL=a@b.com
BAS_PASSWORD=pass1
BAS_WSID=ws-abc
```

### 可选但建议一起设（控制调度，shell 侧读取）

```env
CRON=*/30 * * * *     # 不设则单次执行后退出
TZ=Asia/Shanghai
# NO_CRON=1           # 设 1 则只跑一次不挂 cron
```

> 如果同时设了 `ACCOUNTS`（长 JSON）又设了上面的索引变量：`ACCOUNTS` 合法时优先；
> 一旦 `ACCOUNTS` 被截断/写错，脚本会**告警并自动改用索引式变量**，不会整进程崩。

## 配置方式（通用说明）

支持三种配置方式（优先级从高到低），都来自环境变量，不依赖 `.env` 文件：

### 方式一：ACCOUNTS JSON（可选，适合 GitHub Actions 单 secret）

设置一个 `ACCOUNTS`，值为单行紧凑 JSON 数组：

```env
ACCOUNTS=[{"url":"https://xxx.cloud.sap","email":"a@b.com","password":"p1","wsid":"ws-abc","name":"账号1"},{"url":"https://yyy.cloud.sap","email":"c@d.com","password":"p2","wsid":"ws-def","name":"账号2"}]
```

每个对象必填字段：`url`、`email`、`password`、`wsid`，可选 `name`（账号别名）。
⚠️ 必须是**单行**；写成多行美化 JSON 会被截断成第一行导致解析失败。**HF Spaces 上更推荐用下面的索引式变量，避免这个坑。**

### 方式二：逐行索引（HF Spaces / Docker `-e` 推荐）

```env
BAS_URL_1=https://xxx.cloud.sap
BAS_EMAIL_1=a@b.com
BAS_PASSWORD_1=pass1
BAS_WSID_1=ws-abc
# BAS_NAME_1=我的账号1

BAS_URL_2=https://yyy.cloud.sap
BAS_EMAIL_2=c@d.com
BAS_PASSWORD_2=pass2
BAS_WSID_2=ws-def
# BAS_NAME_2=我的账号2
```

索引从 1 开始递增，脚本自动检测。

### 方式三：单账号

```env
BAS_URL=https://xxx.cloud.sap
BAS_EMAIL=a@b.com
BAS_PASSWORD=pass1
BAS_WSID=ws-abc
```

## 使用方法

### GitHub Actions

1. Fork 或克隆此仓库
2. 在仓库 **Settings → Secrets and variables → Actions** 中添加：
   - **推荐**：只设一个 `ACCOUNTS` secret，值为 JSON 数组
   - 或逐个设置 `BAS_URL_1`/`BAS_EMAIL_1`/`BAS_PASSWORD_1`/`BAS_WSID_1` 等
3. 工作流默认每 30 分钟执行一次，可在 yml 中修改 cron

手动触发：Actions 页面 → "SAP BAS Keep-Alive" → "Run workflow"

### 本地运行

```bash
git clone https://github.com/kob/sap-bas-keepalive
cd sap-bas-keepalive
npm install
npx playwright install chromium
cp .env.example .env   # 编辑 .env 填入账号信息
npm start
```

### Cloudflare Worker 代理（解决国内网络慢问题）

如果你的网络访问SAP BAS较慢，可以使用Cloudflare Worker作为代理加速。

#### 1. 部署Cloudflare Worker
将 `cf-worker-bas-proxy.js` 部署到你的Cloudflare Worker（例如：`https://sap.kob8283.workers.dev`）。

#### 2. 配置 `.env` 文件
```env
# Cloudflare Worker代理配置
PROXY_MODE=cf-worker
CF_WORKER_URL=https://sap.kob8283.workers.dev

# 原有账号配置保持不变
BAS_URL_1=https://39a6e423trial.ap21cf.trial.applicationstudio.cloud.sap
BAS_EMAIL_1=user@example.com
# ...
```

#### 3. 工作原理
脚本会自动将请求通过Cloudflare Worker转发：
- 原始URL: `https://xxx.trial.applicationstudio.cloud.sap`
- 处理后URL: `https://sap.kob8283.workers.dev/?url=https%3A%2F%2Fxxx.trial.applicationstudio.cloud.sap`

#### 4. 其他代理选项
```env
# 方案A：HTTP代理
PROXY_MODE=direct
PROXY_URL=http://proxy.example.com:8080

# 方案B：自定义代理
PROXY_MODE=custom-proxy
CUSTOM_PROXY_BASE=https://proxy.example.com
```

### Docker 运行

```bash
# 构建镜像
docker build -t sap-bas-keepalive .

# 使用 .env 文件运行
docker run --rm --env-file .env sap-bas-keepalive

# 或直接传入环境变量
docker run --rm \
  -e BAS_URL_1=https://xxx.cloud.sap \
  -e BAS_EMAIL_1=a@b.com \
  -e BAS_PASSWORD_1=pass1 \
  -e BAS_WSID_1=ws-abc \
  sap-bas-keepalive
```

## 可选环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BAS_POST_PRIVACY_WAIT_MS` | 隐私弹窗点击后等待时间（毫秒） | 800 |
| `BAS_REMEMBER_WAIT_MS` | 查找"保持登录"复选框超时（毫秒） | 1800 |

## 文件说明

| 文件 | 说明 |
|------|------|
| `keepalive.js` | 主脚本 |
| `package.json` | 依赖配置 |
| `Dockerfile` | Docker 镜像构建 |
| `.env.example` | 环境变量模板 |
| `.github/workflows/bas-keepalive.yml` | GitHub Actions 工作流 |
