'use strict';

/**
 * `/admin/api/sites/:siteId/rules*` 與 `.../resources*`（SPEC-rules §4）。
 *
 * 自己一個檔案的理由跟 `translate-api.js` 一樣：`admin-api.js` 已經很長，
 * 而這一組有自己的依賴（規則服務、上游抓頁、上傳的 raw body）。掛在
 * `/admin/api` 底下，所以認證、跨站檢查、錯誤處理都沿用外層那一套。
 */

const express = require('express');

const {
  validateRuleCreate,
  validateRuleUpdate,
  validateRuleOrder,
  validateResourcePath,
  validateResourceUpload,
  MAX_RESOURCE_BYTES,
} = require('../lib/validate-rules.js');
const { fetchUpstreamPage } = require('../services/fetch-page.js');
const { collectImageRefs } = require('../rules/image-refs.js');
const { isUtf8Document } = require('../translate/charset.js');

/** 上傳的圖片走 raw body（不是 JSON、也不是 multipart —— 零依賴，前端直接送 File） */
const rawImage = express.raw({
  type: (req) => String(req.headers['content-type'] ?? '').startsWith('image/'),
  limit: MAX_RESOURCE_BYTES + 1024,
});

function sendValidationFailed(res, result) {
  res.status(400).json({ error: 'validation_failed', details: result.errors });
}

/**
 * @param {{
 *   store: object,
 *   siteRules: object,
 *   config: object,
 *   logger: object,
 *   fetchImpl?: typeof fetch,
 *   translation?: object,
 * }} context
 */
function createRulesApiRouter({ store, siteRules, config, logger, fetchImpl, translation }) {
  const router = express.Router();

  function requireSite(req, res) {
    const site = store.sites.get(req.params.siteId);
    if (!site) {
      res.status(404).json({ error: 'not_found', message: `找不到網站「${req.params.siteId}」` });
      return null;
    }
    return site;
  }

  function requireRule(req, res, site) {
    const rule = store.siteRules.get(req.params.ruleId);
    if (!rule || rule.site_id !== site.id) {
      res.status(404).json({ error: 'not_found', message: `找不到規則「${req.params.ruleId}」` });
      return null;
    }
    return rule;
  }

  /* --------------------------------- 規則 --------------------------------- */

  router.get('/sites/:siteId/rules', (req, res) => {
    const site = requireSite(req, res);
    if (site) res.json({ rules: siteRules.listForSite(site.id) });
  });

  router.post('/sites/:siteId/rules', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    const result = validateRuleCreate(req.body);
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }

    const created = store.siteRules.create(site.id, result.value);
    res.status(201).json({ rule: siteRules.listForSite(site.id).find((rule) => rule.id === created.id) });
  });

  function updateRule(req, res) {
    const site = requireSite(req, res);
    if (!site || !requireRule(req, res, site)) return;

    const result = validateRuleUpdate(req.body);
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }

    store.siteRules.update(req.params.ruleId, result.value);
    res.json({
      rule: siteRules.listForSite(site.id).find((rule) => rule.id === req.params.ruleId),
    });
  }

  router.put('/sites/:siteId/rules/:ruleId', updateRule);
  router.patch('/sites/:siteId/rules/:ruleId', updateRule);

  router.delete('/sites/:siteId/rules/:ruleId', (req, res) => {
    const site = requireSite(req, res);
    if (!site || !requireRule(req, res, site)) return;

    store.siteRules.remove(req.params.ruleId);
    res.status(204).end();
  });

  /** 整批重排（規格 §4：順序可調）。一條一條更新會在中途留下重複的順序。 */
  router.post('/sites/:siteId/rules/reorder', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    const result = validateRuleOrder(req.body);
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }

    store.siteRules.reorder(site.id, result.value.ids);
    res.json({ rules: siteRules.listForSite(site.id) });
  });

  /**
   * 「試一下」（規格 §4）：對該站的某一頁跑一次，回報每條文字規則命中幾段。
   *
   * ⛔ 寫規則最怕的是「寫了沒反應」—— 所以這支要回**數字**，而且要連
   * 「這份文件沒宣告 UTF-8 所以文字規則整組跳過」這種原因一起說。
   *
   * `hide` 的命中數不在這裡算（那要真的 CSS 比對）：回應帶著 `css`，
   * 控制台用 DOMParser + querySelectorAll 自己數。
   */
  router.post('/sites/:siteId/rules/dry-run', async (req, res, next) => {
    const site = requireSite(req, res);
    if (!site) return;

    const path = typeof req.body?.path === 'string' && req.body.path.startsWith('/') ? req.body.path : '/';

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

      // 文字規則套在**翻譯後**的文字上，所以試跑也要先翻一遍，不然看到的
      // 命中數跟實際頁面不一樣（規格 §1 的執行順序）
      const translated = translation
        ? translation.translateHtml(page.html, { site, contentType: page.contentType })
        : page.html;

      res.json({
        path,
        // 沒宣告 UTF-8 的文件整組文字規則都會被跳過（rules/service.js 有理由），
        // 那是「寫了沒反應」最難猜的原因之一，所以要明說
        charset_ok: isUtf8Document(page.html, page.contentType),
        ...siteRules.dryRun(translated, store.siteRules.listBySite(site.id)),
      });
    } catch (error) {
      next(error);
    }
  });

  /* ------------------------------- 資源覆寫 ------------------------------- */

  router.get('/sites/:siteId/resources', (req, res) => {
    const site = requireSite(req, res);
    if (site) res.json({ resources: store.resourceOverrides.listBySite(site.id) });
  });

  /**
   * 換一張圖。`?path=/images/logo.png` + raw 的圖片 body。
   *
   * 為什麼不是 multipart：零依賴（express 內建 raw parser），而且前端直接
   * 把 `File` 當 body 送出去就好，不用組 FormData 也不用 base64 膨脹 33%。
   */
  router.put('/sites/:siteId/resources', rawImage, (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    const path = validateResourcePath(req.query.path);
    if (!path.ok) {
      sendValidationFailed(res, path);
      return;
    }

    const upload = validateResourceUpload(req.body, req.headers['content-type']);
    if (!upload.ok) {
      sendValidationFailed(res, upload);
      return;
    }

    // 檔案進內容定址的 assets（跟 @require / @resource 同一張表）
    const asset = store.assets.put({
      url: `lm://site/${site.id}${path.value}`,
      content: upload.value.content,
      content_type: upload.value.content_type,
    });

    res.status(201).json({
      resource: store.resourceOverrides.put(site.id, {
        path: path.value,
        sha256: asset.sha256,
        content_type: upload.value.content_type,
      }),
    });
  });

  router.patch('/sites/:siteId/resources/:resourceId', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    const existing = store.resourceOverrides.get(req.params.resourceId);
    if (!existing || existing.site_id !== site.id) {
      res.status(404).json({ error: 'not_found', message: '找不到這筆資源覆寫' });
      return;
    }
    if (typeof req.body?.enabled !== 'boolean') {
      sendValidationFailed(res, { errors: [{ field: 'enabled', message: 'enabled 只接受 true/false' }] });
      return;
    }

    res.json({ resource: store.resourceOverrides.update(existing.id, { enabled: req.body.enabled }) });
  });

  router.delete('/sites/:siteId/resources/:resourceId', (req, res) => {
    const site = requireSite(req, res);
    if (!site) return;

    const existing = store.resourceOverrides.get(req.params.resourceId);
    if (!existing || existing.site_id !== site.id) {
      res.status(404).json({ error: 'not_found', message: '找不到這筆資源覆寫' });
      return;
    }

    store.resourceOverrides.remove(existing.id);
    res.status(204).end();
  });

  /**
   * 候選圖（規格 §3.6）：這個站的某一頁載過哪些圖。
   * 規格明說不要逼使用者自己開 DevTools 抄路徑。
   */
  router.get('/sites/:siteId/resource-candidates', async (req, res, next) => {
    const site = requireSite(req, res);
    if (!site) return;

    const path = typeof req.query.path === 'string' && req.query.path.startsWith('/') ? req.query.path : '/';

    try {
      const page = await fetchUpstreamPage(site, path, {
        fetchImpl,
        allowPrivate: config.allowPrivate,
        timeoutMs: config.upstreamTimeoutMs,
      });

      if (page.html === null) {
        res.status(400).json({
          error: 'not_html',
          message: `${path} 回的不是 HTML（status ${page.status}）`,
        });
        return;
      }

      res.json({ path, candidates: collectImageRefs(page.html, { origin: site.target_origin }) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createRulesApiRouter };
