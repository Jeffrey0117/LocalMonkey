'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { translationHash } = require('../../src/translate/cache.js');
const { AlignmentError, OllamaError } = require('../../src/translate/ollama.js');

/**
 * 規格 §5：請求時的行為（零閃爍的關鍵）。
 *
 * 代理在請求路徑上**只查 SQLite 快取**，沒命中就保留原文並丟進背景佇列。
 * 使用者第一次看到部分英文是**預期行為**，不是 bug。
 */

const MODEL = 'qwen2.5:latest';

const PAGE = [
  '<!doctype html>',
  '<html lang="en"><head>',
  '<meta charset="utf-8">',
  '<title>Our Studio</title>',
  '<meta name="description" content="A free template">',
  '<style>.hero{content:"Contact"}</style>',
  '</head><body>',
  '<h1>Our Team</h1>',
  '<p>\n    We build things\n  </p>',
  '<a href="/contact" class="btn">Contact</a>',
  '<img src="/a.png" alt="Office photo">',
  '<script>var label = "Contact";</script>',
  '</body></html>',
].join('\n');

/** 假 ollama：把原文包起來，所以譯文一眼看得出是哪一段 */
function fakeClient(behaviour = {}) {
  const batches = [];

  return {
    batches,
    model: MODEL,
    batchSize: 20,
    async translateBatch(texts) {
      batches.push([...texts]);
      if (behaviour.fail) throw behaviour.fail;
      return texts.map((text) => `譯:${text}`);
    },
    async listModels() {
      return [MODEL];
    },
    async ping() {
      return behaviour.fail
        ? { ok: false, models: [], error: behaviour.fail.message }
        : { ok: true, models: [MODEL], error: null };
    },
  };
}

function htmlUpstream(body = PAGE, { contentType = 'text/html; charset=utf-8' } = {}) {
  return (req, res) => {
    const buffer = Buffer.from(body, 'utf8');
    res.writeHead(200, { 'content-type': contentType, 'content-length': buffer.length });
    res.end(buffer);
  };
}

/** 起一個「上游 + 代理 + 假 ollama」的完整組合 */
async function scenario(t, { behaviour, upstream: handler, site = {} } = {}) {
  const upstream = await startUpstream(handler ?? htmlUpstream());
  t.after(() => upstream.close());

  const client = fakeClient(behaviour);
  const app = await startApp({ translationClient: client });
  t.after(() => app.close());

  app.store.sites.create({
    id: 'demo',
    name: 'demo',
    target_origin: upstream.origin,
    enabled: 1,
    ...site,
  });
  if (site.translate_enabled !== 0) {
    app.store.sites.update('demo', { translate_enabled: 1, translate_lang: 'zh-TW', ...site });
  }

  const fetchPage = async (pathname = '/p/demo/') => {
    const response = await fetch(`${app.base}${pathname}`);
    return { response, text: await response.text() };
  };

  return { app, upstream, client, fetchPage };
}

/* ------------------------------ 關掉的時候 ------------------------------ */

test('translate_enabled = 0 → HTML 原封不動，而且不碰 ollama', async (t) => {
  const { client, fetchPage } = await scenario(t, { site: { translate_enabled: 0 } });

  const { response, text } = await fetchPage();

  assert.equal(response.status, 200);
  assert.ok(text.includes('<h1>Our Team</h1>'));
  assert.equal(client.batches.length, 0);
});

/* --------------------------- 第一次：零閃爍 --------------------------- */

test('⛔ 第一次載入：保留原文（不等 ollama），段被排進背景佇列', async (t) => {
  const { app, fetchPage } = await scenario(t);

  const started = Date.now();
  const { response, text } = await fetchPage();
  const elapsed = Date.now() - started;

  assert.equal(response.status, 200);
  assert.ok(text.includes('Our Team'), '沒命中就保留原文');
  assert.ok(elapsed < 2_000, `請求路徑不准等 ollama（花了 ${elapsed}ms）`);

  await app.translation.queue.idle();
  assert.ok(app.store.translations.count().total > 0, '背景佇列應該翻好了');
});

test('第二次載入（佇列翻完後）→ 整頁都是譯文', async (t) => {
  const { app, fetchPage } = await scenario(t);

  await fetchPage();
  await app.translation.queue.idle();

  const { text } = await fetchPage();

  assert.ok(text.includes('譯:Our Team'), `h1 沒翻：${text}`);
  assert.ok(text.includes('譯:We build things'), '段落沒翻');
  assert.ok(text.includes('譯:Contact'), '連結文字沒翻');
  assert.ok(text.includes('譯:Our Studio'), '<title> 沒翻');
  assert.ok(text.includes('譯:A free template'), 'meta description 沒翻');
  assert.ok(text.includes('譯:Office photo'), 'alt 沒翻');
});

test('⛔ 回填保留前後空白（版面靠它）', async (t) => {
  const { app, fetchPage } = await scenario(t);

  await fetchPage();
  await app.translation.queue.idle();
  const { text } = await fetchPage();

  assert.ok(text.includes('<p>\n    譯:We build things\n  </p>'), `空白被吃掉了：${text}`);
});

test('⛔ script / style 的內容與 href / class 都沒被動到', async (t) => {
  const { app, fetchPage } = await scenario(t);

  await fetchPage();
  await app.translation.queue.idle();
  const { text } = await fetchPage();

  assert.ok(text.includes('<style>.hero{content:"Contact"}</style>'), 'style 被動到了');
  assert.ok(text.includes('var label = "Contact";'), 'script 被動到了');
  assert.ok(text.includes('href="/p/demo/contact"'), 'href 應該只被代理改寫，沒被翻譯動到');
  assert.ok(text.includes('class="btn"'), 'class 被動到了');
});

test('⛔ 送出去的 byte 是合法 UTF-8（latin1 管線沒把中文弄壞）', async (t) => {
  const { app, fetchPage } = await scenario(t);

  await fetchPage();
  await app.translation.queue.idle();

  const response = await fetch(`${app.base}/p/demo/`);
  const buffer = Buffer.from(await response.arrayBuffer());

  // 這一段是真正的回歸保護：decode 不回來就是使用者看到亂碼
  assert.ok(buffer.toString('utf8').includes('譯:Our Team'));
  assert.equal(buffer.includes(Buffer.from('譯:Our Team', 'utf8')), true);
});

test('同一頁裡重複的段只排一次、只翻一次', async (t) => {
  const page =
    '<meta charset="utf-8"><a>Read more</a><a>Read more</a><a>Read more</a><p>Other text here</p>';
  const { app, client, fetchPage } = await scenario(t, { upstream: htmlUpstream(page) });

  await fetchPage();
  await app.translation.queue.idle();

  assert.deepEqual(client.batches, [['Read more', 'Other text here']]);

  const { text } = await fetchPage();
  assert.equal(text.split('譯:Read more').length - 1, 3, '三處都要換');
});

test('第二次請求不會再呼叫 ollama（快取是主幹）', async (t) => {
  const { app, client, fetchPage } = await scenario(t);

  await fetchPage();
  await app.translation.queue.idle();
  const after = client.batches.length;

  await fetchPage();
  await app.translation.queue.idle();

  assert.equal(client.batches.length, after, '不准再打 ollama');
});

/* ------------------------------ 壞掉的時候 ------------------------------ */

test('⛔ ollama 連不上：代理照常回 200 + 原文，不 500', async (t) => {
  const { app, fetchPage } = await scenario(t, {
    behaviour: { fail: new OllamaError('連不到 ollama（ECONNREFUSED）') },
  });

  const { response, text } = await fetchPage();

  assert.equal(response.status, 200);
  assert.ok(text.includes('Our Team'));

  await app.translation.queue.idle();

  // 錯誤被記錄、佇列保留，下次 ollama 活了就會翻
  const stats = app.store.translateQueue.stats();
  assert.ok(stats.total > 0);
  assert.match(app.store.translateQueue.claim({ limit: 1 })[0].last_error, /ECONNREFUSED/);

  const second = await fetchPage();
  assert.equal(second.response.status, 200);
  assert.ok(second.text.includes('Our Team'));
});

test('⛔ 對齊失敗：那一批退回原文，一個字都沒進快取', async (t) => {
  const { app, fetchPage } = await scenario(t, {
    behaviour: { fail: new AlignmentError('key 數量對不上') },
  });

  await fetchPage();
  await app.translation.queue.idle();

  assert.equal(app.store.translations.count().total, 0);

  const { response, text } = await fetchPage();
  assert.equal(response.status, 200);
  assert.ok(text.includes('Our Team'), '退回原文');
  assert.equal(text.includes('譯:'), false);
});

test('⛔ 沒宣告 UTF-8 的頁面不翻（插中文 byte 進去就是整頁亂碼）', async (t) => {
  const page = '<html><head><title>Our Studio</title></head><body><h1>Our Team</h1></body></html>';
  const { app, client, fetchPage } = await scenario(t, {
    upstream: htmlUpstream(page, { contentType: 'text/html' }),
  });

  const { response, text } = await fetchPage();

  assert.equal(response.status, 200);
  assert.ok(text.includes('Our Team'));
  await app.translation.queue.idle();
  assert.equal(client.batches.length, 0, '連排進佇列都不該發生');
});

test('宣告 Big5 的頁面也不翻', async (t) => {
  const { app, client, fetchPage } = await scenario(t, {
    upstream: htmlUpstream(PAGE, { contentType: 'text/html; charset=big5' }),
  });

  await fetchPage();
  await app.translation.queue.idle();

  assert.equal(client.batches.length, 0);
});

test('非 HTML 的回應完全不經過翻譯層', async (t) => {
  const { app, client, fetchPage } = await scenario(t, {
    upstream: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ title: 'Our Team', body: 'We build things' }));
    },
  });

  const { response, text } = await fetchPage('/p/demo/api.json');

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text), { title: 'Our Team', body: 'We build things' });
  await app.translation.queue.idle();
  assert.equal(client.batches.length, 0);
});

/* ------------------------------ manual 優先 ------------------------------ */

test('⛔ 人工覆寫的那段用人工版本，而且背景翻譯不會蓋掉它', async (t) => {
  const { app, fetchPage } = await scenario(t);

  app.store.translations.setManual(translationHash('Our Team', 'zh-TW', MODEL), {
    source_text: 'Our Team',
    target_lang: 'zh-TW',
    model: MODEL,
    translated: '我們的團隊',
  });

  await fetchPage();
  await app.translation.queue.idle();
  const { text } = await fetchPage();

  assert.ok(text.includes('>我們的團隊<'), `人工版本沒生效：${text}`);
  assert.equal(text.includes('譯:Our Team'), false, '機器版本不准蓋掉人工的');
});

/* ------------------------------ 與注入共存 ------------------------------ */

test('⛔ 翻譯之後腳本注入還是正常（兩個改寫不互相破壞）', async (t) => {
  const { app, fetchPage } = await scenario(t);

  const deployed = await fetch(`${app.base}/admin/api/scripts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${app.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: [
        '// ==UserScript==',
        '// @name        demo',
        `// @match       ${app.store.sites.get('demo').target_origin}/*`,
        '// ==/UserScript==',
        'void 0;',
      ].join('\n'),
    }),
  });
  assert.equal(deployed.status, 201);

  await fetchPage();
  await app.translation.queue.idle();
  const { text } = await fetchPage();

  assert.ok(text.includes('譯:Our Team'), '翻譯還在');
  assert.match(text, /<script src="\/__lm\/script\/[^"]+\.js"><\/script>/, '注入的 script 還在');
});

test('目標語言跟著站台設定走（zh-CN 的段跟 zh-TW 是不同的快取）', async (t) => {
  const { app, fetchPage } = await scenario(t);

  app.store.sites.update('demo', { translate_lang: 'zh-CN' });

  await fetchPage();
  await app.translation.queue.idle();

  const rows = app.store.translations.list({ limit: 100 });
  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((row) => row.target_lang === 'zh-CN'),
    '快取要記在 zh-CN 底下',
  );
});

test('術語表裡的整段不會被送去翻', async (t) => {
  const page = '<meta charset="utf-8"><p>Bootstrap</p><p>Something else here</p>';
  const { app, client, fetchPage } = await scenario(t, { upstream: htmlUpstream(page) });

  app.store.sites.update('demo', { glossary: ['Bootstrap'] });

  await fetchPage();
  await app.translation.queue.idle();

  assert.deepEqual(client.batches, [['Something else here']]);
});
