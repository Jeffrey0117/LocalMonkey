'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, adminJson } = require('../support/app.js');
const { translationHash } = require('../../src/translate/cache.js');

/** SPEC-rules §5.1：掃出快取裡的簡體段，一鍵全部重翻 */

const MODEL = 'qwen2.5:latest';
const LANG = 'zh-TW';

function seed(store, entries) {
  for (const [source, translated, origin = 'machine'] of entries) {
    const hash = translationHash(source, LANG, MODEL);
    store.translations.put({
      hash,
      source_text: source,
      target_lang: LANG,
      model: MODEL,
      translated,
      origin,
    });
    if (origin === 'manual') store.translations.setManual(hash, {
      source_text: source,
      target_lang: LANG,
      model: MODEL,
      translated,
    });
  }
}

function fakeClient() {
  const seen = [];
  return {
    seen,
    model: MODEL,
    batchSize: 20,
    async translateBatch(texts) {
      seen.push(...texts);
      return texts.map((text) => `繁:${text}`);
    },
    async listModels() {
      return [MODEL];
    },
    async ping() {
      return { ok: true, models: [MODEL], error: null };
    },
  };
}

async function scenario(t) {
  const client = fakeClient();
  const app = await startApp({ translationClient: client });
  t.after(() => app.close());

  return { app, client, api: (pathname, init) => adminJson(app.base, app.adminToken, pathname, init) };
}

test('掃得出含簡體的段，並列出是哪幾個字', async (t) => {
  const { app, api } = await scenario(t);

  seed(app.store, [
    ['Lantern River', '灯笼河'],
    ['Dynamic', '动感'],
    ['Slideshow', '幻灯片'],
    ['Free Templates', '免費模板'],
    ['Contact', '聯絡我們'],
  ]);

  const result = await api('/admin/api/translate/simplified');

  assert.equal(result.status, 200);
  assert.equal(result.body.total, 3);
  assert.deepEqual(
    result.body.entries.map((entry) => entry.translated).sort(),
    ['动感', '幻灯片', '灯笼河'],
  );
  assert.deepEqual(result.body.entries.find((entry) => entry.translated === '灯笼河').chars, ['灯', '笼']);
});

test('全繁體的快取 → 0 段（這個 0 才是真的）', async (t) => {
  const { app, api } = await scenario(t);

  seed(app.store, [
    ['Lantern River', '燈河'],
    ['Slideshow', '幻燈片'],
    ['Dashboard', '控制台'],
    ['Taiwan', '台灣'],
  ]);

  assert.equal((await api('/admin/api/translate/simplified')).body.total, 0);
});

test('一鍵重翻：快取那幾筆被砍掉、排進佇列、背景翻成繁體', async (t) => {
  const { app, client, api } = await scenario(t);

  seed(app.store, [
    ['Lantern River', '灯笼河'],
    ['Contact', '聯絡我們'],
  ]);

  const result = await api('/admin/api/translate/simplified/retranslate', {
    method: 'POST',
    body: JSON.stringify({}),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.queued, 1);

  await app.translation.queue.idle();

  assert.deepEqual(client.seen, ['Lantern River']);
  assert.equal(
    app.store.translations.get(translationHash('Lantern River', LANG, MODEL)).translated,
    '繁:Lantern River',
  );
  // 沒問題的那段不准被動到
  assert.equal(app.store.translations.get(translationHash('Contact', LANG, MODEL)).translated, '聯絡我們');
  assert.equal((await api('/admin/api/translate/simplified')).body.total, 0);
});

test('⛔ 預設跳過人工覆寫（砍掉使用者自己打的字是不可逆的）', async (t) => {
  const { app, api } = await scenario(t);

  seed(app.store, [['Lantern River', '灯笼河', 'manual']]);

  const scanned = await api('/admin/api/translate/simplified');
  assert.equal(scanned.body.total, 1);
  assert.equal(scanned.body.manual, 1);

  const skipped = await api('/admin/api/translate/simplified/retranslate', {
    method: 'POST',
    body: JSON.stringify({}),
  });

  assert.equal(skipped.body.queued, 0);
  assert.equal(
    app.store.translations.get(translationHash('Lantern River', LANG, MODEL)).translated,
    '灯笼河',
  );

  const forced = await api('/admin/api/translate/simplified/retranslate', {
    method: 'POST',
    body: JSON.stringify({ includeManual: true }),
  });

  assert.equal(forced.body.queued, 1);
});

test('空的快取不會爆', async (t) => {
  const { api } = await scenario(t);

  const result = await api('/admin/api/translate/simplified');
  assert.deepEqual(result.body.entries, []);
  assert.equal(
    (await api('/admin/api/translate/simplified/retranslate', { method: 'POST', body: '{}' })).body
      .queued,
    0,
  );
});
