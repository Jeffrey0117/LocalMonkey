'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
  MPG_VERSION,
  ORDER_PREFIX,
} = require('../../src/reskin/newebpay.js');

/**
 * ⛔ **這些是藍新官方文件的範例值，不是真金鑰，也不是我自己算出來再抄回去的。**
 *
 * 後者那種測試只能證明「程式跟自己一致」—— 加密寫錯了（padding 錯、編碼錯、
 * 簽章字串串錯）它照樣全綠，而症狀會是「送去藍新被退回一個看不出原因的錯誤」。
 * 要證明的是「我們算出來的跟藍新算出來的一樣」，所以期望值必須來自外部。
 *
 * 文件的 AES 加解密範例（MPG 技術串接手冊）：
 *   HashKey  = 12345678901234567890123456789012
 *   HashIV   = 1234567890123456
 *   明文     = MerchantID=3430112&RespondType=JSON&TimeStamp=1485232229&Version=1.4
 *              &MerchantOrderNo=S_1485232229&Amt=40&ItemDesc=UnitTest
 *   TradeInfo（AES-256-CBC + PKCS7 → hex）與 TradeSha（SHA256 大寫）都印在文件上。
 */
const DOC = Object.freeze({
  hashKey: '12345678901234567890123456789012',
  hashIv: '1234567890123456',
  plain:
    'MerchantID=3430112&RespondType=JSON&TimeStamp=1485232229&Version=1.4' +
    '&MerchantOrderNo=S_1485232229&Amt=40&ItemDesc=UnitTest',
  tradeInfo:
    'ff91c8aa01379e4de621a44e5f11f72e4d25bdb1a18242db6cef9ef07d80b0165e476fd1d9acaa53' +
    '170272c82d122961e1a0700a7427cfa1cf90db7f6d6593bbc93102a4d4b9b66d9974c13c31a7ab4b' +
    'ba1d4e0790f0cbbbd7ad64c6d3c8012a601ceaa808bff70f94a8efa5a4f984b9d41304ffd8796121' +
    '77c622f75f4214fa',
  tradeSha: 'EA0A6CC37F40C1EA5692E7CBB8AE097653DF3E91365E6A9CD7E91312413C7BB8',
});

const KEYS = Object.freeze({ hashKey: DOC.hashKey, hashIv: DOC.hashIv });

/** 一組「形狀對但是假的」設定。⛔ 不是任何人的真金鑰。 */
const FAKE_SETTINGS = Object.freeze({
  env: 'test',
  merchantId: 'MS1234567890',
  hashKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  hashIv: 'bbbbbbbbbbbbbbbb',
});

/* ------------------------- 加密與驗章（規格 §2.1） ------------------------- */

test('TradeInfo 的加密結果跟官方文件的範例值一致', () => {
  assert.equal(encryptTradeInfo(DOC.plain, KEYS), DOC.tradeInfo);
});

test('TradeSha 跟官方文件的範例值一致（SHA256、大寫）', () => {
  assert.equal(tradeSha(DOC.tradeInfo, KEYS), DOC.tradeSha);
  assert.equal(tradeSha(DOC.tradeInfo, KEYS), tradeSha(DOC.tradeInfo, KEYS).toUpperCase());
});

test('解密把官方文件的密文還原成原本的明文', () => {
  assert.equal(decryptTradeInfo(DOC.tradeInfo, KEYS), DOC.plain);
});

test('⛔ 換一把金鑰就解不開（證明解密真的綁著金鑰，不是在做編碼轉換）', () => {
  assert.equal(
    decryptTradeInfo(DOC.tradeInfo, { hashKey: FAKE_SETTINGS.hashKey, hashIv: FAKE_SETTINGS.hashIv }),
    null,
  );
});

test('解密對壞輸入回 null 而不是丟例外', () => {
  for (const bad of ['', 'zz', 'abc', 'ff'.repeat(7), null, undefined, 12, {}]) {
    assert.equal(decryptTradeInfo(bad, KEYS), null, `${String(bad)} 應該回 null`);
  }
});

test('中文與 & 都進得去也出得來（查詢字串自己跳脫）', () => {
  const query = buildTradeInfoQuery({ ItemDesc: '模板 A & B', Amt: 199, Skip: null });

  assert.ok(!query.includes('Skip'), 'null 的欄位不該被送出去');
  assert.equal(new URLSearchParams(query).get('ItemDesc'), '模板 A & B');
  assert.equal(new URLSearchParams(query).get('Amt'), '199');

  const roundTrip = decryptTradeInfo(encryptTradeInfo(query, KEYS), KEYS);
  assert.equal(new URLSearchParams(roundTrip).get('ItemDesc'), '模板 A & B');
});

test('驗章：對的過、錯的不過；大小寫與前後空白無所謂', () => {
  assert.equal(verifyTradeSha(DOC.tradeInfo, DOC.tradeSha, KEYS), true);
  assert.equal(verifyTradeSha(DOC.tradeInfo, DOC.tradeSha.toLowerCase(), KEYS), true);
  assert.equal(verifyTradeSha(DOC.tradeInfo, ` ${DOC.tradeSha} `, KEYS), true);

  assert.equal(verifyTradeSha(DOC.tradeInfo, `${DOC.tradeSha.slice(0, -1)}0`, KEYS), false);
  assert.equal(verifyTradeSha(DOC.tradeInfo, '', KEYS), false);
  assert.equal(verifyTradeSha(DOC.tradeInfo, DOC.tradeSha.slice(0, 32), KEYS), false);
  assert.equal(verifyTradeSha(DOC.tradeInfo, null, KEYS), false);
  // 同一段密文、不同金鑰 → 章對不上（這就是回呼的真偽判斷）
  assert.equal(
    verifyTradeSha(DOC.tradeInfo, DOC.tradeSha, {
      hashKey: FAKE_SETTINGS.hashKey,
      hashIv: FAKE_SETTINGS.hashIv,
    }),
    false,
  );
});

/* ----------------------------- 設定（規格 §1） ----------------------------- */

test('四個值都沒設 → 示範模式，而且說得出缺哪些', () => {
  const state = newebpayStatus({});

  assert.equal(state.connected, false);
  assert.equal(state.env, 'test');
  assert.equal(state.gatewayUrl, GATEWAYS.test);
  assert.deepEqual(state.missing, [
    'LOCALMONKEY_NEWEBPAY_MERCHANT_ID',
    'LOCALMONKEY_NEWEBPAY_HASH_KEY',
    'LOCALMONKEY_NEWEBPAY_HASH_IV',
  ]);
});

test('⛔ 半套設定也是示範模式（少一個就不算接上）', () => {
  const state = newebpayStatus({ ...FAKE_SETTINGS, hashIv: null });

  assert.equal(state.connected, false);
  assert.deepEqual(state.missing, ['LOCALMONKEY_NEWEBPAY_HASH_IV']);
});

test('⛔ 金鑰長度不對 ＝ 沒接上，而且講出要幾個字', () => {
  const short = newebpayStatus({ ...FAKE_SETTINGS, hashKey: 'too-short' });

  assert.equal(short.connected, false);
  assert.equal(short.missing.length, 1);
  assert.match(short.missing[0], /HASH_KEY（要正好 32 個字）/);

  const badIv = newebpayStatus({ ...FAKE_SETTINGS, hashIv: 'xyz' });
  assert.match(badIv.missing[0], /HASH_IV（要正好 16 個字）/);
});

test('設齊了就是接上了，端點照 env 走', () => {
  const testEnv = newebpayStatus(FAKE_SETTINGS);
  assert.equal(testEnv.connected, true);
  assert.equal(testEnv.env, 'test');
  assert.equal(testEnv.gatewayUrl, 'https://ccore.newebpay.com/MPG/mpg_gateway');

  const liveEnv = newebpayStatus({ ...FAKE_SETTINGS, env: 'live' });
  assert.equal(liveEnv.connected, true);
  assert.equal(liveEnv.env, 'live');
  assert.equal(liveEnv.gatewayUrl, 'https://core.newebpay.com/MPG/mpg_gateway');
});

test('env 沒設 → 預設 test（不是 live）', () => {
  assert.equal(newebpayStatus({ ...FAKE_SETTINGS, env: null }).env, 'test');
});

/**
 * ⛔ 打錯字**不准**靜默退回 test。
 *
 * 靜默退回看起來更友善，但它會製造「使用者以為設了正式、其實只是沒接」
 * 或反過來的誤會，而金流的誤判方向只有一個是安全的。
 */
test('⛔ env 打錯字 → 整個當沒接（fail closed）', () => {
  const state = newebpayStatus({ ...FAKE_SETTINGS, env: 'production' });

  assert.equal(state.connected, false);
  assert.match(state.missing[0], /NEWEBPAY_ENV/);
});

test('三態：demo / test / live', () => {
  assert.equal(paymentTone({ connected: false, env: 'live' }), 'demo');
  assert.equal(paymentTone({ connected: true, env: 'test' }), 'test');
  assert.equal(paymentTone({ connected: true, env: 'live' }), 'live');
  assert.equal(paymentTone({}), 'demo');
});

test('keysFrom 只在長度對的時候給金鑰', () => {
  assert.deepEqual(keysFrom(FAKE_SETTINGS), {
    hashKey: FAKE_SETTINGS.hashKey,
    hashIv: FAKE_SETTINGS.hashIv,
  });
  assert.equal(keysFrom({ ...FAKE_SETTINGS, hashKey: 'short' }), null);
  assert.equal(keysFrom({}), null);
});

test('normalizeBaseUrl 修掉尾巴的斜線，拒絕帶帳密與非 http(s) 的網址', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:30613/'), 'http://127.0.0.1:30613');
  assert.equal(normalizeBaseUrl('https://shop.test///'), 'https://shop.test');
  assert.equal(normalizeBaseUrl('https://user:pw@shop.test'), null);
  assert.equal(normalizeBaseUrl('ftp://shop.test'), null);
  assert.equal(normalizeBaseUrl(''), null);
  assert.equal(normalizeBaseUrl(null), null);
});

/* -------------------------- 訂單編號（規格 §2.1） -------------------------- */

test('訂單編號是 HTK 開頭的英數，而且不超過 30 個字', () => {
  const id = newOrderNo();

  assert.ok(id.startsWith(ORDER_PREFIX), `${id} 要以 ${ORDER_PREFIX} 開頭`);
  assert.ok(id.length <= 30, `${id} 太長了`);
  assert.match(id, /^[A-Za-z0-9]+$/);
  assert.equal(isOrderNo(id), true);
});

test('同一毫秒產生的編號也不會一樣（隨機那一段在做事）', () => {
  const ids = new Set();
  for (let index = 0; index < 200; index += 1) ids.add(newOrderNo({ now: 1_700_000_000_000 }));

  assert.equal(ids.size, 200);
});

test('isOrderNo 擋掉空的、太長的、帶符號的', () => {
  assert.equal(isOrderNo('HTK'), false, '只有前綴不算');
  assert.equal(isOrderNo(''), false);
  assert.equal(isOrderNo('HTK/../etc'), false);
  assert.equal(isOrderNo('x'.repeat(31)), false);
  assert.equal(isOrderNo(null), false);
  assert.equal(isOrderNo({}), false);
});

/* --------------------------- 送出去的表單（§2） --------------------------- */

const ORDER = Object.freeze({ id: 'HTKabc123', product_name: '一份模板', amount: 199 });
const URLS = Object.freeze({
  returnUrl: 'http://127.0.0.1:30613/__lm/reskin/checkout/return',
  notifyUrl: 'http://127.0.0.1:30613/__lm/reskin/checkout/notify',
  clientBackUrl: 'http://127.0.0.1:30613/__lm/reskin/paid?site=s&order=HTKabc123',
});

function formFields(settings = FAKE_SETTINGS) {
  const form = buildMpgForm({ settings, order: ORDER, urls: URLS, email: 'buyer@example.test' });
  assert.equal(form.ok, true);
  return form;
}

test('沒接金流就組不出表單', () => {
  assert.deepEqual(buildMpgForm({ settings: {}, order: ORDER, urls: URLS }), {
    ok: false,
    reason: 'not-configured',
  });
});

/**
 * ⛔ **這一條是規格 §0.1 的那條紀律。** HashKey / HashIV 不准出現在任何
 * 會被送到瀏覽器的東西裡。`MerchantID` 是協定逼出來的例外（幕前支付就是
 * 由瀏覽器 POST 商店代號過去），所以它要在；兩把金鑰一定不在。
 */
test('⛔ 表單裡沒有 HashKey、也沒有 HashIV', () => {
  const form = formFields();
  const serialized = JSON.stringify(form);

  assert.ok(!serialized.includes(FAKE_SETTINGS.hashKey), 'HashKey 洩漏到表單裡了');
  assert.ok(!serialized.includes(FAKE_SETTINGS.hashIv), 'HashIV 洩漏到表單裡了');

  assert.deepEqual(Object.keys(form.fields).sort(), [
    'EncryptType',
    'MerchantID',
    'TradeInfo',
    'TradeSha',
    'Version',
  ]);
  assert.equal(form.fields.MerchantID, FAKE_SETTINGS.merchantId);
  assert.equal(form.fields.Version, MPG_VERSION);
  assert.equal(form.fields.EncryptType, '0');
});

test('表單的 TradeSha 真的是它自己那串 TradeInfo 算出來的', () => {
  const form = formFields();

  assert.equal(
    verifyTradeSha(form.fields.TradeInfo, form.fields.TradeSha, {
      hashKey: FAKE_SETTINGS.hashKey,
      hashIv: FAKE_SETTINGS.hashIv,
    }),
    true,
  );
});

test('TradeInfo 裡的欄位照規格，三個回呼網址都在', () => {
  const form = formFields();
  const plain = new URLSearchParams(
    decryptTradeInfo(form.fields.TradeInfo, {
      hashKey: FAKE_SETTINGS.hashKey,
      hashIv: FAKE_SETTINGS.hashIv,
    }),
  );

  assert.equal(plain.get('MerchantID'), FAKE_SETTINGS.merchantId);
  assert.equal(plain.get('Version'), MPG_VERSION);
  assert.equal(plain.get('RespondType'), 'JSON');
  assert.equal(plain.get('MerchantOrderNo'), ORDER.id);
  assert.equal(plain.get('Amt'), '199');
  assert.equal(plain.get('ItemDesc'), ORDER.product_name);
  assert.equal(plain.get('ReturnURL'), URLS.returnUrl);
  assert.equal(plain.get('NotifyURL'), URLS.notifyUrl);
  assert.equal(plain.get('ClientBackURL'), URLS.clientBackUrl);
  assert.equal(plain.get('Email'), 'buyer@example.test');
  // 帶了 email 就不讓付款頁改掉它（不然收據會寄到我們沒記下來的地址）
  assert.equal(plain.get('EmailModify'), '0');
  assert.ok(Number(plain.get('TimeStamp')) > 0);
});

test('ItemDesc 有長度上限（藍新的欄位上限是 50）', () => {
  const form = buildMpgForm({
    settings: FAKE_SETTINGS,
    order: { ...ORDER, product_name: '模'.repeat(200) },
    urls: URLS,
  });

  const plain = new URLSearchParams(
    decryptTradeInfo(form.fields.TradeInfo, {
      hashKey: FAKE_SETTINGS.hashKey,
      hashIv: FAKE_SETTINGS.hashIv,
    }),
  );

  assert.equal(plain.get('ItemDesc').length, 50);
});

test('沒給 email 就整個欄位不送（不是送一個空字串）', () => {
  const form = buildMpgForm({ settings: FAKE_SETTINGS, order: ORDER, urls: URLS, email: null });
  const plain = decryptTradeInfo(form.fields.TradeInfo, {
    hashKey: FAKE_SETTINGS.hashKey,
    hashIv: FAKE_SETTINGS.hashIv,
  });

  assert.ok(!plain.includes('Email'), plain);
});

test('live 的表單送去正式端點', () => {
  const form = buildMpgForm({
    settings: { ...FAKE_SETTINGS, env: 'live' },
    order: ORDER,
    urls: URLS,
  });

  assert.equal(form.action, GATEWAYS.live);
});

/* ----------------------- 回呼的解讀（規格 §2.2） ----------------------- */

/** 藍新 `RespondType=JSON` 的回應長這樣 */
function callbackBody(overrides = {}, settings = FAKE_SETTINGS) {
  const keys = { hashKey: settings.hashKey, hashIv: settings.hashIv };

  const payload = {
    Status: 'SUCCESS',
    Message: '授權成功',
    Result: {
      MerchantID: settings.merchantId,
      Amt: 199,
      TradeNo: '26111912345678',
      MerchantOrderNo: ORDER.id,
      PaymentType: 'CREDIT',
      ...overrides.result,
    },
    ...overrides.top,
  };

  const tradeInfo = encryptTradeInfo(JSON.stringify(payload), keys);

  return {
    Status: payload.Status,
    MerchantID: settings.merchantId,
    Version: MPG_VERSION,
    TradeInfo: tradeInfo,
    TradeSha: overrides.tradeSha ?? tradeSha(tradeInfo, keys),
  };
}

test('正常的回呼讀得出訂單、金額、交易序號', () => {
  const read = readCallback(callbackBody(), FAKE_SETTINGS);

  assert.equal(read.ok, true);
  assert.equal(read.status, 'SUCCESS');
  assert.equal(read.orderNo, ORDER.id);
  assert.equal(read.amount, 199);
  assert.equal(read.tradeNo, '26111912345678');
  assert.equal(read.merchantId, FAKE_SETTINGS.merchantId);
  assert.equal(read.paymentType, 'CREDIT');
  assert.ok(read.raw.includes('MerchantOrderNo'));
});

/**
 * ⛔ **規格 §2.2 的第 1 條，整份規格的安全重點。**
 *
 * 偽造的 `TradeSha` 要在**解密之前**就被擋掉。這條測試的證明方式是：
 * 送一段**用別把金鑰加密**的密文（所以我們這把解不開），搭配一個**亂寫的
 * 簽章**。如果順序是對的，`reason` 必須是 `bad-sha`；如果實作「先解密再說」，
 * 它會先撞到解密失敗而回 `bad-cipher` —— 那個差別就是這條在抓的東西。
 */
test('⛔ 偽造的 TradeSha 被拒絕，而且是在解密之前（reason 是 bad-sha）', () => {
  const stranger = { hashKey: '9'.repeat(32), hashIv: '8'.repeat(16) };
  const foreign = encryptTradeInfo(
    JSON.stringify({ Status: 'SUCCESS', Result: { MerchantOrderNo: ORDER.id, Amt: 999999 } }),
    stranger,
  );

  const read = readCallback({ TradeInfo: foreign, TradeSha: 'F'.repeat(64) }, FAKE_SETTINGS);

  assert.equal(read.ok, false);
  assert.equal(read.reason, 'bad-sha', '驗章必須排在解密之前');
});

test('⛔ 內容被改過一個 byte 就過不了驗章', () => {
  const body = callbackBody();
  const tampered = { ...body, TradeInfo: `${body.TradeInfo.slice(0, -2)}00` };

  assert.deepEqual(readCallback(tampered, FAKE_SETTINGS), { ok: false, reason: 'bad-sha' });
});

test('⛔ 拿別家商店的金鑰簽的回呼過不了（章綁的是我們這把 HashKey）', () => {
  const other = { ...FAKE_SETTINGS, hashKey: '7'.repeat(32), hashIv: '6'.repeat(16) };

  assert.deepEqual(readCallback(callbackBody({}, other), FAKE_SETTINGS), {
    ok: false,
    reason: 'bad-sha',
  });
});

test('缺欄位、太大、沒設定都有各自的理由', () => {
  assert.deepEqual(readCallback({}, FAKE_SETTINGS), { ok: false, reason: 'missing-fields' });
  assert.deepEqual(readCallback({ TradeInfo: 'ab' }, FAKE_SETTINGS), {
    ok: false,
    reason: 'missing-fields',
  });
  assert.deepEqual(readCallback(callbackBody(), {}), { ok: false, reason: 'not-configured' });
  assert.deepEqual(
    readCallback({ TradeInfo: 'a'.repeat(20_001), TradeSha: 'x' }, FAKE_SETTINGS),
    { ok: false, reason: 'too-large' },
  );
});

test('章對了但內容不是 JSON / 不是物件 → bad-payload，不是當成成功', () => {
  const keys = { hashKey: FAKE_SETTINGS.hashKey, hashIv: FAKE_SETTINGS.hashIv };
  const tradeInfo = encryptTradeInfo('{這不是 JSON', keys);

  assert.deepEqual(
    readCallback({ TradeInfo: tradeInfo, TradeSha: tradeSha(tradeInfo, keys) }, FAKE_SETTINGS),
    { ok: false, reason: 'bad-payload' },
  );
});

test('認不出來的訂單編號回 null，不是硬塞一個字串進去', () => {
  const read = readCallback(
    callbackBody({ result: { MerchantOrderNo: '../../etc/passwd' } }),
    FAKE_SETTINGS,
  );

  assert.equal(read.ok, true);
  assert.equal(read.orderNo, null);
});

test('金額不是整數就回 null（呼叫端才分得出「沒給」與「給了 0」）', () => {
  assert.equal(readCallback(callbackBody({ result: { Amt: 'lots' } }), FAKE_SETTINGS).amount, null);
  assert.equal(readCallback(callbackBody({ result: { Amt: 19.9 } }), FAKE_SETTINGS).amount, null);
  assert.equal(readCallback(callbackBody({ result: { Amt: 0 } }), FAKE_SETTINGS).amount, 0);
});

test('失敗的回呼也讀得出來（Result 缺一半也不炸）', () => {
  const read = readCallback(
    callbackBody({
      top: { Status: 'MPG03009', Message: '取消交易' },
      result: { TradeNo: undefined },
    }),
    FAKE_SETTINGS,
  );

  assert.equal(read.ok, true);
  assert.equal(read.status, 'MPG03009');
  assert.equal(read.message, '取消交易');
  assert.equal(read.orderNo, ORDER.id);
});
