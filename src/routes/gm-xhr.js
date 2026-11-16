'use strict';

const express = require('express');

const { isCrossSite } = require('../middleware/admin-auth.js');
const { siteIdFromReferer, siteIdFromCookie } = require('../lib/site-resolve.js');
const { isConnectAllowed } = require('../lib/connect-policy.js');
const { createRateLimiter } = require('../lib/rate-limit.js');
const { assertOriginAllowed, SsrfBlockedError } = require('../lib/ssrf.js');
const { isAllowedHost } = require('../lib/gm-allow-hosts.js');
const { forwardGmRequest, isAllowedMethod, GmForwardError } = require('../services/gm-forward.js');
const { canonicalGrant } = require('../userscript/grants.js');

/**
 * `POST /__lm/gm/xhr` —— GM_xmlhttpRequest 的伺服器端轉發。
 *
 * ⛔ 這個端點讓伺服器代替使用者發任意請求。沒鎖好就是開放代理 + SSRF
 * （這個專案已經修過一次同類漏洞，見 proxy/forward.js 的註解）。
 * 規格 §4.2 的七道防護，每一道在這裡都有對應的 early return：
 *
 *   1. 來源檢查      → 跨站請求擋掉 + Referer/cookie 必須對應到啟用中的 site
 *   2. @connect      → 目標主機必須被腳本宣告過（@connect * 一律拒絕）
 *   3. SSRF          → 重用 lib/ssrf.js，每一跳轉址都再驗一次
 *   4. method 白名單 → GET/POST/PUT/PATCH/DELETE/HEAD
 *   5. 大小與逾時    → 可用 env 調
 *   6. 不轉送憑證    → header 是白名單組出來的，不是複製進來的請求
 *   7. 速率限制      → 每個 site 各算各的
 */

const XHR_GRANTS = new Set(['GM_xmlhttpRequest']);

function deny(res, status, error, message, extra = {}) {
  res.status(status).json({ error, message, ...extra });
}

/** 這支腳本到底有沒有要求 GM_xmlhttpRequest？沒要求就不給用。 */
function hasXhrGrant(metadata) {
  const grants = Array.isArray(metadata?.grants) ? metadata.grants : [];
  return grants.some((grant) => XHR_GRANTS.has(canonicalGrant(grant)));
}

function resolveSiteId(req) {
  // 刻意 Referer 優先（跟代理的 fallback 相反）：cookie 只有一份，使用者同時開兩個
  // 代理網站時會互搶，而這裡是安全判斷 —— 要用「這一頁」的證據，不是「最後一頁」的。
  return siteIdFromReferer(req.headers.referer) ?? siteIdFromCookie(req.headers.cookie);
}

function parseTargetUrl(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function createGmXhrRouter({ store, config, logger, fetchImpl }) {
  const router = express.Router();
  const settings = config.gmXhr;

  const limiter = createRateLimiter({
    limit: settings.rateLimit,
    windowMs: settings.rateWindowMs,
  });

  router.post('/xhr', express.json({ limit: settings.maxRequestBytes }), async (req, res, next) => {
    // 1. 來源檢查
    if (isCrossSite(req)) {
      deny(res, 403, 'cross_site_blocked', '這個請求看起來不是從 LocalMonkey 的頁面發出來的');
      return;
    }

    const siteId = resolveSiteId(req);
    const site = siteId ? store.sites.get(siteId) : null;
    if (!site || !site.enabled) {
      deny(
        res,
        403,
        'unknown_site',
        '認不出這個請求屬於哪個代理網站（Referer 或 lm_site cookie 要指向一個啟用中的網站）',
      );
      return;
    }

    const body = req.body ?? {};
    const script = typeof body.scriptId === 'string' ? store.userscripts.get(body.scriptId) : null;
    if (!script || !script.enabled) {
      deny(res, 403, 'unknown_script', '找不到這支腳本（或它已經停用）');
      return;
    }

    if (!script.sites.some((binding) => binding.site_id === site.id)) {
      deny(res, 403, 'script_not_on_site', `腳本「${script.name}」沒有掛在網站「${site.id}」上`);
      return;
    }

    if (!hasXhrGrant(script.metadata)) {
      deny(
        res,
        403,
        'grant_required',
        '這支腳本沒有宣告 @grant GM_xmlhttpRequest，不能用伺服器端轉發',
      );
      return;
    }

    // 4. method 白名單
    if (!isAllowedMethod(body.method ?? 'GET')) {
      deny(res, 400, 'method_not_allowed', `不支援的 method：${String(body.method)}`);
      return;
    }

    const targetUrl = parseTargetUrl(body.url);
    if (!targetUrl) {
      deny(res, 400, 'bad_url', 'url 必須是 http(s) 的絕對網址');
      return;
    }

    // 2. @connect 白名單
    const policy = isConnectAllowed({
      targetUrl,
      siteOrigin: site.target_origin,
      connect: script.metadata?.connect,
      connectAll: script.metadata?.connectAll === true,
    });
    if (!policy.allowed) {
      deny(res, 403, 'connect_not_allowed', policy.reason);
      return;
    }

    // 7. 速率限制
    const quota = limiter.check(site.id);
    if (!quota.allowed) {
      res.setHeader('retry-after', String(Math.ceil(quota.retryAfterMs / 1000)));
      deny(res, 429, 'rate_limited', '這個網站的 GM_xmlhttpRequest 呼叫太頻繁，請稍後再試');
      return;
    }

    const sameSiteOrigin = targetUrl.origin === site.target_origin;

    try {
      const result = await forwardGmRequest({
        url: targetUrl,
        method: body.method,
        headers: body.headers,
        data: body.data,
        timeoutMs: settings.timeoutMs,
        maxBytes: settings.maxResponseBytes,
        sameSiteOrigin,
        fetchImpl,
        // 3. SSRF + 2. @connect：每一跳轉址都重驗一次
        validateUrl: async (url) => {
          const hop = isConnectAllowed({
            targetUrl: url,
            siteOrigin: site.target_origin,
            connect: script.metadata?.connect,
            connectAll: script.metadata?.connectAll === true,
          });
          if (!hop.allowed) {
            throw new GmForwardError('connect_not_allowed', hop.reason, { status: 403 });
          }
          // 白名單命中 → 豁免「私網位址」那條，但 @connect 已經在上面驗過了。
          // 每一跳都重算：302 導到別的私網主機一樣要被擋。
          const allowlisted = isAllowedHost(settings.allowHosts, url);
          await assertOriginAllowed(url.origin, {
            allowPrivate: config.allowPrivate || allowlisted,
          });
        },
      });

      res.json(result);
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        logger.warn(`擋下 GM_xmlhttpRequest ${site.id} → ${targetUrl.origin}：${error.message}`);
        deny(res, 403, 'ssrf_blocked', error.message);
        return;
      }
      if (error instanceof GmForwardError) {
        logger.warn(`GM_xmlhttpRequest 失敗（${error.reason}）：${error.message}`);
        deny(res, error.status, error.reason, error.message);
        return;
      }
      next(error);
    }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error?.type === 'entity.parse.failed') {
      deny(res, 400, 'invalid_json', 'request body 不是合法的 JSON');
      return;
    }
    if (error?.type === 'entity.too.large') {
      deny(res, 413, 'payload_too_large', 'request body 太大');
      return;
    }
    next(error);
  });

  return router;
}

module.exports = { createGmXhrRouter, hasXhrGrant };
