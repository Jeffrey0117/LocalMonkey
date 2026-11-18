'use strict';

/**
 * `/admin/api/sites/:siteId/reskin*`（SPEC-reskin §6）。
 *
 * 自己一個檔案的理由跟 `rules-api.js` / `translate-api.js` 一樣：
 * `admin-api.js` 已經很長，而這一組有自己的依賴（重繪服務、上游抓頁）。
 * 掛在 `/admin/api` 底下，所以認證、跨站檢查、錯誤處理都沿用外層那一套。
 *
 * ⛔ **抽取設定編不過也要存得起來**（同壞規則的紀律，SPEC-rules §4）：
 * 退回 400 的話使用者只看到一個錯誤訊息，而手上那份半成品沒了。
 * 所以 PUT 一律收，回應裡帶 `config_error` 讓 UI 標紅。
 * **價格方案相反** —— 那是表單填出來的結構化資料，壞掉就擋在門口。
 */

const express = require('express');

const { compileConfig, MAX_CONFIG_BYTES } = require('../reskin/config.js');
const { compilePricing } = require('../reskin/pricing.js');
const { presetFor, listPresets } = require('../reskin/presets/index.js');
const { listThemes } = require('../reskin/themes/index.js');
const { fetchUpstreamPage } = require('../services/fetch-page.js');

function sendValidationFailed(res, errors) {
  res.status(400).json({ error: 'validation_failed', details: errors });
}

/**
 * 設定要嘛是陣列、要嘛是它的 JSON 字串（UI 的 textarea 給字串）。
 *
 * ⛔ 回 `undefined` 代表「這個值看不懂」，所以呼叫端**一定要先確認 body 裡
 * 真的有 `config` 這個鍵**再叫它 —— 不然「沒帶 config」（試跑最常見的用法：
 * 用站上存好的那份）會被當成「帶了一個看不懂的值」而回 400。
 */
function asConfigText(input) {
  if (input === null || input === '') return null;
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return JSON.stringify(input, null, 2);
  return undefined;
}

function hasKey(body, key) {
  return typeof body === 'object' && body !== null && key in body;
}

function pathFrom(value) {
  return typeof value === 'string' && value.startsWith('/') ? value : '/';
}

/**
 * @param {{
 *   store: object,
 *   reskin: object,
 *   config: object,
 *   logger: object,
 *   fetchImpl?: typeof fetch,
 * }} context
 */
function createReskinApiRouter({ store, reskin, config, logger, fetchImpl }) {
  const router = express.Router();

  function requireSite(req, res) {
    const site = store.sites.get(req.params.siteId);
    if (!site) {
      res.status(404).json({ error: 'not_found', message: `找不到網站「${req.params.siteId}」` });
      return null;
    }
    return site;
  }

  /** 控制台的「重繪」區塊一次要的所有東西 */
  router.get('/sites/:siteId/reskin', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    res.json({
      ...reskin.statusFor(site),
      config: site.reskin_config,
      themes: listThemes(),
      presets: listPresets(),
      has_preset: presetFor(site.id) !== null,
    });
  });

  /**
   * 存抽取設定。
   *
   * ⛔ 存完**一定要清快取**：快取的 key 只含上游 HTML 的雜湊，不含設定
   * （規格 §3.3）。少了這一步，改完設定重新整理看到的是**舊設定抽出來的
   * 資料** —— 而那個症狀長得跟「設定沒存到」一模一樣，是這個功能最難查的坑。
   */
  router.put('/sites/:siteId/reskin/config', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    const text = asConfigText(req.body?.config);
    if (text === undefined) {
      sendValidationFailed(res, [{ field: 'config', message: 'config 要是陣列或 JSON 字串' }]);
      return;
    }
    if (text !== null && text.length > MAX_CONFIG_BYTES) {
      sendValidationFailed(res, [
        { field: 'config', message: `設定最長 ${MAX_CONFIG_BYTES} 個字` },
      ]);
      return;
    }

    store.sites.update(site.id, { reskin_config: text });
    const cleared = store.reskinCache.clear(site.id);

    const compiled = compileConfig(text);
    if (!compiled.ok) {
      logger.warn(`${site.id} 存了一份編不過的重繪設定：${compiled.error}`);
    }

    const saved = store.sites.get(site.id);
    res.json({ ...reskin.statusFor(saved), config: saved.reskin_config, cache_cleared: cleared });
  });

  /** 價格方案（規格 §4.3）。這個**擋**壞資料：它是表單填出來的，不是手寫的。 */
  router.put('/sites/:siteId/reskin/pricing', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    const incoming = req.body?.pricing;

    if (incoming === null) {
      store.sites.update(site.id, { reskin_pricing: null });
      res.json(reskin.statusFor(store.sites.get(site.id)));
      return;
    }

    const compiled = compilePricing(incoming);
    if (!compiled.ok) {
      sendValidationFailed(res, [{ field: 'pricing', message: compiled.error }]);
      return;
    }

    store.sites.update(site.id, { reskin_pricing: JSON.stringify(compiled.value) });
    res.json(reskin.statusFor(store.sites.get(site.id)));
  });

  /** 一鍵套上這個站的預設抽取設定（整份取代，見 `presets/index.js`） */
  router.post('/sites/:siteId/reskin/preset', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    const preset = presetFor(site.id);
    if (preset === null) {
      res.status(404).json({ error: 'not_found', message: `「${site.id}」沒有預設的抽取設定` });
      return;
    }

    store.sites.update(site.id, { reskin_config: JSON.stringify(preset, null, 2) });
    const cleared = store.reskinCache.clear(site.id);

    const saved = store.sites.get(site.id);
    res.json({ ...reskin.statusFor(saved), config: saved.reskin_config, cache_cleared: cleared });
  });

  router.post('/sites/:siteId/reskin/cache/clear', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    res.json({ cleared: store.reskinCache.clear(site.id) });
  });

  /**
   * 「試一下」（規格 §6）。
   *
   * ⛔ 寫抽取規則最怕的是「寫了沒反應」，所以這支要回**抽到幾項、每個欄位
   * 抽到什麼**，連「哪一筆設定命中」「為什麼沒命中」都要說。
   *
   * body 可以帶 `config` 覆蓋（＝「先別存，讓我試試看」），不帶就用存好的那份。
   * 刻意**不走快取**：試跑的語意是「用我現在這份設定重算一次」。
   */
  router.post('/sites/:siteId/reskin/dry-run', async (req, res, next) => {
    const site = requireSite(req, res);
    if (!site) return;

    const path = pathFrom(req.body?.path);

    // 沒帶 `config` ＝「用站上存好的那份」，這是試跑最常見的用法
    const provided = hasKey(req.body, 'config');
    const override = provided ? asConfigText(req.body.config) : undefined;

    if (provided && override === undefined) {
      sendValidationFailed(res, [{ field: 'config', message: 'config 要是陣列或 JSON 字串' }]);
      return;
    }

    try {
      const page = await fetchUpstreamPage(site, path, {
        fetchImpl,
        allowPrivate: config.allowPrivate,
        timeoutMs: config.upstreamTimeoutMs,
      });

      if (page.html === null) {
        res.status(400).json({
          error: 'not_html',
          message: `${path} 回的不是 HTML（status ${page.status}、${page.contentType ?? '沒有 content-type'}）`,
        });
        return;
      }

      res.json(
        reskin.dryRun(page.html, {
          site,
          path,
          contentType: page.contentType,
          // `undefined` ＝ 用站上存好的設定；`null` / 字串 ＝ 用這次帶來的
          ...(provided ? { config: override } : {}),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createReskinApiRouter };
