'use strict';

/**
 * 根路徑 fallback 要知道「這個請求屬於哪個代理網站」。
 * 順序照規格：cookie `lm_site` → Referer 裡的 /p/<siteId>/ → 都沒有就 null（呼叫端回 404）。
 */

const { parseCookieHeader } = require('./cookies.js');
const { SLUG_PATTERN } = require('./validate.js');

const SITE_COOKIE_NAME = 'lm_site';
const REFERER_PATTERN = /\/p\/([a-z0-9-]{1,40})(?:[/?#]|$)/;

function isValidSlug(candidate) {
  return typeof candidate === 'string' && SLUG_PATTERN.test(candidate);
}

function siteIdFromReferer(referer) {
  if (typeof referer !== 'string' || referer.length === 0) return null;
  const match = REFERER_PATTERN.exec(referer);
  return match && isValidSlug(match[1]) ? match[1] : null;
}

function siteIdFromCookie(cookieHeader) {
  const candidate = parseCookieHeader(cookieHeader)[SITE_COOKIE_NAME];
  return isValidSlug(candidate) ? candidate : null;
}

/**
 * @param {{ cookie?: string, referer?: string }} headers
 * @returns {string|null}
 */
function resolveSiteIdFromHeaders(headers = {}) {
  return siteIdFromCookie(headers.cookie) ?? siteIdFromReferer(headers.referer) ?? null;
}

module.exports = {
  resolveSiteIdFromHeaders,
  siteIdFromReferer,
  siteIdFromCookie,
  SITE_COOKIE_NAME,
};
