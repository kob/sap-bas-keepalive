FROM node:20-slim

# 环境变量
ENV CRON="*/30 * * * *" \
    TZ="Asia/Shanghai"

# 安装所有依赖（Playwright + cron + 时区）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libatspi2.0-0 libxshmfence1 \
    cron tzdata \
    && ln -sf /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo "${TZ}" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 分离依赖安装以便更好利用 Docker 缓存
COPY package.json package-lock.json* ./
RUN npm install

# 安装 Playwright Chromium
RUN npx playwright install chromium

COPY . .

# 确保 entrypoint 可执行
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
