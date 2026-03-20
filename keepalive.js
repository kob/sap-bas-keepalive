const { chromium } = require('playwright');


const os = require('os');
const path = require('path');


function getRequiredEnv(name) {
    const value = process.env[name];
    if (!value || !value.trim()) {
        throw new Error(`缺少环境变量 ${name}`);
    }
    return value.trim();
}

function getOptionalNumberEnv(name, defaultValue) {
    const raw = process.env[name];
    if (!raw) {
        return defaultValue;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

async function tryCheckRememberMe(page, options = {}) {
    const totalTimeoutMs = options.timeoutMs ?? 1800;
    const deadline = Date.now() + totalTimeoutMs;
    const getRemainingTimeout = (maxPerAttempt) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            return 0;
        }
        return Math.min(maxPerAttempt, remaining);
    };

    const checkboxLocators = [
        page.locator('input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i], input[type="checkbox"][name*="keep" i], input[type="checkbox"][id*="keep" i]').first(),
        page.locator(':has-text("保持登录") input[type="checkbox"], :has-text("记住我") input[type="checkbox"], :has-text("保持登入") input[type="checkbox"]').first(),
        page.getByLabel(/keep me signed in|stay signed in|remember me|保持登录|记住我/i).first(),
        page.locator('label:has-text("Keep me signed in") input[type="checkbox"], label:has-text("Stay signed in") input[type="checkbox"], label:has-text("Remember me") input[type="checkbox"], label:has-text("保持登录") input[type="checkbox"], label:has-text("记住我") input[type="checkbox"]').first(),
        page.locator('input[type="checkbox"][data-testid*="remember"], input[type="checkbox"][id*="remember" i], input[type="checkbox"][id*="KeepSignedIn" i], input[type="checkbox"][name*="remember" i]').first()
    ];

    for (const checkbox of checkboxLocators) {
        try {
            const timeout = getRemainingTimeout(500);
            if (timeout <= 0) {
                break;
            }
            await checkbox.waitFor({ state: 'visible', timeout });
            await checkbox.check({ force: true });
            if (await checkbox.isChecked()) {
                return true;
            }
        } catch (e) {
            // 尝试下一个候选元素
        }
    }

    const textLocators = [
        page.getByText(/keep me signed in|stay signed in|remember me|保持登录|记住我/i).first(),
        page.locator('label:has-text("Keep me signed in"), label:has-text("Stay signed in"), label:has-text("Remember me"), label:has-text("保持登录"), label:has-text("记住我")').first()
    ];

    for (const textNode of textLocators) {
        try {
            const timeout = getRemainingTimeout(350);
            if (timeout <= 0) {
                break;
            }
            await textNode.waitFor({ state: 'visible', timeout });
            await textNode.click({ force: true });
            const checkedAfterTextClick = await page.locator('input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i], input[type="checkbox"][name*="keep" i], input[type="checkbox"][id*="keep" i], input[type="checkbox"]').evaluateAll((nodes) => {
                return nodes.some((n) => n.checked);
            }).catch(() => false);
            if (checkedAfterTextClick) {
                return true;
            }
        } catch (e) {
            // 尝试下一个候选元素
        }
    }

    const checkedByDomFallback = await page.evaluate(() => {
        const textPattern = /(keep me signed in|stay signed in|remember me|保持登录|记住我|保持登入)/i;
        const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));

        const isNearbyRememberText = (el) => {
            const candidates = [
                el.closest('label'),
                el.parentElement,
                el.parentElement?.parentElement,
                el.nextElementSibling,
                el.previousElementSibling
            ].filter(Boolean);

            return candidates.some((node) => textPattern.test((node.innerText || node.textContent || '').trim()));
        };

        const target = allCheckboxes.find((cb) => {
            const attrs = `${cb.name || ''} ${cb.id || ''} ${cb.getAttribute('data-testid') || ''}`;
            return /remember|keep/i.test(attrs) || isNearbyRememberText(cb);
        });

        if (!target) {
            return false;
        }

        target.click();
        if (!target.checked) {
            target.checked = true;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return target.checked;
    }).catch(() => false);

    if (checkedByDomFallback) {
        return true;
    }

    return false;
}

async function handlePrivacyPopup(page, options = {}) {
    const timeoutMs = options.timeoutMs ?? 12000;
    const postClickWaitMs = options.postClickWaitMs ?? 800;
    const privacyMarker = page.locator('#notification-content').filter({ hasText: /SAP Business Application Studio Trial Privacy Statement|privacy/i }).first();
    const privacyButtonMarker = page.locator('a#privacy-button.privacy-btn').filter({ hasText: /privacy/i }).first();
    const dialog = page.locator('.sapMDialog, [role="dialog"]').filter({ hasText: /privacy|Do not show this message again|Open Privacy Statement/i }).first();
    const okButtonByRole = page.getByRole('button', { name: /^OK$/i }).first();
    const okButtonFallback = page.locator('button:has-text("OK"), .sapButtonOK, .ok-btn').first();

    let popupVisible = false;
    try {
        await privacyMarker.waitFor({ state: 'visible', timeout: timeoutMs });
        popupVisible = true;
    } catch (e) {
        try {
            await privacyButtonMarker.waitFor({ state: 'visible', timeout: 2500 });
            popupVisible = true;
        } catch (markerError) {
            try {
                await dialog.waitFor({ state: 'visible', timeout: 3000 });
                popupVisible = true;
            } catch (innerError) {
                return false;
            }
        }
    }

    const checkboxCandidates = [
        page.locator('input#do-not-show-checkbox[name="do-not-show-checkbox"]').first(),
        page.locator('#do-not-show-checkbox').first(),
        page.getByLabel(/do not show this message again|不再显示|不再提示/i).first(),
        page.locator('label:has-text("Do not show this message again") input[type="checkbox"], label:has-text("不再显示") input[type="checkbox"], label:has-text("不再提示") input[type="checkbox"], input[type="checkbox"]').first()
    ];

    let checked = false;
    for (const checkbox of checkboxCandidates) {
        try {
            await checkbox.waitFor({ state: 'visible', timeout: 2000 });
            await checkbox.check({ force: true });
            const isChecked = await checkbox.isChecked().catch(() => false);
            if (!isChecked) {
                await checkbox.click({ force: true });
            }
            if (await checkbox.isChecked().catch(() => false)) {
                checked = true;
                break;
            }
        } catch (e) {
            // 尝试下一个候选复选框
        }
    }

    if (!checked) {
        const labelCandidates = [
            page.getByText(/do not show this message again|不再显示|不再提示/i).first(),
            page.locator('label:has-text("Do not show this message again"), label:has-text("不再显示"), label:has-text("不再提示")').first()
        ];
        for (const label of labelCandidates) {
            try {
                await label.waitFor({ state: 'visible', timeout: 1200 });
                await label.click({ force: true });
                checked = true;
                break;
            } catch (e) {
                // 尝试下一个候选文本
            }
        }
    }

    try {
        await okButtonByRole.waitFor({ state: 'visible', timeout: 3000 });
        await okButtonByRole.click();
    } catch (e) {
        await okButtonFallback.waitFor({ state: 'visible', timeout: 3000 });
        await okButtonFallback.click();
    }

    await page.waitForTimeout(postClickWaitMs);
    return popupVisible;
}

(async () => {
    const browser = await chromium.launch({ 
        headless: false,
        slowMo: 100,
        args: process.platform === 'linux'
            ? ['--no-sandbox', '--disable-setuid-sandbox']
            : []
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    const targetUrl = getRequiredEnv('BAS_URL');
    const basEmail = getRequiredEnv('BAS_EMAIL');
    const basPassword = getRequiredEnv('BAS_PASSWORD');
    const basWorkspaceId = getRequiredEnv('BAS_WSID');
    const postPrivacyWaitMs = getOptionalNumberEnv('BAS_POST_PRIVACY_WAIT_MS', 800);
    const rememberMeWaitMs = getOptionalNumberEnv('BAS_REMEMBER_WAIT_MS', 1800);

    console.log('正在打开 BAS 主页...');

    try {
        // 1. 访问页面
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

        // 2. 执行登录逻辑
        if (page.url().includes('authentication') || page.url().includes('login')) {
            console.log('检测到登录页，开始输入凭据...');
            const emailSelector = 'input[name="j_username"], input[type="email"], input[name="login"]';
            await page.waitForSelector(emailSelector, { timeout: 20000 });
            await page.fill(emailSelector, basEmail);

            const nextBtn = 'button:has-text("Next"), #logOnFormSubmit, input[type="submit"]';
            await page.click(nextBtn);

            const passSelector = 'input[name="j_password"], input[type="password"]';
            await page.waitForSelector(passSelector, { timeout: 3000 });
            await page.fill(passSelector, basPassword);

            // 勾选"保持登录"复选框
            console.log('正在查找"保持登录"复选框...');
            try {
                const checked = await tryCheckRememberMe(page, { timeoutMs: rememberMeWaitMs });
                if (checked) {
                    console.log('找到"保持登录"复选框，正在勾选...');
                } else {
                    console.log('未找到"保持登录"复选框');
                }
            } catch (e) {
                console.log('未检测到"保持登录"复选框，跳过');
            }

            await page.click(nextBtn);

            console.log('登录表单已提交，等待跳转...');
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 3000 })
                .catch(() => console.log('等待跳转超时，尝试继续执行...'));
        }

        // 3. 处理登录后的隐私声明弹窗
        console.log('正在检查登录后的隐私弹窗...');
        try {
            const handled = await handlePrivacyPopup(page, { timeoutMs: 15000, postClickWaitMs: postPrivacyWaitMs });
            if (handled) {
                console.log('已勾选隐私弹窗并点击 OK。');
            } else {
                console.log('未检测到登录后隐私弹窗，跳过。');
            }
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
        const iframeHandle = await iframeElement.elementHandle();
        const wsManagerFrame = iframeHandle ? await iframeHandle.contentFrame() : null;
        
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
        try {
            await wsManagerFrame.waitForLoadState('networkidle', { timeout: 30000 });
            console.log('ws-manager iframe 内部网络活动已平息，内容应已完全加载。');
        } catch (e) {
            console.log('网络请求未完全平息，但 DOM 已加载，继续执行...');
        }

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

        // 11. 进入工作区
        console.log('正在进入工作区...');
        const workspaceUrl = `${targetUrl}#${basWorkspaceId}`;
        console.log(`工作区链接: ${workspaceUrl}`);
        await page.goto(workspaceUrl, { waitUntil: 'networkidle', timeout: 60000 });
        console.log('已成功进入工作区！');

        // 12. 处理进入工作区后的隐私声明弹框
        console.log('正在检查工作区内的隐私声明弹框...');
        try {
            const handledInWorkspace = await handlePrivacyPopup(page, { timeoutMs: 10000, postClickWaitMs: postPrivacyWaitMs });
            if (handledInWorkspace) {
                console.log('工作区隐私声明弹框已处理。');
            } else {
                console.log('未检测到工作区隐私弹框，跳过。');
            }
        } catch (e) {
            console.log('未检测到工作区隐私弹框，跳过。');
        }

        // 13. 等待30秒后截图保存
        console.log('等待30秒...');
        await page.waitForTimeout(30000);
        console.log('正在截图...');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const screenshotPath = path.join(os.tmpdir(), `bas-keepalive-${timestamp}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        console.log(`截图已保存到: ${screenshotPath}`);

    } catch (err) {
        console.error('错误详情:', err.message);
    } finally {
        await browser.close();
    }
})();
