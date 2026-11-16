'use strict';

const { parseCookieHeader } = require('../lib/cookies.js');
const { tokensMatch } = require('../admin/compare.js');
const { renderErrorPage } = require('../views/pages.js');

const ADMIN_COOKIE_NAME = 'lm_admin';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TOKEN_FILE_HINT = 'data/admin-token.txt';

function extractToken(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice('bearer '.length).trim();
  }
  return parseCookieHeader(req.headers.cookie)[ADMIN_COOKIE_NAME] ?? null;
}

/**
 * 跨站判斷。順序：`Sec-Fetch-Site`（現代瀏覽器一定會帶）→ `Origin` 比對 host。
 * 兩個都沒有 = 不是瀏覽器發的（curl / 腳本），放行但照樣要 token。
 *
 * 這裡擋的是「使用者瀏覽器裡的別站網頁拿 cookie 代打」。
 */
function isCrossSite(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite.length > 0) {
    return fetchSite !== 'same-origin';
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    return origin.toLowerCase() !== `${req.protocol}://${req.headers.host}`.toLowerCase();
  }

  return false;
}

function wantsJson(req) {
  return req.originalUrl.startsWith('/admin/api');
}

function unauthorizedPage() {
  return renderErrorPage({
    status: 401,
    title: '需要後台 token',
    paragraphs: [
      `token 在啟動 log 裡，也存在 <code>${TOKEN_FILE_HINT}</code>（或你自己設的 <code>LOCALMONKEY_ADMIN_TOKEN</code>）。`,
      '用 <code>/admin?token=&lt;你的 token&gt;</code> 開一次，之後這個瀏覽器就會記住。',
      'API 請帶 <code>Authorization: Bearer &lt;token&gt;</code>。',
    ],
  });
}

function sendUnauthorized(req, res) {
  if (wantsJson(req)) {
    res.status(401).json({ error: 'unauthorized', message: '需要後台 token' });
    return;
  }
  res.status(401).type('html').send(unauthorizedPage());
}

function sendCrossSiteBlocked(req, res) {
  if (wantsJson(req)) {
    res.status(403).json({
      error: 'cross_site_blocked',
      message: '跨站的寫入請求一律拒絕',
    });
    return;
  }
  res.status(403).type('html').send(
    renderErrorPage({
      status: 403,
      title: '跨站請求被拒絕',
      paragraphs: ['這個寫入請求看起來是從別的網站發出來的，已經被擋下來。'],
    }),
  );
}

/**
 * @param {{ adminToken: string }} input
 */
function createAdminAuth({ adminToken }) {
  return function adminAuth(req, res, next) {
    if (!tokensMatch(extractToken(req), adminToken)) {
      sendUnauthorized(req, res);
      return;
    }

    if (UNSAFE_METHODS.has(req.method) && isCrossSite(req)) {
      sendCrossSiteBlocked(req, res);
      return;
    }

    next();
  };
}

module.exports = {
  createAdminAuth,
  extractToken,
  isCrossSite,
  sendUnauthorized,
  ADMIN_COOKIE_NAME,
};
