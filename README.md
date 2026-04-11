# SAP BAS Keepalive

通过 Playwright 自动登录 SAP Business Application Studio，检查并启动工作区，防止因不活跃而停止。支持多账号并行保活。

## 功能

- 自动登录 BAS 账户
- 自动勾选"保持登录"
- 自动处理隐私声明弹窗
- 检查工作区状态，STOPPED 时自动启动
- **多账号并行保活**，总耗时≈单账号耗时
- 支持 GitHub Actions 定时执行 / 本地运行 / Docker 运行

## 配置方式

支持三种配置方式（优先级从高到低）：

### 方式一：ACCOUNTS JSON（推荐 GitHub Actions）

在 `.env` 文件或环境变量中设置一个 `ACCOUNTS`，值为 JSON 数组：

```env
ACCOUNTS=[{"url":"https://xxx.cloud.sap","email":"a@b.com","password":"p1","wsid":"ws-abc","name":"账号1"},{"url":"https://yyy.cloud.sap","email":"c@d.com","password":"p2","wsid":"ws-def","name":"账号2"}]
```

每个对象必填字段：`url`、`email`、`password`、`wsid`，可选 `name`（账号别名）。

### 方式二：逐行索引（推荐 .env 文件）

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
npm install
npx playwright install chromium
cp .env.example .env   # 编辑 .env 填入账号信息
npm start
```

### 浏览器可视化模式

如果你想查看浏览器操作过程，可以将浏览器设置为可视化模式。

#### 配置 `.env` 文件
```env
# 浏览器显示配置
# true: 无头模式，不显示浏览器界面（适合服务器环境）
# false: 显示浏览器界面（适合调试和可视化操作）
HEADLESS=false

# 原有账号配置保持不变
BAS_URL_1=https://39a6e423trial.ap21cf.trial.applicationstudio.cloud.sap
BAS_EMAIL_1=user@example.com
# ...
```

#### 工作原理
脚本直接连接SAP BAS服务器，无需代理。浏览器界面会显示登录和操作过程。

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
| `HEADLESS` | 浏览器是否显示界面（true=无头模式，false=可视化） | true |

## 文件说明

| 文件 | 说明 |
|------|------|
| `keepalive.js` | 主脚本 |
| `package.json` | 依赖配置 |
| `Dockerfile` | Docker 镜像构建 |
| `.env.example` | 环境变量模板 |
| `.github/workflows/bas-keepalive.yml` | GitHub Actions 工作流 |
| `.gitignore` | Git忽略文件配置 |
| `entrypoint.sh` | Docker容器入口脚本 |