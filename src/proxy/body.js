'use strict';

class PayloadTooLargeError extends Error {
  constructor(limit) {
    super(`請求 body 超過 ${limit} bytes 的上限`);
    this.name = 'PayloadTooLargeError';
    this.limit = limit;
  }
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 把請求 body 讀成 Buffer。代理路由刻意沒掛任何 body parser，
 * 所以這裡是唯一會消耗 request stream 的地方。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer|undefined>} GET/HEAD 回 undefined（fetch 不接受 body）
 */
function readRequestBody(req, limit) {
  if (BODYLESS_METHODS.has(req.method)) return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        // 只停止讀取就好。不要 req.destroy() —— 那會連同還沒送出的 413 回應
        // 一起把 socket 砍掉，使用者只會看到 ECONNRESET，什麼訊息都拿不到。
        req.pause();
        reject(new PayloadTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      cleanup();
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : undefined);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

module.exports = { readRequestBody, PayloadTooLargeError, BODYLESS_METHODS };
