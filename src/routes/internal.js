'use strict';

const fs = require('node:fs');
const path = require('node:path');

const express = require('express');

const { wrapUserCode } = require('../lib/user-script.js');
const { buildShimConfig, renderShim } = require('../lib/gm-shim.js');
const { themeFor, isKnownTheme, DEFAULT_THEME } = require('../reskin/themes/index.js');
const { createPaygate } = require('../reskin/paygate.js');
const { pathnameOf } = require('../reskin/service.js');
const { fetchUpstreamPage } = require('../services/fetch-page.js');
const { requestOrigin } = require('../services/delivery.js');
const { silentLogger } = require('../logger.js');

/**
 * `/__lm/*`：LocalMonkey 自己的端點（腳本、GM shim、@require 資產）。
 * 刻意不要求後台 token —— 這些是瀏覽器匿名載入的資源。
 */

const SHA256_FILE_PATTERN = /^([0-9a-f]{64})(\.[A-Za-z0-9]+)?$/;

/**
 * 重繪版型的前端（SPEC-reskin §4）。跟 GM shim 同一個做法：瀏覽器端的程式
 * 住在 `src/public/`，啟動後讀一次檔、沒有 build step。
 */
const BROWSER_SCRIPTS = Object.freeze({
  'shop.js': path.join(__dirname, '..', 'public', 'reskin-shop.js'),
  // 無限載入（SPEC-reskin-v2 §7）。只有列表頁會載它。
  'feed.js': path.join(__dirname, '..', 'public', 'reskin-feed.js'),
});

const cachedScripts = new Map();

function browserScript(name) {
  if (!cachedScripts.has(name)) {
    cachedScripts.set(name, fs.readFileSync(BROWSER_SCRIPTS[name], 'utf8'));
  }
  return cachedScripts.get(name);
}

/**
 * 無限載入拿來要下一頁的那個路徑。
 *
 * ⛔ **只收「這個站的代理路徑」。** 前端手上的網址是抽取層給的
 * （`/p/<siteId>/page/2` 這種形狀），所以這裡可以把形狀釘死 ——
 * 這個端點是免認證的，而它會讓伺服器去抓一次上游頁面。
 * 釘死形狀之後它能做的事就不會超過「使用者自己開那一頁」。
 *
 * @returns {string|null} 上游路徑（`/page/2`），認不出來就 null
 */
const PROXY_PATH_PATTERN = /^\/p\/([a-z0-9-]+)(\/[^\s]*)?$/;
const MAX_FEED_PATH = 512;

function upstreamPathFrom(raw, siteId) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_FEED_PATH) return null;

  const matched = PROXY_PATH_PATTERN.exec(raw);
  if (matched === null || matched[1] !== siteId) return null;

  return matched[2] ?? '/';
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

/**
 * @param {{
 *   store: object,
 *   favicons: object,
 *   reskin?: object,
 *   config?: object,
 *   logger?: object,
 *   fetchImpl?: typeof fetch,
 * }} context
 *   `reskin` / `config` / `fetchImpl` 只有重繪商城的三個端點要用
 *   （下一頁、結帳、付款回來）。沒給就不掛那三支 —— 同
 *   `admin-api.js` 對 `crawler` 的做法（地雷 39：新依賴要一路轉下去）。
 */
function createInternalRouter({ store, favicons, reskin, config, logger = silentLogger, fetchImpl }) {
  const router = express.Router();

  const paygate =
    reskin && config
      ? createPaygate({ settings: config.paygate ?? {}, fetchImpl, logger })
      : null;

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
  /**
   * ⛔ 一支端點一行，**不要**寫成 `:file(shop.js|feed.js)` ——
   * Express 5 的 path-to-regexp 把參數裡的正則拿掉了，那種寫法會在啟動時
   * 直接丟錯（同地雷 3 的家族：`/*` 要寫成 `/{*splat}`）。
   */
  for (const name of Object.keys(BROWSER_SCRIPTS)) {
    router.get(`/reskin/${name}`, (req, res) => {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-content-type-options', 'nosniff');
      res.send(browserScript(name));
    });
  }

  /**
   * 無限載入的下一頁（SPEC-reskin-v2 §7）。
   *
   * ⛔ **回 JSON，但 `html` 那個欄位是伺服器端畫好的卡片。**
   * 回純資料的話前端就得自己有一份卡片的 markup —— 同一張卡兩個版本
   * （地雷 62 的家族）。所以契約是「這一批的 HTML + 分頁資訊」。
   *
   * ⛔ 失敗一律回 `{ ok: false, reason }` 而不是 4xx/5xx 的 HTML：
   * 前端要分得出「到底了」與「壞了」（後者才顯示重試）。
   */
  router.get('/reskin/listing', async (req, res, next) => {
    if (!reskin) {
      sendNotFound(res, '這個實例沒有掛重繪服務');
      return;
    }

    res.setHeader('cache-control', 'no-store');

    const siteId = String(req.query.site ?? '');
    const site = store.sites.get(siteId);
    if (!site || !site.enabled) {
      res.status(404).json({ ok: false, reason: 'no-site' });
      return;
    }

    const upstreamPath = upstreamPathFrom(req.query.path, siteId);
    if (upstreamPath === null) {
      res.status(400).json({ ok: false, reason: 'bad-path' });
      return;
    }

    try {
      const page = await fetchUpstreamPage(site, upstreamPath, {
        fetchImpl,
        allowPrivate: config.allowPrivate,
        timeoutMs: config.upstreamTimeoutMs,
      });

      if (page.html === null) {
        res.status(502).json({ ok: false, reason: 'not-html', status: page.status });
        return;
      }

      const result = reskin.nextPage(page.html, {
        site,
        pathname: pathnameOf(upstreamPath),
        contentType: page.contentType,
      });

      if (!result.ok) {
        logger.warn(`${siteId} ${upstreamPath} 的下一頁抽不出來：${result.reason}`);
        res.status(200).json({ ok: false, reason: result.reason });
        return;
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * 結帳（SPEC-reskin-v2 §8）。**只有測試環境**。
   *
   * ⛔ 免認證是刻意的（商店前台本來就是匿名的，整個代理也是），
   * 但因此這支**只做一件事**：拿這個站的設定去 PayGate 建一筆訂單。
   * 金額、方案、產品全部來自伺服器端的 env —— 請求裡唯一被採用的
   * 使用者輸入是 email。
   *
   * ⛔ 沒設 env 就回 503 + 一句人看得懂的話，前端會留在面板上顯示它。
   * 「按了沒反應」是這種按鈕最糟的失敗方式。
   */
  router.post('/reskin/checkout', express.json({ limit: 4096 }), async (req, res, next) => {
    if (!reskin || paygate === null) {
      sendNotFound(res, '這個實例沒有掛重繪服務');
      return;
    }

    res.setHeader('cache-control', 'no-store');

    const site = store.sites.get(String(req.body?.site ?? ''));
    if (!site || !site.enabled || site.reskin_enabled !== true) {
      res.status(404).json({ ok: false, message: '這個商店不存在或沒有開重繪。' });
      return;
    }

    const origin = requestOrigin(req);
    if (origin === null) {
      res.status(400).json({ ok: false, message: '認不出這個請求的 Host。' });
      return;
    }

    try {
      /**
       * ⛔ 回跳網址用**這個請求的 Host** 組，不從設定讀：使用者會從
       * 127.0.0.1、區網 IP、tunnel 網域進來，每一種都要回到他來的地方
       * （同投遞端點的決策；而「後端自己組對外網址」在代理後面會組出內部位址）。
       */
      const result = await paygate.createCheckout({
        email: req.body?.email,
        returnUrl: `${origin}/__lm/reskin/paid?site=${encodeURIComponent(site.id)}`,
      });

      if (!result.ok) {
        res.status(result.status).json({ ok: false, message: result.message });
        return;
      }

      res.json({ ok: true, checkout_url: result.checkoutUrl });
    } catch (error) {
      next(error);
    }
  });

  /**
   * 從付款頁回來（PayGate 把這個網址當藍新的「返回商店」）。
   *
   * ⛔ **這一跳帶不回付款結果**（藍新的 `BackURL` 就只是一顆返回按鈕，
   * 真正的結果是 server-to-server 打到 PayGate 的 notify）。所以這一頁
   * 不准寫「付款成功」—— 寫了就是在猜，而猜錯的方向剛好是最糟的那個。
   */
  router.get('/reskin/paid', (req, res) => {
    const site = store.sites.get(String(req.query.site ?? ''));
    const theme = themeFor(site?.reskin_theme ?? DEFAULT_THEME);

    res.setHeader('cache-control', 'no-store');
    res.type('html').send(
      theme.renderNotice({
        title: '付款流程結束',
        lines: [
          '如果你完成了刷卡，金流那邊已經收到通知，訂閱會自己開通 —— 這一頁看不到結果是正常的（結果是伺服器之間對帳的，不走瀏覽器）。',
          '如果你是中途離開付款頁的，那什麼都沒有被扣。',
        ],
        home: site ? `/p/${site.id}/` : null,
      }),
    );
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
    // 舊的版型名會被轉成現在那個（themes/index.js 的 ALIASES），
    // 所以快取裡那份舊網址的 HTML 照樣拿得到樣式
    res.send(themeFor(id).css);
  });

  router.use((req, res) => {
    sendNotFound(res, 'LocalMonkey：沒有這個內部端點');
  });

  /**
   * ⛔ 這支要掛在 404 後面（arity 4 才是 error handler，順序同地雷 10）。
   * 它只為了一件事：`express.json()` 擋下來的壞 body 不要變成一頁 500 的 HTML
   * —— 前台的 fetch 在等 JSON。
   */
  router.use((error, req, res, next) => {
    if (res.headersSent || typeof error?.status !== 'number' || error.status >= 500) {
      next(error);
      return;
    }

    res.status(error.status).json({ ok: false, message: '這個請求看不懂。' });
  });

  return router;
}

module.exports = { createInternalRouter, safeAssetContentType, upstreamPathFrom };
