// 观察台 HTTP 测试的确定性工具。
//
// 不用全局 fetch：它的连接池会保留 keep-alive 套接字，server.close() 因此可能等待
//（Node 在 Windows 上尤其明显），表现为「观察台测试偶发失败」。
// 这里每次请求新建连接、完整读完响应，关闭时主动断开空闲连接。
import http from 'node:http';

/**
 * 发一次请求并完整读完响应体。
 * @param {string} base 形如 http://127.0.0.1:1234
 * @param {string} pathname 以 / 开头的路径
 * @param {{method?:string, body?:string, headers?:object}} [options]
 * @returns {Promise<{status:number, headers:object, body:string}>}
 */
export function request(base, pathname, { method = 'GET', body = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const req = http.request(url, { method, agent: false, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** 请求 JSON 接口。 */
export async function requestJson(base, pathname, options) {
  return JSON.parse((await request(base, pathname, options)).body);
}
