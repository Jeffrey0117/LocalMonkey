'use strict';

const { filterResponseHeaders } = require('../lib/headers.js');
const { rewriteSetCookie } = require('../lib/cookies.js');
const { rewriteLocation } = require('../lib/location.js');
const { rewriteDocumentUrls, injectScripts } = require('../lib/html.js');
const { planInjection } = require('../lib/injection.js');
const { SITE_COOKIE_NAME } = require('../lib/site-resolve.js');

const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml/i;
const BODYLESS_STATUSES = new Set([204, 205, 304]);

function isHtmlResponse(contentType) {
  return typeof contentType === 'string' && HTML_CONTENT_TYPE.test(contentType);
}

function pathnameOf(pathWithQuery) {
  const index = pathWithQuery.search(/[?#]/);
  return index === -1 ? pathWithQuery : pathWithQuery.slice(0, index);
}

/**
 * 挑出這個頁面要注入的東西：啟用中、path_glob 對得上、沒被 @exclude 排除，
 * 再照 run_at 分成三個注入位置（headStart / head / body）。
 * 真正的規則在 lib/injection.js。
 */
function selectScripts(store, site, pathname) {
  return planInjection(store.userscripts.listForInjection(site.id), { pathname });
}

/**
 * HTML 改寫一律走 latin1。latin1 ↔ Buffer 是 byte-lossless，
 * 所以不管頁面是 UTF-8、Big5 還是什麼，沒被我們改到的 byte 都原封不動。
 *
 * 改寫要吃 `target_origin`（不只 siteId）—— `<base href>` 與 meta refresh
 * 的值可能是絕對網址，得先判斷它指的是不是這個站。
 */
function transformHtml(buffer, { site, scripts }) {
  const source = buffer.toString('latin1');
  const rewritten = rewriteDocumentUrls(source, {
    siteId: site.id,
    targetOrigin: site.target_origin,
  });

  return Buffer.from(injectScripts(rewritten, scripts), 'latin1');
}

function copyHeaders(res, response, site) {
  for (const [name, value] of filterResponseHeaders(response.headers)) {
    res.setHeader(name, name === 'location' ? rewriteLocation(value, site) : value);
  }

  for (const cookie of response.headers.getSetCookie()) {
    const rewritten = rewriteSetCookie(cookie);
    if (rewritten) res.append('set-cookie', rewritten);
  }
}

/**
 * @param {import('express').Response} res
 * @param {{ site: object, response: Response, buffer: Buffer, pathWithQuery: string, store: object }} input
 */
function sendProxiedResponse(res, { site, response, buffer, pathWithQuery, store }) {
  const html = isHtmlResponse(response.headers.get('content-type'));
  const hasBody = !BODYLESS_STATUSES.has(response.status) && buffer.length > 0;

  copyHeaders(res, response, site);

  if (html) {
    // 根路徑 fallback 要靠這個 cookie 才知道 /assets/app.js 是誰的
    res.append('set-cookie', `${SITE_COOKIE_NAME}=${site.id}; Path=/; SameSite=Lax`);
  }

  res.status(response.status);

  if (!html || !hasBody) {
    res.end(buffer);
    return;
  }

  const scripts = selectScripts(store, site, pathnameOf(pathWithQuery));
  res.end(transformHtml(buffer, { site, scripts }));
}

module.exports = { sendProxiedResponse, selectScripts, transformHtml, isHtmlResponse, pathnameOf };
