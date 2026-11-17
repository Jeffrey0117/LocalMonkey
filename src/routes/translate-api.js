'use strict';

/**
 * `/admin/api/translate/*` 與 `/admin/api/sites/:siteId/crawl*`（規格 §6 / §7）。
 *
 * 單獨一個 router 而不是塞進 `admin-api.js`：那個檔案已經 350 行，而且翻譯
 * 的端點有自己的一組依賴（翻譯服務、爬蟲）。掛在 `/admin/api` 底下，所以
 * 認證、JSON parse、錯誤處理都沿用外層那一套。
 */

const express = require('express');

const { validateManualTranslation, validateCrawlRequest } = require('../lib/validate.js');
const { translationHash } = require('../translate/cache.js');
const { CrawlError } = require('../translate/crawl.js');

function sendValidationFailed(res, result) {
  res.status(400).json({ error: 'validation_failed', details: result.errors });
}

/**
 * @param {{ store: object, translation: object, crawler: object, logger: object }} context
 */
function createTranslateApiRouter({ store, translation, crawler, logger }) {
  const router = express.Router();

  function requireSite(req, res) {
    const site = store.sites.get(req.params.siteId);
    if (!site) {
      res.status(404).json({ error: 'not_found', message: `找不到網站「${req.params.siteId}」` });
      return null;
    }
    return site;
  }

  /** 佇列狀態 + ollama 活著沒（規格 §7） */
  router.get('/translate/status', async (req, res, next) => {
    try {
      res.json(await translation.status());
    } catch (error) {
      next(error);
    }
  });

  /** 模型下拉選單的來源（規格 §7：從 ollama 的 /api/tags 撈） */
  router.get('/translate/models', async (req, res) => {
    const health = await translation.client.ping();

    // ollama 掛了不是錯誤 —— UI 要能顯示「翻譯服務連不上」而不是整頁爆掉
    res.json({ models: health.models, ok: health.ok, error: health.error });
  });

  /** 「翻譯」分頁的表格。搜尋同時打原文與譯文。 */
  router.get('/translate/entries', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    res.json({
      entries: store.translations.list({
        query: typeof req.query.q === 'string' ? req.query.q : undefined,
        origin: req.query.origin === 'manual' || req.query.origin === 'machine' ? req.query.origin : undefined,
        limit,
        offset,
      }),
      counts: store.translations.count(),
      queue: store.translateQueue.stats(),
    });
  });

  /** 翻不動的那些（attempts >= 3）—— 規格 §7 的篩選 */
  router.get('/translate/failed', (req, res) => {
    res.json({ failed: store.translateQueue.listFailed({ limit: 200 }) });
  });

  /** 人工覆寫：存檔後 origin = 'manual'，之後背景翻譯不准覆蓋 */
  router.put('/translate/entries/:hash', (req, res) => {
    const existing = store.translations.get(req.params.hash);
    if (!existing) {
      res.status(404).json({ error: 'not_found', message: '找不到這一段翻譯' });
      return;
    }

    const result = validateManualTranslation(req.body);
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }

    res.json({
      entry: store.translations.setManual(req.params.hash, {
        source_text: existing.source_text,
        target_lang: existing.target_lang,
        model: existing.model,
        translated: result.value.translated,
      }),
    });
  });

  /**
   * 單段「重翻」：砍掉快取那筆 + 重新排進佇列。
   *
   * 人工覆寫過的也可以重翻（使用者明確要求），但要先把那筆刪掉，
   * 不然 `put` 的 `WHERE origin <> 'manual'` 會把新的機器翻譯擋掉。
   */
  router.post('/translate/entries/:hash/retranslate', (req, res) => {
    const existing = store.translations.get(req.params.hash);
    if (!existing) {
      res.status(404).json({ error: 'not_found', message: '找不到這一段翻譯' });
      return;
    }

    store.translations.remove(req.params.hash);
    store.translateQueue.remove(req.params.hash);
    store.translateQueue.enqueue({
      texts: [existing.source_text],
      targetLang: existing.target_lang,
      model: existing.model,
      siteId: null,
    });
    translation.queue.kick();

    res.json({ queued: true, hash: req.params.hash });
  });

  /** 翻不動的段：放棄它（從佇列移除，原文照舊） */
  router.delete('/translate/queue/:hash', (req, res) => {
    if (!store.translateQueue.remove(req.params.hash)) {
      res.status(404).json({ error: 'not_found', message: '佇列裡沒有這一段' });
      return;
    }
    res.status(204).end();
  });

  /** 讓使用者手動推一把（UI 的「現在就翻」）*/
  router.post('/translate/run', (req, res) => {
    translation.queue.kick();
    res.json({ started: true, queue: store.translateQueue.stats() });
  });

  /* ------------------------- 預先翻譯整站（§6） ------------------------- */

  router.post('/sites/:siteId/crawl', async (req, res, next) => {
    const site = requireSite(req, res);
    if (!site) return;

    const result = validateCrawlRequest(req.body ?? {});
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }

    try {
      const { job, done } = await crawler.start(site, result.value);

      // 不 await：使用者按下去要立刻拿到 job，進度之後輪詢
      done.catch((error) => logger.error('爬取工作結束時出錯', error));

      res.status(202).json({ job: crawler.describeJob(job, store.translateQueue.stats()) });
    } catch (error) {
      if (error instanceof CrawlError) {
        res.status(400).json({ error: 'crawl_failed', message: error.message });
        return;
      }
      next(error);
    }
  });

  router.get('/sites/:siteId/crawl', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    const stats = store.translateQueue.stats();

    res.json({
      jobs: store.crawlJobs
        .listBySite(site.id, { limit: 10 })
        .map((job) => crawler.describeJob(job, stats)),
    });
  });

  router.post('/sites/:siteId/crawl/:jobId/cancel', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    const cancelled = crawler.cancel(req.params.jobId);
    if (!cancelled || cancelled.site_id !== site.id) {
      res.status(404).json({ error: 'not_found', message: `找不到爬取工作「${req.params.jobId}」` });
      return;
    }

    res.json({ job: crawler.describeJob(cancelled, store.translateQueue.stats()) });
  });

  return router;
}

module.exports = { createTranslateApiRouter };
