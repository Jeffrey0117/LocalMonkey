'use strict';

const express = require('express');

const {
  validateSiteCreate,
  validateSiteUpdate,
  validateScriptCreate,
  validateScriptUpdate,
} = require('../lib/validate.js');
const { assertOriginAllowed, SsrfBlockedError } = require('../lib/ssrf.js');
const { DuplicateIdError, NotFoundError } = require('../db/errors.js');

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
function createAdminApiRouter({ store, config, logger }) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  const ssrfOptions = { allowPrivate: config.allowPrivate };

  function requireSite(req, res) {
    const site = store.sites.get(req.params.siteId);
    if (!site) {
      sendNotFound(res, `找不到網站「${req.params.siteId}」`);
      return null;
    }
    return site;
  }

  router.get('/sites', (req, res) => {
    res.json({ sites: store.sites.list() });
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

  router.put('/sites/:siteId', async (req, res) => {
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
  });

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

  router.get('/scripts/:scriptId', (req, res) => {
    const script = store.scripts.get(req.params.scriptId);
    if (!script) {
      sendNotFound(res, `找不到腳本「${req.params.scriptId}」`);
      return;
    }
    res.json({ script });
  });

  router.put('/scripts/:scriptId', (req, res) => {
    const result = validateScriptUpdate(req.body);
    if (!result.ok) {
      sendValidationFailed(res, result);
      return;
    }
    if (!store.scripts.get(req.params.scriptId)) {
      sendNotFound(res, `找不到腳本「${req.params.scriptId}」`);
      return;
    }

    res.json({ script: store.scripts.update(req.params.scriptId, result.value) });
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
