'use strict';

const fs = require('node:fs');
const path = require('node:path');

const express = require('express');

const { wrapUserCode } = require('../lib/user-script.js');
const { buildShimConfig, renderShim } = require('../lib/gm-shim.js');
const { themeFor, isKnownTheme, DEFAULT_THEME } = require('../reskin/themes/index.js');
const {
  newebpayStatus,
  normalizeBaseUrl,
  newOrderNo,
  buildMpgForm,
  readCallback,
} = require('../reskin/newebpay.js');
const { compilePricing, headlinePrice } = require('../reskin/pricing.js');
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

  /**
   * 金流（SPEC-checkout）。`reskin` / `config` 沒給就整組不掛
   * —— 同 `admin-api.js` 對 `crawler` 的做法。
   */
  const newebpay = reskin && config ? config.newebpay ?? {} : null;
  const payments = newebpay === null ? null : newebpayStatus(newebpay);

  /**
   * 回呼網址的根。
   *
   * ⛔ 預設用**這個請求的 Host**（同投遞端點的決策：使用者會從 127.0.0.1、
   * 區網 IP、tunnel 網域進來，每一種都要回到他來的地方）。設了
   * `LOCALMONKEY_PUBLIC_URL` 才以它為準 —— 那是給「躲在反向代理後面」用的，
   * 那時候 `Host` 是內部位址，自己組會組出打不開的網址。
   */
  function callbackBase(req) {
    return normalizeBaseUrl(config?.publicUrl) ?? requestOrigin(req);
  }

  function callbackUrls(req, base, siteId, orderId) {
    const site = encodeURIComponent(siteId);
    const order = encodeURIComponent(orderId);

    return {
      // 付完瀏覽器帶著加密結果 POST 回來的那一支（localhost 唯一收得到的）
      returnUrl: `${base}/__lm/reskin/checkout/return`,
      // 藍新伺服器主動打的那一支。⛔ localhost 收不到（規格 §0.2）
      notifyUrl: `${base}/__lm/reskin/checkout/notify`,
      // 「返回商店」／中途離開：讀我們自己的訂單狀態，不猜結果
      clientBackUrl: `${base}/__lm/reskin/paid?site=${site}&order=${order}`,
    };
  }

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

  /* ------------------------------ 結帳（§2） ------------------------------ */

  /** 這個站現在賣多少錢。**金額只由伺服器端算**，請求裡的數字一律不採信。 */
  function priceFor(site, { planId, qty }) {
    const pricing = compilePricing(site.reskin_pricing);
    const value = pricing.ok ? pricing.value : compilePricing(null).value;

    const headline = headlinePrice(value.plans);
    const plan =
      value.plans.find((candidate) => candidate.id === planId) ??
      value.plans.find((candidate) => candidate.price === headline.price) ??
      value.plans[0];

    return { plan, amount: plan.price * qty };
  }

  function clampQty(raw) {
    const qty = Number.parseInt(raw, 10);
    return Number.isInteger(qty) && qty >= 1 ? Math.min(qty, 99) : 1;
  }

  /**
   * 商品的身分與名稱。
   *
   * ⛔ 這兩個是**前端給的**（抽取層的資料只有瀏覽器那一頁有，伺服器要知道
   * 就得再抓一次上游再抽一次）。所以它們只能當**標籤**用：進訂單、進
   * `ItemDesc`，長度夾死、輸出一律轉義。
   * **金額不在這裡** —— 那個只由 `priceFor()` 從伺服器端的設定算。
   */
  function productFrom(body) {
    const id = String(body?.productId ?? '').trim().slice(0, 80);
    const name = String(body?.productName ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);

    return { id: id.length > 0 ? id : '-', name: name.length > 0 ? name : '模板' };
  }

  /**
   * 結帳（SPEC-checkout §2）：建一筆 `pending` 訂單，回那張要 POST 去藍新的表單。
   *
   * ⛔ 免認證是刻意的（商店前台本來就是匿名的，整個代理也是），
   * 所以這支**能被任何人呼叫** —— 它因此只做一件事：建一筆我們自己的訂單。
   * 金額來自伺服器端的價格設定，`MerchantOrderNo` 由我們產生，
   * 請求裡唯一被採用的使用者輸入是 email 與（夾過的）數量與商品標籤。
   *
   * ⛔ 回應裡**沒有** HashKey / HashIV。有的是 `MerchantID` / `TradeInfo` /
   * `TradeSha` —— 那是 MPG 幕前支付的協定本身要瀏覽器送出去的東西
   * （`reskin/newebpay.js` 的檔頭有完整理由）。
   *
   * ⛔ 沒設 env 就回 503 + 一句人看得懂的話，前端會留在面板上顯示它。
   * 「按了沒反應」是這種按鈕最糟的失敗方式。
   */
  router.post('/reskin/checkout', express.json({ limit: 4096 }), (req, res, next) => {
    if (!reskin || payments === null) {
      sendNotFound(res, '這個實例沒有掛重繪服務');
      return;
    }

    res.setHeader('cache-control', 'no-store');

    if (!payments.connected) {
      res.status(503).json({ ok: false, message: '這個站還沒接金流（示範模式）。' });
      return;
    }

    const site = store.sites.get(String(req.body?.site ?? ''));
    if (!site || !site.enabled || site.reskin_enabled !== true) {
      res.status(404).json({ ok: false, message: '這個商店不存在或沒有開重繪。' });
      return;
    }

    const base = callbackBase(req);
    if (base === null) {
      res.status(400).json({ ok: false, message: '認不出這個請求的 Host。' });
      return;
    }

    try {
      const qty = clampQty(req.body?.qty);
      const { plan, amount } = priceFor(site, { planId: req.body?.plan, qty });

      // 藍新收不了 0 元的單。免費方案不該走金流，而不是送去被退回來。
      if (amount <= 0) {
        res.status(400).json({ ok: false, message: '這個方案不用付錢，不需要結帳。' });
        return;
      }

      const product = productFrom(req.body);
      const order = store.reskinOrders.create({
        id: newOrderNo(),
        siteId: site.id,
        productId: product.id,
        productName: product.name,
        amount,
        env: payments.env,
      });

      const form = buildMpgForm({
        settings: newebpay,
        order,
        email: typeof req.body?.email === 'string' ? req.body.email : null,
        urls: callbackUrls(req, base, site.id, order.id),
      });

      if (!form.ok) {
        // 這裡只會因為設定問題失敗，而 `payments.connected` 已經先擋過一次
        logger.error(`${site.id} 的結帳表單組不出來：${form.reason}`);
        res.status(503).json({ ok: false, message: '金流設定有問題，請檢查伺服器設定。' });
        return;
      }

      logger.info(
        `${site.id} 建立訂單 ${order.id}：${product.name} × ${qty}・${amount}・${payments.env}`,
      );

      res.json({
        ok: true,
        order_id: order.id,
        amount,
        plan: plan.id,
        env: payments.env,
        action: form.action,
        fields: form.fields,
      });
    } catch (error) {
      next(error);
    }
  });

  /* ---------------------------- 回呼（§2.2） ---------------------------- */

  /**
   * 收到一筆已經**驗過章、解過密**的回呼之後要做的事。
   *
   * ⛔ 順序是規格 §2.2 的第 2~4 條：先確認訂單是我們建的 → 再比對金額 →
   * 才看成功失敗。金額不符一律**不結算**（既不算成功也不改成失敗）：
   * 那代表有人動過參數，而那時候「把訂單標成失敗」會把真相蓋掉。
   *
   * @returns {{ outcome: string, order: object|null }}
   */
  function settle(callback) {
    if (callback.orderNo === null) return { outcome: 'bad-order-no', order: null };

    const order = store.reskinOrders.get(callback.orderNo);
    if (order === null) return { outcome: 'no-order', order: null };

    // 驗過章就代表對方握有我們的 HashKey，但商店代號還是要對得上
    // （同一把金鑰只服務一家商店，不符就是設定被換過）
    if (callback.merchantId !== null && callback.merchantId !== newebpay.merchantId) {
      return { outcome: 'wrong-merchant', order };
    }
    if (callback.amount !== null && callback.amount !== order.amount) {
      return { outcome: 'amount-mismatch', order };
    }

    const succeeded = callback.status === 'SUCCESS';

    /**
     * ⛔ idempotent（規格 §2.2 第 4 條）。同一筆訂單被打到兩次以上是
     * **正常的**：ReturnURL 與 NotifyURL 都會送，使用者還可能重新整理。
     * 條件寫在 UPDATE 的 WHERE 裡，`changes === 0` ＝ 早就結算過了。
     */
    const changes = succeeded
      ? store.reskinOrders.markPaid({
          id: order.id,
          tradeNo: callback.tradeNo,
          rawResult: callback.raw,
        })
      : store.reskinOrders.markFailed({ id: order.id, rawResult: callback.raw });

    return {
      outcome: succeeded ? (changes === 0 ? 'already-paid' : 'paid') : 'failed',
      order: store.reskinOrders.get(order.id),
    };
  }

  /** 拒絕回呼的理由 → 一句話。**不要把內部細節寫進去。** */
  const REJECTIONS = Object.freeze({
    'not-configured': '這台機器沒有接金流，收不了付款結果。',
    'missing-fields': '這筆回應缺少必要的欄位。',
    'too-large': '這筆回應太大了。',
    'bad-sha': '這筆付款結果的簽章對不上，已經拒絕處理。',
    'bad-cipher': '這筆付款結果解不開，已經拒絕處理。',
    'bad-payload': '這筆付款結果的內容看不懂，已經拒絕處理。',
    'bad-order-no': '這筆付款結果沒有認得出來的訂單編號。',
    'no-order': '找不到這筆訂單。',
    'wrong-merchant': '這筆付款結果不是這家商店的，已經拒絕處理。',
    'amount-mismatch': '這筆付款結果的金額跟訂單不一致，已經拒絕處理。',
  });

  /**
   * 驗 → 解 → 結算。ReturnURL 與 NotifyURL 共用這一支，差別只有「回什麼」。
   *
   * ⛔ **驗章在解密之前**（`readCallback` 的 return 順序就是那條規格）。
   */
  function handleCallback(req, source) {
    const read = readCallback(req.body, newebpay);

    if (!read.ok) {
      // 偽造的回呼要留得下痕跡 —— 但 log 不准印金鑰，也不印整段密文
      logger.warn(`${source} 的付款回呼被拒絕：${read.reason}`);
      return { ok: false, reason: read.reason, message: REJECTIONS[read.reason] ?? '這筆回應無法處理。' };
    }

    const { outcome, order } = settle(read);

    if (REJECTIONS[outcome] !== undefined) {
      logger.warn(`${source} 的付款回呼被拒絕：${outcome}（訂單 ${read.orderNo ?? '?'}）`);
      return { ok: false, reason: outcome, message: REJECTIONS[outcome] };
    }

    logger.info(`${source} 的付款回呼：${order.id} → ${outcome}（${read.status}）`);
    return { ok: true, outcome, order, status: read.status, message: read.message };
  }

  /** 訂單狀態 → 給人看的那一頁 */
  function noticeFor(result) {
    if (!result.ok) {
      return {
        title: '這筆付款結果沒有被接受',
        lines: [
          result.message,
          '如果你確實完成了刷卡，請把這一頁的時間告訴我們 —— 款項不會因為這一頁而消失，但訂單需要人工對帳。',
        ],
      };
    }

    const { order } = result;
    const amount = `${order.currency} ${order.amount}`;

    if (order.status === 'paid') {
      return {
        title: result.outcome === 'already-paid' ? '這筆訂單已經付過了' : '付款成功',
        lines: [
          `訂單 ${order.id}・${order.product_name}・${amount}`,
          order.trade_no === null ? '' : `金流交易序號：${order.trade_no}`,
          order.env === 'live'
            ? '這是正式環境的交易，款項已經真的被收取。'
            : '這是測試環境的交易，沒有真的收錢。',
        ].filter((line) => line.length > 0),
      };
    }

    return {
      title: '付款沒有完成',
      lines: [
        `訂單 ${order.id}・${order.product_name}・${amount}`,
        result.message.length > 0 ? `金流回報：${result.message}` : '金流沒有回報原因。',
        '這筆訂單沒有被收款。要重試的話回商城再按一次「立即購買」。',
      ],
    };
  }

  function renderNoticePage(res, site, { title, lines }, status = 200) {
    const theme = themeFor(site?.reskin_theme ?? DEFAULT_THEME);

    res.status(status);
    res.setHeader('cache-control', 'no-store');
    res.type('html').send(
      theme.renderNotice({ title, lines, home: site ? `/p/${site.id}/` : null }),
    );
  }

  /**
   * `ReturnURL`：藍新把使用者的瀏覽器 POST 回這裡，body 裡有加密的結果。
   *
   * ⛔ **這是 localhost 唯一收得到的回呼**（規格 §0.2）：`NotifyURL` 是藍新
   * 的伺服器主動打的，而它打不到 `127.0.0.1`。所以在這台機器上，訂單狀態
   * 完全靠這一跳 —— 使用者付完**關掉瀏覽器**就不會有人來告訴我們結果，
   * 那筆訂單會永遠停在 `pending`。這不是完整實作，正式站要讓 `NotifyURL`
   * 進得來（tunnel 或真的部署）。
   */
  router.post(
    '/reskin/checkout/return',
    express.urlencoded({ extended: false, limit: 64 * 1024 }),
    (req, res) => {
      if (!reskin || payments === null) {
        sendNotFound(res, '這個實例沒有掛重繪服務');
        return;
      }

      const result = handleCallback(req, 'ReturnURL');
      const site = result.ok ? store.sites.get(result.order.site_id) : null;

      // 驗章失敗回 403：這一頁是人在看，但狀態碼要說實話（偽造的回呼不是 200）
      renderNoticePage(res, site, noticeFor(result), result.ok ? 200 : 403);
    },
  );

  /**
   * `NotifyURL`：藍新的**伺服器**主動 POST 的那一支。
   *
   * ⛔ **在 localhost 這支永遠不會被呼叫到**（藍新打不到 127.0.0.1）。
   * 它存在是因為驗證與結算的邏輯跟 ReturnURL 完全一樣 —— 哪天換成 tunnel
   * 或真的部署，不用改一行程式就會開始對帳。回純文字（對方是機器）。
   */
  router.post(
    '/reskin/checkout/notify',
    express.urlencoded({ extended: false, limit: 64 * 1024 }),
    (req, res) => {
      if (!reskin || payments === null) {
        sendNotFound(res, '這個實例沒有掛重繪服務');
        return;
      }

      const result = handleCallback(req, 'NotifyURL');

      res.status(result.ok ? 200 : 403)
        .type('text/plain; charset=utf-8')
        .send(result.ok ? `OK ${result.outcome}` : `REJECTED ${result.reason}`);
    },
  );

  /**
   * `ClientBackURL`：使用者在付款頁按「返回商店」或中途離開時落地的地方。
   *
   * ⛔ **這一跳帶不回付款結果**（它就只是一顆返回按鈕）。所以這一頁不准猜 ——
   * 它去讀**我們自己的訂單**，訂單說什麼就寫什麼。還是 `pending` 就老實說
   * 「還沒收到結果」，不要寫成「付款成功」或「付款失敗」。
   */
  router.get('/reskin/paid', (req, res) => {
    const site = store.sites.get(String(req.query.site ?? ''));
    const order = reskin ? store.reskinOrders.get(String(req.query.order ?? '')) : null;

    if (order === null) {
      renderNoticePage(res, site, {
        title: '付款流程結束',
        lines: [
          '我們這邊沒有查到對應的訂單紀錄。如果你剛剛完成了刷卡，請把時間告訴我們以便對帳。',
          '如果你是中途離開付款頁的，那什麼都沒有被扣。',
        ],
      });
      return;
    }

    const amount = `${order.currency} ${order.amount}`;
    const lines = {
      paid: [
        `訂單 ${order.id}・${order.product_name}・${amount}`,
        order.env === 'live' ? '這是正式環境的交易。' : '這是測試環境的交易，沒有真的收錢。',
      ],
      pending: [
        `訂單 ${order.id}・${order.product_name}・${amount}`,
        '我們還沒收到這筆的付款結果。如果你剛完成刷卡，稍等一下再回來看；如果你是中途離開付款頁的，那什麼都沒有被扣。',
      ],
      failed: [`訂單 ${order.id}・${order.product_name}・${amount}`, '這筆付款沒有完成，沒有被收款。'],
      cancelled: [`訂單 ${order.id}・${order.product_name}・${amount}`, '這筆訂單已經取消。'],
    };

    const titles = {
      paid: '付款成功',
      pending: '還沒收到付款結果',
      failed: '付款沒有完成',
      cancelled: '訂單已取消',
    };

    renderNoticePage(res, site, {
      title: titles[order.status] ?? '訂單狀態',
      lines: lines[order.status] ?? [`訂單 ${order.id}・${order.product_name}・${amount}`],
    });
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
