const { chromium } = require('playwright');
const os = require('os');
const path = require('path');

// 环境检查
const getEnv = (n) => (process.env[n] || '').trim();

(async () => {
    console.log('--- 启动自动化任务 ---');
    
    const browser = await chromium.launch({ 
        headless: true, // Actions 环境必须为 true
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    const config = {
        url: getEnv('BAS_URL'),
        email: getEnv('BAS_EMAIL'),
        pass: getEnv('BAS_PASSWORD'),
        wsid: getEnv('BAS_WSID')
    };

    try {
        if (!config.url || !config.email) throw new Error("环境变量未配置！");

        console.log(`正在访问: ${config.url}`);
        await page.goto(config.url, { waitUntil: 'networkidle', timeout: 60000 });

        // 登录逻辑
        if (page.url().includes('login') || await page.locator('input[type="email"]').isVisible()) {
            console.log('执行登录步骤...');
            await page.fill('input[type="email"], input[name="j_username"]', config.email);
            await page.click('button:has-text("Next"), #logOnFormSubmit');
            
            await page.waitForSelector('input[type="password"]', { timeout: 10000 });
            await page.fill('input[type="password"]', config.pass);
            
            // 尝试勾选记住我
            await page.locator('label:has-text("Remember"), label:has-text("保持")').click().catch(() => {});
            
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
                page.click('button:has-text("Log On"), button:has-text("Next"), #logOnFormSubmit')
            ]);
        }

        // 处理弹窗
        const okBtn = page.locator('button:has-text("OK"), .sapMDialog button').first();
        if (await okBtn.isVisible({ timeout: 10000 })) {
            console.log('处理隐私弹窗...');
            await okBtn.click();
        }

        // 工作区管理
        console.log('定位工作区管理器...');
        const frame = page.frameLocator('#ws-manager');
        const status = frame.locator('#ErrorMsg0');
        
        await status.waitFor({ state: 'visible', timeout: 30000 });
        const text = await status.innerText();
        console.log(`当前状态: ${text}`);

        if (text.includes('STOPPED')) {
            console.log('正在点击启动按钮...');
            await frame.locator('button:has(svg[data-icon="play-circle"])').click();
            await status.getByText('RUNNING').waitFor({ state: 'visible', timeout: 240000 });
            console.log('工作区已启动！');
        }

        // 进入 IDE
        const finalUrl = `${config.url.split('#')[0]}#${config.wsid}`;
        await page.goto(finalUrl, { waitUntil: 'networkidle' });
        console.log('已进入 IDE 界面，保活任务完成。');

        // 截图留存
        const scPath = path.join(os.tmpdir(), `bas-success-${Date.now()}.png`);
        await page.screenshot({ path: scPath });
        console.log(`截图已保存: ${scPath}`);

    } catch (err) {
        console.error(`任务失败: ${err.message}`);
        await page.screenshot({ path: path.join(os.tmpdir(), `bas-error-${Date.now()}.png`) }).catch(() => {});
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
