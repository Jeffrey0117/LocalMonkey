'use strict';

/**
 * 有上限地讀取 fetch 回應。
 *
 * 重點是「邊讀邊數」而不是 `await response.arrayBuffer()` 之後才檢查大小 ——
 * 後者等於讓上游決定我們要吃掉多少記憶體。
 *
 * 兩個呼叫端的政策刻意不同：
 *   - GM_xmlhttpRequest：讀到上限就截斷（腳本拿到部分內容比完全失敗有用）
 *   - @require / @resource：截斷等於壞檔，由呼叫端當成失敗處理
 */

class ContentTooLargeError extends Error {
  constructor(declared, maxBytes) {
    super(`上游回應宣告 ${declared} bytes，超過上限 ${maxBytes}`);
    this.name = 'ContentTooLargeError';
    this.declared = declared;
    this.maxBytes = maxBytes;
  }
}

/**
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<{ buffer: Buffer, truncated: boolean }>}
 * @throws {ContentTooLargeError} 上游「宣告」的長度就已經超過上限
 */
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ContentTooLargeError(declared, maxBytes);
  }

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > maxBytes
      ? { buffer: buffer.subarray(0, maxBytes), truncated: true }
      : { buffer, truncated: false };
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const chunk = Buffer.from(value);
    const room = maxBytes - total;

    if (chunk.length >= room) {
      chunks.push(chunk.subarray(0, Math.max(0, room)));
      try {
        await reader.cancel();
      } catch {
        /* 上游已經斷了也沒關係 */
      }
      return { buffer: Buffer.concat(chunks), truncated: true };
    }

    chunks.push(chunk);
    total += chunk.length;
  }

  return { buffer: Buffer.concat(chunks), truncated: false };
}

module.exports = { readCapped, ContentTooLargeError };
