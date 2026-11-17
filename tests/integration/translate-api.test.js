'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, adminJson } = require('../support/app.js');
const { translationHash } = require('../../src/translate/cache.js');
const { DEFAULT_GLOSSARY } = require('../../src/translate/glossary.js');

/** 規格 §7：控制台的翻譯分頁與站台翻譯設定背後的 API。 */

const MODEL = 'qwen2.5:latest';

function fakeClient({ down = false } = {}) {
  const batches = [];

  return {
    batches,
    model: MODEL,
    batchSize: 20,
    async translateBatch(texts) {
      batches.push([...texts]);
      return texts.map((text) => `譯:${text}`);
    },
    async listModels() {
      if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      return [MODEL, 'llama3:8b'];
    },
    async ping() {
      return down
        ? { ok: false, models: [], error: 'connect ECONNREFUSED 127.0.0.1:11434' }
        : { ok: true, models: [MODEL, 'llama3:8b'], error: null };
    },
    baseUrl: 'http://127.0.0.1:11434',
  };
}

async function harness(t, options = {}) {
  const client = fakeClient(options);
  const app = await startApp({ translationClient: client });
  t.after(() => app.close());

  app.store.sites.create({
    id: 'demo',
    name: 'demo',
    target_origin: 'https://templatemo.com',
    enabled: 1,
  });

  const api = (pathname, init) => adminJson(app.base, app.adminToken, pathname, init);
  return { app, client, api };
}

function seedEntry(app, { text = 'Contact', translated = '聯絡我們', origin = 'machine' } = {}) {
  const hash = translationHash(text, 'zh-TW', MODEL);

  if (origin === 'manual') {
    app.store.translations.setManual(hash, {
      source_text: text,
      target_lang: 'zh-TW',
      model: MODEL,
      translated,
    });
  } else {
    app.store.translations.put({
      source_text: text,
      target_lang: 'zh-TW',
      model: MODEL,
      translated,
      origin,
    });
  }

  return hash;
}

/* -------------------------------- 狀態 -------------------------------- */

test('GET /translate/status：ollama 活著、佇列與快取的數字', async (t) => {
  const { app, api } = await harness(t);

  seedEntry(app);
  app.store.translateQueue.enqueue({
    texts: ['About Us'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const { status, body } = await api('/admin/api/translate/status');

  assert.equal(status, 200);
  assert.equal(body.ollama.ok, true);
  assert.equal(body.ollama.model, MODEL);
  assert.deepEqual(body.cache, { total: 1, manual: 0 });
  assert.equal(body.queue.pending, 1);
  assert.deepEqual(body.defaults.glossary, [...DEFAULT_GLOSSARY]);
});

test('⛔ ollama 掛掉時 status 仍回 200（UI 要能顯示「連不上」而不是整頁爆掉）', async (t) => {
  const { api } = await harness(t, { down: true });

  const { status, body } = await api('/admin/api/translate/status');

  assert.equal(status, 200);
  assert.equal(body.ollama.ok, false);
  assert.match(body.ollama.error, /ECONNREFUSED/);
});

test('GET /translate/models：模型下拉選單的來源；掛掉回空清單 + ok:false', async (t) => {
  const alive = await harness(t);
  const aliveResponse = await alive.api('/admin/api/translate/models');

  assert.equal(aliveResponse.status, 200);
  assert.deepEqual(aliveResponse.body.models, [MODEL, 'llama3:8b']);
  assert.equal(aliveResponse.body.ok, true);

  const dead = await harness(t, { down: true });
  const deadResponse = await dead.api('/admin/api/translate/models');

  assert.equal(deadResponse.status, 200);
  assert.deepEqual(deadResponse.body.models, []);
  assert.equal(deadResponse.body.ok, false);
});

/* -------------------------------- 列表 -------------------------------- */

test('GET /translate/entries：列表 + 搜尋（原文與譯文都能搜）', async (t) => {
  const { app, api } = await harness(t);

  seedEntry(app, { text: 'Contact us today', translated: '立即聯絡我們' });
  seedEntry(app, { text: 'About the team', translated: '關於團隊' });

  const all = await api('/admin/api/translate/entries');
  assert.equal(all.body.entries.length, 2);
  assert.deepEqual(all.body.counts, { total: 2, manual: 0 });

  const bySource = await api('/admin/api/translate/entries?q=Contact');
  assert.equal(bySource.body.entries.length, 1);

  const byTarget = await api('/admin/api/translate/entries?q=' + encodeURIComponent('團隊'));
  assert.equal(byTarget.body.entries.length, 1);
  assert.equal(byTarget.body.entries[0].source_text, 'About the team');
});

test('GET /translate/entries?origin=manual：只看人工覆寫', async (t) => {
  const { app, api } = await harness(t);

  seedEntry(app, { text: 'Contact' });
  seedEntry(app, { text: 'About', translated: '關於', origin: 'manual' });

  const { body } = await api('/admin/api/translate/entries?origin=manual');

  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].source_text, 'About');
});

test('GET /translate/failed：翻不動的（attempts >= 3）', async (t) => {
  const { app, api } = await harness(t);

  app.store.translateQueue.enqueue({
    texts: ['Stubborn text'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  for (const unused of [0, 1, 2]) {
    app.store.translateQueue.recordFailure(
      app.store.translateQueue.claim({ limit: 10 }),
      '一直對不上',
    );
  }

  const { body } = await api('/admin/api/translate/failed');

  assert.equal(body.failed.length, 1);
  assert.equal(body.failed[0].source_text, 'Stubborn text');
  assert.equal(body.failed[0].attempts, 3);
});

/* ------------------------------ 人工覆寫 ------------------------------ */

test('PUT /translate/entries/:hash：存檔後 origin 變 manual', async (t) => {
  const { app, api } = await harness(t);
  const hash = seedEntry(app, { translated: '機器翻的' });

  const { status, body } = await api(`/admin/api/translate/entries/${hash}`, {
    method: 'PUT',
    body: JSON.stringify({ translated: '人工改的' }),
  });

  assert.equal(status, 200);
  assert.equal(body.entry.translated, '人工改的');
  assert.equal(body.entry.origin, 'manual');
  assert.equal(app.store.translations.get(hash).origin, 'manual');
});

test('⛔ 人工覆寫過之後，背景翻譯不准蓋掉（規格 §2）', async (t) => {
  const { app, api } = await harness(t);
  const hash = seedEntry(app);

  await api(`/admin/api/translate/entries/${hash}`, {
    method: 'PUT',
    body: JSON.stringify({ translated: '人工版本' }),
  });

  // 背景佇列後來又翻了同一段
  app.store.translations.put({
    source_text: 'Contact',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '機器版本',
    origin: 'machine',
  });

  assert.equal(app.store.translations.get(hash).translated, '人工版本');
});

test('人工覆寫的輸入驗證：空的、太長、非物件都被擋', async (t) => {
  const { app, api } = await harness(t);
  const hash = seedEntry(app);

  for (const payload of [{ translated: '' }, { translated: '   ' }, { translated: 'x'.repeat(5000) }, {}]) {
    const response = await api(`/admin/api/translate/entries/${hash}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400, JSON.stringify(payload));
  }
});

test('人工覆寫不存在的 hash 回 404', async (t) => {
  const { api } = await harness(t);

  const response = await api('/admin/api/translate/entries/deadbeef', {
    method: 'PUT',
    body: JSON.stringify({ translated: 'x' }),
  });

  assert.equal(response.status, 404);
});

/* ------------------------------- 重翻 ------------------------------- */

test('POST retranslate：砍掉快取那筆 + 重新排進佇列', async (t) => {
  const { app, api } = await harness(t);
  const hash = seedEntry(app);

  const { status, body } = await api(`/admin/api/translate/entries/${hash}/retranslate`, {
    method: 'POST',
    body: '{}',
  });

  assert.equal(status, 200);
  assert.equal(body.queued, true);

  await app.translation.queue.idle();

  // 重翻之後是新的機器翻譯
  assert.equal(app.store.translations.get(hash).translated, '譯:Contact');
});

test('⛔ 人工覆寫過的段也能重翻（要先刪掉，不然 put 的 manual 保護會擋住）', async (t) => {
  const { app, api } = await harness(t);
  const hash = seedEntry(app, { translated: '人工版本', origin: 'manual' });

  await api(`/admin/api/translate/entries/${hash}/retranslate`, { method: 'POST', body: '{}' });
  await app.translation.queue.idle();

  const row = app.store.translations.get(hash);
  assert.equal(row.translated, '譯:Contact');
  assert.equal(row.origin, 'machine');
});

test('DELETE /translate/queue/:hash：放棄翻不動的段', async (t) => {
  const { app, api } = await harness(t);

  app.store.translateQueue.enqueue({
    texts: ['Stubborn'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });
  const hash = translationHash('Stubborn', 'zh-TW', MODEL);

  assert.equal((await api(`/admin/api/translate/queue/${hash}`, { method: 'DELETE' })).status, 204);
  assert.equal(app.store.translateQueue.stats().total, 0);
  assert.equal((await api(`/admin/api/translate/queue/${hash}`, { method: 'DELETE' })).status, 404);
});

test('POST /translate/run：推一把，回目前的佇列狀態', async (t) => {
  const { app, api } = await harness(t);

  app.store.translateQueue.enqueue({
    texts: ['Contact'],
    targetLang: 'zh-TW',
    model: MODEL,
    siteId: 'demo',
  });

  const { status, body } = await api('/admin/api/translate/run', { method: 'POST', body: '{}' });

  assert.equal(status, 200);
  assert.equal(body.started, true);

  await app.translation.queue.idle();
  assert.equal(app.store.translateQueue.stats().total, 0);
});

/* --------------------------- 站台的翻譯設定 --------------------------- */

test('PATCH /sites/:id：四個翻譯欄位都存得起來', async (t) => {
  const { api } = await harness(t);

  const { status, body } = await api('/admin/api/sites/demo', {
    method: 'PATCH',
    body: JSON.stringify({
      translate_enabled: true,
      translate_lang: 'zh-CN',
      translate_model: 'llama3:8b',
      glossary: 'Bootstrap\nTailwind\n\nBootstrap',
    }),
  });

  assert.equal(status, 200);
  assert.equal(body.site.translate_enabled, true);
  assert.equal(body.site.translate_lang, 'zh-CN');
  assert.equal(body.site.translate_model, 'llama3:8b');
  assert.deepEqual(body.site.glossary, ['Bootstrap', 'Tailwind'], '要去重、丟掉空行');
});

test('translate_model 留空 = 用全域預設（存成 null）', async (t) => {
  const { api } = await harness(t);

  await api('/admin/api/sites/demo', {
    method: 'PATCH',
    body: JSON.stringify({ translate_model: 'llama3:8b' }),
  });

  const { body } = await api('/admin/api/sites/demo', {
    method: 'PATCH',
    body: JSON.stringify({ translate_model: null }),
  });

  assert.equal(body.site.translate_model, null);
});

test('⛔ 翻譯設定的輸入驗證（這些值會進 prompt 與 hash）', async (t) => {
  const { api } = await harness(t);

  const bad = [
    { translate_lang: '中文' },
    { translate_lang: 'zh_TW' },
    { translate_lang: '' },
    { translate_model: 'rm -rf /' },
    { translate_model: 'a;b' },
    { translate_enabled: 'yes' },
    { glossary: 42 },
  ];

  for (const payload of bad) {
    const response = await api('/admin/api/sites/demo', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400, JSON.stringify(payload));
  }
});

test('GET /sites 的每一列都帶翻譯設定（清單要能顯示開關狀態）', async (t) => {
  const { api } = await harness(t);

  const { body } = await api('/admin/api/sites');
  const [site] = body.sites;

  assert.equal(site.translate_enabled, false, '預設不翻');
  assert.equal(site.translate_lang, 'zh-TW');
  assert.equal(site.translate_model, null);
  assert.deepEqual(site.glossary, []);
});

test('GET /settings 也回翻譯層的 env（設定分頁要列出來）', async (t) => {
  const { api } = await harness(t);

  const { body } = await api('/admin/api/settings');

  assert.equal(body.settings.translate.ollamaUrl, 'http://127.0.0.1:11434');
  assert.equal(body.settings.translate.model, 'qwen2.5:latest');
  assert.equal(body.settings.translate.batchSize, 20);
  assert.equal(typeof body.settings.translate.crawlPolitenessMs, 'number');
});

test('翻譯的端點全部要 token（跟後台其他 API 一樣）', async (t) => {
  const { app } = await harness(t);

  for (const pathname of [
    '/admin/api/translate/status',
    '/admin/api/translate/entries',
    '/admin/api/translate/models',
    '/admin/api/translate/failed',
  ]) {
    const response = await fetch(`${app.base}${pathname}`);
    assert.equal(response.status, 401, pathname);
  }
});
