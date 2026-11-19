'use strict';

const express = require('express');

const { createInternalRouter } = require('./routes/internal.js');
const { createGmXhrRouter } = require('./routes/gm-xhr.js');
const { createDeliveryRouter } = require('./routes/delivery.js');
const { createAdminRouter } = require('./routes/admin-page.js');
const { createProxyHandlers } = require('./proxy/handler.js');
const { createFaviconService } = require('./services/favicon.js');
const { createTranslationService } = require('./translate/service.js');
const { createSiteRulesService } = require('./rules/service.js');
const { createReskinService } = require('./reskin/service.js');
const { newebpayStatus } = require('./reskin/newebpay.js');
const { createCrawler } = require('./translate/crawl.js');
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
 *   translationClient?: object,
 * }} input
 */
function createApp({
  store,
  config,
  adminToken,
  logger = silentLogger,
  fetchImpl,
  translationClient,
}) {
  if (typeof adminToken !== 'string' || adminToken.length === 0) {
    throw new Error('createApp 需要 adminToken（沒有預設值，也不准不驗證）');
  }

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag'); // 回應是我們改寫過的，不要讓 express 自己算 etag

  /**
   * 翻譯層（v4）。背景佇列的狀態掛在這個 instance 上，所以要跟 app 同壽命。
   * `translationClient` 是測試注入假 ollama 的接縫 —— 掛上 `app.locals`
   * 讓整合測試能 `await app.locals.translation.queue.idle()`。
   */
  const translation = createTranslationService({
    store,
    config,
    logger,
    fetchImpl,
    client: translationClient,
  });
  app.locals.translation = translation;

  // 「預先翻譯整站」（規格 §6）。進度在 DB 裡，所以這個 instance 不持有狀態。
  const crawler = createCrawler({ store, config, logger, translation, fetchImpl });
  app.locals.crawler = crawler;

  /**
   * 改造規則（v5）。沒有狀態（每個請求重讀 DB），所以這個 instance 只是
   * 把 store 與 logger 綁上去而已。
   */
  const siteRules = createSiteRulesService({ store, logger });
  app.locals.siteRules = siteRules;

  /**
   * 重繪模式（v8，SPEC-reskin）。同樣沒有狀態（每個請求重讀 + 重編譯設定），
   * 抽出來的資料存在 DB 的 `reskin_cache` 裡而不是這個 instance 上。
   *
   * `payments` 是「這台機器有沒有接金流」（SPEC-checkout §1）：env 齊了才算接上，
   * 沒接就是示範模式。**進到頁面的只有 `connected` 與 `env` 兩個值**，
   * 金鑰留在伺服器端。
   */
  const reskin = createReskinService({
    store,
    logger,
    payments: newebpayStatus(config.newebpay ?? {}),
  });
  app.locals.reskin = reskin;

  const { handleProxyRoute, handleFallbackRoute } = createProxyHandlers({
    store,
    config,
    logger,
    fetchImpl,
    translation,
    siteRules,
    reskin,
  });

  // 保留路徑：不進代理。
  // gm/xhr 要排在 internal 之前 —— internal router 的尾巴是 catch-all 404。
  // 後台列表的站點圖示。快取在這個 service 的 instance 裡，所以要跟 app 同壽命。
  const favicons = createFaviconService({ store, config, fetchImpl, lookup: config.lookup });

  app.use('/__lm/gm', createGmXhrRouter({ store, config, logger, fetchImpl }));
  // 重繪商城的三支前台端點（下一頁、結帳、付款回來）也住在這個 router 底下，
  // 所以它要拿得到 reskin 服務與 config（地雷 39：新依賴要一路轉下去）
  app.use('/__lm', createInternalRouter({ store, favicons, reskin, config, logger, fetchImpl }));
  app.use(
    '/admin',
    createAdminRouter({
      store,
      config,
      adminToken,
      logger,
      fetchImpl,
      translation,
      crawler,
      siteRules,
      reskin,
    }),
  );

  // 投遞給 Tampermonkey。免認證（憑證是路徑裡的 token），要排在代理的 catch-all 之前。
  app.use('/s', createDeliveryRouter({ store, config, logger }));

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
