'use strict';

const express = require('express');

const { wrapUserCode } = require('../lib/user-script.js');
const { buildShimConfig, renderShim } = require('../lib/gm-shim.js');

/**
 * `/__lm/*`：LocalMonkey 自己的端點（腳本、GM shim、@require 資產）。
 * 刻意不要求後台 token —— 這些是瀏覽器匿名載入的資源。
 */

const SHA256_FILE_PATTERN = /^([0-9a-f]{64})(\.[A-Za-z0-9]+)?$/;

/**
 * 資產是「從別人的 CDN 抓回來的檔案」，而且是從**我們自己的 origin** 送出去的。
 * 如果照著上游的 content-type 回 text/html，那支 HTML 就是一個同源頁面，
 * 可以直接打 `/admin/api/*`（後台 cookie 的 Path=/admin，瀏覽器會幫它帶上）。
 * 所以這裡只放行幾種安全的型別，其他一律降級成 text/plain。
 */
function safeAssetContentType(asset, extension) {
  if (extension === '.js') return 'application/javascript; charset=utf-8';

  const declared = String(asset.content_type ?? '').toLowerCase();

  if (/^application\/(javascript|x-javascript)/.test(declared) || /^text\/javascript/.test(declared)) {
    return 'application/javascript; charset=utf-8';
  }
  if (declared.startsWith('text/css')) return 'text/css; charset=utf-8';
  if (declared.startsWith('image/')) return declared.split(';')[0];
  if (declared.startsWith('application/json')) return 'application/json; charset=utf-8';

  return 'text/plain; charset=utf-8';
}

function sendNotFound(res, message) {
  res.status(404).type('text/plain; charset=utf-8').send(message);
}

function createInternalRouter({ store }) {
  const router = express.Router();

  router.get('/script/:scriptFile', (req, res) => {
    const { scriptFile } = req.params;
    if (!scriptFile.endsWith('.js')) {
      sendNotFound(res, '腳本不存在');
      return;
    }

    const script = store.userscripts.get(scriptFile.slice(0, -'.js'.length));
    if (!script || !script.enabled) {
      sendNotFound(res, '腳本不存在或已停用');
      return;
    }

    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.setHeader('cache-control', 'no-cache'); // 改完要立刻生效
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(
      wrapUserCode(script.name, script.source, {
        runAt: script.run_at,
        scriptId: script.id,
        grants: script.metadata?.grants,
        noframes: script.metadata?.noframes === true,
      }),
    );
  });

  /**
   * GM shim。只有「有 @grant 且不是 none」的腳本才有（needsShim），
   * 其他一律 404 —— 不要給沒要求的腳本任何 GM_* 能力。
   */
  router.get('/shim/:scriptFile', (req, res) => {
    const { scriptFile } = req.params;
    if (!scriptFile.endsWith('.js')) {
      sendNotFound(res, 'shim 不存在');
      return;
    }

    const script = store.userscripts.get(scriptFile.slice(0, -'.js'.length));
    if (!script || !script.enabled || !script.metadata?.needsShim) {
      sendNotFound(res, 'shim 不存在（這支腳本沒有宣告 @grant）');
      return;
    }

    const config = buildShimConfig(script, { loadAsset: (sha256) => store.assets.get(sha256) });

    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.setHeader('cache-control', 'no-cache'); // @grant 改了要立刻生效
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(renderShim(config));
  });

  router.get('/asset/:assetFile', (req, res) => {
    const matched = SHA256_FILE_PATTERN.exec(req.params.assetFile);
    if (!matched) {
      sendNotFound(res, '資產不存在');
      return;
    }

    const asset = store.assets.get(matched[1]);
    if (!asset) {
      sendNotFound(res, '資產不存在');
      return;
    }

    res.setHeader('content-type', safeAssetContentType(asset, matched[2]));
    res.setHeader('x-content-type-options', 'nosniff');
    // 內容定址：網址變了才代表內容變了，所以可以放心長期快取
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.end(asset.content);
  });

  router.use((req, res) => {
    sendNotFound(res, 'LocalMonkey：沒有這個內部端點');
  });

  return router;
}

module.exports = { createInternalRouter, safeAssetContentType };
