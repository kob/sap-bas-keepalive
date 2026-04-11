// Cloudflare Worker示例代码
// 用于反代SAP BAS服务，解决国内网络访问慢的问题

export default {
  async fetch(request) {
    // 目标SAP BAS域名
    const targetHost = 'applicationstudio.cloud.sap';
    
    // 获取原始请求的URL
    const url = new URL(request.url);
    
    // 解析目标子域名
    // Cloudflare Worker URL格式：https://worker.example.com/{subdomain}.applicationstudio.cloud.sap/
    const pathParts = url.pathname.split('/');
    let targetSubdomain = '';
    
    if (pathParts.length > 1 && pathParts[1].includes('.')) {
      // 第一个路径部分可能是子域名
      targetSubdomain = pathParts[1];
      url.pathname = '/' + pathParts.slice(2).join('/');
    }
    
    // 构建目标URL
    const targetUrl = new URL(`https://${targetSubdomain}${targetHost}${url.pathname}${url.search}`);
    
    // 复制请求头，移除不必要的头
    const headers = new Headers(request.headers);
    headers.delete('Host'); // Cloudflare会设置正确的Host
    
    // 设置一些优化头
    headers.set('X-Forwarded-Host', targetHost);
    
    // 转发请求
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' ? request.body : undefined
    });
    
    // 返回响应
    return response;
  }
}