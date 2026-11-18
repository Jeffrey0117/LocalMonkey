'use strict';

const { assertOriginAllowed, SsrfBlockedError } = require('../lib/ssrf.js');
const { resolveSiteIdFromHeaders, SITE_COOKIE_NAME } = require('../lib/site-resolve.js');
const { renderErrorPage, escapeHtml } = require('../views/pages.js');
const { readRequestBody, PayloadTooLargeError } = require('./body.js');
const { forwardToUpstream, UpstreamError } = require('./forward.js');
const { sendProxiedResponse } = require('./respond.js');
const { serveResourceOverride } = require('./resource-override.js');

const PROXY_PREFIX_PATTERN = /^\/p\/[^/?#]+/;

function sendPage(res, status, page) {
  res.status(status).type('html').send(page);
}

/** 從原始 URL 切掉 `/p/<siteId>`，留下要送給上游的 path + query */
function upstreamPathFromOriginalUrl(originalUrl) {
  const match = PROXY_PREFIX_PATTERN.exec(originalUrl);
  const rest = match ? originalUrl.slice(match[0].length) : '';
  return rest.length === 0 ? '/' : rest;
}

function siteNotFoundPage(siteId) {
  return renderErrorPage({
    status: 404,
    title: '找不到這個代理網站',
    paragraphs: [
      `後台裡沒有 id 為 <code>${escapeHtml(siteId)}</code> 的網站。`,
      '到 <code>/admin</code> 新增一個，或確認網址裡的 id 沒有打錯。',
    ],
  });
}

function siteDisabledPage(site) {
  return renderErrorPage({
    status: 404,
    title: '這個網站已停用',
    paragraphs: [
      `<code>${escapeHtml(site.id)}</code> 目前是停用狀態，所以不會代理。`,
      '到 <code>/admin</code> 把它重新啟用。',
    ],
  });
}

function unresolvedSitePage() {
  return renderErrorPage({
    status: 404,
    title: '不知道這個請求屬於哪個網站',
    paragraphs: [
      '這個路徑不在 <code>/p/&lt;siteId&gt;/</code> 底下，而且也找不到線索可以推斷它屬於哪個代理網站。',
      `判斷順序是：cookie <code>${SITE_COOKIE_NAME}</code> → <code>Referer</code> 裡的 <code>/p/&lt;siteId&gt;/</code>。`,
      '請直接用 <code>/p/&lt;siteId&gt;/</code> 開頁面，瀏覽器之後才會帶著正確的 cookie 來拿資源。',
    ],
  });
}

function ssrfBlockedPage(site, error) {
  return renderErrorPage({
    status: 403,
    title: '目標位址被 SSRF 防護擋下來了',
    paragraphs: [
      `<code>${escapeHtml(site.target_origin)}</code> 解析到不允許的位址。`,
      escapeHtml(error.message),
    ],
    hints: [
      '目標真的是內網服務 → 啟動時設 <code>LOCALMONKEY_ALLOW_PRIVATE=1</code>（請先確認你信任這個目標）',
      '目標是公開網站 → 它的 DNS 可能被改成指向內網位址了（DNS rebinding）',
    ],
  });
}

function upstreamFailedPage(site, error) {
  return renderErrorPage({
    status: 502,
    title: '上游網站沒有回應',
    paragraphs: [
      `LocalMonkey 把請求轉到 <code>${escapeHtml(site.target_origin)}</code>，但沒拿到回應。`,
      `錯誤：<code>${escapeHtml(error.cause?.code ?? error.cause?.name ?? error.message)}</code>`,
    ],
    hints: [
      '目標網站現在真的掛了或很慢（逾時）',
      'target_origin 打錯了（port、scheme、網域）',
      '這台機器連不到外網，或被防火牆 / DNS 擋住',
      '目標只接受 HTTPS，但 target_origin 寫成 http',
    ],
  });
}

/**
 * 代理的兩個入口（主路由與根路徑 fallback）共用同一條管線。
 */
function createProxyHandlers({ store, config, logger, fetchImpl, translation, siteRules }) {
  async function proxy(req, res, { site, pathWithQuery }) {
    // 資源覆寫擺在最前面：命中就完全不碰上游（SPEC-rules §3.6）
    if (serveResourceOverride(req, res, { store, site, pathWithQuery, logger })) return;

    try {
      await assertOriginAllowed(site.target_origin, { allowPrivate: config.allowPrivate });
    } catch (error) {
      if (!(error instanceof SsrfBlockedError)) throw error;
      logger.warn(`擋下代理請求 ${site.id} → ${site.target_origin}：${error.message}`);
      sendPage(res, 403, ssrfBlockedPage(site, error));
      return;
    }

    let body;
    try {
      body = await readRequestBody(req, config.maxRequestBodyBytes);
    } catch (error) {
      if (!(error instanceof PayloadTooLargeError)) throw error;
      logger.warn(`請求 body 過大：${req.method} ${req.originalUrl}`);
      // body 沒讀完，這條連線不能再重用
      res.setHeader('connection', 'close');
      sendPage(
        res,
        413,
        renderErrorPage({
          status: 413,
          title: '請求內容太大',
          paragraphs: [escapeHtml(error.message), '可以用 <code>LOCALMONKEY_MAX_BODY_BYTES</code> 調整上限。'],
        }),
      );
      return;
    }

    try {
      const { response, buffer } = await forwardToUpstream({
        site,
        pathWithQuery,
        method: req.method,
        headers: req.headers,
        body,
        timeoutMs: config.upstreamTimeoutMs,
        fetchImpl,
      });

      sendProxiedResponse(res, {
        site,
        response,
        buffer,
        pathWithQuery,
        store,
        translate: translation?.translateHtml,
        rules: siteRules?.applyToHtml,
      });
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      logger.error(`代理失敗 ${req.method} ${req.originalUrl} → ${site.target_origin}`, error.cause);
      sendPage(res, 502, upstreamFailedPage(site, error));
    }
  }

  function resolveSite(res, siteId) {
    const site = store.sites.get(siteId);
    if (!site) {
      sendPage(res, 404, siteNotFoundPage(siteId));
      return null;
    }
    if (!site.enabled) {
      sendPage(res, 404, siteDisabledPage(site));
      return null;
    }
    return site;
  }

  /** ALL /p/:siteId 與 /p/:siteId/{*splat} */
  async function handleProxyRoute(req, res) {
    const site = resolveSite(res, req.params.siteId);
    if (!site) return;

    await proxy(req, res, {
      site,
      pathWithQuery: upstreamPathFromOriginalUrl(req.originalUrl),
    });
  }

  /** ALL /{*splat}：接住頁面裡「根絕對路徑」的資源請求 */
  async function handleFallbackRoute(req, res) {
    const siteId = resolveSiteIdFromHeaders(req.headers);
    if (!siteId) {
      sendPage(res, 404, unresolvedSitePage());
      return;
    }

    const site = resolveSite(res, siteId);
    if (!site) return;

    await proxy(req, res, { site, pathWithQuery: req.originalUrl });
  }

  return { handleProxyRoute, handleFallbackRoute };
}

module.exports = { createProxyHandlers, upstreamPathFromOriginalUrl };
