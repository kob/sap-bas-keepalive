require('dotenv').config();
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

/**
 * 解析账号配置，支持多账号
 * 按索引读取 BAS_URL_1/BAS_EMAIL_1/BAS_PASSWORD_1/BAS_WSID_1, BAS_URL_2/... 等
 * 如果没有带索引的变量，回退到 BAS_URL/BAS_EMAIL/BAS_PASSWORD/BAS_WSID 单账号模式
 */
function parseAccounts() {
    const accounts = [];

    // 尝试按索引读取多账号
    for (let i = 1; ; i++) {
        const url = process.env[`BAS_URL_${i}`];
        if (!url || !url.trim()) break;
        const email = process.env[`BAS_EMAIL_${i}`];
        const password = process.env[`BAS_PASSWORD_${i}`];
        const wsid = process.env[`BAS_WSID_${i}`];
        const name = process.env[`BAS_NAME_${i}`]?.trim() || `账号${i}`;

        if (!email || !password || !wsid) {
            throw new Error(`账号 ${i} (BAS_URL_${i}) 缺少必填字段 BAS_EMAIL_${i}/BAS_PASSWORD_${i}/BAS_WSID_${i}`);
        }

        accounts.push({
            name,
            url: url.trim(),
            email: email.trim(),
            password: password.trim(),
            wsid: wsid.trim(),
        });
    }

    if (accounts.length > 0) {
        return accounts;
    }

    // 单账号模式（不带索引）
    return [{
        name: '默认账号',
        url: getRequiredEnv('BAS_URL'),
        email: getRequiredEnv('BAS_EMAIL'),
        password: getRequiredEnv('BAS_PASSWORD'),
        wsid: getRequiredEnv('BAS_WSID'),
    }];
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

/**
 * 对单个账号执行保活操作
 */
async function keepaliveOne(browser, account, globalOptions) {
    const { postPrivacyWaitMs, rememberMeWaitMs } = globalOptions;
    const prefix = `[${account.name}]`;

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    try {
        console.log(`${prefix} 正在打开 BAS 主页...`);

        // 1. 访问页面
        await page.goto(account.url, { waitUntil: 'networkidle', timeout: 60000 });

        // 2. 执行登录逻辑
        if (page.url().includes('authentication') || page.url().includes('login')) {
            console.log(`${prefix} 检测到登录页，开始输入凭据...`);
            const emailSelector = 'input[name="j_username"], input[type="email"], input[name="login"]';
            await page.waitForSelector(emailSelector, { timeout: 20000 });
            await page.fill(emailSelector, account.email);

            const nextBtn = 'button:has-text("Next"), #logOnFormSubmit, input[type="submit"]';
            await page.click(nextBtn);

            const passSelector = 'input[name="j_password"], input[type="password"]';
            await page.waitForSelector(passSelector, { timeout: 3000 });
            await page.fill(passSelector, account.password);

            // 勾选"保持登录"复选框
            console.log(`${prefix} 正在查找"保持登录"复选框...`);
            try {
                const checked = await tryCheckRememberMe(page, { timeoutMs: rememberMeWaitMs });
                if (checked) {
                    console.log(`${prefix} 找到"保持登录"复选框，正在勾选...`);
                } else {
                    console.log(`${prefix} 未找到"保持登录"复选框`);
                }
            } catch (e) {
                console.log(`${prefix} 未检测到"保持登录"复选框，跳过`);
            }

            await page.click(nextBtn);

            console.log(`${prefix} 登录表单已提交，等待跳转...`);
            // 等待页面跳转完成（登录后通常跳转到主页）
            try {
                await page.waitForURL(url => !url.includes('authentication') && !url.includes('login'), { timeout: 30000 });
            } catch (e) {
                console.log(`${prefix} 等待跳转超时，尝试继续执行...`);
            }
            // 等待页面内容加载
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(3000);
        }

        // 3. 处理登录后的隐私声明弹窗
        console.log(`${prefix} 正在检查登录后的隐私弹窗...`);
        try {
            const handled = await handlePrivacyPopup(page, { timeoutMs: 15000, postClickWaitMs });
            if (handled) {
                console.log(`${prefix} 已勾选隐私弹窗并点击 OK。`);
            } else {
                console.log(`${prefix} 未检测到登录后隐私弹窗，跳过。`);
            }
        } catch (e) {
            console.log(`${prefix} 未检测到弹窗或弹窗未加载，跳过弹窗处理。`);
        }

        // 4. 等待主页面的 ws-manager iframe 元素出现并可见
        console.log(`${prefix} 等待主页面中的 ws-manager iframe 元素...`);
        // 先确保页面完全加载
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        const iframeElement = page.locator('#ws-manager');
        await iframeElement.waitFor({ state: 'visible', timeout: 60000 });
        console.log(`${prefix} 主页面中的 ws-manager iframe 元素已找到并可见。`);

        // 5. 获取 iframe 的引用
        console.log(`${prefix} 正在获取 ws-manager iframe 的引用...`);
        const iframeHandle = await iframeElement.elementHandle();
        const wsManagerFrame = iframeHandle ? await iframeHandle.contentFrame() : null;

        if (!wsManagerFrame) {
            throw new Error('无法找到 ID 或 name 为 "ws-manager" 的 iframe。');
        }
        console.log(`${prefix} 已成功获取 ws-manager iframe 的引用。`);

        // 6. 等待 iframe 内部的 DOM 加载
        console.log(`${prefix} 等待 ws-manager iframe 内部内容加载...`);
        await wsManagerFrame.waitForLoadState('domcontentloaded', { timeout: 30000 });
        console.log(`${prefix} ws-manager iframe 内部 DOM 已加载。`);

        // 7. 等待 iframe 内部的网络请求平息
        console.log(`${prefix} 等待 ws-manager iframe 内部网络请求完成...`);
        try {
            await wsManagerFrame.waitForLoadState('networkidle', { timeout: 30000 });
            console.log(`${prefix} ws-manager iframe 内部网络活动已平息。`);
        } catch (e) {
            console.log(`${prefix} 网络请求未完全平息，但 DOM 已加载，继续执行...`);
        }

        // 8. 检查工作区状态并决定下一步
        console.log(`${prefix} 检查当前工作区状态...`);
        const runningStatusLocator = wsManagerFrame.locator(`#ErrorMsg0:has-text("RUNNING")`);
        const stoppedStatusLocator = wsManagerFrame.locator(`#ErrorMsg0:has-text("STOPPED")`);

        const isRunning = await runningStatusLocator.count() > 0 && await runningStatusLocator.isVisible();
        if (isRunning) {
            console.log(`${prefix} 工作区当前状态已经是 RUNNING，跳过启动步骤。`);
        } else {
            const isStopped = await stoppedStatusLocator.count() > 0 && await stoppedStatusLocator.isVisible();
            if (isStopped) {
                console.log(`${prefix} 工作区当前状态为 STOPPED，准备启动...`);

                // 9. 在 iframe 内部寻找启动按钮并点击
                console.log(`${prefix} 在 iframe 中寻找启动按钮...`);
                const startButtonInFrame = wsManagerFrame.locator('button:has(svg[data-icon="play-circle"])');
                await startButtonInFrame.waitFor({ state: 'visible', timeout: 30000 });
                console.log(`${prefix} 找到启动按钮，正在点击...`);
                await startButtonInFrame.click();
                console.log(`${prefix} 启动按钮已点击，等待工作区变为 RUNNING 状态...`);

                // 10. 等待工作区变为 RUNNING 状态
                await runningStatusLocator.waitFor({ state: 'visible', timeout: 120000 });
                console.log(`${prefix} 工作区已进入 RUNNING 状态！`);
            } else {
                throw new Error('无法识别工作区当前状态，既不是 STOPPED 也不是 RUNNING。');
            }
        }

        // 11. 进入工作区
        console.log(`${prefix} 正在进入工作区...`);
        const workspaceUrl = `${account.url}#${account.wsid}`;
        console.log(`${prefix} 工作区链接: ${workspaceUrl}`);
        await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForTimeout(10000);
        console.log(`${prefix} 已成功进入工作区！`);

        // 12. 处理进入工作区后的隐私声明弹框
        console.log(`${prefix} 正在检查工作区内的隐私声明弹框...`);
        try {
            const handledInWorkspace = await handlePrivacyPopup(page, { timeoutMs: 10000, postClickWaitMs });
            if (handledInWorkspace) {
                console.log(`${prefix} 工作区隐私声明弹框已处理。`);
            } else {
                console.log(`${prefix} 未检测到工作区隐私弹框，跳过。`);
            }
        } catch (e) {
            console.log(`${prefix} 未检测到工作区隐私弹框，跳过。`);
        }

        // 13. 等待30秒后截图保存
        console.log(`${prefix} 等待30秒...`);
        await page.waitForTimeout(30000);
        console.log(`${prefix} 正在截图...`);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeName = account.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_');
        const screenshotPath = path.join(os.tmpdir(), `bas-keepalive-${safeName}-${timestamp}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        console.log(`${prefix} 截图已保存到: ${screenshotPath}`);

        console.log(`${prefix} ✅ 保活完成！`);
    } catch (err) {
        console.error(`${prefix} ❌ 错误详情: ${err.message}`);
    } finally {
        await context.close();
    }
}

(async () => {
    const accounts = parseAccounts();
    const globalOptions = {
        postPrivacyWaitMs: getOptionalNumberEnv('BAS_POST_PRIVACY_WAIT_MS', 800),
        rememberMeWaitMs: getOptionalNumberEnv('BAS_REMEMBER_WAIT_MS', 1800),
    };

    console.log(`共 ${accounts.length} 个账号需要保活，开始轮流执行...\n`);

    const browser = await chromium.launch({
        headless: true,
        slowMo: 100,
        args: process.platform === 'linux'
            ? ['--no-sandbox', '--disable-setuid-sandbox']
            : []
    });

    try {
        const results = await Promise.allSettled(
            accounts.map((account, i) => {
                console.log(`========== ${account.name} (${i + 1}/${accounts.length}) ==========`);
                return keepaliveOne(browser, account, globalOptions);
            })
        );

        // 输出汇总
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        console.log(`\n========== 执行汇总：成功 ${succeeded}/${accounts.length}，失败 ${failed} ==========`);
    } finally {
        await browser.close();
    }

    console.log('\n========== 全部账号保活完成 ==========');
})();
