'use strict';

const crypto = require('node:crypto');
const express = require('express');

const { createRateLimiter } = require('../lib/rate-limit.js');
const { rewriteHeaderUrls, buildDeliveryUrl } = require('../services/delivery.js');

/**
 * `GET /s/<token>/<slug>.user.js` —— 讓 Tampermonkey 直接裝、之後自動更新（SPEC-console §8）。
 *
 * 這個端點**免認證**：Tampermonkey 抓腳本時帶不了 admin bearer token。
 * 憑證是路徑裡那組 32 bytes 的隨機 token（腳本內容可能含金鑰，不能裸奔）。
 *
 * 兩個最容易做錯、而且錯了會「靜默失效」的地方：
 *   1. `Content-Type` 必須是 text/javascript —— text/plain 不會觸發 Tampermonkey 安裝
 *   2. 回傳前要把 header 的 @updateURL / @downloadURL 換成本端點的絕對網址，
 *      否則它會繼續去腳本原本寫的地方（真實樣本是 localhost:8001）檢查更新
 */

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const USERSCRIPT_SUFFIX = '.user.js';

/** 查無 token、腳本停用、檔名不對 —— 一律同一個回應，不洩漏腳本存不存在 */
function sendNotFound(res) {
  res.status(404).type('text/plain; charset=utf-8').send('找不到這個腳本');
}

function etagFor(body) {
  return `"${crypto.createHash('sha256').update(body).digest('hex')}"`;
}

/** `If-None-Match` 可能帶多個、也可能是 weak etag */
function matchesEtag(header, etag) {
  if (typeof header !== 'string' || header.length === 0) return false;

  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === etag || candidate === `W/${etag}` || candidate === '*');
}

function httpDate(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? null : date.toUTCString();
}

function createDeliveryRouter({ store, config, logger }) {
  const router = express.Router();

  const limiter = createRateLimiter({
    limit: config.delivery.rateLimit,
    windowMs: config.delivery.rateWindowMs,
  });

  router.get('/:token/:file', (req, res) => {
    const { token, file } = req.params;

    if (!TOKEN_PATTERN.test(token) || !file.endsWith(USERSCRIPT_SUFFIX)) {
      sendNotFound(res);
      return;
    }

    const quota = limiter.check(token);
    if (!quota.allowed) {
      res.setHeader('retry-after', String(Math.ceil(quota.retryAfterMs / 1000)));
      res.status(429).type('text/plain; charset=utf-8').send('請求太頻繁，請稍後再試');
      return;
    }

    const script = store.userscripts.getByDeliveryToken(token);
    if (!script || !script.enabled) {
      sendNotFound(res);
      return;
    }

    // 絕對網址用「請求進來時的 Host」組，不從設定讀：使用者會從 127.0.0.1、
    // 區網 IP、或 tunnel 網域來裝，每一種都要給對應的網址。
    const deliveryUrl = buildDeliveryUrl(req, script);
    const body = deliveryUrl === null ? script.source : rewriteHeaderUrls(script.source, deliveryUrl);

    const etag = etagFor(body);
    const lastModified = httpDate(script.updated_at);

    res.setHeader('etag', etag);
    if (lastModified) res.setHeader('last-modified', lastModified);
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');

    // 更新檢查很頻繁（每台裝置、每天好幾次），沒變就不要傳整份
    if (matchesEtag(req.headers['if-none-match'], etag)) {
      res.status(304).end();
      return;
    }

    logger.info(`投遞腳本「${script.name}」給 ${req.headers['user-agent'] ?? '未知的 UA'}`);

    res.setHeader('content-type', 'text/javascript; charset=utf-8');
    res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
    res.status(200).end(body);
  });

  router.use((req, res) => {
    sendNotFound(res);
  });

  return router;
}

module.exports = { createDeliveryRouter, etagFor, matchesEtag };
