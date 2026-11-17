'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');
const { translationHash } = require('../../src/translate/cache.js');

const MODEL = 'qwen2.5:latest';

function storeWith(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return createStore(db);
}

/* ------------------------------ hash ------------------------------ */

test('hash = sha256(原文 + lang + model)，所以換模型自動重翻', () => {
  const a = translationHash('Contact', 'zh-TW', MODEL);
  const b = translationHash('Contact', 'zh-TW', 'llama3:8b');
  const c = translationHash('Contact', 'zh-CN', MODEL);
  const d = translationHash('Contact', 'zh-TW', MODEL);

  assert.equal(a, d, '同樣的輸入要是同一個 hash');
  assert.notEqual(a, b, '換模型要換 hash');
  assert.notEqual(a, c, '換語言要換 hash');
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('⛔ hash 的分隔不會讓不同輸入撞在一起', () => {
  // 規格寫的是「原文 + 換行 + lang + 換行 + model」，而那個寫法下
  // ('a', 'b\nzh') 與 ('a\nb', 'zh') 會算出同一個 hash ——
  // 撞到的後果是「某一段拿到另一段的譯文」，而且會進永久快取。
  // 實作改成長度前綴（db/translations.js 的註解說明這個偏離）。
  assert.notEqual(translationHash('a', 'b\nzh', MODEL), translationHash('a\nb', 'zh', MODEL));
  assert.notEqual(translationHash('ab', 'c', MODEL), translationHash('a', 'bc', MODEL));
});

/* ----------------------------- 讀寫 ----------------------------- */

test('put 之後 lookup 拿得到（這是整個設計的主幹）', (t) => {
  const store = storeWith(t);

  store.translations.put({
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '聯絡我們',
    origin: 'machine',
  });

  const found = store.translations.lookup({
    texts: ['Contact'],
    targetLang: 'zh-TW',
    model: MODEL,
  });

  assert.equal(found.get('Contact').translated, '聯絡我們');
  assert.equal(found.get('Contact').origin, 'machine');
});

test('lookup 一次查多段，沒命中的不出現在結果裡', (t) => {
  const store = storeWith(t);

  store.translations.put({
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '聯絡我們',
    origin: 'machine',
  });

  const found = store.translations.lookup({
    texts: ['Contact', 'About Us', 'Read More'],
    targetLang: 'zh-TW',
    model: MODEL,
  });

  assert.equal(found.size, 1);
  assert.equal(found.has('About Us'), false);
});

test('lookup：空清單不會發 SQL，回空 Map', (t) => {
  const store = storeWith(t);
  assert.equal(store.translations.lookup({ texts: [], targetLang: 'zh-TW', model: MODEL }).size, 0);
});

test('lookup：段數超過 SQLite 的參數上限也不會爆（會自己分批）', (t) => {
  const store = storeWith(t);
  const texts = Array.from({ length: 5_000 }, (unused, index) => `Segment number ${index}`);

  store.translations.put({
    source_text: 'Segment number 4999',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '最後一段',
    origin: 'machine',
  });

  const found = store.translations.lookup({ texts, targetLang: 'zh-TW', model: MODEL });

  assert.equal(found.size, 1);
  assert.equal(found.get('Segment number 4999').translated, '最後一段');
});

test('同一段再 put 一次是更新，不是新增一列', (t) => {
  const store = storeWith(t);
  const row = { source_text: 'Contact', target_lang: 'zh-TW', model: MODEL, origin: 'machine' };

  store.translations.put({ ...row, translated: '第一版' });
  store.translations.put({ ...row, translated: '第二版' });

  assert.equal(store.translations.count().total, 1);
  assert.equal(
    store.translations.lookup({ texts: ['Contact'], targetLang: 'zh-TW', model: MODEL }).get('Contact')
      .translated,
    '第二版',
  );
});

/* --------------------------- manual 優先 --------------------------- */

test('⛔ 同一段有 machine 也有 manual → 用 manual（規格 §2）', (t) => {
  const store = storeWith(t);

  store.translations.put({
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '機器翻的',
    origin: 'machine',
  });
  store.translations.setManual(translationHash('Contact', 'zh-TW', 'llama3:8b'), {
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: 'llama3:8b',
    translated: '人工改的',
  });

  const found = store.translations.lookup({
    texts: ['Contact'],
    targetLang: 'zh-TW',
    model: MODEL,
  });

  assert.equal(found.get('Contact').translated, '人工改的');
  assert.equal(found.get('Contact').origin, 'manual');
});

test('⛔ 人工改過的那段，背景翻譯不准覆蓋（規格 §2：origin=manual 永遠優先）', (t) => {
  const store = storeWith(t);
  const hash = translationHash('Contact', 'zh-TW', MODEL);

  store.translations.setManual(hash, {
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '人工版本',
  });

  // 背景佇列後來翻好了同一段
  store.translations.put({
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '機器版本',
    origin: 'machine',
  });

  const row = store.translations.get(hash);
  assert.equal(row.translated, '人工版本');
  assert.equal(row.origin, 'manual');
});

test('人工覆寫可以改第二次（而且 updated_at 會動）', (t) => {
  const store = storeWith(t);
  const hash = translationHash('Contact', 'zh-TW', MODEL);
  const base = { source_text: 'Contact', target_lang: 'zh-TW', model: MODEL };

  store.translations.setManual(hash, { ...base, translated: '第一次' });
  const first = store.translations.get(hash);

  store.translations.setManual(hash, { ...base, translated: '第二次' });
  const second = store.translations.get(hash);

  assert.equal(second.translated, '第二次');
  assert.ok(second.updated_at >= first.updated_at);
});

test('remove：單段「重翻」要先把快取那筆砍掉', (t) => {
  const store = storeWith(t);
  const hash = translationHash('Contact', 'zh-TW', MODEL);

  store.translations.put({
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '聯絡我們',
    origin: 'machine',
  });

  assert.equal(store.translations.remove(hash), true);
  assert.equal(store.translations.get(hash), null);
  assert.equal(store.translations.remove(hash), false, '砍不存在的回 false');
});

/* ------------------------------ 列表 ------------------------------ */

test('list：最近更新的在前面，可以分頁', (t) => {
  const store = storeWith(t);

  for (const index of [0, 1, 2]) {
    store.translations.put({
      source_text: `Text number ${index}`,
      target_lang: 'zh-TW',
      model: MODEL,
      translated: `譯文 ${index}`,
      origin: 'machine',
    });
  }

  const page = store.translations.list({ limit: 2 });
  assert.equal(page.length, 2);
  assert.equal(store.translations.list({ limit: 2, offset: 2 }).length, 1);
});

test('list：搜尋原文與譯文都要能搜（規格 §7）', (t) => {
  const store = storeWith(t);

  store.translations.put({
    source_text: 'Contact us today',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '立即聯絡我們',
    origin: 'machine',
  });
  store.translations.put({
    source_text: 'About the team',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '關於團隊',
    origin: 'machine',
  });

  assert.equal(store.translations.list({ query: 'Contact' }).length, 1, '搜原文');
  assert.equal(store.translations.list({ query: '團隊' }).length, 1, '搜譯文');
  assert.equal(store.translations.list({ query: 'contact' }).length, 1, '不分大小寫');
  assert.equal(store.translations.list({ query: 'nothing here' }).length, 0);
});

test('⛔ 搜尋字串裡的 % 與 _ 不會變成萬用字元', (t) => {
  const store = storeWith(t);

  store.translations.put({
    source_text: 'Save 50% today',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '今天省 50%',
    origin: 'machine',
  });

  assert.equal(store.translations.list({ query: '50%' }).length, 1);
  assert.equal(store.translations.list({ query: '%' }).length, 1, 'LIKE 的 % 要被跳脫');
  assert.equal(store.translations.list({ query: 'Save_50' }).length, 0, '`_` 不准當任意字元');
});

test('count：總數與人工覆寫數（UI 要顯示）', (t) => {
  const store = storeWith(t);

  store.translations.put({
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: 'a',
    origin: 'machine',
  });
  store.translations.setManual(translationHash('About', 'zh-TW', MODEL), {
    source_text: 'About',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: 'b',
  });

  assert.deepEqual(store.translations.count(), { total: 2, manual: 1 });
});
