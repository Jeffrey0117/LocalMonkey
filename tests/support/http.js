'use strict';

const http = require('node:http');

/**
 * 原始 HTTP 請求。用 node:http 而不是 fetch，因為代理測試要精準控制
 * hop-by-hop header（undici 會自己管一部分），而且 binary 回應要拿到原始 bytes。
 */
function rawRequest({ port, host = '127.0.0.1', method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, method, path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: { ...response.headers },
          setCookie: response.headers['set-cookie'] ?? [],
          body: buffer,
          text: buffer.toString('utf8'),
        });
      });
    });

    request.on('error', reject);
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

module.exports = { rawRequest };
