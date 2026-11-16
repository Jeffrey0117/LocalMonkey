'use strict';

const express = require('express');

const {
  validateSiteCreate,
  validateSiteUpdate,
  validateScriptCreate,
  validateScriptUpdate,
  validateUserscriptCreate,
  validateUserscriptUpdate,
  validateParseRequest,
} = require('../lib/validate.js');
const { assertOriginAllowed, SsrfBlockedError } = require('../lib/ssrf.js');
const { DuplicateIdError, NotFoundError } = require('../db/errors.js');
const { parseUserscript } = require('../userscript/parse.js');
const { deployUserscript, DeployError } = require('../services/deploy.js');

/** v2 的腳本只接受這些輸入欄位；其他（code / match_glob / run_at…）是 v1 的相容欄位 */
const V2_SCRIPT_KEYS = new Set(['source', 'enabled', 'order_index', 'fallbackName']);

function isV2OnlyBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;

  const keys = Object.keys(body);
  return keys.length > 0 && keys.every((key) => V2_SCRIPT_KEYS.has(key));
}

function sendValidationFailed(res, result) {
  res.status(400).json({ error: 'validation_failed', details: result.errors });
}

function sendNotFound(res, message) {
  res.status(404).json({ error: 'not_found', message });
}

function createErrorHandler(logger) {
  return function adminApiErrorHandler(error, req, res, next) {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof SsrfBlockedError) {
      res.status(400).json({ error: 'ssrf_blocked', message: error.message });
      return;
    }
    if (error instanceof DeployError) {
      res.status(400).json({ error: 'deploy_failed', message: error.message });
      return;
    }
    if (error instanceof DuplicateIdError) {
      res.status(409).json({ error: 'duplicate_id', message: error.message });
      return;
    }
    if (error instanceof NotFoundError) {
      res.status(404).json({ error: 'not_found', message: error.message });
      return;
    }
    if (error?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'request body 不是合法的 JSON' });
      return;
    }
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large', message: 'request body 太大' });
      return;
    }

    logger.error('後台 API 發生未預期的錯誤', error);
    res.status(500).json({
      error: 'internal_error',
      message: '後台 API 發生未預期的錯誤，詳情在伺服器 log',
    });
  };
}

/**
 * `/admin/api/*`。已經過 admin auth（token + 跨站檢查），這裡只管資料。
 */
function createAdminApiRouter({ store, config, logger, fetchImpl }) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  const ssrfOptions = { allowPrivate: config.allowPrivate };
  const deployContext = { store, config, logger, fetchImpl };

  function requireSite(req, res) {
    const site = store.sites.get(req.params.siteId);
    if (!site) {
      sendNotFound(res, `找不到網站「${req.params.siteId}」`);
      return null;
    }
    return site;
  }

  /**
   * 單一腳本的回應形狀：v2 的欄位（source / metadata / sites）**外加** v1 的別名
   * （code / site_id / match_glob）。v1 的後台與既有測試讀的是別名，v2 的控制台
   * 讀的是前者，兩邊同一個端點。
   */
  function scriptResponse(scriptId) {
    const script = store.userscripts.get(scriptId);
    if (!script) return null;

    const legacy = store.scripts.get(scriptId);

    return {
      ...script,
      code: script.source,
      site_id: legacy?.site_id ?? null,
      match_glob: legacy?.match_glob ?? null,
    };
  }

  router.get('/sites', (req, res) => {
    res.json({ sites: store.sites.listWithScripts() });
  });

  router.post('/sites', async (req, res) => {
    const result = validateSiteCreate(req.body);
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }

    await assertOriginAllowed(result.value.target_origin, ssrfOptions);
    res.status(201).json({ site: store.sites.create(result.value) });
  });

  router.get('/sites/:siteId', (req, res) => {
    const site = requireSite(req, res);
    if (site) res.json({ site });
  });

  // PUT 與 PATCH 同一套：都只准改 name / target_origin / enabled
  // （「網站」分頁是唯讀清單，唯一的寫入就是啟用開關與萬用子網域要指定的具體主機）
  async function updateSite(req, res) {
    const result = validateSiteUpdate(req.body);
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }
    if (!requireSite(req, res)) return;

    if (result.value.target_origin) {
      await assertOriginAllowed(result.value.target_origin, ssrfOptions);
    }

    res.json({ site: store.sites.update(req.params.siteId, result.value) });
  }

  router.put('/sites/:siteId', updateSite);
  router.patch('/sites/:siteId', updateSite);

  router.delete('/sites/:siteId', (req, res) => {
    if (!store.sites.remove(req.params.siteId)) {
      sendNotFound(res, `找不到網站「${req.params.siteId}」`);
      return;
    }
    res.status(204).end();
  });

  router.get('/sites/:siteId/scripts', (req, res) => {
    const site = requireSite(req, res);
    if (site) res.json({ scripts: store.scripts.listBySite(site.id) });
  });

  router.post('/sites/:siteId/scripts', (req, res) => {
    const result = validateScriptCreate(req.body);
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }
    const site = requireSite(req, res);
    if (!site) return;

    res.status(201).json({ script: store.scripts.create(site.id, result.value) });
  });

  /* ------------------------- v2：腳本優先的控制台 ------------------------- */

  router.get('/scripts', (req, res) => {
    res.json({ scripts: store.userscripts.list() });
  });

  /** 只解析不寫入：給「丟腳本」的預覽與編輯器打字時的即時資訊列用 */
  router.post('/userscript/parse', (req, res) => {
    const result = validateParseRequest(req.body);
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }

    res.json({
      parsed: parseUserscript(result.value.source, { fallbackName: result.value.fallbackName }),
    });
  });

  router.post('/scripts', async (req, res) => {
    const result = validateUserscriptCreate(req.body);
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }

    const deployed = await deployUserscript(deployContext, result.value);

    res.status(201).json({
      script: scriptResponse(deployed.script.id),
      targets: deployed.targets,
      warnings: deployed.warnings,
    });
  });

  router.get('/scripts/:scriptId', (req, res) => {
    const script = scriptResponse(req.params.scriptId);
    if (!script) {
      sendNotFound(res, `找不到腳本「${req.params.scriptId}」`);
      return;
    }
    res.json({ script });
  });

  /**
   * 帶 `source` → 走 v2 的部署流程（重新解析 + 重算綁定）。
   * 只帶 v1 的欄位（code / match_glob / run_at…）→ 走 v1 的相容更新。
   */
  router.put('/scripts/:scriptId', async (req, res) => {
    if (!store.userscripts.get(req.params.scriptId)) {
      sendNotFound(res, `找不到腳本「${req.params.scriptId}」`);
      return;
    }

    if (req.body && typeof req.body === 'object' && 'source' in req.body) {
      const result = validateUserscriptUpdate(req.body);
      if (!result.ok) {
        sendValidationFailed(res, result);
        return;
      }

      const deployed = await deployUserscript(deployContext, {
        ...result.value,
        scriptId: req.params.scriptId,
      });

      res.json({
        script: scriptResponse(deployed.script.id),
        targets: deployed.targets,
        warnings: deployed.warnings,
      });
      return;
    }

    // 沒帶 source：只有 v2 的欄位就走 v2，出現任何 v1 欄位就走相容路徑
    // （不能用「v2 validator 過得了」當判斷 —— 它會把 code / match_glob 當不認識的欄位
    //   忽略掉，結果使用者改的東西被靜默丟棄）
    if (isV2OnlyBody(req.body)) {
      const v2Only = validateUserscriptUpdate(req.body);
      if (!v2Only.ok) {
        sendValidationFailed(res, v2Only);
        return;
      }

      store.userscripts.update(req.params.scriptId, v2Only.value);
      res.json({ script: scriptResponse(req.params.scriptId) });
      return;
    }

    const legacy = validateScriptUpdate(req.body);
    if (!legacy.ok) {
      sendValidationFailed(res, legacy);
      return;
    }

    store.scripts.update(req.params.scriptId, legacy.value);
    res.json({ script: scriptResponse(req.params.scriptId) });
  });

  router.delete('/scripts/:scriptId', (req, res) => {
    if (!store.scripts.remove(req.params.scriptId)) {
      sendNotFound(res, `找不到腳本「${req.params.scriptId}」`);
      return;
    }
    res.status(204).end();
  });

  router.use((req, res) => {
    sendNotFound(res, `後台 API 沒有這個端點：${req.method} ${req.originalUrl}`);
  });

  router.use(createErrorHandler(logger));

  return router;
}

module.exports = { createAdminApiRouter };
