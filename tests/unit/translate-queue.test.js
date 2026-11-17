'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');
const { createTranslationQueue, MAX_ATTEMPTS } = require('../../src/translate/queue.js');
const { AlignmentError, OllamaError } = require('../../src/translate/ollama.js');
const { silentLogger } = require('../../src/logger.js');

const MODEL = 'qwen2.5:latest';

function storeWith(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return createStore(db);
}

/** 假的 ollama：記下每次被叫到什麼，依注入的行為回應 */
function fakeClient(behaviour = {}) {
  const batches = [];

  return {
    batches,
    model: MODEL,
    batchSize: behaviour.batchSize ?? 20,
    async translateBatch(texts) {
      batches.push([...texts]);
      if (behaviour.fail) throw behaviour.fail;
      if (behaviour.failFirstTimes && batches.length <= behaviour.failFirstTimes) {
        throw new AlignmentError('對不上');
      }
      return texts.map((text) => `[${text}]`);
    },
  };
}

function queueWith(store, client, overrides = {}) {
  return createTranslationQueue({
    store,
    client,
    logger: silentLogger,
    batchSize: 20,
    ...overrides,
  });
}

/* ------------------------------ 排進去 ------------------------------ */

test('enqueue：沒命中的段排進佇列，重複的只排一筆', (t) => {
  const store = storeWith(t);

  const added = store.translateQueue.enqueue({
    texts: ['Contact', 'About Us', 'Contact'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  assert.equal(added, 2);
  assert.equal(store.translateQueue.stats().pending, 2);
});

test('enqueue：同一段排第二次不會重複（PK 是 hash）、也不會把 attempts 歸零', (t) => {
  const store = storeWith(t);
  const payload = { texts: ['Contact'], targetLang: 'zh-TW', model: MODEL, siteId: 'demo' };

  store.translateQueue.enqueue(payload);
  store.translateQueue.recordFailure(store.translateQueue.claim({ limit: 10 }), '壞了');

  assert.equal(store.translateQueue.enqueue(payload), 0);
  assert.equal(store.translateQueue.claim({ limit: 10 })[0].attempts, 1, 'attempts 不准被洗掉');
});

test('⛔ 已經在快取裡的段不會被排進佇列（規格 §6：重跑很便宜）', (t) => {
  const store = storeWith(t);

  store.translations.put({
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '聯絡我們',
    origin: 'machine',
  });

  const added = store.translateQueue.enqueue({
    texts: ['Contact', 'About Us'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  assert.equal(added, 1);
  assert.deepEqual(
    store.translateQueue.claim({ limit: 10 }).map((row) => row.source_text),
    ['About Us'],
  );
});

/* ------------------------------ 跑佇列 ------------------------------ */

test('drain：把佇列翻完，寫進 translations，佇列清空', async (t) => {
  const store = storeWith(t);
  const client = fakeClient();

  store.translateQueue.enqueue({
    texts: ['Contact', 'About Us'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const result = await queueWith(store, client).drain();

  assert.deepEqual(result, { batches: 1, translated: 2, failed: 0 });
  assert.equal(store.translateQueue.stats().pending, 0);
  assert.equal(
    store.translations.lookup({ texts: ['Contact'], targetLang: 'zh-TW', model: MODEL }).get('Contact')
      .translated,
    '[Contact]',
  );
});

test('drain：超過 batchSize 時自己切批（ollama 不准被一次灌 100 段）', async (t) => {
  const store = storeWith(t);
  const client = fakeClient();

  store.translateQueue.enqueue({
    texts: Array.from({ length: 7 }, (unused, index) => `Segment ${index}`),
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const result = await queueWith(store, client, { batchSize: 3 }).drain();

  assert.equal(result.batches, 3);
  assert.deepEqual(client.batches.map((batch) => batch.length), [3, 3, 1]);
  assert.equal(store.translateQueue.stats().pending, 0);
});

test('⛔ 同一段第二次不會再呼叫 ollama（快取是主幹，不是優化）', async (t) => {
  const store = storeWith(t);
  const client = fakeClient();
  const queue = queueWith(store, client);

  const payload = { texts: ['Contact'], targetLang: 'zh-TW', model: MODEL, siteId: 'demo' };

  store.translateQueue.enqueue(payload);
  await queue.drain();
  assert.equal(client.batches.length, 1);

  // 第二次：enqueue 看到快取裡有了，直接跳過
  store.translateQueue.enqueue(payload);
  await queue.drain();

  assert.equal(client.batches.length, 1, '不准再打 ollama');
});

test('⛔ 背景翻譯不覆蓋人工覆寫（manual 永遠優先）', async (t) => {
  const store = storeWith(t);
  const { translationHash } = require('../../src/translate/cache.js');
  const hash = translationHash('Contact', 'zh-TW', MODEL);

  // 先排進佇列，然後人工先改好
  store.translateQueue.enqueue({
    texts: ['Contact'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });
  store.translations.setManual(hash, {
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '人工版本',
  });

  await queueWith(store, fakeClient()).drain();

  assert.equal(store.translations.get(hash).translated, '人工版本');
  assert.equal(store.translations.get(hash).origin, 'manual');
});

/* ------------------------------ 失敗 ------------------------------ */

test('⛔ 對齊失敗：整批留在佇列、attempts +1、記下 last_error', async (t) => {
  const store = storeWith(t);
  const client = fakeClient({ fail: new AlignmentError('key 數量對不上') });

  store.translateQueue.enqueue({
    texts: ['Contact', 'About Us'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const result = await queueWith(store, client).drain();

  assert.equal(result.failed, 2);
  assert.equal(store.translations.count().total, 0, '一個字都不准寫進快取');

  const rows = store.translateQueue.claim({ limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].attempts, 1);
  assert.match(rows[0].last_error, /key 數量對不上/);
});

test('⛔ ollama 連不上：佇列保留、記 last_error、drain 不丟錯', async (t) => {
  const store = storeWith(t);
  const client = fakeClient({ fail: new OllamaError('連不到 ollama（ECONNREFUSED）') });

  store.translateQueue.enqueue({
    texts: ['Contact'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const result = await queueWith(store, client).drain();

  assert.equal(result.failed, 1);
  assert.equal(store.translateQueue.stats().pending, 1);
  assert.match(store.translateQueue.claim({ limit: 1 })[0].last_error, /ECONNREFUSED/);
});

test('⛔ attempts >= 3 的段不再重試（規格 §4：標記成翻不動，讓人工處理）', async (t) => {
  const store = storeWith(t);
  const client = fakeClient({ fail: new AlignmentError('一直對不上') });
  const queue = queueWith(store, client);

  assert.equal(MAX_ATTEMPTS, 3);

  store.translateQueue.enqueue({
    texts: ['Contact'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  await queue.drain();
  await queue.drain();
  await queue.drain();
  assert.equal(client.batches.length, 3);

  // 第四次：那段已經 attempts=3，不准再叫 ollama
  await queue.drain();
  assert.equal(client.batches.length, 3, '不准無限重試');

  const stats = store.translateQueue.stats();
  assert.equal(stats.pending, 0, '翻不動的不算待翻');
  assert.equal(stats.failed, 1);
  assert.equal(store.translateQueue.listFailed({ limit: 10 })[0].source_text, 'Contact');
});

test('重試成功後那段就離開佇列了', async (t) => {
  const store = storeWith(t);
  const client = fakeClient({ failFirstTimes: 1 });
  const queue = queueWith(store, client);

  store.translateQueue.enqueue({
    texts: ['Contact'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  await queue.drain();
  assert.equal(store.translateQueue.stats().pending, 1);

  await queue.drain();
  assert.equal(store.translateQueue.stats().pending, 0);
  assert.equal(store.translations.count().total, 1);
});

/* ---------------------------- 併發與收尾 ---------------------------- */

test('⛔ 序列化：同時 kick 兩次只會有一條在跑（ollama 本來就不併行）', async (t) => {
  const store = storeWith(t);
  const client = fakeClient();
  const queue = queueWith(store, client, { batchSize: 1 });

  store.translateQueue.enqueue({
    texts: ['One thing', 'Two thing', 'Three thing'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const [first, second] = [queue.drain(), queue.drain()];
  await Promise.all([first, second]);

  // 三段、batchSize 1 → 剛好三批。有併發的話同一段會被翻兩次
  assert.equal(client.batches.length, 3);
  assert.equal(new Set(client.batches.flat()).size, 3);
});

test('kick 是射後不理的，不會把錯誤丟到外面（代理的請求路徑在呼叫它）', async (t) => {
  const store = storeWith(t);
  const client = fakeClient({ fail: new OllamaError('掛了') });
  const queue = queueWith(store, client);

  store.translateQueue.enqueue({
    texts: ['Contact'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  assert.doesNotThrow(() => queue.kick());
  await queue.idle();
});

test('stop 之後不再處理新的批次（關機 / 測試收尾要用）', async (t) => {
  const store = storeWith(t);
  const client = fakeClient();
  const queue = queueWith(store, client, { batchSize: 1 });

  store.translateQueue.enqueue({
    texts: ['One thing', 'Two thing', 'Three thing'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  queue.stop();
  await queue.drain();

  assert.equal(client.batches.length, 0);
});

test('佇列空的時候 drain 什麼都不做', async (t) => {
  const store = storeWith(t);
  const client = fakeClient();

  assert.deepEqual(await queueWith(store, client).drain(), {
    batches: 0,
    translated: 0,
    failed: 0,
  });
  assert.equal(client.batches.length, 0);
});

test('stats：待翻 / 翻不動 / 總數（UI 的佇列狀態）', (t) => {
  const store = storeWith(t);

  store.translateQueue.enqueue({
    texts: ['Contact', 'About Us'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  assert.deepEqual(store.translateQueue.stats(), { pending: 2, failed: 0, total: 2 });
});
