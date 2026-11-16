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
  };
}

module.exports = { loadConfig, DEFAULTS };
