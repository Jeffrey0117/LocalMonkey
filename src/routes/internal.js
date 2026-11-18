'use strict';

const fs = require('node:fs');
const path = require('node:path');

const express = require('express');

const { wrapUserCode } = require('../lib/user-script.js');
const { buildShimConfig, renderShim } = require('../lib/gm-shim.js');
const { THEMES, isKnownTheme } = require('../reskin/themes/index.js');

/**
 * `/__lm/*`：LocalMonkey 自己的端點（腳本、GM shim、@require 資產）。
 * 刻意不要求後台 token —— 這些是瀏覽器匿名載入的資源。
 */

const SHA256_FILE_PATTERN = /^([0-9a-f]{64})(\.[A-Za-z0-9]+)?$/;

/**
 * 重繪版型的前端（SPEC-reskin §4）。跟 GM shim 同一個做法：瀏覽器端的程式
 * 住在 `src/public/`，啟動後讀一次檔、沒有 build step。
 */
const SHOP_SCRIPT_PATH = path.join(__dirname, '..', 'public', 'reskin-shop.js');

let cachedShopScript = null;

function shopScript() {
  if (cachedShopScript === null) cachedShopScript = fs.readFileSync(SHOP_SCRIPT_PATH, 'utf8');
  return cachedShopScript;
}

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

function createInternalRouter({ store, favicons }) {
  const router = express.Router();

  /**
   * 站點 favicon（後台列表用）。**永遠回 200 的一張圖** —— 抓不到、站不存在、
   * 被 SSRF 擋下來都回內建的佔位 SVG。列表一次畫十幾個站，破圖與 console 錯誤
   * 比沒有圖示難看得多。抓取與快取的政策在 services/favicon.js。
   */
  router.get('/favicon/:siteId', async (req, res, next) => {
    try {
      const { content, contentType } = await favicons.resolve(req.params.siteId);

      res.setHeader('content-type', contentType);
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('cache-control', 'private, max-age=600');
      res.end(content);
    } catch (error) {
      next(error);
    }
  });

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

  /**
   * 重繪版型的樣式表與前端（SPEC-reskin §4）。
   *
   * 外部檔案而不是內嵌：可以被瀏覽器快取、錯誤行號正確，而且不會跟上游的
   * `</style>` / `</script>` 攪在一起（同「注入用外部 script src」那個決策）。
   *
   * ⛔ 快取政策是 `no-cache` 而不是長期快取：版型沒有內容雜湊可以掛在網址上，
   * 而「改了版型但瀏覽器拿的是舊的」正是這個專案踩過兩次的坑（地雷 33 / 46）。
   * 這兩個檔案都很小，一次 304 的成本遠低於那個症狀的查錯成本。
   */
  router.get('/reskin/shop.js', (req, res) => {
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(shopScript());
  });

  router.get('/reskin/:themeFile', (req, res) => {
    const { themeFile } = req.params;
    if (!themeFile.endsWith('.css')) {
      sendNotFound(res, '沒有這個版型樣式表');
      return;
    }

    const id = themeFile.slice(0, -'.css'.length);
    if (!isKnownTheme(id)) {
      sendNotFound(res, `沒有「${id}」這個版型`);
      return;
    }

    res.setHeader('content-type', 'text/css; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(THEMES[id].css);
  });

  router.use((req, res) => {
    sendNotFound(res, 'LocalMonkey：沒有這個內部端點');
  });

  return router;
}

module.exports = { createInternalRouter, safeAssetContentType };
