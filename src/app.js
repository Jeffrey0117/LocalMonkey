'use strict';

const express = require('express');

const { createInternalRouter } = require('./routes/internal.js');
const { createGmXhrRouter } = require('./routes/gm-xhr.js');
const { createAdminRouter } = require('./routes/admin-page.js');
const { createProxyHandlers } = require('./proxy/handler.js');
const { renderErrorPage, escapeHtml } = require('./views/pages.js');
const { silentLogger } = require('./logger.js');

/**
 * 組出 express app。所有外部依賴（DB、設定、logger、fetch）都從外面注入，
 * 測試才能在 port 0 上起真的 server 對打。
 *
 * @param {{
 *   store: object,
 *   config: { allowPrivate: boolean, upstreamTimeoutMs: number, maxRequestBodyBytes: number },
 *   adminToken: string,
 *   logger?: object,
 *   fetchImpl?: typeof fetch,
 * }} input
 */
function createApp({ store, config, adminToken, logger = silentLogger, fetchImpl }) {
  if (typeof adminToken !== 'string' || adminToken.length === 0) {
    throw new Error('createApp 需要 adminToken（沒有預設值，也不准不驗證）');
  }

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag'); // 回應是我們改寫過的，不要讓 express 自己算 etag

  const { handleProxyRoute, handleFallbackRoute } = createProxyHandlers({
    store,
    config,
    logger,
    fetchImpl,
  });

  // 保留路徑：不進代理。
  // gm/xhr 要排在 internal 之前 —— internal router 的尾巴是 catch-all 404。
  app.use('/__lm/gm', createGmXhrRouter({ store, config, logger, fetchImpl }));
  app.use('/__lm', createInternalRouter({ store }));
  app.use('/admin', createAdminRouter({ store, config, adminToken, logger }));

  // 主路由
  app.all('/p/:siteId', handleProxyRoute);
  app.all('/p/:siteId/{*splat}', handleProxyRoute);

  // 根路徑 fallback：接住頁面裡的根絕對路徑資源
  app.all('/{*splat}', handleFallbackRoute);

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    logger.error(`處理 ${req.method} ${req.originalUrl} 時發生未預期的錯誤`, error);
    res
      .status(500)
      .type('html')
      .send(
        renderErrorPage({
          status: 500,
          title: 'LocalMonkey 自己出錯了',
          paragraphs: [
            `處理 <code>${escapeHtml(req.method)} ${escapeHtml(req.originalUrl)}</code> 時發生未預期的錯誤。`,
            '詳細原因（含堆疊）在伺服器的 log 裡。',
          ],
        }),
      );
  });

  return app;
}

module.exports = { createApp };
