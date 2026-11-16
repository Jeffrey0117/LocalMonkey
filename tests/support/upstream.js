'use strict';

const http = require('node:http');

/**
 * 假的「上游網站」：跟真的代理對打用。綁 port 0，由呼叫端在 t.after 收掉。
 * 不 mock fetch —— 規格要求測真東西。
 */
function startUpstream(handler) {
  const received = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks),
      });
      handler(req, res, Buffer.concat(chunks));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        received,
        lastRequest: () => received[received.length - 1],
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** 1x1 的真 PNG，用來驗 binary 沒被改壞 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

module.exports = { startUpstream, TINY_PNG };
