const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 1. 环境变量检查
const env = {
    url: process.env.BAS_URL,
    email: process.env.BAS_EMAIL,
    password: process.env.BAS_PASSWORD
};

if (!env.url || !env.email || !env.password) {
    console.error('❌ 错误: 请设置环境变量 BAS_URL, BAS_EMAIL, BAS_PASSWORD');
    process.exit(1);
}

// 辅助函数：截图
async function takeScreenshot(page, stepName) {
    const safeName = stepName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filePath = path.join(process.cwd(), `debug-${safeName}.png`);
    try {
        await page.screenshot({ path: filePath, fullPage: true });
        console.log(`📸 截图保存至: ${filePath}`);
    } catch (e) { console.error('截图失败:', e); }
}

(async () => {
    let browser;
    try {
        console.log('🚀 正在启动 Playwright 浏览器...');
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        const context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        // --- 步骤 1: 访问与登录 (保持不变) ---
        console.log(`🌐 正在访问 BAS: ${env.url}`);
        await page.goto(env.url, { waitUntil: 'networkidle', timeout: 60000 });

        if (page.url().includes('login') || page.url().includes('authentication')) {
            console.log('🔑 正在执行登录...');
            await page.fill('input[name="j_username"], input[type="email"]', env.email);
            const nextBtn = page.locator('button:has-text("Next"), #logOnFormSubmit').first();
            if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await nextBtn.click();
                await page.waitForTimeout(1000);
            }
            await page.fill('input[name="j_password"], input[type="password"]', env.password);
            try {
                const checkbox = page.locator('input[type="checkbox"][id*="remember"]');
                if (await checkbox.isVisible({ timeout: 3000 })) await checkbox.check();
            } catch (e) {}
            await nextBtn.click();
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 });
        }

        // --- 步骤 2: 处理弹窗 (保持不变) ---
        try {
            const okBtn = page.locator('button:has-text("OK"), button:has-text("Accept"), .sapButtonOK').first();
            if (await okBtn.isVisible({ timeout: 5000 })) {
                console.log('🛡️ 处理弹窗...');
                const cb = page.locator('input[type="checkbox"]');
                if (await cb.isVisible()) await cb.check();
                await okBtn.click();
                await page.waitForTimeout(2000);
            }
        } catch (e) { console.log('ℹ️ 无弹窗'); }

        // --- 步骤 3: 定位 ws-manager Iframe (保持不变) ---
        console.log('🔍 寻找 ws-manager iframe...');
        await page.waitForSelector('iframe#ws-manager, iframe[name="ws-manager"]', { timeout: 30000 });
        const frame = page.frame({ name: 'ws-manager' }) || page.frame({ id: 'ws-manager' });
        if (!frame) throw new Error('无法获取 ws-manager iframe 句柄');
        await frame.waitForLoadState('networkidle', { timeout: 60000 });

        // --- 步骤 4: 检查状态并启动 (保持不变) ---
        console.log('📊 检查工作区状态...');
        const statusLocator = frame.locator('text="STOPPED"');
        const isStopped = await statusLocator.isVisible({ timeout: 10000 }).catch(() => false);

        if (isStopped) {
            console.log('⚡ 状态为 [STOPPED]，正在启动...');
            const startBtn = frame.locator('button:has(i[data-icon="play-circle"]), button[aria-label="Start"]');
            await startBtn.waitFor({ state: 'visible', timeout: 15000 });
            await startBtn.click();
            console.log('🖱️ 已点击启动');

            const runningLocator = frame.locator('text="RUNNING"');
            await runningLocator.waitFor({ state: 'visible', timeout: 180000 });
            console.log('✅ 状态已变为 [RUNNING]');
        } else {
            console.log('ℹ️ 状态不是 STOPPED，跳过启动。');
        }

        // ==========================================
        // === 新增步骤：打开工作区 (Open Workspace) ===
        // ==========================================
        console.log('🔑 正在寻找“打开”按钮以进入工作区...');

        try {
            // 1. 在 iframe 中寻找 "Open" 或 "开发" 按钮
            // 注意：BAS 的按钮文本可能是 "Open", "开发", 或 "Connect"
            // 我们使用包含文本的选择器，并限制在 iframe 内
            const openBtn = frame.locator('button:has-text("Open"), button:has-text("开发"), button:has-text("Connect")').first();

            // 等待按钮变得可点击（防止页面还在刷新状态）
            await openBtn.waitFor({ state: 'enabled', timeout: 10000 });
            
            console.log('🖱️ 点击“打开”按钮，准备跳转...');
            
            // 2. 监听页面跳转
            // 点击后，BAS 通常会跳转到一个新的 URL，或者在当前页加载 IDE
            // 我们需要等待主页面 (page) 的导航完成，而不是 iframe
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }),
                openBtn.click()
            ]);

            console.log('🌐 页面已跳转，正在等待 IDE 界面加载...');

            // 3. 等待 IDE 核心元素加载
            // BAS 的 IDE 基于 Theia，加载完成后通常会有特定的 DOM 结构
            // 我们等待 "theia-app" 或 "sap_ide_app" 出现，或者等待加载遮罩消失
            
            // 等待 IDE 的主容器出现
            await page.waitForSelector('#theia-app, #sap_ide_app, .theia-SplitPanel', { timeout: 60000 });
            
            // 额外等待几秒，确保文件系统初始化完成
            await page.waitForTimeout(5000);

            console.log('🎉 成功！工作区已完全加载并打开。');
            
            // 可选：在这里截图确认
            await takeScreenshot(page, 'workspace_opened');

        } catch (e) {
            console.error('❌ 打开工作区失败:', e.message);
            await takeScreenshot(page, 'open_workspace_error');
        }

    } catch (err) {
        console.error('❌ 脚本执行异常:', err.message);
        if (page) await takeScreenshot(page, 'error_final');
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        console.log('👋 浏览器进程已关闭');
    }
})();
