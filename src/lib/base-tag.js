'use strict';

/**
 * `<base href>` 的改寫。
 *
 * ⛔ 這是「代理對某些網站完全失效」的頭號成因，而且症狀會騙人。
 *
 * 原站 `<head>` 有 `<base href="https://templatemo.com/" />`，我們把資源路徑
 * 正確改寫成 `/p/templatemo-com/x.css` 之後，瀏覽器拿**原站的 base** 去解析它：
 *
 *     我們送出      /p/templatemo-com/x.css
 *     瀏覽器實際請求 https://templatemo.com/p/templatemo-com/x.css   ← 404
 *
 * 畫面上只是「沒有樣式」，而且 `curl` 完全驗不出來（curl 不解析 base）。
 * 注入的 `<script>` tag 也一樣載不到 —— **tag 在 DOM 裡不代表它載得到**。
 *
 * 只處理被引號包起來的屬性值（跟 SPEC.md 的其他改寫同一個保守規則）。
 */

const { toProxyPath } = require('./proxy-path.js');
const { attributePattern, findQuotedAttribute, replaceAttribute } = require('./attribute.js');

const BASE_TAG_PATTERN = /<base\b[^>]*>/gi;
const HREF_PATTERN = attributePattern('href');

/**
 * @param {string} html
 * @param {{ siteId: string, targetOrigin: string }} site
 * @returns {string}
 */
function rewriteBaseHref(html, { siteId, targetOrigin } = {}) {
  if (typeof html !== 'string') return html;

  return html.replace(BASE_TAG_PATTERN, (tag) => {
    const attribute = findQuotedAttribute(tag, HREF_PATTERN);
    if (!attribute) return tag;

    const rewritten = toProxyPath(attribute.value, { siteId, targetOrigin });
    return rewritten === null ? tag : replaceAttribute(tag, attribute, rewritten);
  });
}

module.exports = { rewriteBaseHref };
