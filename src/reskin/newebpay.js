'use strict';

/**
 * 藍新金流 **MPG 幕前支付**（SPEC-checkout）——「一套模板 NT$199、立即購買」
 * 是**單筆買斷**，所以走 MPG，不是訂閱。
 *
 * ```
 * 立即購買 → POST /__lm/reskin/checkout（我們）
 *              建單（pending）→ AES-256-CBC 加密 TradeInfo → SHA256 算 TradeSha
 *              回表單參數
 *          → 瀏覽器 POST 到藍新 MPG → 使用者付款
 *          → 藍新 POST 回 ReturnURL   → **先驗章** → 解密 → 比對訂單與金額 → 結算
 * ```
 *
 * ## ⛔ 金鑰
 *
 * `HashKey` / `HashIV` **只活在這支模組的參數裡**：不輸出、不 log、不進頁面。
 * 整支檔案沒有任何預設值、沒有任何範例金鑰 —— 缺設定就是示範模式（規格 §0.1）。
 *
 * `MerchantID` 是**例外，而且是協定逼出來的**：MPG 幕前支付就是「瀏覽器拿著
 * `MerchantID` + `TradeInfo` + `TradeSha` POST 到藍新」，所以商店代號一定會
 * 出現在那張表單裡。它不是秘密（任何一筆正常的藍新交易都會送它），
 * 真正的秘密是 HashKey / HashIV —— 那兩個一個 byte 都不會離開伺服器。
 *
 * ## ⛔ 回呼的驗證順序（規格 §2.2，整份規格的安全重點）
 *
 * ```
 * 1. 驗 TradeSha      ← 不符就**直接拒絕**，連解密都不做
 * 2. 解密 TradeInfo
 * 3. 比對 MerchantOrderNo 是我們建立過的訂單
 * 4. 比對金額
 * ```
 *
 * 「先解密再說」是錯的：解密是拿我們的金鑰去處理一段**來源不明**的輸入，
 * 而驗章只花一次 SHA256 就能證明那段 hex 是我們這家商店的對手方產生的。
 * 順序顛倒的話，攻擊者就有一個「餵任意 ciphertext 給我們的 AES」的入口。
 *
 * ## 契約的來源
 *
 * 加解密與驗章用**藍新官方文件的範例值**釘住（`tests/unit/reskin-newebpay.test.js`）：
 * key `12345678901234567890123456789012`、iv `1234567890123456`、
 * 明文 `MerchantID=3430112&RespondType=JSON&…&ItemDesc=UnitTest`
 * → ciphertext 與 TradeSha 都是文件上印的那一串。**不是真金鑰，也不是我自己
 * 算出來再抄回去的**（那種測試只能證明「程式跟自己一致」）。
 */

const crypto = require('node:crypto');

/** test → 測試端點；live → 正式端點（會真的扣款） */
const GATEWAYS = Object.freeze({
  test: 'https://ccore.newebpay.com/MPG/mpg_gateway',
  live: 'https://core.newebpay.com/MPG/mpg_gateway',
});

const ENVIRONMENTS = Object.freeze(['test', 'live']);
const DEFAULT_ENV = 'test';

/** MPG 的 API 版本。TradeInfo 裡與表單上各要一份，兩邊必須一致。 */
const MPG_VERSION = '2.0';
/** `0` ＝ AES-256-CBC + PKCS7（`1` 是 GCM，我們沒用） */
const ENCRYPT_TYPE = '0';

/**
 * 訂單前綴。
 *
 * ⛔ `MerchantOrderNo` **同一商店不可重複**，而這台機器的其他專案也在用
 * 同一顆商店 —— `~/.claude/rules/infra-map.md`：「同商店多專案 → 訂單前綴
 * 要不同」。這個站是 html模板大王 → `HTK`（規格 §2.1）。
 */
const ORDER_PREFIX = 'HTK';

/** AES-256 的 key 是 32 bytes、CBC 的 iv 是 16 bytes。長度不對就不是「能用的金鑰」。 */
const HASH_KEY_LENGTH = 32;
const HASH_IV_LENGTH = 16;

/** 藍新的欄位上限 */
const MAX_ITEM_DESC = 50;
const MAX_EMAIL = 50;
const MAX_ORDER_NO = 30;

/** 回呼的 TradeInfo 再怎麼長也就幾 KB。超過的輸入連驗章都不值得做。 */
const MAX_TRADE_INFO = 20_000;

/* --------------------------------- 設定 --------------------------------- */

/**
 * `https://example.test/` → `https://example.test`（帶帳密的網址一律拒絕）。
 *
 * 回呼網址要組在這個值後面，所以尾巴的斜線要先修掉 —— 不然會送出
 * `https://x//__lm/…`，而藍新那邊只會回一個看不出原因的錯誤。
 */
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

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 這台機器有沒有把金流接起來。
 *
 * ⛔ **三個必填值要嘛全有、要嘛全無。** 少一個就是示範模式，而缺的是哪幾個
 * 要講得出來（`missing`）—— 「半套設定」是這個生態踩過最貴的坑之一：
 * 服務 200、健檢綠燈，而功能其實從來沒接上
 * （`~/.claude/rules/infra-map.md` 的 areyoubot 實案）。
 *
 * ⛔ **`env` 打錯字一律當沒接**（fail closed）。靜默退回 `test` 看起來更
 * 友善，但那會變成「使用者以為在測試、其實也只是沒接」或反過來，
 * 而金流的誤判方向只有一個是安全的。
 *
 * @param {{ env?: string|null, merchantId?: string|null, hashKey?: string|null, hashIv?: string|null }} settings
 * @returns {{ connected: boolean, env: 'test'|'live', gatewayUrl: string, missing: Array<string> }}
 *   `connected` ＝ 設定齊全、按鈕是真的；`env` ＝ 會打哪一個端點。
 *   **刻意不叫 `live`** —— 那個字在這裡有兩個完全不同的意思
 *   （「接上了」與「正式環境」），混用一次就是「以為在測試卻真的扣款」。
 */
function newebpayStatus(settings = {}) {
  const rawEnv = nonEmpty(settings.env);
  const envOk = rawEnv === null || ENVIRONMENTS.includes(rawEnv);
  const env = envOk && rawEnv !== null ? rawEnv : DEFAULT_ENV;

  const hashKey = nonEmpty(settings.hashKey);
  const hashIv = nonEmpty(settings.hashIv);

  const missing = [
    envOk ? null : 'LOCALMONKEY_NEWEBPAY_ENV（只能是 test 或 live）',
    nonEmpty(settings.merchantId) === null ? 'LOCALMONKEY_NEWEBPAY_MERCHANT_ID' : null,
    hashKey === null
      ? 'LOCALMONKEY_NEWEBPAY_HASH_KEY'
      : hashKey.length === HASH_KEY_LENGTH
        ? null
        : `LOCALMONKEY_NEWEBPAY_HASH_KEY（要正好 ${HASH_KEY_LENGTH} 個字）`,
    hashIv === null
      ? 'LOCALMONKEY_NEWEBPAY_HASH_IV'
      : hashIv.length === HASH_IV_LENGTH
        ? null
        : `LOCALMONKEY_NEWEBPAY_HASH_IV（要正好 ${HASH_IV_LENGTH} 個字）`,
  ].filter((name) => name !== null);

  return { connected: missing.length === 0, env, gatewayUrl: GATEWAYS[env], missing };
}

/** 給版型／控制台用的三態。版型層不准自己把兩個布林值組起來（組錯過一次就是扣款）。 */
function paymentTone(payments = {}) {
  if (payments.connected !== true) return 'demo';
  return payments.env === 'live' ? 'live' : 'test';
}

/* --------------------------------- 加解密 --------------------------------- */

/**
 * @returns {{ hashKey: string, hashIv: string }|null} 長度不對就回 null
 *   （丟例外的話呼叫端會變成 500，而這是設定問題不是程式錯誤）
 */
function keysFrom(settings = {}) {
  const hashKey = nonEmpty(settings.hashKey);
  const hashIv = nonEmpty(settings.hashIv);

  if (hashKey === null || hashKey.length !== HASH_KEY_LENGTH) return null;
  if (hashIv === null || hashIv.length !== HASH_IV_LENGTH) return null;

  return { hashKey, hashIv };
}

/**
 * 交易資料 → 查詢字串（規格 §2.1）。
 *
 * `URLSearchParams` 負責跳脫 —— 自己串的話 `ItemDesc` 裡一個 `&` 就會把
 * 後面的欄位全部頂掉，而症狀是藍新回一個跟原因無關的錯誤。
 * `null` / `undefined` 的欄位整個不送（藍新對「空字串」與「沒送」的處理不一樣）。
 */
function buildTradeInfoQuery(params) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.append(key, String(value));
  }

  return search.toString();
}

/** AES-256-CBC + PKCS7 → hex（藍新要的就是 hex，不是 base64） */
function encryptTradeInfo(plain, { hashKey, hashIv }) {
  const cipher = crypto.createCipheriv('aes-256-cbc', hashKey, hashIv);
  cipher.setAutoPadding(true); // PKCS7，node 的預設；寫出來是因為它是規格的一部分
  return Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]).toString('hex');
}

/**
 * hex → 明文。
 *
 * ⛔ **回 `null` 而不是丟例外。** 這支吃的是網路上送進來的東西，
 * 而「密文壞掉」是可預期的輸入，不是程式錯誤。丟例外的話回呼端點會變成
 * 一頁 500 的 HTML，使用者只看到「伺服器壞了」。
 */
function decryptTradeInfo(hex, { hashKey, hashIv }) {
  if (typeof hex !== 'string') return null;

  const trimmed = hex.trim();
  // CBC 的密文一定是 16 bytes（32 個 hex 字元）的整數倍
  if (trimmed.length === 0 || trimmed.length % 32 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return null;

  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', hashKey, hashIv);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(trimmed, 'hex'), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** `HashKey=<key>&<TradeInfo>&HashIV=<iv>` → SHA256 → **大寫** hex（規格 §2.1） */
function tradeSha(tradeInfoHex, { hashKey, hashIv }) {
  return crypto
    .createHash('sha256')
    .update(`HashKey=${hashKey}&${tradeInfoHex}&HashIV=${hashIv}`, 'utf8')
    .digest('hex')
    .toUpperCase();
}

/**
 * ⛔ 這是整個金流唯一的真偽判斷。
 *
 * 用 `timingSafeEqual`：比對的是「對方算得出我們的 HashKey 的證明」，
 * 而一個會提早回傳的字串比較等於把那個比對過程洩漏出去。
 * （`admin/compare.js` 的註解講的是同一件事。）
 */
function verifyTradeSha(tradeInfoHex, provided, keys) {
  if (typeof tradeInfoHex !== 'string' || typeof provided !== 'string') return false;

  const expected = Buffer.from(tradeSha(tradeInfoHex, keys), 'utf8');
  const actual = Buffer.from(provided.trim().toUpperCase(), 'utf8');

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/* -------------------------------- 訂單編號 -------------------------------- */

/**
 * `HTK` + 時間 + 隨機（規格 §3）。英數，而且同一商店不可重複。
 *
 * 時間用 base36 是為了短：`MerchantOrderNo` 上限 30 個字，而前綴要留給
 * 「哪個專案」。時間 + 8 個 hex 的隨機已經足夠 —— 同一毫秒要撞還得撞對
 * 32 bit。
 */
function newOrderNo({ now = Date.now(), random = crypto.randomBytes(4).toString('hex') } = {}) {
  const id = `${ORDER_PREFIX}${Number(now).toString(36)}${random}`;
  return id.slice(0, MAX_ORDER_NO);
}

function isOrderNo(value) {
  return (
    typeof value === 'string' &&
    value.length > ORDER_PREFIX.length &&
    value.length <= MAX_ORDER_NO &&
    /^[A-Za-z0-9_]+$/.test(value)
  );
}

/* ------------------------------ 送出去的表單 ------------------------------ */

function clamp(value, limit) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * 組出瀏覽器要 POST 給藍新的那張表單。
 *
 * @param {{
 *   settings: object,
 *   order: { id: string, product_name: string, amount: number },
 *   urls: { returnUrl: string, notifyUrl: string, clientBackUrl: string },
 *   email?: string|null,
 *   now?: number,
 * }} input
 * @returns {{ ok: true, action: string, fields: Record<string, string> }
 *   | { ok: false, reason: string }}
 *   `fields` 裡**只有** MerchantID / TradeInfo / TradeSha / Version / EncryptType。
 *   HashKey 與 HashIV 不在裡面，也不在任何一個回應裡。
 */
function buildMpgForm({ settings, order, urls, email = null, now = Date.now() }) {
  const state = newebpayStatus(settings);
  if (!state.connected) return { ok: false, reason: 'not-configured' };

  const keys = keysFrom(settings);
  if (keys === null) return { ok: false, reason: 'bad-keys' };

  const merchantId = nonEmpty(settings.merchantId);

  const plain = buildTradeInfoQuery({
    MerchantID: merchantId,
    // JSON 比 String 好對帳：回呼解密出來就是一個物件，不用再猜欄位順序
    RespondType: 'JSON',
    TimeStamp: Math.floor(now / 1000),
    Version: MPG_VERSION,
    LangType: 'zh-tw',
    MerchantOrderNo: order.id,
    Amt: order.amount,
    ItemDesc: clamp(order.product_name, MAX_ITEM_DESC),
    // 付完瀏覽器帶著結果 POST 回來的那一支（localhost 唯一收得到的回呼）
    ReturnURL: urls.returnUrl,
    // 藍新**伺服器**主動打的那一支。⛔ localhost 收不到（規格 §0.2），
    // 但該送還是要送：換成 tunnel／正式網域的那一天不用改程式。
    NotifyURL: urls.notifyUrl,
    // 使用者在付款頁按「返回商店」或中途離開時落地的地方
    ClientBackURL: urls.clientBackUrl,
    Email: email === null ? null : clamp(email, MAX_EMAIL),
    // 帶了 email 就不讓付款頁改它 —— 不然收據會寄到我們沒記下來的地址
    EmailModify: email === null ? null : 0,
    // 不強迫註冊藍新會員
    LoginType: 0,
  });

  const tradeInfo = encryptTradeInfo(plain, keys);

  return {
    ok: true,
    action: state.gatewayUrl,
    fields: {
      MerchantID: merchantId,
      TradeInfo: tradeInfo,
      TradeSha: tradeSha(tradeInfo, keys),
      Version: MPG_VERSION,
      EncryptType: ENCRYPT_TYPE,
    },
  };
}

/* -------------------------------- 回呼解讀 -------------------------------- */

/**
 * `RespondType=JSON` 的回應解密出來長這樣：
 *
 * ```json
 * { "Status": "SUCCESS", "Message": "…", "Result": { "MerchantOrderNo": "HTK…", "Amt": 199, … } }
 * ```
 *
 * 失敗時 `Result` 可能是字串或缺少 —— 所以每個欄位都當「可能沒有」處理。
 * 另外保留查詢字串的解析路徑：萬一哪天有人把 `RespondType` 改成 `String`，
 * 我們至少還認得出訂單編號，而不是整筆變成「看不懂的回呼」。
 */
function parseResultPayload(plain) {
  const text = String(plain ?? '').trim();
  if (text.length === 0) return null;

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object') return null;

      const result = typeof parsed.Result === 'object' && parsed.Result !== null ? parsed.Result : {};
      return { status: String(parsed.Status ?? ''), message: String(parsed.Message ?? ''), result };
    } catch {
      return null;
    }
  }

  const search = new URLSearchParams(text);
  if (![...search.keys()].length) return null;

  return {
    status: search.get('Status') ?? '',
    message: search.get('Message') ?? '',
    result: Object.fromEntries(search.entries()),
  };
}

function asAmount(value) {
  const amount = Number(value);
  return Number.isInteger(amount) && amount >= 0 ? amount : null;
}

/**
 * 回呼 → 「這是誰、付了多少、成功了沒」。
 *
 * ⛔ **驗章在解密之前**（規格 §2.2 第 1 條）。這支函式的 return 順序就是
 * 那條規格 —— 任何「先解密看看是誰」的改動都是在開一個洞。
 *
 * @param {Record<string, unknown>} body 表單欄位（藍新是 urlencoded POST）
 * @param {object} settings
 * @returns {{ ok: true, status: string, message: string, orderNo: string|null,
 *             amount: number|null, tradeNo: string|null, merchantId: string|null,
 *             paymentType: string|null, raw: string }
 *   | { ok: false, reason: 'not-configured'|'missing-fields'|'too-large'|'bad-sha'|'bad-cipher'|'bad-payload' }}
 */
function readCallback(body, settings) {
  const keys = keysFrom(settings);
  if (keys === null) return { ok: false, reason: 'not-configured' };

  const tradeInfo = typeof body?.TradeInfo === 'string' ? body.TradeInfo.trim() : '';
  const provided = typeof body?.TradeSha === 'string' ? body.TradeSha : '';

  if (tradeInfo.length === 0 || provided.length === 0) {
    return { ok: false, reason: 'missing-fields' };
  }
  if (tradeInfo.length > MAX_TRADE_INFO) return { ok: false, reason: 'too-large' };

  // ① 驗章。不符就到此為止 —— 不准拿我們的金鑰去解一段來源不明的密文。
  if (!verifyTradeSha(tradeInfo, provided, keys)) return { ok: false, reason: 'bad-sha' };

  // ② 解密
  const plain = decryptTradeInfo(tradeInfo, keys);
  if (plain === null) return { ok: false, reason: 'bad-cipher' };

  const parsed = parseResultPayload(plain);
  if (parsed === null) return { ok: false, reason: 'bad-payload' };

  const { result } = parsed;

  return {
    ok: true,
    status: parsed.status,
    message: parsed.message,
    orderNo: isOrderNo(result.MerchantOrderNo) ? result.MerchantOrderNo : null,
    amount: asAmount(result.Amt),
    tradeNo: nonEmpty(result.TradeNo),
    merchantId: nonEmpty(result.MerchantID),
    paymentType: nonEmpty(result.PaymentType),
    // 存進 `reskin_orders.raw_result` 當對帳依據。⛔ 裡面沒有金鑰
    // （解密出來的是交易結果），但有卡號前六後四 —— 所以它只在控制台看得到。
    raw: plain,
  };
}

module.exports = {
  newebpayStatus,
  paymentTone,
  normalizeBaseUrl,
  keysFrom,
  buildTradeInfoQuery,
  encryptTradeInfo,
  decryptTradeInfo,
  tradeSha,
  verifyTradeSha,
  newOrderNo,
  isOrderNo,
  buildMpgForm,
  readCallback,
  GATEWAYS,
  ENVIRONMENTS,
  DEFAULT_ENV,
  MPG_VERSION,
  ENCRYPT_TYPE,
  ORDER_PREFIX,
  HASH_KEY_LENGTH,
  HASH_IV_LENGTH,
  MAX_ITEM_DESC,
  MAX_ORDER_NO,
};
