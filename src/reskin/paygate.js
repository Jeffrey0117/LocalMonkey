'use strict';

/**
 * 金流（SPEC-reskin-v2 §8）——「**只做測試環境，不碰正式收款**」。
 *
 * ```
 * 立即購買 → POST /__lm/reskin/checkout（我們）
 *          → POST {paygate}/api/newebpay/subscribe（Bearer，伺服器端）
 *          → 回 checkout_url → 瀏覽器導過去 → 藍新付款頁
 *          → 付完 PayGate 收 notify → 使用者按「返回商店」回我們的成功頁
 * ```
 *
 * ⛔ **金鑰只活在伺服器端。** 這支不輸出任何東西給瀏覽器，而版型放進 HTML 的
 * 設定只有一個布林值（`payments.live`）—— 網址與 token 一個字都不會進頁面。
 *
 * ⛔ **沒設 env ＝ 示範模式，不是壞掉。** 四個值都齊了才算 live；缺哪一個
 * 要講得出來（`missing`），不然使用者只會看到按鈕沒反應。
 *
 * ## 契約是實測來的，不是憑記憶寫的
 *
 * `~/.claude/rules/infra-map.md` 記著「PayGate 的端點清單部分過時要實測」。
 * 2026-11-19 從這台實打：
 *
 * - `GET /api/plans` → 200（公開；方案是 PayGate 那邊先建好的，`id` 長
 *   `<product>:<tier>:<cycle>`）
 * - `POST /api/newebpay/subscribe` → 401（要 Bearer；body 是
 *   `{ email, product, plan_id, return_url }`，回 `{ order_id, mer_order_no, checkout_url }`）
 * - `POST /api/subscribe` → 401（那是「登記訂閱」，不產生付款頁，不是這裡要的）
 * - `GET /` → 404（正常，根路徑沒開）
 *
 * ⛔ **PayGate 這支端點是「定期定額」**（它自己的註解寫著 lifetime 要走單次
 * 付款，而單次付款沒有對外端點）。所以這條路做出來的是**訂閱**，不是
 * 「買一份模板」—— 測試金流夠用，但不要把它當成正式的商品收款。
 * 要收一次性的錢得先在 PayGate 那邊開一支單次付款的端點。
 *
 * ⛔ **金額不在我們這邊。** 我們只送 `plan_id`，扣多少錢是 PayGate 的方案
 * 決定的（`reskin/pricing.js` 的 `price` 只是印在畫面上的數字）。
 * 這是刻意的：前端改不了金額，連我們的伺服器都改不了。
 */

const CHECKOUT_PATH = '/api/newebpay/subscribe';

/** PayGate 在家機後面（CF tunnel），冷的時候慢一點是正常的 */
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * email 的檢查刻意寬鬆：真正的驗證在 PayGate（它才知道自己收不收）。
 * 這裡擋的是「明顯不是 email 的字串」與長度 —— 那是我們這邊的輸入驗證責任。
 */
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 160;

function isEmail(value) {
  return typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value);
}

/** `https://paygate.example/` → `https://paygate.example`（帶帳密的網址一律拒絕） */
function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username.length > 0 || url.password.length > 0) return null;

    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * 這台機器有沒有把金流接起來。
 *
 * ⛔ 四個都要有。少一個就是示範模式 —— **半套設定比沒設定更危險**：
 * 服務是 200、健檢是綠的，而使用者按下去才發現什麼都沒發生
 * （`~/.claude/rules/infra-map.md` 的 areyoubot 實案就是這個形狀）。
 *
 * @param {{ url?: string|null, token?: string|null, product?: string|null, planId?: string|null }} settings
 * @returns {{ live: boolean, baseUrl: string|null, missing: Array<string> }}
 */
function paygateStatus(settings = {}) {
  const baseUrl = normalizeBaseUrl(settings.url);

  const missing = [
    baseUrl === null ? 'LOCALMONKEY_PAYGATE_URL' : null,
    settings.token ? null : 'LOCALMONKEY_PAYGATE_TOKEN',
    settings.product ? null : 'LOCALMONKEY_PAYGATE_PRODUCT',
    settings.planId ? null : 'LOCALMONKEY_PAYGATE_PLAN',
  ].filter((name) => name !== null);

  return { live: missing.length === 0, baseUrl, missing };
}

/**
 * @param {{
 *   settings: object,
 *   fetchImpl?: typeof fetch,
 *   logger: object,
 *   timeoutMs?: number,
 * }} context
 */
function createPaygate({ settings, fetchImpl = fetch, logger, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const state = paygateStatus(settings);

  /**
   * 建立一筆結帳。
   *
   * ⛔ 回去給瀏覽器的訊息是**固定的那幾句**，不是 PayGate 回來的字 ——
   * 那邊的錯誤訊息會帶內部細節（方案 id、產品名）。詳細原因寫進我們的 log，
   * 使用者看到的是「現在不能結帳」+ 我們這邊查得到。
   *
   * @returns {Promise<{ ok: true, checkoutUrl: string, orderId: string|null }
   *   | { ok: false, status: number, message: string }>}
   */
  async function createCheckout({ email, returnUrl }) {
    if (!state.live) {
      return { ok: false, status: 503, message: '這個站還沒接金流（示範模式）。' };
    }
    if (!isEmail(email)) {
      return { ok: false, status: 400, message: '請填一個收得到信的 email。' };
    }

    const endpoint = `${state.baseUrl}${CHECKOUT_PATH}`;
    let response;

    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          // ⛔ token 只出現在這一行。不要 log 它、不要回它、不要放進頁面。
          authorization: `Bearer ${settings.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          email,
          product: settings.product,
          plan_id: settings.planId,
          return_url: returnUrl,
        }),
        // node 的 fetch 沒有預設逾時 —— 少了這行，對方接了連線但不回應
        // 就會讓這個請求永遠掛著（infra-map 的 JWKS 實案）
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      logger.error(`打不到 PayGate（${endpoint}）`, error);
      return { ok: false, status: 502, message: '金流暫時連不上，請稍後再試。' };
    }

    const text = await response.text().catch(() => '');

    if (!response.ok) {
      logger.error(`PayGate 回了 ${response.status}：${text.slice(0, 400)}`);
      return {
        ok: false,
        status: 502,
        message:
          response.status === 401
            ? '金流的金鑰不對，請檢查伺服器設定。'
            : '金流現在建立不了訂單，請稍後再試。',
      };
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      logger.error(`PayGate 回的不是 JSON：${text.slice(0, 200)}`);
      return { ok: false, status: 502, message: '金流回了看不懂的東西，請稍後再試。' };
    }

    const checkoutUrl = normalizeBaseUrl(payload?.checkout_url);
    if (checkoutUrl === null) {
      logger.error(`PayGate 沒給 checkout_url：${text.slice(0, 200)}`);
      return { ok: false, status: 502, message: '金流沒給付款網址，請稍後再試。' };
    }

    return {
      ok: true,
      checkoutUrl: payload.checkout_url,
      orderId: typeof payload.order_id === 'string' ? payload.order_id : null,
    };
  }

  return { status: () => ({ ...state }), createCheckout };
}

module.exports = {
  createPaygate,
  paygateStatus,
  normalizeBaseUrl,
  isEmail,
  CHECKOUT_PATH,
  DEFAULT_TIMEOUT_MS,
};
