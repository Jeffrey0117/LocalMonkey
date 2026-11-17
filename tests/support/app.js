'use strict';

const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');
const { createApp } = require('../../src/app.js');
const { loadConfig } = require('../../src/config.js');
const { silentLogger } = require('../../src/logger.js');

const TEST_ADMIN_TOKEN = 'test-token-7f3a91c4d5e607182b3c4d5e6f708192';

/**
 * 真的把 app 起在 port 0 上。資料庫用 :memory:，所以每個測試都是乾淨的。
 */
async function startApp(options = {}) {
  const store = createStore(openDatabase(':memory:'));

  const config = {
    allowPrivate: true, // 假上游跑在 127.0.0.1，不放行就什麼都測不到
    upstreamTimeoutMs: 5_000,
    maxRequestBodyBytes: 1024 * 1024,
    ...options.config,
    delivery: {
      rateLimit: 1000,
      rateWindowMs: 60_000,
      ...options.config?.delivery,
    },
    gmXhr: {
      timeoutMs: 5_000,
      maxResponseBytes: 1024 * 1024,
      maxRequestBytes: 256 * 1024,
      rateLimit: 1000,
      rateWindowMs: 60_000,
      allowHosts: [],
      ...options.config?.gmXhr,
    },
    /**
     * 翻譯層的預設直接取自真的 `loadConfig`，這樣測試用的 config 形狀
     * 永遠跟正式環境一致（漏一個欄位就會變成「測試裡是 null、線上是數字」）。
     * 只有逾時調短，不然一個壞掉的假 client 會讓測試等兩分鐘。
     */
    translate: {
      ...loadConfig({}).translate,
      timeoutMs: 5_000,
      ...options.config?.translate,
    },
  };

  const app = createApp({
    store,
    config,
    adminToken: options.adminToken ?? TEST_ADMIN_TOKEN,
    logger: options.logger ?? silentLogger,
    fetchImpl: options.fetchImpl,
    // 沒注入的話翻譯層會拿真的 ollama client —— 但每個站預設 translate_enabled=0，
    // 所以除了明確打開的測試之外不會有人去碰它
    translationClient: options.translationClient,
  });

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  const { port } = server.address();

  return {
    store,
    config,
    port,
    base: `http://127.0.0.1:${port}`,
    adminToken: options.adminToken ?? TEST_ADMIN_TOKEN,
    // 翻譯的整合測試要能等背景佇列跑完（queue.idle()）
    translation: app.locals.translation,
    close: async () => {
      app.locals.translation.queue.stop();
      await app.locals.translation.queue.idle();
      await new Promise((done) => server.close(done));
    },
  };
}

/** 建一個指向假上游的網站 + 任意數量的腳本 */
function seedSite(store, { id = 'demo', targetOrigin, enabled = 1, scripts = [] }) {
  const site = store.sites.create({
    id,
    name: `site ${id}`,
    target_origin: targetOrigin,
    enabled,
  });

  const created = scripts.map((script) => store.scripts.create(id, script));
  return { site, scripts: created };
}

function adminHeaders(token, extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function adminJson(base, token, pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      ...adminHeaders(token),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  return { status: response.status, body, headers: response.headers };
}

module.exports = { startApp, seedSite, adminJson, adminHeaders, TEST_ADMIN_TOKEN };
