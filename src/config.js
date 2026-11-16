'use strict';

const path = require('node:path');

const DEFAULTS = Object.freeze({
  port: 30600,
  host: '127.0.0.1',
  upstreamTimeoutMs: 20_000,
  maxRequestBodyBytes: 25 * 1024 * 1024,
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
  };
}

module.exports = { loadConfig, DEFAULTS };
