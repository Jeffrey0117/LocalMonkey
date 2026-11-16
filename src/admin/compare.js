'use strict';

const crypto = require('node:crypto');

/**
 * 定時比對 token。長度不同要先擋掉 —— timingSafeEqual 遇到長度不同會直接丟錯，
 * 而且長度本來就不是秘密。
 *
 * 注意這裡刻意用 `crypto.timingSafeEqual(...)` 而不是先 destructure，
 * 測試才能 spy 到它真的被呼叫。
 */
function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length === 0 || expected.length === 0) return false;

  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (providedBytes.length !== expectedBytes.length) return false;

  return crypto.timingSafeEqual(providedBytes, expectedBytes);
}

module.exports = { tokensMatch };
