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

/**
 * `@grant` 的值是使用者可以隨便打的字串，而注入的 wrapper 會把它當成**變數名稱**
 * 寫進送給瀏覽器的 JS。所以在那之前一定要過這道濾網，否則
 * `@grant x; window.PWNED = 1` 就會變成真的程式碼。
 */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isValidGrantName(grant) {
  if (typeof grant !== 'string') return false;
  if (grant.startsWith('GM.')) return IDENTIFIER_PATTERN.test(grant.slice(3));
  return IDENTIFIER_PATTERN.test(grant);
}

/**
 * 要在使用者腳本的 scope 裡宣告哪些名字。
 * GM4 的點號形式（`GM.setValue`）全部收斂成一個 `GM` 物件，跟 Tampermonkey 一樣。
 * @param {readonly string[]} grants
 * @returns {string[]}
 */
function aliasNamesFor(grants) {
  const names = (Array.isArray(grants) ? grants : [])
    .filter((grant) => isValidGrantName(grant))
    .map((grant) => (grant.startsWith('GM.') ? 'GM' : grant));

  return [...new Set(names)];
}

module.exports = {
  SUPPORTED_GRANTS,
  canonicalGrant,
  isSupportedGrant,
  isValidGrantName,
  aliasNamesFor,
  IDENTIFIER_PATTERN,
};
