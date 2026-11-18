'use strict';

const path = require('node:path');

const { parseAllowHosts } = require('./lib/gm-allow-hosts.js');

const DEFAULTS = Object.freeze({
  port: 30600,
  host: '127.0.0.1',
  upstreamTimeoutMs: 20_000,
  maxRequestBodyBytes: 25 * 1024 * 1024,
  gmXhrTimeoutMs: 30_000,
  gmXhrMaxResponseBytes: 10 * 1024 * 1024,
  gmXhrMaxRequestBytes: 1024 * 1024,
  gmXhrRateLimit: 60,
  gmXhrRateWindowMs: 60_000,
  deliveryRateLimit: 120,
  deliveryRateWindowMs: 60_000,
  assetTimeoutMs: 15_000,
  assetMaxBytes: 5 * 1024 * 1024,

  // 伺服器端翻譯層（SPEC-translate §8）
  ollamaUrl: 'http://127.0.0.1:11434',
  translateModel: 'qwen2.5:latest',
  translateBatch: 20,
  translateKeepAlive: '30m',
  translateTimeoutMs: 120_000,
  crawlPolitenessMs: 500,
  translateRetryDelayMs: 30_000,
});

function parseInteger(raw, fallback, { min, max }) {
  if (raw === undefined || raw === null || String(raw).trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function parseToken(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * @param {Record<string, string|undefined>} [env]
 */
function loadConfig(env = process.env) {
  const dataDir = env.LOCALMONKEY_DATA_DIR
    ? path.resolve(env.LOCALMONKEY_DATA_DIR)
    : path.resolve(__dirname, '..', 'data');

  return {
    port: parseInteger(env.PORT, DEFAULTS.port, { min: 0, max: 65535 }),
    host: parseToken(env.HOST) ?? DEFAULTS.host,
    dataDir,
    databaseFile: path.join(dataDir, 'localmonkey.db'),
    adminToken: parseToken(env.LOCALMONKEY_ADMIN_TOKEN),
    allowPrivate: env.LOCALMONKEY_ALLOW_PRIVATE === '1',
    upstreamTimeoutMs: parseInteger(env.LOCALMONKEY_UPSTREAM_TIMEOUT_MS, DEFAULTS.upstreamTimeoutMs, {
      min: 1,
      max: 600_000,
    }),
    maxRequestBodyBytes: parseInteger(
      env.LOCALMONKEY_MAX_BODY_BYTES,
      DEFAULTS.maxRequestBodyBytes,
      { min: 1, max: 1024 * 1024 * 1024 },
    ),
    logLevel: parseToken(env.LOCALMONKEY_LOG_LEVEL) ?? 'info',

    // GET /s/<token>/<slug>.user.js（投遞給 Tampermonkey）
    delivery: {
      rateLimit: parseInteger(env.LOCALMONKEY_DELIVERY_RATE, DEFAULTS.deliveryRateLimit, {
        min: 1,
        max: 100_000,
      }),
      rateWindowMs: parseInteger(env.LOCALMONKEY_DELIVERY_WINDOW_MS, DEFAULTS.deliveryRateWindowMs, {
        min: 1,
        max: 3_600_000,
      }),
    },

    // 存腳本時在伺服器端抓 @require / @resource
    assetTimeoutMs: parseInteger(env.LOCALMONKEY_ASSET_TIMEOUT_MS, DEFAULTS.assetTimeoutMs, {
      min: 1,
      max: 600_000,
    }),
    assetMaxBytes: parseInteger(env.LOCALMONKEY_ASSET_MAX_BYTES, DEFAULTS.assetMaxBytes, {
      min: 1,
      max: 256 * 1024 * 1024,
    }),

    // GM_xmlhttpRequest 的伺服器端轉發（/__lm/gm/xhr）
    gmXhr: {
      timeoutMs: parseInteger(env.LOCALMONKEY_GM_XHR_TIMEOUT_MS, DEFAULTS.gmXhrTimeoutMs, {
        min: 1,
        max: 600_000,
      }),
      maxResponseBytes: parseInteger(
        env.LOCALMONKEY_GM_XHR_MAX_BYTES,
        DEFAULTS.gmXhrMaxResponseBytes,
        { min: 1, max: 1024 * 1024 * 1024 },
      ),
      maxRequestBytes: parseInteger(
        env.LOCALMONKEY_GM_XHR_MAX_REQUEST_BYTES,
        DEFAULTS.gmXhrMaxRequestBytes,
        { min: 1, max: 64 * 1024 * 1024 },
      ),
      rateLimit: parseInteger(env.LOCALMONKEY_GM_XHR_RATE, DEFAULTS.gmXhrRateLimit, {
        min: 1,
        max: 100_000,
      }),
      rateWindowMs: parseInteger(env.LOCALMONKEY_GM_XHR_WINDOW_MS, DEFAULTS.gmXhrRateWindowMs, {
        min: 1,
        max: 3_600_000,
      }),

      // 預設空的。只影響 GM_xmlhttpRequest，不影響代理目標（見 lib/gm-allow-hosts.js）
      allowHosts: parseAllowHosts(env.LOCALMONKEY_GM_ALLOW_HOSTS),
    },

    /**
     * 伺服器端翻譯層（SPEC-translate §8）。
     *
     * ⛔ ollama 在 localhost，所以這些呼叫會撞到 SSRF 防護的那條規則 ——
     * **不要**因此打開 `LOCALMONKEY_ALLOW_PRIVATE`（那是代理目標的全域開關，
     * 打開等於讓所有被代理的站都能指向內網）。翻譯是**伺服器自己發起**的
     * 呼叫，走獨立路徑、獨立設定，跟 `LOCALMONKEY_GM_ALLOW_HOSTS` 也無關。
     */
    translate: {
      ollamaUrl: parseToken(env.LOCALMONKEY_OLLAMA_URL) ?? DEFAULTS.ollamaUrl,
      model: parseToken(env.LOCALMONKEY_TRANSLATE_MODEL) ?? DEFAULTS.translateModel,
      batchSize: parseInteger(env.LOCALMONKEY_TRANSLATE_BATCH, DEFAULTS.translateBatch, {
        min: 1,
        max: 200,
      }),
      keepAlive: parseToken(env.LOCALMONKEY_TRANSLATE_KEEPALIVE) ?? DEFAULTS.translateKeepAlive,
      timeoutMs: parseInteger(
        env.LOCALMONKEY_TRANSLATE_TIMEOUT_MS,
        DEFAULTS.translateTimeoutMs,
        { min: 1_000, max: 1_800_000 },
      ),

      // ⛔ 爬蟲是在打**別人的**伺服器。規格 §6 要求每個請求之間至少 500ms，
      // 所以這個值只准往上調 —— 往下調就是把功能變成壓測工具。
      // 一輪跑完但還有做得動的段時，隔多久自己再試一次
      // （二分讓失敗變少，但沒解決「誰來開始下一輪」—— 使用者不再開頁面就沒有下一輪）
      retryDelayMs: parseInteger(
        env.LOCALMONKEY_TRANSLATE_RETRY_MS,
        DEFAULTS.translateRetryDelayMs,
        { min: 1_000, max: 3_600_000 },
      ),

      crawlPolitenessMs: parseInteger(
        env.LOCALMONKEY_CRAWL_POLITENESS_MS,
        DEFAULTS.crawlPolitenessMs,
        { min: DEFAULTS.crawlPolitenessMs, max: 60_000 },
      ),
    },
  };
}

module.exports = { loadConfig, DEFAULTS };
