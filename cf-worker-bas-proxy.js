// Cloudflare Worker for SAP BAS 保活脚本 - 增强版
// 部署到：https://sap.kob8283.workers.dev
// 配置：PROXY_MODE=cf-worker, CF_WORKER_URL=https://sap.kob8283.workers.dev
//
// 支持CORS、Cookies和重定向处理，解决跨域安全问题

export default {
  async fetch(request) {
    // 目标SAP BAS域名
    const TARGET_HOST = 'applicationstudio.cloud.sap';
    
    // 处理预检请求（OPTIONS）
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400',
        }
      });
    }
    
    try {
      const url = new URL(request.url);
      
      // 从查询参数获取原始URL
      let targetUrl = url.searchParams.get('url');
      
      if (!targetUrl) {
        // 如果没有提供url参数，返回错误
        return new Response('缺少url参数。用法：https://sap.kob8283.workers.dev/?url=原始URL', {
          status: 400,
          headers: { 
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      
      // 确保目标URL是有效的SAP BAS URL
      const targetUrlObj = new URL(targetUrl);
      if (!targetUrlObj.hostname.endsWith(TARGET_HOST)) {
        return new Response(`仅支持代理 ${TARGET_HOST} 域名的请求`, {
          status: 403,
          headers: { 
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      
      // 准备请求头 - 移除可能引起问题的头
      const requestHeaders = new Headers(request.headers);
      
      // 修改Host头为目标主机
      requestHeaders.set('Host', targetUrlObj.hostname);
      
      // 移除可能引起CORS问题的头
      requestHeaders.delete('Origin');
      requestHeaders.delete('Referer');
      
      // 创建新的请求
      const newRequest = new Request(targetUrl, {
        method: request.method,
        headers: requestHeaders,
        body: request.body,
        redirect: 'follow' // 自动跟随重定向
      });
      
      // 转发请求，不传递cookieStore（避免跨域cookie问题）
      const response = await fetch(newRequest);
      
      // 处理响应头
      const responseHeaders = new Headers(response.headers);
      
      // 添加CORS头部
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');
      responseHeaders.set('Access-Control-Expose-Headers', '*');
      
      // 修改Set-Cookie头，确保它们能在代理环境中工作
      if (responseHeaders.has('Set-Cookie')) {
        const cookies = responseHeaders.get('Set-Cookie').split(', ');
        const updatedCookies = cookies.map(cookie => {
          // 移除SameSite和Secure属性，避免跨域问题
          return cookie
            .replace(/; Secure/gi, '')
            .replace(/; SameSite=\w+/gi, '')
            .replace(/; HttpOnly/gi, '');
        });
        responseHeaders.set('Set-Cookie', updatedCookies.join(', '));
      }
      
      // 修改Location头（处理重定向）
      if (responseHeaders.has('Location')) {
        const location = responseHeaders.get('Location');
        if (location.startsWith('http')) {
          // 将重定向URL转换为通过Worker代理的URL
          const newLocation = `${url.origin}?url=${encodeURIComponent(location)}`;
          responseHeaders.set('Location', newLocation);
        }
      }
      
      // 创建新的响应
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
      
    } catch (error) {
      return new Response(`代理请求失败: ${error.message}`, {
        status: 502,
        headers: { 
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
}