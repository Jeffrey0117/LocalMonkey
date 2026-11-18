'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');
const { createTranslationQueue } = require('../../src/translate/queue.js');
const { translationHash } = require('../../src/translate/cache.js');
const { wantsTraditional } = require('../../src/translate/simplified.js');
const { silentLogger } = require('../../src/logger.js');

/**
 * SPEC-rules §5.1 的後半段。
 *
 * 「掃出來重翻」只解決**已經在快取裡**的那些。實測（2026-11-18 對使用者真的
 * 快取跑一次重翻）：13 段重翻完還剩 8 段是簡體 —— qwen2.5 就是會把
 * `Lantern River` 翻成「灯笼河」，prompt 裡寫「禁止簡體」它也照寫。
 *
 * 所以「禁止簡體」要從**請求**變成**驗收**：翻回來的東西含簡體字就當成
 * 對齊失敗（二分 → 單段 → attempts += 1 → 進「翻不動」清單讓人工處理），
 * 而不是寫進永久快取。
 */

const MODEL = 'test-model';

function setup({ targetLang = 'zh-TW', translations }) {
  const store = createStore(openDatabase(':memory:'));
  const texts = Object.keys(translations);

  store.translateQueue.enqueue({ texts, targetLang, model: MODEL, siteId: null });

  const queue = createTranslationQueue({
    store,
    logger: silentLogger,
    batchSize: 20,
    client: {
      model: MODEL,
      async translateBatch(sources) {
        return sources.map((source) => translations[source]);
      },
    },
  });

  return { store, queue, hashOf: (text) => translationHash(text, targetLang, MODEL) };
}

test('wantsTraditional：只有繁體目標語言才要擋簡體', () => {
  for (const lang of ['zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-TW', 'ZH-tw']) {
    assert.equal(wantsTraditional(lang), true, lang);
  }
  for (const lang of ['zh-CN', 'zh-Hans', 'zh', 'en', 'ja', null, undefined]) {
    assert.equal(wantsTraditional(lang), false, String(lang));
  }
});

test('⛔ 譯文含簡體 → 不准進快取，那一段記一次失敗', async () => {
  const { store, queue, hashOf } = setup({
    translations: { 'Lantern River': '灯笼河', Contact: '聯絡我們' },
  });

  await queue.drain();

  assert.equal(store.translations.get(hashOf('Lantern River')), null, '簡體的不准寫進快取');
  assert.equal(store.translations.get(hashOf('Contact')).translated, '聯絡我們', '乾淨的照樣寫進去');

  const failed = store.translateQueue.listFailed({ maxAttempts: 1 });
  assert.equal(failed.length, 1);
  assert.match(failed[0].last_error, /簡體/);
  assert.match(failed[0].last_error, /灯笼/, '要講出是哪幾個字');
});

/**
 * ⛔ `recordFailure` 會把**同一句**錯誤寫給這一批裡每一個失敗的段，所以訊息
 * 裡不能點名某一段的原文 —— 實測（2026-11-18）那樣會讓「631 Kinetic」的
 * 失敗原因寫成另一段的句子，查錯方向整個歪掉（地雷 36 的同一個教訓）。
 */
test('⛔ 失敗訊息不准點名某一段的原文（那句話會被寫給整批）', async () => {
  const { store, queue } = setup({
    translations: { 'Lantern River': '灯笼河', Kinetic: '动感' },
  });

  await queue.drain();

  const failed = store.translateQueue.listFailed({ maxAttempts: 1 });
  assert.equal(failed.length, 2);

  for (const row of failed) {
    assert.ok(!row.last_error.includes('Lantern River'), row.last_error);
    assert.ok(!row.last_error.includes('Kinetic'), row.last_error);
  }
});

test('一段壞的不會連坐同一批裡好的（二分找出是哪一段）', async () => {
  const { store, queue, hashOf } = setup({
    translations: {
      A: '動感',
      B: '灯笼',
      C: '預覽',
      D: '下載',
    },
  });

  await queue.drain();

  for (const text of ['A', 'C', 'D']) {
    assert.ok(store.translations.get(hashOf(text)), `${text} 應該翻好了`);
  }
  assert.equal(store.translations.get(hashOf('B')), null);
});

test('重試三次還是簡體 → 進「翻不動」清單，不要無限重試', async () => {
  const { store, queue } = setup({ translations: { 'Lantern River': '灯笼河' } });

  for (let round = 0; round < 4; round += 1) await queue.drain();

  const stats = store.translateQueue.stats();
  assert.equal(stats.failed, 1, '三次之後要停下來');
  assert.equal(stats.pending, 0);
});

test('⛔ 目標語言是簡體中文時不准擋（那時候簡體才是對的）', async () => {
  const { store, queue } = setup({
    targetLang: 'zh-CN',
    translations: { 'Lantern River': '灯笼河' },
  });

  await queue.drain();

  assert.equal(
    store.translations.get(translationHash('Lantern River', 'zh-CN', MODEL)).translated,
    '灯笼河',
  );
});
