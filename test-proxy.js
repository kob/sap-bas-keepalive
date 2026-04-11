// 测试代理配置
require('dotenv').config();

// 从keepalive.js导入函数
const fs = require('fs');
const path = require('path');

// 读取keepalive.js内容并提取函数
const keepaliveContent = fs.readFileSync(path.join(__dirname, 'keepalive.js'), 'utf8');

// 手动定义函数（简化版）
function processUrlWithProxy(originalUrl) {
    const proxyMode = process.env.PROXY_MODE || 'direct';
    
    if (proxyMode === 'cf-worker') {
        const workerUrl = process.env.CF_WORKER_URL;
        if (workerUrl && workerUrl.trim()) {
            try {
                const proxyUrl = new URL(workerUrl);
                proxyUrl.searchParams.set('url', originalUrl);
                return proxyUrl.toString();
            } catch (e) {
                console.warn(`Cloudflare Worker URL处理失败: ${e.message}`);
            }
        }
    }
    return originalUrl;
}

// 测试URL
const testUrls = [
    'https://39a6e423trial.ap21cf.trial.applicationstudio.cloud.sap',
    'https://d759df47trial.ap21cf.trial.applicationstudio.cloud.sap',
    'https://8c7ac2b0trial.ap21cf.trial.applicationstudio.cloud.sap'
];

console.log('当前代理配置:');
console.log(`PROXY_MODE: ${process.env.PROXY_MODE || '未设置'}`);
console.log(`CF_WORKER_URL: ${process.env.CF_WORKER_URL || '未设置'}`);
console.log('\n测试URL转换:');

testUrls.forEach((url, index) => {
    const processed = processUrlWithProxy(url);
    console.log(`\n原始URL ${index + 1}: ${url}`);
    console.log(`处理后URL: ${processed}`);
});