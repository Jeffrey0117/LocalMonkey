'use strict';

/**
 * latin1 ↔ UTF-8 的橋。
 *
 * 代理的 HTML 改寫全程走 latin1（`buffer.toString('latin1')`）—— 那是
 * byte-lossless 的，所以不用猜頁面的 charset。代價是字串裡的每個字元
 * 其實是**一個 byte**，中文在裡面長得像一串亂碼。
 *
 * 翻譯是這條管線裡第一個需要「真的讀懂文字」的步驟，所以它要在邊界上
 * 做一次解碼、回填時再編回去：
 *
 *   原始 byte --latin1--> 管線字串 --fromLatin1--> 真文字 --翻譯-->
 *   譯文 --toLatin1--> 管線字串 --latin1--> 原始 byte
 *
 * 這只有在頁面是 UTF-8 時成立，所以呼叫端一定要先過 `charset.js`。
 */

/** latin1 管線字串 → 真文字（byte 不是合法 UTF-8 時會出現 U+FFFD，rules 會跳過那段） */
function fromLatin1(text) {
  return Buffer.from(text, 'latin1').toString('utf8');
}

/** 真文字 → latin1 管線字串（每個字元代表一個 UTF-8 byte） */
function toLatin1(text) {
  return Buffer.from(text, 'utf8').toString('latin1');
}

module.exports = { fromLatin1, toLatin1 };
