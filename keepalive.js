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

        // --- 步骤 1: 访问 ---
        console.log(`🌐 正在访问 BAS: ${env.url}`);
        await page.goto(env.url, { waitUntil: 'networkidle', timeout: 60000 });

        // --- 步骤 2: 登录逻辑 (已修复) ---
        // 检查是否需要登录
        if (page.url().includes('login') || page.url().includes('authentication')) {
            console.log('🔑 正在执行登录...');
            
            // 填写用户名
            await page.fill('input[name="j_username"], input[type="email"]', env.email);
            
            // 点击下一步 (如果有)
            const nextBtn = page.locator('button:has-text("Next"), #logOnFormSubmit').first();
            if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await nextBtn.click();
                // 等待密码框出现，而不是等待页面跳转
                await page.waitForSelector('input[type="password"]', { timeout: 10000 });
            }

            // 填写密码
            await page.fill('input[name="j_password"], input[type="password"]', env.password);

            // 勾选 "保持登录"
            try {
                const checkbox = page.locator('input[type="checkbox"][id*="remember"]');
                if (await checkbox.isVisible({ timeout: 3000 })) await checkbox.check();
            } catch (e) {}

            // 点击登录按钮
            console.log('⏳ 提交登录信息...');
            await nextBtn.click();

            // 【关键修复】：不再等待 navigation，而是等待登录表单消失 或 主界面出现
            // 我们等待页面上的 "j_password" 输入框消失，意味着登录成功
            try {
                await page.waitForSelector('input[name="j_password"]', { state: 'hidden', timeout: 30000 });
                console.log('✅ 登录表单已消失，登录似乎成功。');
            } catch (e) {
                console.warn('⚠️ 等待登录表单消失超时，尝试继续...');
                // 即使超时，我们也尝试继续，因为可能是单页应用跳转
            }
            
            // 额外等待几秒，确保页面状态稳定
            await page.waitForTimeout(3000);
        }

        // --- 步骤 3: 处理弹窗 ---
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

        // --- 步骤 4: 定位 ws-manager Iframe ---
        console.log('🔍 寻找 ws-manager iframe...');
        // 增加重试逻辑，防止 iframe 加载慢
        await page.waitForSelector('iframe#ws-manager, iframe[name="ws-manager"]', { timeout: 30000 });
        const frame = page.frame({ name: 'ws-manager' }) || page.frame({ id: 'ws-manager' });
        if (!frame) throw new Error('无法获取 ws-manager iframe 句柄');
        
        // 等待 iframe 内部网络空闲
        await frame.waitForLoadState('networkidle', { timeout: 60000 });

        // --- 步骤 5: 检查状态并启动 ---
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

        // --- 步骤 6: 打开工作区 (已修复) ---
        console.log('🔑 正在寻找“打开”按钮以进入工作区...');

        try {
            const openBtn = frame.locator('button:has-text("Open"), button:has-text("开发"), button:has-text("Connect")').first();
            await openBtn.waitFor({ state: 'enabled', timeout: 10000 });
            
            console.log('🖱️ 点击“打开”按钮...');
            await openBtn.click();

            // 【关键修复】：BAS 打开 IDE 有时不触发主页面 navigation，而是替换内容
            // 我们不再等待 navigation，而是直接等待 IDE 的元素出现
            console.log('🌐 等待 IDE 界面加载...');
            
            // 等待 IDE 的核心容器出现 (兼容 Theia 和 SAP IDE)
            await page.waitForSelector('#theia-app, #sap_ide_app, .theia-SplitPanel, iframe[id^="ide-"]', { timeout: 120000 });
            
            // 等待几秒确保内部 iframe 也加载出来
            await page.waitForTimeout(5000);

            console.log('🎉 成功！工作区已完全加载。');
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
