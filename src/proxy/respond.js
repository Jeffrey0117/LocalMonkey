'use strict';

const { filterResponseHeaders } = require('../lib/headers.js');
const { rewriteSetCookie } = require('../lib/cookies.js');
const { rewriteLocation } = require('../lib/location.js');
const { rewriteRootPaths, injectScripts } = require('../lib/html.js');
const { matchGlob } = require('../lib/glob.js');
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
 * 挑出這個頁面要注入的腳本：啟用中、match_glob 對得上，並照 run_at 分兩組。
 */
function selectScripts(store, site, pathname) {
  const active = store.scripts
    .listActiveForSite(site.id)
    .filter((script) => matchGlob(script.match_glob, pathname));

  return {
    head: active.filter((script) => script.run_at === 'head-end'),
    body: active.filter((script) => script.run_at === 'body-end'),
  };
}

/**
 * HTML 改寫一律走 latin1。latin1 ↔ Buffer 是 byte-lossless，
 * 所以不管頁面是 UTF-8、Big5 還是什麼，沒被我們改到的 byte 都原封不動。
 */
function transformHtml(buffer, { site, scripts }) {
  const source = buffer.toString('latin1');
  const injected = injectScripts(rewriteRootPaths(source, site.id), scripts);
  return Buffer.from(injected, 'latin1');
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
