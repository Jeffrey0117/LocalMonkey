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

test('⛔ 一段翻不動不會把整條佇列卡死（剩下的要繼續翻）', async (t) => {
  const store = storeWith(t);

  // 'Bravo two' 是會讓模型吐出多餘 key 的那一段，其他三段沒問題
  const client = pickyClient({ poison: 'Bravo two' });

  store.translateQueue.enqueue({
    texts: ['Alpha one', 'Bravo two', 'Charlie three', 'Delta four'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const result = await queueWith(store, client, { batchSize: 2 }).drain();

  // 壞的那段留著等下一輪，另外三段**這一輪就要翻好**
  assert.equal(result.translated, 3, '一段失敗之後就不做事了＝整站卡住');
  assert.equal(result.failed, 1);
  assert.equal(store.translations.count().total, 3);
  assert.equal(store.translateQueue.stats().pending, 1);
});

test('⛔ 同一輪裡不會重複拿到剛失敗的那段（不然會原地打轉）', async (t) => {
  const store = storeWith(t);

  // 每一段都對不上 → 每一段都會被二分到單段、各記一次 attempts，然後這一輪結束
  const client = pickyClient({ maxAligned: 0 });

  store.translateQueue.enqueue({
    texts: ['Alpha one', 'Bravo two', 'Charlie three', 'Delta four'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const result = await queueWith(store, client, { batchSize: 2 }).drain();

  assert.equal(result.failed, 4);
  assert.deepEqual(
    store.translateQueue.claim({ limit: 10 }).map((row) => row.attempts),
    [1, 1, 1, 1],
    '每一段只該被算一次失敗',
  );
});

test('⛔ 逾時不二分（一次 120 秒，遞迴下去 20 段會變成一個多小時）', async (t) => {
  const store = storeWith(t);
  const timeout = new OllamaError('ollama 超過 120000ms 還沒回應', { kind: 'timeout' });
  const client = pickyClient({ fail: timeout });

  store.translateQueue.enqueue({
    texts: texts(16),
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  await queueWith(store, client, { batchSize: 16 }).drain();

  assert.equal(client.batches.length, 1, '逾時一次就收手，不准拆小再等 N 次');
  assert.deepEqual(
    store.translateQueue.claim({ limit: 20 }).map((row) => row.attempts),
    Array.from({ length: 16 }, () => 0),
    '冷啟動逾時不該燒掉任何一段的重試額度',
  );
});

test('claim 的 exclude：排除指定的 hash（佇列跳過剛失敗的那批靠它）', (t) => {
  const store = storeWith(t);

  store.translateQueue.enqueue({
    texts: ['Alpha one', 'Bravo two'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const all = store.translateQueue.claim({ limit: 10 });
  assert.equal(all.length, 2);

  const rest = store.translateQueue.claim({ limit: 10, exclude: [all[0].hash] });
  assert.deepEqual(rest.map((row) => row.hash), [all[1].hash]);

  assert.equal(store.translateQueue.claim({ limit: 10, exclude: all.map((r) => r.hash) }).length, 0);
});

/* ------------------------- 失敗就二分（§4 補強） ------------------------- */

/**
 * 實測（團隊 2026-11-18 對真的 templatemo）：**20 段的批次，qwen2.5 回了 35 個 key**。
 * 規格的「批次 20」是從「10 段實測完美」外推的，那個外推錯了。
 *
 * 固定批次 + 整批重試 3 次的語意是「19 個好段被 1 個壞段連坐」——
 * 所以失敗要二分：20 → 2×10 → 4×5 → … → 單段。
 * 單段不可能數量對不上（送 1 回 1），所以一定收斂，而且只有真的有問題的那幾段
 * 會掉到慢速路徑。
 */

function texts(count, prefix = 'Segment') {
  return Array.from({ length: count }, (unused, index) => `${prefix} number ${index}`);
}

/** 假 ollama：可以指定「批次大於幾段就對不上」與「含有哪段就對不上」 */
function pickyClient({ maxAligned = Infinity, poison = null, fail = null } = {}) {
  const batches = [];

  return {
    batches,
    model: MODEL,
    batchSize: 20,
    async translateBatch(list) {
      batches.push([...list]);

      if (fail) throw fail;
      if (list.length > maxAligned) {
        throw new AlignmentError(`數量對不上：送了 ${list.length} 段，回來 ${list.length + 15} 段`);
      }
      if (poison !== null && list.includes(poison)) {
        throw new AlignmentError('這一段每次都讓模型吐出多餘的 key');
      }

      return list.map((text) => `[${text}]`);
    },
  };
}

test('⛔ 大批次對不上 → 二分到小批次，整批最後全部翻完', async (t) => {
  const store = storeWith(t);
  const client = pickyClient({ maxAligned: 5 });

  store.translateQueue.enqueue({
    texts: texts(20),
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const result = await queueWith(store, client, { batchSize: 20 }).drain();

  assert.equal(result.translated, 20, '20 段應該全部翻完');
  assert.equal(result.failed, 0);
  assert.equal(store.translations.count().total, 20);
  assert.equal(store.translateQueue.stats().total, 0, '佇列要清空');

  // 20 →(失敗) 10,10 →(都失敗) 5,5,5,5 →(都成功)
  assert.deepEqual(client.batches.map((batch) => batch.length), [20, 10, 5, 5, 10, 5, 5]);
});

test('⛔ 只有一段有問題 → 其他 19 段照樣翻完，不被連坐', async (t) => {
  const store = storeWith(t);
  const poison = 'Segment number 7';
  const client = pickyClient({ poison });

  store.translateQueue.enqueue({
    texts: texts(20),
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const result = await queueWith(store, client, { batchSize: 20 }).drain();

  assert.equal(result.translated, 19, '19 個好段不該被 1 個壞段連坐');
  assert.equal(result.failed, 1);

  const remaining = store.translateQueue.claim({ limit: 10 });
  assert.deepEqual(remaining.map((row) => row.source_text), [poison]);
  assert.equal(remaining[0].attempts, 1);
});

test('⛔ 二分是對數次呼叫，不是一段一段慢慢試', async (t) => {
  const store = storeWith(t);
  const client = pickyClient({ poison: 'Segment number 7' });

  store.translateQueue.enqueue({
    texts: texts(20),
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  await queueWith(store, client, { batchSize: 20 }).drain();

  // 退化成單段逐一重試的話會是 20+ 次
  assert.ok(client.batches.length <= 12, `呼叫了 ${client.batches.length} 次，太多了`);
  assert.ok(
    client.batches.some((batch) => batch.length === 1),
    '最後要縮到單段才找得出是哪一段',
  );
});

test('⛔ attempts 只算在「單段也失敗」的那一段上（整批記 attempts 會連坐）', async (t) => {
  const store = storeWith(t);
  const client = pickyClient({ poison: 'Segment number 2' });

  store.translateQueue.enqueue({
    texts: texts(4),
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  await queueWith(store, client, { batchSize: 4 }).drain();

  // 壞的那段 attempts=1；其他三段早就翻完離開佇列了
  const remaining = store.translateQueue.claim({ limit: 10 });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].source_text, 'Segment number 2');
  assert.equal(remaining[0].attempts, 1);
  assert.equal(store.translations.count().total, 3);
});

test('⛔ 連不到 ollama 不准二分（那只會多等好幾次，而且跟段落內容無關）', async (t) => {
  const store = storeWith(t);
  const client = pickyClient({ fail: new OllamaError('連不到 ollama（ECONNREFUSED）') });

  store.translateQueue.enqueue({
    texts: texts(8),
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  await queueWith(store, client, { batchSize: 8 }).drain();

  assert.equal(client.batches.length, 1, '整個 run 只該打一次就收手');
});

test('⛔ 基礎設施壞掉不准燒掉段落的重試額度（ollama 關一小時不該讓整站標成翻不動）', async (t) => {
  const store = storeWith(t);
  const client = pickyClient({ fail: new OllamaError('連不到 ollama（ECONNREFUSED）') });
  const queue = queueWith(store, client, { batchSize: 8 });

  store.translateQueue.enqueue({
    texts: texts(4),
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  await queue.drain();
  await queue.drain();
  await queue.drain();
  await queue.drain();

  const rows = store.translateQueue.claim({ limit: 10 });
  assert.equal(rows.length, 4, '四段都還在等，沒有一段被標成翻不動');
  assert.deepEqual(rows.map((row) => row.attempts), [0, 0, 0, 0]);
  assert.match(rows[0].last_error, /ECONNREFUSED/, '但錯誤原因要記下來給 UI 看');
  assert.equal(store.translateQueue.stats().failed, 0);
});

test('單段的對齊失敗才會累加 attempts，三次之後不再重試', async (t) => {
  const store = storeWith(t);
  const client = pickyClient({ poison: 'Segment number 0' });
  const queue = queueWith(store, client, { batchSize: 1 });

  store.translateQueue.enqueue({
    texts: texts(1),
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  await queue.drain();
  await queue.drain();
  await queue.drain();
  assert.equal(client.batches.length, 3);

  await queue.drain();
  assert.equal(client.batches.length, 3, 'attempts 滿了就不再叫 ollama');
  assert.equal(store.translateQueue.stats().failed, 1);
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
