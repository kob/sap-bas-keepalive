// 简单的Cloudflare Worker反代
// 部署后，将你的BAS URL改为：https://你的worker.域名/原始URL的路径部分

export default {
  async fetch(request) {
    // 获取原始URL
    const url = new URL(request.url);
    
    // 从查询参数中获取目标URL，或者使用固定的目标
    let targetUrl = url.searchParams.get('url');
    
    if (!targetUrl) {
      // 如果没有提供目标URL，使用预设的SAP BAS服务
      // 修改下面的URL为你实际的BAS服务地址
      const defaultTarget = 'https://trial.applicationstudio.cloud.sap';
      
      // 构建目标URL
      targetUrl = new URL(defaultTarget);
      targetUrl.pathname = url.pathname;
      targetUrl.search = url.search;
      targetUrl.hash = url.hash;
    }
    
    // 创建新的请求
    const newRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
    
    // 转发请求
    try {
      const response = await fetch(newRequest);
      return response;
    } catch (error) {
      return new Response(`代理请求失败: ${error.message}`, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
}