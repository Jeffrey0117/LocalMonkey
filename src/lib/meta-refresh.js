'use strict';

/**
 * `<meta http-equiv="refresh" content="0; url=…">` 的改寫。
 *
 * 跟 `<base>` 是同一類問題：放它過去，使用者會在幾秒後被**整個踢出代理**
 * （連帶注入的腳本一起消失），而且畫面上看起來只是「網站自己跳轉了」。
 *
 * 指向被代理的站 → 換成代理路徑；指向別人 → 原樣保留。
 * 沒有 `url=` 的 refresh（原地重新載入）不動。
 */

const { toProxyPath } = require('./proxy-path.js');
const { attributePattern, findQuotedAttribute, replaceAttribute } = require('./attribute.js');

const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
const HTTP_EQUIV_PATTERN = attributePattern('http-equiv');
const CONTENT_PATTERN = attributePattern('content');

/**
 * `content` 的格式是 `<秒數>; url=<網址>`。網址自己還可能被另一種引號包起來
 * （`content="0; url='https://x/'"`），那層引號要原樣留著。
 */
const CONTENT_URL_PATTERN = /^([^;]*;\s*url\s*=\s*)(['"]?)([^'"]*)\2(\s*)$/i;

function isRefresh(tag) {
  const attribute = findQuotedAttribute(tag, HTTP_EQUIV_PATTERN);
  return attribute !== null && attribute.value.trim().toLowerCase() === 'refresh';
}

function rewriteContent(content, site) {
  const parts = CONTENT_URL_PATTERN.exec(content);
  if (!parts) return null;

  const [, lead, innerQuote, url, trailing] = parts;
  const rewritten = toProxyPath(url, site);
  if (rewritten === null) return null;

  return `${lead}${innerQuote}${rewritten}${innerQuote}${trailing}`;
}

/**
 * @param {string} html
 * @param {{ siteId: string, targetOrigin: string }} site
 * @returns {string}
 */
function rewriteMetaRefresh(html, site = {}) {
  if (typeof html !== 'string') return html;

  return html.replace(META_TAG_PATTERN, (tag) => {
    if (!isRefresh(tag)) return tag;

    const attribute = findQuotedAttribute(tag, CONTENT_PATTERN);
    if (!attribute) return tag;

    const rewritten = rewriteContent(attribute.value, site);
    return rewritten === null ? tag : replaceAttribute(tag, attribute, rewritten);
  });
}

module.exports = { rewriteMetaRefresh };
