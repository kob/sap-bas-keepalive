const { chromium } = require('playwright');

// 检查必需的环境变量
if (!process.env.BAS_EMAIL || !process.env.BAS_PASSWORD || !process.env.BAS_URL) {
    console.error('错误: 请设置环境变量 BAS_EMAIL, BAS_PASSWORD 和 BAS_URL');
    process.exit(1);
}

(async () => {
    const browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    const targetUrl = process.env.BAS_URL;

    console.log('正在打开 BAS 主页...');

    try {
        // 1. 访问页面
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

        // 2. 执行登录逻辑
        if (page.url().includes('authentication') || page.url().includes('login')) {
            console.log('检测到登录页，开始输入凭据...');
            const emailSelector = 'input[name="j_username"], input[type="email"], input[name="login"]';
            await page.waitForSelector(emailSelector, { timeout: 20000 });
            await page.fill(emailSelector, process.env.BAS_EMAIL);
            
            const nextBtn = 'button:has-text("Next"), #logOnFormSubmit, input[type="submit"]';
            await page.click(nextBtn);

            const passSelector = 'input[name="j_password"], input[type="password"]';
            await page.waitForSelector(passSelector, { timeout: 20000 });
            await page.fill(passSelector, process.env.BAS_PASSWORD);
            await page.click(nextBtn);
            
            console.log('登录表单已提交，等待跳转...');
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 45000 })
                .catch(() => console.log('等待跳转超时，尝试继续执行...'));
        }

        // 3. 处理登录后的隐私声明弹窗
        console.log('正在检查登录后的隐私弹窗...');
        const checkbox = page.locator('input[type="checkbox"], .sapCheckbox');
        const okButton = page.locator('button:has-text("OK"), .sapButtonOK');

        try {
            await okButton.waitFor({ state: 'visible', timeout: 15000 });
            if (await checkbox.isVisible()) {
                console.log('勾选 "Do not show this message again"...');
                await checkbox.check();
            }
            console.log('点击登录后的 OK 按钮...');
            await okButton.click();
            await page.waitForTimeout(3000);
        } catch (e) {
            console.log('未检测到弹窗或弹窗未加载，跳过弹窗处理。');
        }

        // 4. 等待主页面的 ws-manager iframe 元素出现并可见
        console.log('等待主页面中的 ws-manager iframe 元素...');
        const iframeElement = page.locator('#ws-manager');
        await iframeElement.waitFor({ state: 'visible', timeout: 30000 });
        console.log('主页面中的 ws-manager iframe 元素已找到并可见。');

        // 5. 获取 iframe 的引用
        console.log('正在获取 ws-manager iframe 的引用...');
        const wsManagerFrame = page.frame({ name: 'ws-manager' }) || page.frame({ id: 'ws-manager' });
        
        if (!wsManagerFrame) {
            throw new Error('无法找到 ID 或 name 为 "ws-manager" 的 iframe。');
        }
        console.log('已成功获取 ws-manager iframe 的引用。');

        // 6. 等待 iframe 内部的 DOM 加载
        console.log('等待 ws-manager iframe 内部内容加载...');
        // 等待 iframe 内部的 body 元素出现
        await wsManagerFrame.waitForLoadState('domcontentloaded', { timeout: 30000 });
        console.log('ws-manager iframe 内部 DOM 已加载。');

        // 7. 等待 iframe 内部的网络请求平息，确保数据加载完成
        console.log('等待 ws-manager iframe 内部网络请求完成...');
        await wsManagerFrame.waitForLoadState('networkidle', { timeout: 45000 });
        console.log('ws-manager iframe 内部网络活动已平息，内容应已完全加载。');

        // 8. 检查工作区状态 ---
        console.log('检查当前工作区状态...');

        // 检查是否为 STOPPED 状态
        const stoppedStatusLocator = wsManagerFrame.locator(`#ErrorMsg0:has-text("STOPPED")`);
        const isStopped = await stoppedStatusLocator.count() > 0 && await stoppedStatusLocator.isVisible();

        if (isStopped) {
            console.log('工作区当前状态为 STOPPED，准备启动...');
        } else {
            console.log('工作区当前状态不是 STOPPED，跳过启动步骤');
            // 跳过后续的启动操作
            return;
        }

        // 9. 在 iframe 内部寻找包含 "play-circle" 图标的按钮并点击
        console.log('在 iframe 中寻找包含 "play-circle" 图标的启动按钮...');
        const startButtonInFrame = wsManagerFrame.locator('button:has(svg[data-icon="play-circle"])');
        
        await startButtonInFrame.waitFor({ state: 'visible', timeout: 30000 });
        console.log('在 iframe 中找到启动按钮 (包含 play-circle 图标)，正在点击...');
        await startButtonInFrame.click();
        
        console.log('启动按钮已点击，等待工作区变为 RUNNING 状态...');

        // 10. 等待工作区变为 RUNNING 状态,使用 iframe 中的状态元素进行等待
        const runningStatusLocator = wsManagerFrame.locator(`#ErrorMsg0:has-text("RUNNING")`);
        await runningStatusLocator.waitFor({ state: 'visible', timeout: 120000 }); // 增加超时时间，启动可能需要几分钟
        console.log('工作区已进入 RUNNING 状态！');


    } catch (err) {
        console.error('错误详情:', err.message);
    } finally {
        await browser.close();
    }
})();