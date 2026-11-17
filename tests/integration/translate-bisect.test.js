'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { startApp } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');

/**
 * 「失敗就二分」的端到端驗證。
 *
 * ⛔ 這一支**不注入假 client** —— 它起一台真的 HTTP 伺服器假扮 ollama，讓
 * `translate/ollama.js` 真的發請求、真的解析回應、真的跑對齊檢查。
 * 不然測到的只是佇列自己的邏輯，而真實世界的失敗是在 client 那一層發生的。
 *
 * 重現的是實測到的那個行為（2026-11-18 對真的 templatemo）：
 * **送 20 段，qwen2.5 回了 35 個 key**。批次越大越容易發生，拆小就正常。
 */

/**
 * 假 ollama。
 *
 * @param {{ alignedUpTo: number }} behaviour 批次 <= 這個數字才會乖乖對齊
 */
async function startFakeOllama({ alignedUpTo }) {
  const batches = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');

      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'fake:latest' }] }));
        return;
      }

      // 從 prompt 裡把「原文那包 JSON」挖回來（索引當 key 的 object）
      const prompt = JSON.parse(body).prompt;
      const payload = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1));
      const count = Object.keys(payload).length;

      batches.push(count);

      const answer =
        count <= alignedUpTo
          ? // 乖乖對齊：同樣的 key、翻好的 value
            Object.fromEntries(Object.entries(payload).map(([key, text]) => [key, `譯:${text}`]))
          : // 實測的壞掉長相：多吐 15 個 key
            Object.fromEntries(
              Array.from({ length: count + 15 }, (unused, index) => [String(index), `亂答 ${index}`]),
            );

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: JSON.stringify(answer) }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    batches,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** 12 段可翻的文字（長度不一，比較像真的頁面） */
const SEGMENTS = [
  'Welcome to our studio',
  'We build fast websites',
  'About the team',
  'Contact us today',
  'Read the latest news',
  'Our services include design',
  'Frequently asked questions',
  'Download the free template',
  'Sign up for our newsletter',
  'Privacy policy and terms',
  'Follow us on social media',
  'All rights reserved here',
];

const TITLE = 'Studio home page';

/** `<title>` 也是可翻的段，所以總數是 SEGMENTS + 1 —— 別把它漏掉 */
const ALL_TEXTS = [TITLE, ...SEGMENTS];

function page() {
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${TITLE}</title></head><body>`,
    ...SEGMENTS.map((text) => `<p>${text}</p>`),
    '</body></html>',
  ].join('\n');
}

async function scenario(t, { alignedUpTo }) {
  const ollama = await startFakeOllama({ alignedUpTo });
  t.after(() => ollama.close());

  const upstream = await startUpstream((req, res) => {
    const buffer = Buffer.from(page(), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buffer.length });
    res.end(buffer);
  });
  t.after(() => upstream.close());

  // ⛔ 刻意不給 translationClient：要讓真的 ollama client 跑起來
  const app = await startApp({
    config: {
      translate: { ollamaUrl: ollama.url, model: 'fake:latest', batchSize: ALL_TEXTS.length },
    },
  });
  t.after(() => app.close());

  app.store.sites.create({
    id: 'demo',
    name: 'demo',
    target_origin: upstream.origin,
    enabled: 1,
  });
  app.store.sites.update('demo', { translate_enabled: 1 });

  return { app, ollama };
}

test('⛔ 大批次對不上時，真的 client + 佇列會二分到成功，整頁翻完', async (t) => {
  // 整批一次送會對不上（多回 15 個 key），拆到 3 段以下才正常
  const { app, ollama } = await scenario(t, { alignedUpTo: 3 });

  await fetch(`${app.base}/p/demo/`);
  await app.translation.queue.idle();

  assert.equal(app.store.translations.count().total, ALL_TEXTS.length, '每一段都該翻完');
  assert.equal(app.store.translateQueue.stats().total, 0, '佇列要清空');
  assert.equal(app.store.translateQueue.stats().failed, 0, '不該有任何一段被標成翻不動');

  // 二分的形狀：第一次送整批 → 每次對半 → 成功的一定都在門檻以內
  assert.equal(ollama.batches[0], ALL_TEXTS.length, '第一次應該直接送整批');
  assert.ok(Math.min(...ollama.batches) <= 3, `沒有拆到門檻以下：${ollama.batches}`);
  assert.ok(
    ollama.batches.length < ALL_TEXTS.length * 2,
    `呼叫 ${ollama.batches.length} 次，退化成逐段重試了：${ollama.batches}`,
  );

  const second = await fetch(`${app.base}/p/demo/`);
  const html = await second.text();

  for (const text of ALL_TEXTS) {
    assert.ok(html.includes(`譯:${text}`), `「${text}」沒翻到：${html.slice(0, 300)}`);
  }
});

test('⛔ 只有單段才算得上翻不動（19 個好段不准被 1 個壞段連坐）', async (t) => {
  // alignedUpTo 0 → 連單段都對不上，所以每一段都會被試到單段才放棄
  const { app, ollama } = await scenario(t, { alignedUpTo: 0 });

  await fetch(`${app.base}/p/demo/`);
  await app.translation.queue.idle();

  const rows = app.store.translateQueue.claim({ limit: 50 });

  assert.equal(rows.length, ALL_TEXTS.length);
  assert.deepEqual(
    rows.map((row) => row.attempts),
    rows.map(() => 1),
    '每一段只該被算一次失敗（不是整批一起連坐好幾次）',
  );
  assert.match(rows[0].last_error, /數量對不上/);

  // 最小的批次一定是 1（證明真的縮到單段才放棄）
  assert.equal(Math.min(...ollama.batches), 1);
});

test('批次本來就對得上時不會多叫 ollama（二分只在失敗時才發生）', async (t) => {
  const { app, ollama } = await scenario(t, { alignedUpTo: 100 });

  await fetch(`${app.base}/p/demo/`);
  await app.translation.queue.idle();

  assert.deepEqual(ollama.batches, [ALL_TEXTS.length], '一次就過，不該有任何額外呼叫');
  assert.equal(app.store.translations.count().total, ALL_TEXTS.length);
});

test('⛔ 代理在整個過程中都正常回 200（翻譯壞掉不准影響看網頁）', async (t) => {
  const { app } = await scenario(t, { alignedUpTo: 0 });

  const first = await fetch(`${app.base}/p/demo/`);
  assert.equal(first.status, 200);
  assert.ok((await first.text()).includes('Welcome to our studio'), '退回原文');

  await app.translation.queue.idle();

  const second = await fetch(`${app.base}/p/demo/`);
  assert.equal(second.status, 200);
  assert.ok((await second.text()).includes('Welcome to our studio'));
});
