'use strict';

/**
 * `@grant` 的支援清單。
 *
 * 沒列在這裡的（GM_download、GM_cookie…）**不要靜默失敗** ——
 * shim 會給一個會 console.error 的 stub，後台也會紅字標出來，
 * 使用者才知道哪裡會壞。
 */

const SUPPORTED_GRANTS = Object.freeze([
  'unsafeWindow',
  'GM_addStyle',
  'GM_setValue',
  'GM_getValue',
  'GM_deleteValue',
  'GM_listValues',
  'GM_openInTab',
  'GM_setClipboard',
  'GM_registerMenuCommand',
  'GM_notification',
  'GM_info',
  'GM_getResourceText',
  'GM_getResourceURL',
  'GM_xmlhttpRequest',
]);

const CANONICAL_BY_LOWER = new Map(
  SUPPORTED_GRANTS.map((grant) => [grant.toLowerCase(), grant]),
);

/**
 * GM4 的點號形式（`GM.setValue`）與大小寫差異（`GM_xmlHttpRequest`）
 * 都正規化成清單裡的寫法。認不出來的原樣回傳。
 * @param {string} grant
 * @returns {string}
 */
function canonicalGrant(grant) {
  if (typeof grant !== 'string') return '';

  const trimmed = grant.trim();
  const underscored = trimmed.startsWith('GM.') ? `GM_${trimmed.slice(3)}` : trimmed;

  return CANONICAL_BY_LOWER.get(underscored.toLowerCase()) ?? trimmed;
}

/**
 * @param {string} grant 使用者宣告的原始寫法
 * @returns {boolean}
 */
function isSupportedGrant(grant) {
  return CANONICAL_BY_LOWER.has(canonicalGrant(grant).toLowerCase());
}

module.exports = { SUPPORTED_GRANTS, canonicalGrant, isSupportedGrant };
