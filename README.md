# BAS Keepalive2

通过 GitHub Actions 每天定时运行 SAP Business Application Studio 保持活跃脚本。

## 功能

- 自动登录 BAS 账户
- 检查工作区状态
- 如果工作区为 STOPPED 状态，则启动工作区
- 每天自动执行，防止工作区因不活跃而停止

## 使用方法

### 1. 克隆或 Fork 此仓库到你的 GitHub 账户

### 2. 配置 GitHub Secrets

在 GitHub 仓库设置中添加以下 Secrets：

1. 进入仓库 **Settings** → **Secrets and variables** → **Actions**
2. 点击 **New repository secret** 添加：
   - `BAS_EMAIL`: 你的 BAS 账户邮箱
   - `BAS_PASSWORD`: 你的 BAS 账户密码
   - `BAS_URL`: 你的 BAS 主页 URL

### 3. 执行时间

默认配置：每天 UTC 时间 00:00-01:00 每十分钟执行一次（北京时间 08:00-09:00）

修改时间：编辑 `.github/workflows/bas-keepalive.yml` 中的 cron 表达式。

### 4. 手动运行

在 GitHub Actions 页面，选择 "BAS Keepalive2 Daily" 工作流，点击 "Run workflow" 手动触发。

## 本地运行

```bash
# 安装依赖
npm install

# 设置环境变量
export BAS_EMAIL="your-email@example.com"
export BAS_PASSWORD="your-password"
export BAS_URL="https://your-bas-url.cloud.sap"

# 运行脚本
npm start
```

## 文件说明

- `keepalive.js` - 主脚本文件
- `package.json` - 依赖配置
- `.github/workflows/bas-keepalive.yml` - GitHub Actions 工作流配置
