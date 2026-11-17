'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, adminJson } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { DEFAULTS, MS_PER_SEGMENT } = require('../../src/translate/crawl.js');
const { loadConfig } = require('../../src/config.js');

/** 規格 §6：預先翻譯整站。**這是在打別人的伺服器**，所以禮貌是規格的一部分。 */

const MODEL = 'qwen2.5:latest';

/** 一個小網站：/ → /about → /deep → /deeper，外加幾個不該被爬的連結 */
const PAGES = {
  '/': [
    '<meta charset="utf-8">',
    '<h1>Welcome home</h1>',
    '<a href="/about">About</a>',
    '<a href="/contact">Contact</a>',
    '<a href="/files/brochure.pdf">Brochure</a>',
    '<a href="https://example.com/outside">Outside</a>',
    '<a href="/about?utm=1">About again</a>',
    '<a href="mailto:hi@example.com">Mail</a>',
  ].join('\n'),
  '/about': '<meta charset="utf-8"><h1>About page</h1><a href="/deep">Deeper</a>',
  '/contact': '<meta charset="utf-8"><h1>Contact page</h1>',
  '/deep': '<meta charset="utf-8"><h1>Deep page</h1><a href="/deeper">Even deeper</a>',
  '/deeper': '<meta charset="utf-8"><h1>Deeper page</h1>',
};

function fakeClient(behaviour = {}) {
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
      return [MODEL];
    },
    async ping() {
      return behaviour.ollamaDown
        ? { ok: false, models: [], error: 'connect ECONNREFUSED 127.0.0.1:11434' }
        : { ok: true, models: [MODEL], error: null };
    },
  };
}

async function scenario(t, { behaviour, politenessMs = 30 } = {}) {
  const requests = [];

  const upstream = await startUpstream((req, res) => {
    requests.push({ path: req.url, at: Date.now() });

    const body = PAGES[req.url.split('?')[0]];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }

    const buffer = Buffer.from(body, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buffer.length });
    res.end(buffer);
  });
  t.after(() => upstream.close());

  const client = fakeClient(behaviour);
  const app = await startApp({
    translationClient: client,
    config: { translate: { crawlPolitenessMs: politenessMs } },
  });
  t.after(() => app.close());

  app.store.sites.create({
    id: 'demo',
    name: 'demo',
    target_origin: upstream.origin,
    enabled: 1,
  });
  app.store.sites.update('demo', { translate_enabled: 1 });

  const api = (pathname, init) => adminJson(app.base, app.adminToken, pathname, init);

  const crawl = async (body = {}) =>
    api('/admin/api/sites/demo/crawl', { method: 'POST', body: JSON.stringify(body) });

  return { app, upstream, client, requests, api, crawl };
}

/** 等爬蟲真的跑完（進度在 DB 裡，狀態離開 running 就是結束） */
async function waitForFinish(app, jobId, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = app.store.crawlJobs.get(jobId);
    if (job && job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`爬取工作 ${jobId} 在 ${timeoutMs}ms 內沒有結束`);
}

/* ------------------------------ 基本路徑 ------------------------------ */

test('POST crawl 立刻回 202 + job（不等整站爬完）', async (t) => {
  const { app, crawl } = await scenario(t);

  const started = Date.now();
  const response = await crawl({ maxPages: 5 });
  const elapsed = Date.now() - started;

  assert.equal(response.status, 202);
  assert.equal(response.body.job.status, 'running');
  assert.equal(response.body.job.max_pages, 5);
  assert.ok(elapsed < 2_000, `按下去要立刻回（花了 ${elapsed}ms）`);

  await waitForFinish(app, response.body.job.id);
});

test('⛔ 只爬同源的 HTML：外站 / pdf / mailto / 重複 query 都不爬', async (t) => {
  const { app, requests, crawl } = await scenario(t);

  const { body } = await crawl({ maxPages: 50, maxDepth: 3 });
  await waitForFinish(app, body.job.id);

  const paths = requests.map((entry) => entry.path).sort();

  assert.deepEqual(paths, ['/', '/about', '/contact', '/deep', '/deeper']);
  assert.equal(
    requests.some((entry) => entry.path.includes('.pdf')),
    false,
    'pdf 不該被抓',
  );
  assert.equal(
    requests.some((entry) => entry.path.includes('utm')),
    false,
    'query 不同但路徑相同的算同一頁',
  );
});

test('整站爬完之後，每一頁的文字都在快取裡了', async (t) => {
  const { app, crawl } = await scenario(t);

  const { body } = await crawl({ maxPages: 50, maxDepth: 3 });
  const job = await waitForFinish(app, body.job.id);

  assert.equal(job.status, 'done');
  assert.equal(job.pages_done, 5);
  assert.ok(job.segments_new >= 5, `新增的段太少：${job.segments_new}`);

  const cached = app.store.translations.lookup({
    texts: ['Welcome home', 'About page', 'Contact page', 'Deep page', 'Deeper page'],
    targetLang: 'zh-TW',
    model: MODEL,
  });

  assert.equal(cached.size, 5);
  assert.equal(cached.get('Deeper page').translated, '譯:Deeper page');
});

/* ------------------------------ 上限 ------------------------------ */

test('⛔ maxDepth 擋得住（深度 1 只會拿到首頁與它直接連到的）', async (t) => {
  const { app, requests, crawl } = await scenario(t);

  const { body } = await crawl({ maxDepth: 1, maxPages: 50 });
  await waitForFinish(app, body.job.id);

  assert.deepEqual(requests.map((entry) => entry.path).sort(), ['/', '/about', '/contact']);
});

test('⛔ maxDepth 0 只爬起點那一頁', async (t) => {
  const { app, requests, crawl } = await scenario(t);

  const { body } = await crawl({ maxDepth: 0 });
  await waitForFinish(app, body.job.id);

  assert.deepEqual(requests.map((entry) => entry.path), ['/']);
});

test('⛔ maxPages 擋得住', async (t) => {
  const { app, requests, crawl } = await scenario(t);

  const { body } = await crawl({ maxPages: 2, maxDepth: 3 });
  await waitForFinish(app, body.job.id);

  assert.equal(requests.length, 2);
});

test('maxPages 超過規格上限 500 → 400，而且訊息講得出為什麼', async (t) => {
  const { crawl } = await scenario(t);

  // 刻意回錯誤而不是默默夾到 500：使用者輸入 99999 時他想要的不是 500，
  // 默默改掉他的數字只會讓他以為整站都爬過了
  const tooMany = await crawl({ maxPages: 99_999 });

  assert.equal(tooMany.status, 400);
  assert.match(JSON.stringify(tooMany.body.details), /maxPages/);
  assert.match(JSON.stringify(tooMany.body.details), /500/);
});

test('startPath 可以指定（規格 §6）', async (t) => {
  const { app, requests, crawl } = await scenario(t);

  const { body } = await crawl({ startPath: '/about', maxDepth: 0 });
  await waitForFinish(app, body.job.id);

  assert.deepEqual(requests.map((entry) => entry.path), ['/about']);
});

/* ------------------------------ 禮貌 ------------------------------ */

test('⛔ 同時只打 1 個請求，而且每個之間有間隔（規格 §6：別變成壓測）', async (t) => {
  const { app, requests, crawl } = await scenario(t, { politenessMs: 120 });

  const { body } = await crawl({ maxPages: 3, maxDepth: 3 });
  await waitForFinish(app, body.job.id);

  assert.equal(requests.length, 3);

  for (let index = 1; index < requests.length; index += 1) {
    const gap = requests[index].at - requests[index - 1].at;
    assert.ok(gap >= 100, `第 ${index} 個請求只隔了 ${gap}ms`);
  }
});

test('⛔ 正式預設的禮貌間隔是 500ms，而且 env 只准往上調', () => {
  assert.equal(DEFAULTS.politenessMs, 500);
  assert.equal(loadConfig({}).translate.crawlPolitenessMs, 500);
  assert.equal(
    loadConfig({ LOCALMONKEY_CRAWL_POLITENESS_MS: '10' }).translate.crawlPolitenessMs,
    500,
    '調小的值要被忽略',
  );
  assert.equal(
    loadConfig({ LOCALMONKEY_CRAWL_POLITENESS_MS: '2000' }).translate.crawlPolitenessMs,
    2_000,
  );
});

/* ------------------------------ 取消 ------------------------------ */

test('⛔ 取消要立刻生效：之後不再對上游發任何請求', async (t) => {
  const { app, requests, api, crawl } = await scenario(t, { politenessMs: 200 });

  const { body } = await crawl({ maxPages: 50, maxDepth: 3 });

  // 等第一頁抓完（這時候 frontier 裡還有 /about、/contact 排著）。
  // 一定要有上限 —— 無界的 while 讓一條失敗的測試把整個 run 吊死（踩過）
  const deadline = Date.now() + 10_000;
  while (requests.length < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(requests.length >= 1, '爬蟲連第一頁都沒抓');

  const cancelled = await api(`/admin/api/sites/demo/crawl/${body.job.id}/cancel`, {
    method: 'POST',
    body: '{}',
  });

  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.job.status, 'cancelled');

  const atCancel = requests.length;
  const job = await waitForFinish(app, body.job.id);

  assert.equal(job.status, 'cancelled', '不准被收尾的程式碼蓋回 done');
  assert.ok(
    requests.length <= atCancel + 1,
    `取消後還打了 ${requests.length - atCancel} 個請求（最多容許正在飛的那一個）`,
  );
});

test('取消不存在的工作回 404；重複取消回同一個狀態', async (t) => {
  const { app, api, crawl } = await scenario(t);

  const missing = await api('/admin/api/sites/demo/crawl/crawl_nope/cancel', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(missing.status, 404);

  const { body } = await crawl({ maxPages: 1 });
  await api(`/admin/api/sites/demo/crawl/${body.job.id}/cancel`, { method: 'POST', body: '{}' });
  const again = await api(`/admin/api/sites/demo/crawl/${body.job.id}/cancel`, {
    method: 'POST',
    body: '{}',
  });

  assert.equal(again.status, 200);
  assert.equal(again.body.job.status, 'cancelled');
  await waitForFinish(app, body.job.id);
});

/* ------------------------------ 進度與重跑 ------------------------------ */

test('GET crawl 回進度與預估剩餘時間（規格 §6）', async (t) => {
  const { app, api, crawl } = await scenario(t);

  const { body } = await crawl({ maxPages: 50, maxDepth: 3 });
  await waitForFinish(app, body.job.id);

  const progress = await api('/admin/api/sites/demo/crawl');

  assert.equal(progress.status, 200);
  const [job] = progress.body.jobs;

  assert.equal(job.id, body.job.id);
  assert.equal(job.status, 'done');
  assert.equal(job.pages_done, 5);
  assert.ok(job.pages_found >= 5);
  assert.equal(typeof job.segments_pending, 'number');
  assert.equal(job.eta_ms, job.segments_pending * MS_PER_SEGMENT);
});

test('⛔ 重跑整站很便宜：已經在快取裡的段不會再排、也不再叫 ollama', async (t) => {
  const { app, client, crawl } = await scenario(t);

  const first = await crawl({ maxPages: 50, maxDepth: 3 });
  await waitForFinish(app, first.body.job.id);
  const callsAfterFirst = client.batches.length;
  assert.ok(callsAfterFirst > 0);

  const second = await crawl({ maxPages: 50, maxDepth: 3 });
  const job = await waitForFinish(app, second.body.job.id);

  assert.equal(client.batches.length, callsAfterFirst, '不准再打 ollama');
  assert.equal(job.segments_new, 0);
});

/* ------------------------------ 擋在前面 ------------------------------ */

test('⛔ ollama 連不上 → 直接回錯誤，不要讓使用者等半天（規格 §6）', async (t) => {
  const { app, requests, crawl } = await scenario(t, { behaviour: { ollamaDown: true } });

  const response = await crawl({ maxPages: 5 });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'crawl_failed');
  assert.match(response.body.message, /ollama/);
  assert.equal(requests.length, 0, '連第一頁都不該去抓');
  assert.equal(app.store.crawlJobs.latestForSite('demo'), null, '不該留下一筆殭屍 job');
});

test('翻譯沒打開的站不准爬（不然爬完什麼都沒發生）', async (t) => {
  const { app, crawl } = await scenario(t);

  app.store.sites.update('demo', { translate_enabled: false });
  const response = await crawl({});

  assert.equal(response.status, 400);
  assert.match(response.body.message, /翻譯沒有打開/);
});

test('不存在的網站回 404', async (t) => {
  const { api } = await scenario(t);

  const response = await api('/admin/api/sites/nope/crawl', { method: 'POST', body: '{}' });
  assert.equal(response.status, 404);
});

test('一頁掛掉不會讓整個工作失敗（壞連結很常見）', async (t) => {
  const { app, crawl } = await scenario(t);

  // PAGES 裡沒有 /missing，上游會回 404 → 那一頁跳過，其他照跑
  const { body } = await crawl({ startPath: '/missing', maxDepth: 1 });
  const job = await waitForFinish(app, body.job.id);

  assert.equal(job.status, 'done');
  assert.equal(job.pages_done, 1);
  assert.equal(job.segments_new, 0);
});
