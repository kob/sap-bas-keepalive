require('dotenv').config();
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');

/**
 * 获取代理服务器配置
 * 支持格式：
 * - http://proxy.example.com:8080
 * - socks5://proxy.example.com:1080
 * - 空字符串表示不使用代理
 */
function getProxyConfig() {
    const proxyUrl = process.env.PROXY_URL || '';
    if (!proxyUrl || !proxyUrl.trim()) {
        return null;
    }
    
    try {
        const url = new URL(proxyUrl);
        return {
            server: proxyUrl,
            // 对于SAP BAS服务，我们可能需要绕过某些域名
            bypass: process.env.PROXY_BYPASS || 'localhost,127.0.0.1,*.cloud.sap'
        };
    } catch (e) {
        console.warn(`代理URL格式错误: ${proxyUrl}, 错误: ${e.message}`);
        return null;
    }
}

/**
 * 处理URL，如果需要通过代理重写
 * 支持Cloudflare Worker反代模式
 */
function processUrlWithProxy(originalUrl) {
    const proxyMode = process.env.PROXY_MODE || 'direct'; // direct, cf-worker, custom-proxy
    
    if (proxyMode === 'cf-worker') {
        const workerUrl = process.env.CF_WORKER_URL;
        if (workerUrl && workerUrl.trim()) {
            try {
                const urlObj = new URL(originalUrl);
                // 通过Worker代理
                const proxyUrl = new URL(workerUrl);
                proxyUrl.pathname = urlObj.pathname;
                proxyUrl.search = urlObj.search;
                proxyUrl.hash = urlObj.hash;
                return proxyUrl.toString();
            } catch (e) {
                console.warn(`Cloudflare Worker URL处理失败: ${e.message}`);
            }
        }
    } else if (proxyMode === 'custom-proxy') {
        const customProxyBase = process.env.CUSTOM_PROXY_BASE;
        if (customProxyBase && customProxyBase.trim()) {
            try {
                const urlObj = new URL(originalUrl);
                const proxyUrl = new URL(customProxyBase);
                // 将目标主机名作为子域名或路径
                proxyUrl.hostname = `${urlObj.hostname}.${proxyUrl.hostname}`;
                proxyUrl.pathname = urlObj.pathname;
                proxyUrl.search = urlObj.search;
                proxyUrl.hash = urlObj.hash;
                return proxyUrl.toString();
            } catch (e) {
                console.warn(`自定义代理URL处理失败: ${e.message}`);
            }
        }
    }
    
    return originalUrl; // 直接模式，返回原始URL
}

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
 * 优先级：ACCOUNTS JSON > 逐行索引 BAS_URL_1/... > 单账号 BAS_URL/...
 */
function parseAccounts() {
    // 1. 优先使用 ACCOUNTS JSON（适合 GitHub Actions 只设一个 secret）
    const accountsRaw = process.env.ACCOUNTS;
    if (accountsRaw && accountsRaw.trim()) {
        try {
            const arr = JSON.parse(accountsRaw);
            if (!Array.isArray(arr) || arr.length === 0) {
                throw new Error('ACCOUNTS 必须是非空 JSON 数组');
            }
            return arr.map((acc, i) => {
                if (!acc.url || !acc.email || !acc.password || !acc.wsid) {
                    throw new Error(`ACCOUNTS[${i}] 缺少必填字段 (url/email/password/wsid)`);
                }
                return {
                    name: acc.name?.trim() || `账号${i + 1}`,
                    url: acc.url.trim(),
                    email: acc.email.trim(),
                    password: acc.password.trim(),
                    wsid: acc.wsid.trim(),
                };
            });
        } catch (e) {
            throw new Error(`ACCOUNTS 解析失败: ${e.message}`);
        }
    }

    // 2. 逐行索引模式（适合 .env 文件，每个账号写一行）
    const accounts = [];
    for (let i = 1; ; i++) {
        const url = process.env[`BAS_URL_${i}`];
        if (!url || !url.trim()) break;
        const email = process.env[`BAS_EMAIL_${i}`];
        const password = process.env[`BAS_PASSWORD_${i}`];
        const wsid = process.env[`BAS_WSID_${i}`];
        const name = process.env[`BAS_NAME_${i}`]?.trim() || `账号${i}`;

        if (!email || !email.trim() || !password || !password.trim() || !wsid || !wsid.trim()) {
            console.warn(`⚠️ 跳过账号 ${i} (BAS_URL_${i}): 缺少必填字段 BAS_EMAIL_${i}/BAS_PASSWORD_${i}/BAS_WSID_${i}`);
            continue;
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

    // 3. 单账号模式（不带索引）
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

/**
 * 关闭可能遮挡页面的所有弹框（模态框、遮罩层）
 */
async function closeAllBlockingDialogs(page) {
    try {
        // 查找所有 role="dialog" 或 modal 类名的元素
        const dialogs = page.locator('[role="dialog"], .modal, .popup, .dialog, .modal-dialog, .sapMDialog');
        const count = await dialogs.count();
        for (let i = 0; i < count; i++) {
            const dialog = dialogs.nth(i);
            try {
                if (await dialog.isVisible()) {
                    // 查找关闭按钮（X、关闭、取消、OK、确定）
                    const closeButtons = dialog.locator('[aria-label*="close" i], button:has-text("Close"), button:has-text("关闭"), .close-btn, [data-testid*="close"], .sapButtonOK, button:has-text("OK"), button:has-text("确定")');
                    for (let j = 0; j < await closeButtons.count(); j++) {
                        try {
                            const btn = closeButtons.nth(j);
                            if (await btn.isVisible()) {
                                await btn.click();
                                await page.waitForTimeout(300);
                                break;
                            }
                        } catch (_) {}
                    }
                }
            } catch (_) {}
        }

        // 查找遮罩层（overlay/backdrop）并点击以关闭
        const overlays = page.locator('.overlay, .backdrop, .modal-backdrop, [class*="overlay"], [class*="backdrop"]');
        for (let i = 0; i < await overlays.count(); i++) {
            try {
                const overlay = overlays.nth(i);
                if (await overlay.isVisible()) {
                    await overlay.click({ force: true });
                    await page.waitForTimeout(200);
                }
            } catch (_) {}
        }

        // 尝试按下 Escape 键关闭模态框
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
    } catch (e) {
        // 忽略任何错误，不让它影响主流程
    }
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
 * 处理登录后进入的页面的隐私环节（不是弹窗，而是页面的一部分）
 * 需要勾选 <input type="checkbox" id="do-not-show-checkbox" name="do-not-show-checkbox">
 * 然后点击 <button id="confirm-notification-btn" type="button" class="notification-btn">OK</button>
 */
async function handleIndexPagePrivacyPopup(page, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15000;
    const prefix = options.prefix || '';
    
    console.log(`${prefix}检查登录后页面的隐私环节...`);
    
    // 这不是一个弹窗，而是页面中的一部分，所以直接查找元素
    // 先尝试查找复选框
    const checkboxCandidates = [
        page.locator('input#do-not-show-checkbox[name="do-not-show-checkbox"]').first(),
        page.locator('#do-not-show-checkbox').first(),
        page.locator('input[type="checkbox"][id*="do-not-show"]').first(),
        page.locator('input[type="checkbox"][name*="do-not-show"]').first(),
        page.getByLabel(/do not show this message again|不再显示|不再提示/i).first(),
    ];

    let foundCheckbox = false;
    let checkboxElement = null;
    
    for (const checkbox of checkboxCandidates) {
        try {
            await checkbox.waitFor({ state: 'visible', timeout: 5000 });
            foundCheckbox = true;
            checkboxElement = checkbox;
            console.log(`${prefix}找到"不再显示"复选框`);
            break;
        } catch (e) {
            // 尝试下一个候选
        }
    }

    // 如果没有找到复选框，可能这个环节不存在
    if (!foundCheckbox) {
        console.log(`${prefix}未找到"不再显示"复选框，可能此环节不存在`);
        return false;
    }

    // 勾选复选框
    console.log(`${prefix}正在勾选"不再显示"复选框...`);
    let checked = false;
    try {
        await checkboxElement.check({ force: true });
        const isChecked = await checkboxElement.isChecked().catch(() => false);
        if (!isChecked) {
            await checkboxElement.click({ force: true });
        }
        if (await checkboxElement.isChecked().catch(() => false)) {
            checked = true;
            console.log(`${prefix}已成功勾选"不再显示"复选框`);
        }
    } catch (e) {
        console.log(`${prefix}勾选复选框失败: ${e.message}`);
    }

    if (!checked) {
        console.log(`${prefix}尝试通过文本点击复选框`);
        const labelCandidates = [
            page.getByText(/do not show this message again|不再显示|不再提示/i).first(),
            page.locator('label:has-text("Do not show this message again"), label:has-text("不再显示"), label:has-text("不再提示")').first()
        ];
        for (const label of labelCandidates) {
            try {
                await label.waitFor({ state: 'visible', timeout: 2000 });
                await label.click({ force: true });
                checked = true;
                console.log(`${prefix}通过文本点击成功勾选复选框`);
                break;
            } catch (e) {
                // 继续尝试
            }
        }
    }

    // 点击OK按钮
    console.log(`${prefix}正在点击OK按钮...`);
    const okButtonCandidates = [
        page.locator('button#confirm-notification-btn.notification-btn').first(),
        page.locator('#confirm-notification-btn').first(),
        page.locator('button:has-text("OK")').first(),
        page.getByRole('button', { name: /^OK$/i }).first(),
        page.locator('.notification-btn:has-text("OK")').first(),
    ];

    let clicked = false;
    for (const button of okButtonCandidates) {
        try {
            await button.waitFor({ state: 'visible', timeout: 5000 });
            await button.click();
            clicked = true;
            console.log(`${prefix}已成功点击OK按钮`);
            break;
        } catch (e) {
            // 尝试下一个按钮
        }
    }

    if (!clicked) {
        console.log(`${prefix}未能点击OK按钮，尝试通过JavaScript点击`);
        try {
            await page.evaluate(() => {
                const btn = document.querySelector('button#confirm-notification-btn');
                if (btn) btn.click();
            });
            clicked = true;
        } catch (e) {
            console.log(`${prefix}通过JavaScript点击也失败`);
        }
    }

    // 等待页面反应
    await page.waitForTimeout(2000);
    
    if (checked && clicked) {
        console.log(`${prefix}成功处理登录后页面的隐私环节`);
        return true;
    } else {
        console.log(`${prefix}部分处理登录后页面的隐私环节（复选框: ${checked}, OK按钮: ${clicked})`);
        return false;
    }
}

/**
 * 对单个账号执行保活操作
 * 返回 true 表示成功，抛出异常表示失败
 */
async function keepaliveOne(browser, account, globalOptions, proxyConfig) {
    const { postPrivacyWaitMs, rememberMeWaitMs } = globalOptions;
    const prefix = `[${account.name}]`;

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        proxy: proxyConfig // 添加代理配置
    });
    const page = await context.newPage();
    let success = false;

    try {
        console.log(`${prefix} 正在打开 BAS 主页...`);

        // 1. 访问页面（使用代理处理后的URL）
        const processedUrl = processUrlWithProxy(account.url);
        console.log(`${prefix} 原始URL: ${account.url}`);
        console.log(`${prefix} 处理后URL: ${processedUrl}`);
        await page.goto(processedUrl, { waitUntil: 'networkidle', timeout: 60000 });

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

        // 3.5 处理登录后页面的隐私环节（登录后进入的页面）
        console.log(`${prefix} 检查登录后页面的隐私环节...`);
        try {
            const handledIndex = await handleIndexPagePrivacyPopup(page, { 
                timeoutMs: 10000, 
                prefix: prefix 
            });
            if (handledIndex) {
                console.log(`${prefix} 已处理登录后页面的隐私环节。`);
            } else {
                console.log(`${prefix} 未检测到登录后页面的隐私环节，跳过。`);
            }
        } catch (e) {
            console.log(`${prefix} 处理登录后页面隐私环节时出错: ${e.message}`);
        }

        // 4. 等待主页面的 ws-manager iframe 元素
        console.log(`${prefix} 等待主页面中的 ws-manager iframe 元素...`);
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        
        // 先尝试关闭可能遮挡的弹框
        await closeAllBlockingDialogs(page);
        await page.waitForTimeout(500);

        const iframeElement = page.locator('#ws-manager');

        // 先等 iframe 存在于 DOM，再等可见；如果一直 hidden，尝试刷新一次
        await iframeElement.waitFor({ state: 'attached', timeout: 30000 });
        console.log(`${prefix} iframe 已存在于 DOM，等待变为可见...`);

        try {
            await iframeElement.waitFor({ state: 'visible', timeout: 30000 });
        } catch (e) {
            // iframe hidden 可能是因为弹框遮挡，再尝试关一次弹框
            await closeAllBlockingDialogs(page);
            await page.waitForTimeout(1000);
            await iframeElement.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {
                console.log(`${prefix} iframe 仍为 hidden，尝试刷新页面...`);
                throw e;
            });
        }
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
        const baseUrl = account.url.split('#')[0]; // 移除可能存在的hash
        const processedBaseUrl = processUrlWithProxy(baseUrl);
        const workspaceUrl = `${processedBaseUrl}#${account.wsid}`;
        console.log(`${prefix} 工作区链接: ${workspaceUrl}`);
        await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded', timeout: 180000 }); // 增加超时到3分钟
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
        success = true;
    } catch (err) {
        console.error(`${prefix} ❌ 错误详情: ${err.message}`);
        // 失败时截图用于诊断
        try {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const safeName = account.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_');
            const failPath = path.join(os.tmpdir(), `bas-fail-${safeName}-${ts}.png`);
            await page.screenshot({ path: failPath, fullPage: false });
            console.log(`${prefix} 失败截图已保存到: ${failPath}`);
        } catch (_) {}
        throw err; // 重新抛出，让 Promise.allSettled 捕获
    } finally {
        await context.close();
    }
    return success;
}

(async () => {
    const accounts = parseAccounts();
    const globalOptions = {
        postPrivacyWaitMs: getOptionalNumberEnv('BAS_POST_PRIVACY_WAIT_MS', 800),
        rememberMeWaitMs: getOptionalNumberEnv('BAS_REMEMBER_WAIT_MS', 1800),
    };

    console.log(`共 ${accounts.length} 个账号需要保活，开始轮流执行...\n`);

    // 获取代理配置
    const proxyConfig = getProxyConfig();
    const proxyMode = process.env.PROXY_MODE || 'direct';
    
    console.log(`代理模式: ${proxyMode}`);
    if (proxyConfig) {
        console.log(`使用代理服务器: ${proxyConfig.server}`);
    }

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
                return keepaliveOne(browser, account, globalOptions, proxyConfig);
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
