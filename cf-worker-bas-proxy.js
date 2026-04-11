// Cloudflare Worker for SAP BAS 保活脚本
// 部署到：https://sap.kob8283.workers.dev
// 配置：PROXY_MODE=cf-worker, CF_WORKER_URL=https://sap.kob8283.workers.dev

export default {
  async fetch(request) {
    // 目标SAP BAS域名
    const TARGET_HOST = 'applicationstudio.cloud.sap';
    
    try {
      const url = new URL(request.url);
      
      // 从查询参数获取原始URL
      let targetUrl = url.searchParams.get('url');
      
      if (!targetUrl) {
        // 如果没有提供url参数，返回错误
        return new Response('缺少url参数。用法：https://sap.kob8283.workers.dev/?url=原始URL', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      
      // 确保目标URL是有效的SAP BAS URL
      const targetUrlObj = new URL(targetUrl);
      if (!targetUrlObj.hostname.endsWith(TARGET_HOST)) {
        return new Response(`仅支持代理 ${TARGET_HOST} 域名的请求`, {
          status: 403,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      
      // 创建新的请求
      const newRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });
      
      // 转发请求
      const response = await fetch(newRequest);
      
      // 返回响应
      return response;
      
    } catch (error) {
      return new Response(`代理请求失败: ${error.message}`, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
}