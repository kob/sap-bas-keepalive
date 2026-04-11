FROM node:20-slim

# 安装 Playwright Chromium 依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libatspi2.0-0 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install && npx playwright install chromium

COPY . .

# CRON: cron 表达式，默认每 30 分钟执行一次
# TZ: 时区，默认 Asia/Shanghai
ENV CRON="*/30 * * * *" \
    TZ="Asia/Shanghai"

# 安装 cron 和时区数据
RUN apt-get update && apt-get install -y --no-install-recommends cron tzdata \
    && ln -sf /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo "${TZ}" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
