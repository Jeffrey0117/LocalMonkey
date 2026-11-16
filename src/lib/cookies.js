'use strict';

/**
 * Cookie 改寫。上游的 Set-Cookie 直接轉述會被瀏覽器丟掉：
 * - `Domain=.example.com` 與代理的 host 不符
 * - `Secure` 在 http://127.0.0.1 下不會被存
 * - `SameSite=None` 沒有 Secure 也會被丟掉
 */

function rewriteSetCookie(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  const [nameValue, ...attributes] = value.split(';');

  const kept = attributes
    .map((attribute) => attribute.trim())
    .filter((attribute) => attribute.length > 0)
    .filter((attribute) => {
      const lower = attribute.toLowerCase();
      if (lower === 'secure') return false;
      if (lower.startsWith('domain=')) return false;
      if (lower.startsWith('samesite=')) return false;
      return true;
    });

  return [nameValue.trim(), ...kept, 'SameSite=Lax'].join('; ');
}

function decodeValue(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * @param {string|undefined} header req.headers.cookie
 * @returns {Record<string, string>}
 */
function parseCookieHeader(header) {
  if (typeof header !== 'string' || header.length === 0) return {};

  return header.split(';').reduce((acc, part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return acc;

    const name = part.slice(0, separator).trim();
    if (name.length === 0) return acc;

    return { ...acc, [name]: decodeValue(part.slice(separator + 1).trim()) };
  }, {});
}

module.exports = { rewriteSetCookie, parseCookieHeader };
