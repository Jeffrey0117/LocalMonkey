'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startApp } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const {
  encryptTradeInfo,
  tradeSha,
  decryptTradeInfo,
  MPG_VERSION,
} = require('../../src/reskin/newebpay.js');

/**
 * 單筆結帳的整條路（SPEC-checkout）：真 server、真 SQLite、真 HTTP，
 * 假的「藍新」—— **一個付款請求都不會真的送出去**。
 *
 * 驗的是四件事：
 *
 * 1. 沒設 env → 示範模式，而且商品頁上看得到那句話（規格 §1）
 * 2. 設了 test → 建一筆 `pending` 訂單，回一張指向藍新**測試**端點的表單
 * 3. `live` → 商品頁上是警告色的「正式環境（會真的扣款）」
 * 4. **偽造的 TradeSha 回呼被拒絕，訂單不動**（規格 §2.2）
 */

/** ⛔ 形狀對、長度對，但不是任何人的真金鑰。 */
const KEYS = Object.freeze({
  merchantId: 'MS0000000001',
  hashKey: 'cccccccccccccccccccccccccccccccc',
  hashIv: 'dddddddddddddddd',
});

const PRODUCT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>一份模板</title></head>
<body>
  <div class="box">
    <h2 class="name">星空作品集模板</h2>
    <img class="shot" src="/img/shot.jpg" alt="">
    <p class="desc">一份乾淨的單頁模板。</p>
  </div>
</body></html>`;

/** 抽取設定刻意自己寫一份：這支測的是結帳，不是某個站的抽取規則。 */
const RESKIN_CONFIG = JSON.stringify([
  {
    match: '^/item/\\d+$',
    kind: 'product',
    fields: {
      name: { sel: '.name', attr: 'text' },
      description: { sel: '.desc', attr: 'text' },
      gallery: { sel: '.shot', attr: 'src', as: 'url', many: true },
    },
  },
]);

async function setup(t, { newebpay = {}, pricing = null } = {}) {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PRODUCT_HTML);
  });
  t.after(() => upstream.close());

  const app = await startApp({ config: { newebpay } });
  t.after(() => app.close());

  app.store.sites.create({ id: 'shop', name: 'shop', target_origin: upstream.origin });
  app.store.sites.update('shop', {
    reskin_enabled: true,
    reskin_config: RESKIN_CONFIG,
    ...(pricing === null ? {} : { reskin_pricing: JSON.stringify(pricing) }),
  });

  return app;
}

function adminHeaders(app) {
  return { authorization: `Bearer ${app.adminToken}`, accept: 'application/json' };
}

async function productPage(app) {
  const response = await fetch(`${app.base}/p/shop/item/7`);
  return { status: response.status, html: await response.text() };
}

async function postCheckout(app, body) {
  const response = await fetch(`${app.base}/__lm/reskin/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { status: response.status, payload: await response.json() };
}

/** 假「藍新」回呼：用同一把金鑰加密 + 簽章（偽造的那條測試自己改 TradeSha） */
function callbackForm({ orderNo, amount = 199, status = 'SUCCESS', tradeNo = 'T0001' }, keys = KEYS) {
  const payload = JSON.stringify({
    Status: status,
    Message: status === 'SUCCESS' ? '授權成功' : '交易失敗',
    Result: {
      MerchantID: keys.merchantId,
      Amt: amount,
      TradeNo: tradeNo,
      MerchantOrderNo: orderNo,
      PaymentType: 'CREDIT',
    },
  });

  const tradeInfo = encryptTradeInfo(payload, keys);

  return {
    Status: status,
    MerchantID: keys.merchantId,
    Version: MPG_VERSION,
    TradeInfo: tradeInfo,
    TradeSha: tradeSha(tradeInfo, keys),
  };
}

async function postCallback(app, fields, path = '/__lm/reskin/checkout/return') {
  const response = await fetch(`${app.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

  return { status: response.status, body: await response.text() };
}

/* ------------------------- 示範模式（規格 §1 / §6.1） ------------------------- */

test('沒設 env → 商品頁寫「未接金流（示範模式）」，結帳端點回 503', async (t) => {
  const app = await setup(t);

  const page = await productPage(app);
  assert.equal(page.status, 200);
  assert.ok(page.html.includes('立即購買'), '應該重繪成我們的商品頁');
  assert.ok(page.html.includes('未接金流（示範模式）'), page.html.slice(0, 400));
  assert.ok(!page.html.includes('正式環境（會真的扣款）'));
  // 示範模式不收 email（不要畫看起來能用卻什麼都不做的欄位）
  assert.ok(!page.html.includes('data-lm-email'));
  assert.ok(page.html.includes('"connected":false'));

  const checkout = await postCheckout(app, { site: 'shop' });
  assert.equal(checkout.status, 503);
  assert.match(checkout.payload.message, /示範模式/);

  // 沒接金流就不該留下任何訂單
  assert.equal(app.store.reskinOrders.count('shop'), 0);
});

test('半套設定（缺 HASH_IV）也是示範模式，控制台講得出缺哪一個', async (t) => {
  const app = await setup(t, { newebpay: { ...KEYS, hashIv: null } });

  const page = await productPage(app);
  assert.ok(page.html.includes('未接金流（示範模式）'));

  const status = await fetch(`${app.base}/admin/api/sites/shop/reskin`, {
    headers: adminHeaders(app),
  }).then((response) => response.json());

  assert.equal(status.payments.connected, false);
  assert.equal(status.payments.tone, 'demo');
  assert.deepEqual(status.payments.missing, ['LOCALMONKEY_NEWEBPAY_HASH_IV']);
});

/* --------------------------- 測試環境（規格 §6.2） --------------------------- */

test('設了 test env → 商品頁標「測試環境（不會真的扣款）」', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const page = await productPage(app);

  assert.ok(page.html.includes('測試環境（不會真的扣款）'), page.html.slice(0, 400));
  // ⚠ 比對「會真的扣款」會中招 ——「不**會真的扣款**」含那四個字。要釘的是整句。
  assert.ok(!page.html.includes('正式環境（會真的扣款）'));
  assert.ok(!page.html.includes('is-live'));
  // 接上了才收 email
  assert.ok(page.html.includes('data-lm-email'));
  assert.ok(page.html.includes('"tone":"test"'));
});

test('立即購買 → 訂單進 DB 是 pending，表單指向藍新測試端點', async (t) => {
  const app = await setup(t, { newebpay: KEYS });

  const { status, payload } = await postCheckout(app, {
    site: 'shop',
    email: 'buyer@example.test',
    qty: 2,
    productId: 'tpl-7',
    productName: '星空作品集模板',
  });

  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'https://ccore.newebpay.com/MPG/mpg_gateway');
  assert.equal(payload.env, 'test');
  // 199 × 2 —— 金額是伺服器端算的
  assert.equal(payload.amount, 398);
  assert.ok(payload.order_id.startsWith('HTK'), payload.order_id);

  const order = app.store.reskinOrders.get(payload.order_id);
  assert.equal(order.status, 'pending');
  assert.equal(order.amount, 398);
  assert.equal(order.env, 'test');
  assert.equal(order.product_id, 'tpl-7');
  assert.equal(order.product_name, '星空作品集模板');
  assert.equal(order.currency, 'TWD');
  assert.equal(order.trade_no, null);

  // 表單的內容真的是這一筆訂單
  const plain = new URLSearchParams(
    decryptTradeInfo(payload.fields.TradeInfo, { hashKey: KEYS.hashKey, hashIv: KEYS.hashIv }),
  );
  assert.equal(plain.get('MerchantOrderNo'), payload.order_id);
  assert.equal(plain.get('Amt'), '398');
  assert.equal(plain.get('Email'), 'buyer@example.test');
  // 回呼網址用的是「這個請求的 Host」
  assert.equal(plain.get('ReturnURL'), `${app.base}/__lm/reskin/checkout/return`);
  assert.equal(plain.get('NotifyURL'), `${app.base}/__lm/reskin/checkout/notify`);
});

/**
 * ⛔ 規格 §0.1：金鑰不准出現在前端、HTML、log、錯誤訊息裡。
 *
 * `MerchantID` 是協定逼出來的例外（幕前支付就是由瀏覽器 POST 商店代號過去），
 * 所以它會在結帳回應的表單裡 —— 但**不准**出現在商品頁的 HTML 裡，
 * 而兩把金鑰哪裡都不准有。
 */
test('⛔ 金鑰不在商品頁、也不在結帳回應裡', async (t) => {
  const app = await setup(t, { newebpay: KEYS });

  const page = await productPage(app);
  for (const secret of [KEYS.hashKey, KEYS.hashIv, KEYS.merchantId]) {
    assert.ok(!page.html.includes(secret), `商品頁洩漏了 ${secret}`);
  }

  const checkout = await postCheckout(app, { site: 'shop', email: 'a@b.test' });
  const serialized = JSON.stringify(checkout.payload);
  assert.ok(!serialized.includes(KEYS.hashKey), '結帳回應洩漏了 HashKey');
  assert.ok(!serialized.includes(KEYS.hashIv), '結帳回應洩漏了 HashIV');
  // 這一個是協定要的，所以它在
  assert.equal(checkout.payload.fields.MerchantID, KEYS.merchantId);
});

test('數量被夾在 1~99，而且 0 元方案不送去金流', async (t) => {
  const app = await setup(t, { newebpay: KEYS });

  const huge = await postCheckout(app, { site: 'shop', email: 'a@b.test', qty: 9999 });
  assert.equal(huge.payload.amount, 199 * 99);

  const nonsense = await postCheckout(app, { site: 'shop', email: 'a@b.test', qty: 'many' });
  assert.equal(nonsense.payload.amount, 199);

  const free = await setup(t, {
    newebpay: KEYS,
    pricing: { currency: 'NT$', plans: [{ id: 'free', name: '免費', price: 0 }] },
  });
  const zero = await postCheckout(free, { site: 'shop', email: 'a@b.test' });
  assert.equal(zero.status, 400);
  assert.match(zero.payload.message, /不用付錢/);
});

test('沒開重繪 / 不存在的站 → 404，不留訂單', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  app.store.sites.update('shop', { reskin_enabled: false });

  assert.equal((await postCheckout(app, { site: 'shop', email: 'a@b.test' })).status, 404);
  assert.equal((await postCheckout(app, { site: 'nope', email: 'a@b.test' })).status, 404);
  assert.equal(app.store.reskinOrders.count('shop'), 0);
});

/* ------------------------- 正式環境的警告（規格 §1） ------------------------- */

/**
 * ⛔ 使用者自己說要用正式環境，但**按下去之前必須看得到會真的扣款**。
 * 所以這條同時釘「那句話在」與「它帶著警告色的 class」—— 只有文字沒有顏色
 * 的話它會混在一堆灰色小字裡。
 */
test('⛔ ENV=live → 購買列是警告色的「正式環境（會真的扣款）」', async (t) => {
  const app = await setup(t, { newebpay: { ...KEYS, env: 'live' } });
  const page = await productPage(app);

  assert.ok(page.html.includes('正式環境（會真的扣款）'), page.html.slice(0, 600));
  assert.ok(page.html.includes('lm-pay-note is-live'), '那一列要帶警告色的 class');
  assert.ok(!page.html.includes('測試環境'));
  assert.ok(page.html.includes('"tone":"live"'));

  // 結帳會送去正式端點，而訂單記著 env=live（測試單與正式單不准混在一起對帳）
  const checkout = await postCheckout(app, { site: 'shop', email: 'a@b.test' });
  assert.equal(checkout.payload.action, 'https://core.newebpay.com/MPG/mpg_gateway');
  assert.equal(app.store.reskinOrders.get(checkout.payload.order_id).env, 'live');
});

test('env 打錯字 → 退回示範模式（不是靜默當成 test）', async (t) => {
  const app = await setup(t, { newebpay: { ...KEYS, env: 'production' } });
  const page = await productPage(app);

  assert.ok(page.html.includes('未接金流（示範模式）'));
  assert.equal((await postCheckout(app, { site: 'shop' })).status, 503);
});

/* ----------------------- 回呼（規格 §2.2，安全重點） ----------------------- */

async function orderFor(app) {
  const checkout = await postCheckout(app, {
    site: 'shop',
    email: 'buyer@example.test',
    productName: '星空作品集模板',
  });

  assert.equal(checkout.status, 200);
  return checkout.payload.order_id;
}

/**
 * ⛔ **這是規格 §6.3 要求「寫一個測試證明」的那一條。**
 *
 * 偽造的回呼不只要被拒絕，訂單還**必須一個 byte 都沒動** —— 那才是這條
 * 在守的東西（「拒絕了但順手把訂單標成失敗」也是壞的）。
 */
test('⛔ 偽造的 TradeSha → 403，訂單維持 pending', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const orderNo = await orderFor(app);

  const forged = { ...callbackForm({ orderNo }), TradeSha: 'F'.repeat(64) };
  const result = await postCallback(app, forged);

  assert.equal(result.status, 403);
  assert.match(result.body, /簽章對不上/);
  assert.ok(!result.body.includes('付款成功'));

  const order = app.store.reskinOrders.get(orderNo);
  assert.equal(order.status, 'pending');
  assert.equal(order.trade_no, null);
  assert.equal(order.paid_at, null);
  assert.equal(order.raw_result, null);
});

test('⛔ 用別把金鑰簽的回呼 → 403，訂單維持 pending', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const orderNo = await orderFor(app);

  const stranger = { merchantId: KEYS.merchantId, hashKey: '1'.repeat(32), hashIv: '2'.repeat(16) };
  const result = await postCallback(app, callbackForm({ orderNo }, stranger));

  assert.equal(result.status, 403);
  assert.equal(app.store.reskinOrders.get(orderNo).status, 'pending');
});

test('⛔ 章是對的但金額被改大 → 拒絕，而且不准標成失敗（那會蓋掉真相）', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const orderNo = await orderFor(app);

  const result = await postCallback(app, callbackForm({ orderNo, amount: 1 }));

  assert.equal(result.status, 403);
  assert.match(result.body, /金額跟訂單不一致/);
  assert.equal(app.store.reskinOrders.get(orderNo).status, 'pending');
});

test('不是我們建過的訂單編號 → 拒絕', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  await orderFor(app);

  const result = await postCallback(app, callbackForm({ orderNo: 'HTKneverexisted' }));

  assert.equal(result.status, 403);
  assert.match(result.body, /找不到這筆訂單/);
});

test('空的 / 亂寫的回呼不會變成一頁 500', async (t) => {
  const app = await setup(t, { newebpay: KEYS });

  const empty = await postCallback(app, {});
  assert.equal(empty.status, 403);
  assert.match(empty.body, /缺少必要的欄位/);

  const junk = await postCallback(app, { TradeInfo: 'not-hex', TradeSha: 'x'.repeat(64) });
  assert.equal(junk.status, 403);
});

test('正常的回呼 → 訂單 paid，頁面寫付款成功', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const orderNo = await orderFor(app);

  const result = await postCallback(app, callbackForm({ orderNo, tradeNo: '26111999' }));

  assert.equal(result.status, 200);
  assert.match(result.body, /付款成功/);
  assert.ok(result.body.includes(orderNo));
  assert.ok(result.body.includes('沒有真的收錢'), '測試環境要講明白');

  const order = app.store.reskinOrders.get(orderNo);
  assert.equal(order.status, 'paid');
  assert.equal(order.trade_no, '26111999');
  assert.ok(order.paid_at.length > 0);
  assert.ok(order.raw_result.includes('MerchantOrderNo'));

  // ⛔ 解密後的結果存起來對帳，但金鑰不准在裡面
  assert.ok(!order.raw_result.includes(KEYS.hashKey));
  assert.ok(!order.raw_result.includes(KEYS.hashIv));
});

/**
 * ⛔ 規格 §2.2 第 4 條。同一筆被打到兩次是**正常的**（ReturnURL 與
 * NotifyURL 都會送，使用者還可能重新整理那一頁）。
 */
test('同一筆回呼送兩次是 idempotent（第二次說「已經付過了」）', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const orderNo = await orderFor(app);
  const form = callbackForm({ orderNo, tradeNo: 'FIRST' });

  assert.match((await postCallback(app, form)).body, /付款成功/);

  const again = await postCallback(app, form);
  assert.equal(again.status, 200);
  assert.match(again.body, /已經付過了/);

  const order = app.store.reskinOrders.get(orderNo);
  assert.equal(order.status, 'paid');
  assert.equal(order.trade_no, 'FIRST', '第二次不該覆寫交易序號');
});

test('失敗的回呼 → 訂單 failed，頁面不留白', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const orderNo = await orderFor(app);

  const result = await postCallback(app, callbackForm({ orderNo, status: 'MPG03009' }));

  assert.equal(result.status, 200);
  assert.match(result.body, /付款沒有完成/);
  assert.match(result.body, /沒有被收款/);
  assert.equal(app.store.reskinOrders.get(orderNo).status, 'failed');
});

test('⛔ 已經 paid 的訂單不會被後到的失敗回呼改掉', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const orderNo = await orderFor(app);

  await postCallback(app, callbackForm({ orderNo }));
  await postCallback(app, callbackForm({ orderNo, status: 'MPG03009' }));

  assert.equal(app.store.reskinOrders.get(orderNo).status, 'paid');
});

/**
 * NotifyURL 在 localhost 永遠不會被藍新呼叫到（規格 §0.2），但邏輯要是同一套
 * —— 換成 tunnel 或真的部署就會開始對帳。對方是機器，所以回純文字。
 */
test('NotifyURL 走同一套驗證，回純文字', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const orderNo = await orderFor(app);
  const path = '/__lm/reskin/checkout/notify';

  const forged = await postCallback(
    app,
    { ...callbackForm({ orderNo }), TradeSha: 'F'.repeat(64) },
    path,
  );
  assert.equal(forged.status, 403);
  assert.equal(forged.body, 'REJECTED bad-sha');
  assert.equal(app.store.reskinOrders.get(orderNo).status, 'pending');

  const good = await postCallback(app, callbackForm({ orderNo }), path);
  assert.equal(good.status, 200);
  assert.equal(good.body, 'OK paid');
  assert.equal(app.store.reskinOrders.get(orderNo).status, 'paid');
});

/* -------------------------- 回商店那一頁 / 訂單清單 -------------------------- */

/**
 * ⛔ `ClientBackURL` 帶不回付款結果（它就只是一顆返回按鈕）。
 * 所以那一頁去讀**我們自己的訂單**，還是 pending 就老實說。
 */
test('從付款頁按「返回商店」→ 照訂單的真實狀態講話，不猜', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const orderNo = await orderFor(app);

  const pending = await fetch(
    `${app.base}/__lm/reskin/paid?site=shop&order=${encodeURIComponent(orderNo)}`,
  );
  const pendingHtml = await pending.text();
  assert.equal(pending.status, 200);
  assert.match(pendingHtml, /還沒收到付款結果/);
  assert.ok(!pendingHtml.includes('付款成功'));

  await postCallback(app, callbackForm({ orderNo }));

  const paidHtml = await fetch(
    `${app.base}/__lm/reskin/paid?site=shop&order=${encodeURIComponent(orderNo)}`,
  ).then((response) => response.text());
  assert.match(paidHtml, /付款成功/);
});

test('認不出訂單的回商店頁不會變 500', async (t) => {
  const app = await setup(t, { newebpay: KEYS });

  const response = await fetch(`${app.base}/__lm/reskin/paid?site=shop&order=HTKnope`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /沒有查到對應的訂單/);
});

test('控制台的訂單清單是唯讀的，而且不回 raw_result', async (t) => {
  const app = await setup(t, { newebpay: KEYS });
  const orderNo = await orderFor(app);
  await postCallback(app, callbackForm({ orderNo, tradeNo: 'T777' }));

  const listed = await fetch(`${app.base}/admin/api/sites/shop/reskin/orders`, {
    headers: adminHeaders(app),
  });
  const payload = await listed.json();

  assert.equal(listed.status, 200);
  assert.equal(payload.total, 1);
  assert.equal(payload.orders.length, 1);

  const [order] = payload.orders;
  assert.equal(order.id, orderNo);
  assert.equal(order.status, 'paid');
  assert.equal(order.env, 'test');
  assert.equal(order.amount, 199);
  assert.equal(order.trade_no, 'T777');
  assert.equal(order.product_name, '星空作品集模板');
  // ⛔ 解密後的交易結果裡有卡號前六後四，控制台的清單不需要它
  assert.equal(order.raw_result, undefined);

  // 唯讀：沒有任何寫入端點
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const attempt = await fetch(`${app.base}/admin/api/sites/shop/reskin/orders`, {
      method,
      headers: adminHeaders(app),
    });
    assert.ok(attempt.status >= 400, `${method} 不該被接受（回了 ${attempt.status}）`);
  }
});

test('訂單清單要 token', async (t) => {
  const app = await setup(t, { newebpay: KEYS });

  const response = await fetch(`${app.base}/admin/api/sites/shop/reskin/orders`);
  assert.equal(response.status, 401);
});
